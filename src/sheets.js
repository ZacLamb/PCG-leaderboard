/**
 * Google Sheets as the primary data source.
 *
 * Read through the gviz endpoint, which needs no API key or service account —
 * only that the sheet is shared so anyone with the link can view. That keeps
 * setup to pasting a sheet ID into Railway.
 *
 * The sheet is the operational record: it carries Payout, Date Paid and
 * Clawback, which don't exist in the CRM. GHL stays as the fallback for when a
 * sheet is unreachable, empty, or simply not configured.
 */

/** Column headers we look for, in priority order. Matching ignores case/punctuation. */
const COLUMNS = {
  date:        ['date'],
  broker:      ['broker name', 'broker', 'rep', 'agent'],
  business:    ['business name', 'business', 'merchant', 'company'],
  funded:      ['funded amount', 'funded', 'amount funded'],
  commission:  ['commision amount', 'commission amount', 'commision', 'commission'],
  payout:      ['payout', 'payout amount'],
  datePaid:    ['date paid', 'paid date'],
  clawback:    ['clawback', 'claw back'],
  fee:         ['fee', 'psf'],
  lender:      ['lender/s', 'lenders', 'lender', 'funder'],
  gotPaid:     ['did we get paid', 'got paid', 'paid'],
  source:      ['source', 'lead source'],
  // Consolidation deals record their amounts in dedicated columns and leave
  // Funded Amount / Commision Amount blank.
  consolidationFunded:     ['total consolidation funded', 'consolidation funded'],
  consolidationCommission: ['total consolidation commision', 'total consolidation commission',
                            'consolidation commision', 'consolidation commission'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function parseAmount(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Turn Google's response into a sentence that names the actual problem.
 * A sign-in page, a permission error and a missing tab all fail the same way
 * without this, and each needs a different fix.
 */
function describeSheetBody(text) {
  const body = String(text || '');
  const head = body.slice(0, 400).replace(/\s+/g, ' ');

  if (/accounts\.google\.com|ServiceLogin|signin\/v2|Sign in/i.test(body)) {
    return 'Google served a sign-in page — the sheet is not readable without logging in. ' +
           'Set File → Share → General access → Anyone with the link → Viewer.';
  }
  if (/permission|not have access|PERMISSION_DENIED|requires access/i.test(body)) {
    return 'Google reported a permissions error. ' +
           'Set File → Share → General access → Anyone with the link → Viewer.';
  }
  if (/invalid[_ ]?(sheet|gid)|Invalid query|unknown sheet/i.test(body)) {
    return 'Google rejected the tab reference — the gid may be wrong for this spreadsheet.';
  }
  if (/<!DOCTYPE html|<html/i.test(body)) {
    return `Google returned an HTML page instead of data. First 200 chars: ${head.slice(0, 200)}`;
  }
  return `Unexpected response. First 200 chars: ${head.slice(0, 200)}`;
}

/** gviz returns dates as the literal string "Date(2026,6,10)" — month is 0-based. */
function parseSheetDate(v) {
  if (!v) return null;
  try {
    if (typeof v === 'string' && v.startsWith('Date(')) {
      const p = v.replace('Date(', '').replace(')', '').split(',').map(Number);
      return new Date(Date.UTC(p[0], p[1], p[2], 12)); // midday UTC avoids TZ edge flips
    }
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;

    /**
     * Free-text notes land in date columns ("Ari paid $600" parses as year 600).
     * Anything outside a sane window is a misread, not a date.
     */
    const year = d.getUTCFullYear();
    if (year < 2000 || year > 2100) return null;

    return d;
  } catch {
    return null;
  }
}

/** Locate each logical column by header text, so column order can change safely. */
function mapColumns(cols) {
  const labels = cols.map((c) => norm(c.label));
  const found = {};

  for (const [key, candidates] of Object.entries(COLUMNS)) {
    for (const cand of candidates) {
      const idx = labels.indexOf(norm(cand));
      if (idx !== -1) { found[key] = idx; break; }
    }
    // Fall back to a contains-match for headers with extra words.
    if (found[key] === undefined) {
      for (const cand of candidates) {
        const idx = labels.findIndex((l) => l && l.includes(norm(cand)));
        if (idx !== -1) { found[key] = idx; break; }
      }
    }
  }

  return found;
}

/**
 * Fetch and parse one office's commission sheet.
 *
 * Identifies the tab by gid when available. A gid is stable and unambiguous —
 * it survives the tab being renamed, and it means we don't have to know how
 * each office spelled "Commision". Falls back to the tab name if no gid.
 *
 * @returns {{ rows: object[], meta: object }}
 */
export async function fetchSheetRows({ sheetId, gid, tab, locationName, report = () => {} }) {
  const target = gid
    ? `&gid=${encodeURIComponent(gid)}`
    : (tab ? `&sheet=${encodeURIComponent(tab)}` : '');

  const url =
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json` +
    target +
    `&t=${Date.now()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let text;
  let httpStatus;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    httpStatus = res.status;
    text = await res.text();
    if (!res.ok) {
      throw new Error(`Google returned HTTP ${res.status}. ${describeSheetBody(text)}`);
    }
  } finally {
    clearTimeout(timeout);
  }

  const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/);
  if (!match) {
    // Say what actually came back — an auth wall and a bad gid look identical
    // otherwise, and they need completely different fixes.
    throw new Error(
      `Sheet did not return data (HTTP ${httpStatus}). ${describeSheetBody(text)}`
    );
  }

  const json = JSON.parse(match[1]);

  // gviz can answer with a well-formed error object instead of a table —
  // a wrong gid does exactly this. Report it rather than crashing on .cols.
  if (json.status === 'error' || !json.table) {
    const reasons = (json.errors || [])
      .map((e) => e.detailed_message || e.message || e.reason)
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `Google rejected the query${reasons ? `: ${reasons}` : '.'} ` +
      'Check that the gid matches a tab in this spreadsheet.'
    );
  }

  const cols = json.table.cols || [];
  const rawRows = json.table.rows || [];
  const map = mapColumns(cols);

  report(`[${locationName}] Sheet columns matched: ${Object.keys(map).join(', ')}`);

  const missing = ['date', 'broker', 'funded'].filter((k) => map[k] === undefined);
  if (missing.length) {
    throw new Error(
      `Sheet is missing required column(s): ${missing.join(', ')}. ` +
      `Headers found: ${cols.map((c) => c.label).filter(Boolean).join(' | ')}`
    );
  }

  const cell = (r, idx) => {
    if (idx === undefined) return '';
    const c = r.c?.[idx];
    if (!c) return '';
    return c.v !== undefined && c.v !== null ? c.v : (c.f || '');
  };

  const rows = [];
  let skippedNoBroker = 0;
  let skippedNoDate = 0;

  for (const r of rawRows) {
    const broker = String(cell(r, map.broker)).trim();
    if (!broker || norm(broker) === norm('broker name')) { skippedNoBroker++; continue; }

    const date = parseSheetDate(cell(r, map.date));
    if (!date) { skippedNoDate++; continue; }

    /**
     * A consolidation deal leaves Funded Amount and Commision Amount blank and
     * records its numbers in the consolidation columns instead. Treated as a
     * fallback rather than a sum: for these rows the consolidation figure IS
     * the funded amount, so adding both would double-count.
     */
    const plainFunded = parseAmount(cell(r, map.funded));
    const plainComm   = parseAmount(cell(r, map.commission));
    const consFunded  = parseAmount(cell(r, map.consolidationFunded));
    const consComm    = parseAmount(cell(r, map.consolidationCommission));

    const isConsolidation = !plainFunded && !!consFunded;
    const fundedAmount = plainFunded || consFunded;
    const commission   = plainComm || consComm;

    rows.push({
      broker,
      businessName: String(cell(r, map.business) || '—').trim(),
      fundedAmount,
      commission,
      isConsolidation,
      consolidationFunded: consFunded,
      consolidationCommission: consComm,
      fee: parseAmount(cell(r, map.fee)),
      payout: parseAmount(cell(r, map.payout)),
      clawback: parseAmount(cell(r, map.clawback)),
      lender: String(cell(r, map.lender) || '—').trim(),
      source: String(cell(r, map.source) || '—').trim(),
      datePaid: parseSheetDate(cell(r, map.datePaid))?.toISOString() || null,
      gotPaid: String(cell(r, map.gotPaid) || '').trim(),
      fundedDate: date.toISOString(),
      status: 'won',
      dataSource: 'sheet',
    });
  }

  return {
    rows,
    meta: {
      totalSheetRows: rawRows.length,
      usableRows: rows.length,
      skippedNoBroker,
      skippedNoDate,
      columnsMatched: map,
      headers: cols.map((c) => c.label).filter(Boolean),
    },
  };
}

/**
 * Upgrade first-name-only sheet entries to the full names GHL uses.
 *
 * The sheet records brokers as "Ari" or "Jack" while GHL has "Ari Goldman" and
 * "Jack Harper". Left alone, the same person would appear differently depending
 * on which source was live, and headshots (keyed on first name) would still
 * work but the board would read inconsistently.
 *
 * Only unambiguous matches are upgraded — if two GHL users share a first name,
 * the sheet's version is kept rather than guessing which person it means.
 */
/**
 * Normalize a name's casing for display: "JAMES" -> "James", "jack/sean" ->
 * "Jack/Sean". Applied to names we can't upgrade to a full GHL name, because
 * the leaderboard groups by the broker string — without this, "Ari" and "ari"
 * are two people and one rep's deals get split across two rows.
 */
function titleCase(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function upgradeBrokerNames(rows, users, report = () => {}) {
  const byFirst = new Map();

  for (const u of Object.values(users || {})) {
    const first = norm(String(u.name).split(' ')[0]);
    if (!first) continue;
    if (byFirst.has(first)) byFirst.set(first, null); // ambiguous — stop trying
    else byFirst.set(first, u.name);
  }

  let upgraded = 0;
  let recased = 0;
  const ambiguous = new Set();

  const out = rows.map((r) => {
    const key = norm(r.broker);

    // Already a full name that matches a GHL user? Leave it.
    if (String(r.broker).includes(' ')) return r;

    const full = byFirst.get(key);
    if (full) { upgraded++; return { ...r, broker: full }; }
    if (byFirst.has(key)) ambiguous.add(r.broker);

    // Couldn't upgrade — at least make the casing consistent so variants merge.
    const cased = titleCase(r.broker);
    if (cased !== r.broker) recased++;
    return { ...r, broker: cased };
  });

  if (upgraded) report(`Matched ${upgraded} sheet entries to full GHL names`);
  if (recased) report(`Normalized casing on ${recased} unmatched name(s) so variants merge`);
  if (ambiguous.size) {
    report(`Kept short names for ambiguous first names: ${[...ambiguous].join(', ')}`);
  }

  return out;
}
