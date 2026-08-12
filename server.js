import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, validateConfig } from './src/config.js';
import { fetchOpportunities, fetchUsers, resolveFundedStage, fetchCustomFieldDefs, enrichWithCustomFields, setLogger, fetchPipelines } from './src/ghl.js';
import { normalizeOpportunities, aggregateByBroker, buildTotals, fieldHealth, summarizeBySource } from './src/normalize.js';
import { resolveRange, availableMonths } from './src/dateRange.js';
import { cached, getStale, invalidate, cacheMeta } from './src/cache.js';
import { attachRole, createSession, clearSession, verifyAdminPassword } from './src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const app = express();

/**
 * Ring buffer of recent sync output.
 *
 * Railway's log view isn't always reachable when you need it, and the admin
 * cookie can be blocked inside an iframe — so the same lines are kept here and
 * served over HTTP. Capped so a long-running container can't grow unbounded.
 */
const LOG_CAP = 400;
const recentLogs = [];

function logLine(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  console.log(msg);
  recentLogs.push(line);
  if (recentLogs.length > LOG_CAP) recentLogs.splice(0, recentLogs.length - LOG_CAP);
}

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

setLogger(logLine); // GHL client errors land in the readable buffer too

app.set('trust proxy', 1); // Railway sits behind a proxy
app.use(express.json());
app.use(cookieParser());
app.use(attachRole(cfg.jwtSecret || 'unset-secret-config-invalid'));

// ── Data pipeline ────────────────────────────────────────────────────────────

/** Fetch + normalize one location's funded opportunities. Cached. */
async function syncLocation(loc) {
  const key = `loc:${loc.id}`;

  const { value } = await cached(key, cfg.cacheTtlMs, async () => {
    const log = (msg) => logLine(`[${loc.name}] ${msg}`);
    log('─'.repeat(50));
    log(`Sync starting — location ${loc.id}`);

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
      log(`Stage resolved: "${resolved.pipelineName}" → "${resolved.stageName}" (${stageId})`);
    } else {
      log(`Stage pinned from env: ${stageId}`);
    }

    const [rawOpportunities, users, fieldDefs] = await Promise.all([
      fetchOpportunities({ token: loc.token, locationId: loc.id, pipelineId, stageId }),
      fetchUsers({ token: loc.token, locationId: loc.id }),
      // Required: opportunity payloads carry custom field IDs, not names.
      fetchCustomFieldDefs({ token: loc.token, locationId: loc.id }),
    ]);

    log(`Opportunities in stage: ${rawOpportunities.length}`);
    log(`Users: ${Object.keys(users).length}`);

    const defMeta = fieldDefs.__meta || {};
    log(
      `Custom field defs: ${Object.keys(fieldDefs).length} usable ` +
      `(from ${defMeta.total ?? '?'} total, ${defMeta.skippedNonOpportunity ?? 0} non-opportunity dropped, ` +
      `${defMeta.keptUnknownModel ?? 0} kept with unknown model)`
    );

    if (Object.keys(fieldDefs).length === 0) {
      log('⚠️  NO usable custom field definitions — every custom field will read empty.');
      log('    The /locations/{id}/customFields endpoint returned nothing for the opportunity model.');
    } else {
      const sampleNames = Object.values(fieldDefs).slice(0, 8).map((d) => d.fieldKey || d.name);
      log(`    e.g. ${sampleNames.join(', ')}`);
    }

    if (rawOpportunities.length === 0) {
      log('⚠️  Search returned no opportunities in this stage.');
      log(`    Resolved stage was "${cfg.fundedStageName}" in pipeline id ${pipelineId}.`);
      log('    If this office does have funded deals, the stage name likely matched');
      log(`    the wrong pipeline — set ${loc.slot}_PIPELINE_ID and ${loc.slot}_STAGE_ID explicitly.`);
      return [];
    }

    // How the search endpoint reported statuses, before filtering.
    const statusCounts = rawOpportunities.reduce((a, o) => {
      const k = o.status || '(none)';
      a[k] = (a[k] || 0) + 1;
      return a;
    }, {});
    log(`Status breakdown: ${JSON.stringify(statusCounts)}`);

    /**
     * Status filter. The stage already scopes us to Funded, but a deal can sit
     * in Funded and still be marked lost or abandoned — those shouldn't count
     * toward anyone's numbers. Default excludes them while keeping both won and
     * open, since teams don't always flip status the moment a deal funds.
     * Set OPPORTUNITY_STATUS=won to count only explicitly won deals.
     */
    const statusFiltered = rawOpportunities.filter((o) => {
      const st = String(o.status || '').toLowerCase();
      if (cfg.opportunityStatuses.includes('all')) return true;
      if (!st) return true; // no status set — keep it, the stage is the signal
      return cfg.opportunityStatuses.includes(st);
    });
    log(`After status filter [${cfg.opportunityStatuses.join(',')}]: ${statusFiltered.length}`);

    const searchHadFields = statusFiltered.some(
      (o) => Array.isArray(o.customFields) && o.customFields.length > 0
    );
    log(`Search response included custom fields: ${searchHadFields ? 'yes' : 'no'}`);

    // The search endpoint usually omits custom fields; fill them in per-deal.
    const { opportunities, enriched, failures } = await enrichWithCustomFields({
      token: loc.token,
      locationId: loc.id,
      opportunities: statusFiltered,
    });

    if (enriched) {
      const withFields = opportunities.filter(
        (o) => Array.isArray(o.customFields) && o.customFields.length > 0
      ).length;
      log(`Enriched ${opportunities.length} deals individually — ${withFields} now carry custom fields` +
          (failures ? `, ${failures} detail fetches failed` : ''));

      if (withFields === 0) {
        log('⚠️  Detail fetches returned no custom fields either.');
      }
    }

    const rows = normalizeOpportunities(opportunities, users, {
      locationId: loc.id,
      locationName: loc.name,
      fieldNames: cfg.fieldNames,
      fieldDefs,
      fieldIds: loc.fieldIds,
      commissionFromValue: cfg.commissionFromValue,
    });

    const health = fieldHealth(rows);
    log(`Resolved: funded ${health.fundedResolved}/${rows.length}` +
        (health.resolvedVia.fundedAmount?.length ? ` via ${health.resolvedVia.fundedAmount.join('|')}` : '') +
        `, commission ${health.commissionFromField + health.commissionFromValue}/${rows.length}`);

    if (rows[0]) {
      const s = rows[0];
      log(`Sample: ${s.broker} | ${s.businessName} | funded $${s.fundedAmount} | comm $${s.commission} | ${s.lender} | ${s.fundedDate}`);
    }

    if (health.fundedMissing === rows.length && rows.length > 0) {
      log('⚠️  No deal resolved a Funded Amount.');
      log(`    Field names seen on deals: ${health.availableFields.slice(0, 15).join(', ') || '(none)'}`);
    }

    log(`Sync complete — ${rows.length} rows`);
    return rows;
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

// The key travels in the URL here, so rate-limit it like the login form.
const selftestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
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

    /**
     * Optional lead-source filter. Applied after the date filter so the source
     * list below always reflects the full period — otherwise picking a source
     * would erase every other option from the dropdown.
     */
    const sourceFilter = String(req.query.source || '').trim();
    const filtered = sourceFilter && sourceFilter !== 'all'
      ? inRange.filter((r) => (r.source && r.source !== '—' ? r.source : 'Unattributed') === sourceFilter)
      : inRange;

    // Fee is not commission, so it isn't gated. Total stays with commission —
    // total minus fee would give commission away.
    const leaderboard = aggregateByBroker(filtered, { includeCommission: isAdmin, includeFee: true });
    const totals = buildTotals(filtered, { includeCommission: isAdmin, includeFee: true });
    // Breakdown spans the unfiltered period so every source stays selectable.
    const sources = summarizeBySource(inRange, { includeCommission: isAdmin, includeFee: true });

    /**
     * Warn only on genuine gaps. A deal reading its amount from the
     * opportunity value field is normal here, so that is not flagged —
     * a banner that fires on every deal teaches people to ignore banners.
     */
    const health = fieldHealth(filtered);
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
    const deals = filtered
      .map((r) => {
        const base = {
          broker: r.broker,
          businessName: r.businessName,
          fundedAmount: r.fundedAmount,
          fee: r.fee,
          lender: r.lender,
          source: r.source,
          fundedDate: r.fundedDate,
          locationName: r.locationName,
        };
        if (isAdmin) {
          base.commission = r.commission;
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
      sources,
      appliedSource: sourceFilter || 'all',
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
          statusBreakdown: rows.reduce((acc, r) => {
            const k = r.status || '(none)';
            acc[k] = (acc[k] || 0) + 1;
            return acc;
          }, {}),
        },
      });
    } catch (err) {
      out.push({ location: loc.name, error: err.message });
    }
  }

  res.json({
    configuredFieldNames: cfg.fieldNames,
    commissionReadsOpportunityValueField: cfg.commissionFromValue,
    countedStatuses: cfg.opportunityStatuses,
    hint:
      'Funded Amount comes from the custom field of that name. Commission comes from ' +
      'the opportunity Value field. If a figure is wrong, compare resolvedFrom on the ' +
      'sample deal against customFieldNamesInYourGHL.',
    locations: out,
  });
});

/**
 * Self-test: forces a fresh sync and returns everything needed to diagnose it.
 *
 * Authenticated by ?key= rather than the session cookie, because the cookie is
 * exactly what fails inside a GHL iframe or a browser blocking third-party
 * cookies — and that's precisely when you most need to see what's happening.
 * Same secret as the admin login, so it grants no additional access.
 *
 *   https://<your-app>.up.railway.app/api/selftest?key=YOUR_ADMIN_PASSWORD
 */
app.get('/api/selftest', selftestLimiter, async (req, res) => {
  if (!verifyAdminPassword(req.query.key, cfg.adminPassword)) {
    return res.status(401).json({
      error: 'Add ?key=<your ADMIN_PASSWORD> to this URL.',
    });
  }

  recentLogs.length = 0;
  invalidate('loc:'); // force a real sync rather than reporting on cache

  const out = { startedAt: new Date().toISOString(), locations: [] };

  for (const loc of cfg.locations) {
    const entry = { name: loc.name, locationId: loc.id, tokenPrefix: loc.token.slice(0, 8) + '…' };
    try {
      // Every pipeline/stage available, so a wrong-pipeline match is obvious.
      try {
        const pipelines = await fetchPipelines({ token: loc.token, locationId: loc.id });
        entry.pipelines = pipelines.map((p) => ({
          name: p.name,
          id: p.id,
          stages: (p.stages || []).map((s) => ({ name: s.name, id: s.id })),
        }));
      } catch (e) {
        entry.pipelines = `could not list: ${e.message}`;
      }

      const rows = await syncLocation(loc);
      const health = fieldHealth(rows);

      entry.ok = true;
      entry.dealCount = rows.length;
      entry.fieldResolution = {
        fundedAmount: {
          resolved: health.fundedResolved,
          missing: health.fundedMissing,
          matchedVia: health.resolvedVia.fundedAmount,
        },
        commission: {
          fromCustomField: health.commissionFromField,
          fromOpportunityValueField: health.commissionFromValue,
          missing: health.commissionMissing,
        },
        fee: { resolved: health.feeResolved, matchedVia: health.resolvedVia.fee },
      };
      entry.customFieldNamesSeenOnDeals = health.availableFields;
      entry.statusBreakdown = rows.reduce((a, r) => {
        const k = r.status || '(none)';
        a[k] = (a[k] || 0) + 1;
        return a;
      }, {});
      entry.rawCustomFieldShape = rows[0]?._rawCustomFields || [];
      entry.sampleDeals = rows.slice(0, 3).map((r) => ({
        broker: r.broker,
        businessName: r.businessName,
        fundedAmount: r.fundedAmount,
        commission: r.commission,
        fee: r.fee,
        lender: r.lender,
        fundedDate: r.fundedDate,
        status: r.status,
        opportunityValue: r.monetaryValue,
        resolvedFrom: r._sources,
      }));
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
      entry.status = err.status || null;
    }
    out.locations.push(entry);
  }

  out.config = {
    fundedStageName: cfg.fundedStageName,
    countedStatuses: cfg.opportunityStatuses,
    commissionFromValueField: cfg.commissionFromValue,
    timezone: cfg.tz,
    fieldCandidates: cfg.fieldNames,
  };
  out.syncLog = recentLogs.slice();

  res.json(out);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(cfg.port, () => {
  console.log(`\n🏆 PCG Leaderboard running on port ${cfg.port}`);
  console.log(`   Locations: ${cfg.locations.map((l) => l.name).join(', ') || 'none configured'}`);
  console.log(`   Timezone:  ${cfg.tz}`);
  console.log(`   Cache TTL: ${cfg.cacheTtlMs / 60000} min\n`);
});
