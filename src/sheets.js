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
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function parseAmount(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
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
    return isNaN(d.getTime()) ? null : d;
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
 * @returns {{ rows: object[], meta: object }}
 */
export async function fetchSheetRows({ sheetId, tab, locationName, report = () => {} }) {
  const url =
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json` +
    (tab ? `&sheet=${encodeURIComponent(tab)}` : '') +
    `&t=${Date.now()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let text;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/);
  if (!match) {
    throw new Error(
      'Sheet did not return data. Share it so anyone with the link can view ' +
      '(File → Share → General access → Anyone with the link → Viewer).'
    );
  }

  const json = JSON.parse(match[1]);
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

    rows.push({
      broker,
      businessName: String(cell(r, map.business) || '—').trim(),
      fundedAmount: parseAmount(cell(r, map.funded)),
      commission: parseAmount(cell(r, map.commission)),
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
export function upgradeBrokerNames(rows, users, report = () => {}) {
  const byFirst = new Map();

  for (const u of Object.values(users || {})) {
    const first = norm(String(u.name).split(' ')[0]);
    if (!first) continue;
    if (byFirst.has(first)) byFirst.set(first, null); // ambiguous — stop trying
    else byFirst.set(first, u.name);
  }

  let upgraded = 0;
  const ambiguous = new Set();

  const out = rows.map((r) => {
    const key = norm(r.broker);
    // Already a full name that matches a GHL user? Leave it.
    if (String(r.broker).includes(' ')) return r;

    const full = byFirst.get(key);
    if (full) { upgraded++; return { ...r, broker: full }; }
    if (byFirst.has(key)) ambiguous.add(r.broker);
    return r;
  });

  if (upgraded) report(`Matched ${upgraded} sheet entries to full GHL names`);
  if (ambiguous.size) {
    report(`Kept short names for ambiguous first names: ${[...ambiguous].join(', ')}`);
  }

  return out;
}
