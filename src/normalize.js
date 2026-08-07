/**
 * Turns raw GHL opportunities into flat leaderboard rows.
 *
 * GHL stores funded amount / commission / lender / fee as custom fields, and
 * custom field IDs differ per sub-account. Rather than hardcode IDs, we match
 * on the field *name* (configurable via env), which survives a field being
 * rebuilt in one location but not the other.
 */

/** Pull a number out of "$12,500.00", "12500", 12500, etc. */
export function parseAmount(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Normalize a field name for fuzzy matching: lowercase, alphanumeric only. */
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build a lookup of normalized custom-field-name -> value for one opportunity.
 * GHL returns customFields as [{ id, fieldValue|value, fieldKey?, name? }].
 * We index by every identifier the payload gives us so name OR key both work.
 */
function customFieldMap(opp) {
  const map = {};
  const fields = opp.customFields || opp.customField || [];

  for (const f of fields) {
    const value =
      f.fieldValue !== undefined ? f.fieldValue :
      f.value !== undefined ? f.value :
      f.fieldValueString !== undefined ? f.fieldValueString :
      '';

    for (const ident of [f.name, f.fieldKey, f.key, f.id]) {
      if (!ident) continue;
      // fieldKey often looks like "opportunity.funded_amount" — index the tail too.
      const tail = String(ident).split('.').pop();
      map[normKey(ident)] = value;
      map[normKey(tail)] = value;
    }
  }

  return map;
}

/** Look up a custom field by any of several candidate names. */
function pick(cfMap, candidates) {
  for (const c of candidates) {
    const v = cfMap[normKey(c)];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

/**
 * Determine the date an opportunity entered the funded stage.
 *
 * Preference order:
 *   1. A custom "Funded Date" field, if the team fills one in.
 *   2. lastStageChangeAt — set by GHL when the opportunity moved stages. Since
 *      we only query the Funded stage, this is the date it landed there.
 *   3. updatedAt, then createdAt, as last resorts.
 */
function resolveFundedDate(opp, cfMap, fieldNames) {
  const custom = pick(cfMap, fieldNames.fundedDate);
  if (custom) {
    const d = new Date(custom);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  for (const key of ['lastStageChangeAt', 'lastStatusChangeAt', 'updatedAt', 'createdAt']) {
    if (opp[key]) {
      const d = new Date(opp[key]);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }

  return null;
}

/**
 * @param {object[]} opportunities raw GHL opportunities
 * @param {object}   users         userId -> { name, email }
 * @param {object}   opts          { locationId, locationName, fieldNames }
 */
export function normalizeOpportunities(opportunities, users, opts) {
  const { locationId, locationName, fieldNames } = opts;
  const rows = [];

  for (const opp of opportunities) {
    const cfMap = customFieldMap(opp);

    const ownerId = opp.assignedTo || opp.assigned_to || opp.userId || null;
    const owner = ownerId && users[ownerId] ? users[ownerId] : null;

    // Business name: prefer the contact's company, fall back to opportunity name.
    const contact = opp.contact || {};
    const businessName =
      contact.companyName ||
      contact.company ||
      pick(cfMap, fieldNames.businessName) ||
      opp.name ||
      contact.name ||
      '—';

    rows.push({
      id: opp.id,
      locationId,
      locationName,
      broker: owner ? owner.name : 'Unassigned',
      brokerId: ownerId || null,
      businessName: String(businessName).trim(),
      fundedAmount: parseAmount(pick(cfMap, fieldNames.fundedAmount) || opp.monetaryValue),
      commission: parseAmount(pick(cfMap, fieldNames.commission)),
      fee: parseAmount(pick(cfMap, fieldNames.fee)),
      lender: String(pick(cfMap, fieldNames.lender) || '—').trim(),
      fundedDate: resolveFundedDate(opp, cfMap, fieldNames),
      status: opp.status || '',
    });
  }

  return rows;
}

/**
 * Aggregate flat rows into per-broker leaderboard entries.
 * commission/fee/total are omitted entirely when includeCommission is false —
 * they are never sent to a non-admin client, not merely hidden in the UI.
 */
export function aggregateByBroker(rows, { includeCommission }) {
  const map = new Map();

  for (const r of rows) {
    if (!map.has(r.broker)) {
      map.set(r.broker, {
        broker: r.broker,
        brokerId: r.brokerId,
        deals: 0,
        fundedAmount: 0,
        commission: 0,
        fee: 0,
        locations: new Set(),
        lenders: new Set(),
      });
    }

    const b = map.get(r.broker);
    b.deals += 1;
    b.fundedAmount += r.fundedAmount;
    b.commission += r.commission;
    b.fee += r.fee;
    b.locations.add(r.locationName);
    if (r.lender && r.lender !== '—') b.lenders.add(r.lender);
  }

  const out = [...map.values()].map((b) => {
    const base = {
      broker: b.broker,
      brokerId: b.brokerId,
      deals: b.deals,
      fundedAmount: Math.round(b.fundedAmount),
      locations: [...b.locations],
      lenderCount: b.lenders.size,
    };

    if (includeCommission) {
      base.commission = Math.round(b.commission);
      base.fee = Math.round(b.fee);
      base.total = Math.round(b.commission + b.fee);
    }

    return base;
  });

  // Admins rank by total revenue; everyone else ranks by funded volume.
  out.sort((a, b) =>
    includeCommission
      ? b.total - a.total || b.fundedAmount - a.fundedAmount
      : b.fundedAmount - a.fundedAmount || b.deals - a.deals
  );

  return out;
}

/** Roll rows up into the headline stat cards. */
export function buildTotals(rows, { includeCommission }) {
  const totals = {
    deals: rows.length,
    fundedAmount: Math.round(rows.reduce((s, r) => s + r.fundedAmount, 0)),
    brokers: new Set(rows.map((r) => r.broker)).size,
  };

  if (includeCommission) {
    totals.commission = Math.round(rows.reduce((s, r) => s + r.commission, 0));
    totals.fee = Math.round(rows.reduce((s, r) => s + r.fee, 0));
    totals.total = totals.commission + totals.fee;
  }

  return totals;
}
