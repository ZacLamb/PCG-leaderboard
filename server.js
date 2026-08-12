import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, validateConfig } from './src/config.js';
import { fetchOpportunities, fetchUsers, resolveFundedStage, fetchCustomFieldDefs } from './src/ghl.js';
import { normalizeOpportunities, aggregateByBroker, buildTotals, fieldHealth } from './src/normalize.js';
import { resolveRange, availableMonths } from './src/dateRange.js';
import { cached, getStale, invalidate, cacheMeta } from './src/cache.js';
import { attachRole, createSession, clearSession, verifyAdminPassword } from './src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const app = express();

// ── Boot validation ──────────────────────────────────────────────────────────
const { errors: configErrors, warnings: configWarnings } = validateConfig(cfg);

if (configErrors.length) {
  console.error('\n❌ Configuration errors — dashboard will show a setup screen:\n');
  configErrors.forEach((e) => console.error('   • ' + e));
  console.error('\nSet these in Railway → Variables, then redeploy.\n');
  // Keep serving so the UI can show a setup message instead of a blank page.
}

if (configWarnings.length) {
  console.warn('\n⚠️  Configuration warnings:\n');
  configWarnings.forEach((w) => console.warn('   • ' + w));
  console.warn('');
}

app.set('trust proxy', 1); // Railway sits behind a proxy
app.use(express.json());
app.use(cookieParser());
app.use(attachRole(cfg.jwtSecret || 'unset-secret-config-invalid'));

// ── Data pipeline ────────────────────────────────────────────────────────────

/** Fetch + normalize one location's funded opportunities. Cached. */
async function syncLocation(loc) {
  const key = `loc:${loc.id}`;

  const { value } = await cached(key, cfg.cacheTtlMs, async () => {
    // Resolve the Funded stage unless it's pinned in env.
    let pipelineId = loc.pipelineId;
    let stageId = loc.stageId;

    if (!stageId) {
      const resolved = await resolveFundedStage({
        token: loc.token,
        locationId: loc.id,
        stageName: cfg.fundedStageName,
      });
      pipelineId = resolved.pipelineId;
      stageId = resolved.stageId;

      if (!stageId) {
        throw new Error(
          `No pipeline stage named "${cfg.fundedStageName}" found in ${loc.name}. ` +
          `Set ${loc.slot}_STAGE_ID or fix FUNDED_STAGE_NAME.`
        );
      }
    }

    const [opportunities, users, fieldDefs] = await Promise.all([
      fetchOpportunities({ token: loc.token, locationId: loc.id, pipelineId, stageId }),
      fetchUsers({ token: loc.token, locationId: loc.id }),
      // Required: opportunity payloads carry custom field IDs, not names.
      fetchCustomFieldDefs({ token: loc.token, locationId: loc.id }),
    ]);

    return normalizeOpportunities(opportunities, users, {
      locationId: loc.id,
      locationName: loc.name,
      fieldNames: cfg.fieldNames,
      fieldDefs,
      commissionFromValue: cfg.commissionFromValue,
    });
  });

  return value;
}

/** Resolve the ?location= param into the set of locations to include. */
function selectLocations(param) {
  const want = String(param || 'joint').toLowerCase();
  if (want === 'joint' || want === 'all' || want === 'both') return cfg.locations;
  const match = cfg.locations.filter(
    (l) => l.key === want || l.id === param || l.name.toLowerCase() === want
  );
  return match.length ? match : cfg.locations;
}

// ── Routes ───────────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};

  if (!verifyAdminPassword(password, cfg.adminPassword)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  createSession(res, { role: 'admin' }, cfg.jwtSecret);
  res.json({ role: 'admin' });
});

app.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ role: 'viewer' });
});

app.get('/api/session', (req, res) => {
  res.json({
    role: req.role,
    locations: cfg.locations.map((l) => ({ key: l.key, name: l.name })),
    barMax: cfg.barMax,
    configured: configErrors.length === 0,
    configErrors: configErrors.length ? configErrors : undefined,
    configWarnings: configWarnings.length ? configWarnings : undefined,
  });
});

app.get('/api/leaderboard', async (req, res) => {
  const isAdmin = req.role === 'admin';

  try {
    const locations = selectLocations(req.query.location);
    if (!locations.length) {
      return res.status(503).json({ error: 'No locations configured.' });
    }

    // Pull each location, tolerating one being down.
    const results = await Promise.allSettled(locations.map(syncLocation));

    const rows = [];
    const warnings = [];

    results.forEach((r, i) => {
      const loc = locations[i];
      if (r.status === 'fulfilled') {
        rows.push(...r.value);
      } else {
        const stale = getStale(`loc:${loc.id}`);
        if (stale) {
          rows.push(...stale);
          warnings.push(`${loc.name}: showing cached data (${r.reason.message})`);
        } else {
          warnings.push(`${loc.name}: unavailable (${r.reason.message})`);
        }
      }
    });

    // Date filtering
    const range = resolveRange(
      {
        preset: req.query.preset,
        month: req.query.month,
        from: req.query.from,
        to: req.query.to,
        start: req.query.start,
        end: req.query.end,
      },
      cfg.tz
    );

    const inRange = rows.filter((r) => {
      if (!r.fundedDate) return false;
      const d = new Date(r.fundedDate);
      return d >= range.start && d <= range.end;
    });

    const leaderboard = aggregateByBroker(inRange, { includeCommission: isAdmin });
    const totals = buildTotals(inRange, { includeCommission: isAdmin });

    /**
     * Warn only on genuine gaps. A deal reading its amount from the
     * opportunity value field is normal here, so that is not flagged —
     * a banner that fires on every deal teaches people to ignore banners.
     */
    const health = fieldHealth(inRange);
    if (health.total > 0) {
      if (health.fundedMissing === health.total) {
        warnings.push(
          'No "Funded Amount" custom field matched any deal — funded totals are $0. ' +
          'Check /api/diagnostics for the real field names, then set FIELD_FUNDED_AMOUNT.'
        );
      } else if (health.fundedMissing > 0) {
        warnings.push(
          `${health.fundedMissing} of ${health.total} deals have no Funded Amount set in GHL.`
        );
      }

      if (isAdmin && health.commissionMissing === health.total) {
        warnings.push(
          'No commission value found on any deal — commission totals are $0. ' +
          'Check /api/diagnostics to see what the opportunities carry.'
        );
      }
    }

    // Deal-level detail. Commission and fee are stripped for viewers.
    const deals = inRange
      .map((r) => {
        const base = {
          broker: r.broker,
          businessName: r.businessName,
          fundedAmount: r.fundedAmount,
          lender: r.lender,
          fundedDate: r.fundedDate,
          locationName: r.locationName,
        };
        if (isAdmin) {
          base.commission = r.commission;
          base.fee = r.fee;
          base.total = r.commission + r.fee;
        }
        return base;
      })
      .sort((a, b) => new Date(b.fundedDate) - new Date(a.fundedDate));

    res.json({
      role: req.role,
      range: { label: range.label, preset: range.preset, start: range.start, end: range.end },
      locations: locations.map((l) => ({ key: l.key, name: l.name })),
      totals,
      leaderboard,
      deals,
      months: availableMonths(rows),
      warnings: warnings.length ? warnings : undefined,
      cache: cacheMeta(`loc:${locations[0].id}`),
    });
  } catch (err) {
    console.error('leaderboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only.' });
  }
  invalidate('loc:');
  res.json({ ok: true });
});

/**
 * Shows exactly how each money field resolved, and every custom field name
 * actually present on your opportunities — so a mapping miss is a two-minute
 * fix instead of a guessing game.
 */
app.get('/api/diagnostics', async (req, res) => {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only.' });
  }

  const out = [];

  for (const loc of cfg.locations) {
    try {
      const stage = await resolveFundedStage({
        token: loc.token,
        locationId: loc.id,
        stageName: cfg.fundedStageName,
      });

      const rows = await syncLocation(loc);
      const health = fieldHealth(rows);
      const sample = rows[0] || null;

      out.push({
        location: loc.name,
        resolvedStage: {
          pipeline: stage.pipelineName,
          stage: stage.stageName,
          stageId: stage.stageId,
        },
        dealCount: rows.length,

        fieldResolution: {
          fundedAmount: {
            resolvedFromCustomField: health.fundedResolved,
            noValueFound: health.fundedMissing,
            matchedFieldNames: health.resolvedVia.fundedAmount,
          },
          commission: {
            fromCustomField: health.commissionFromField,
            fromOpportunityValueField: health.commissionFromValue,
            noValueFound: health.commissionMissing,
            matchedFieldNames: health.resolvedVia.commission,
          },
          fee: {
            resolved: health.feeResolved,
            matchedFieldNames: health.resolvedVia.fee,
          },
        },

        // The answer to "what are my fields actually called?"
        customFieldNamesInYourGHL: health.availableFields,

        sampleDeal: sample && {
          broker: sample.broker,
          businessName: sample.businessName,
          fundedAmount: sample.fundedAmount,
          commission: sample.commission,
          fee: sample.fee,
          lender: sample.lender,
          fundedDate: sample.fundedDate,
          opportunityValue: sample.monetaryValue,
          resolvedFrom: sample._sources,
        },

        dataQuality: {
          missingFundedDate: rows.filter((r) => !r.fundedDate).length,
          zeroFundedAmount: rows.filter((r) => !r.fundedAmount).length,
          zeroCommission: rows.filter((r) => !r.commission).length,
          unassignedBroker: rows.filter((r) => r.broker === 'Unassigned').length,
        },
      });
    } catch (err) {
      out.push({ location: loc.name, error: err.message });
    }
  }

  res.json({
    configuredFieldNames: cfg.fieldNames,
    commissionReadsOpportunityValueField: cfg.commissionFromValue,
    hint:
      'Funded Amount comes from the custom field of that name. Commission comes from ' +
      'the opportunity Value field. If a figure is wrong, compare resolvedFrom on the ' +
      'sample deal against customFieldNamesInYourGHL.',
    locations: out,
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(cfg.port, () => {
  console.log(`\n🏆 PCG Leaderboard running on port ${cfg.port}`);
  console.log(`   Locations: ${cfg.locations.map((l) => l.name).join(', ') || 'none configured'}`);
  console.log(`   Timezone:  ${cfg.tz}`);
  console.log(`   Cache TTL: ${cfg.cacheTtlMs / 60000} min\n`);
});
