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
 * Same as pick(), but reports which candidate name actually matched.
 * Provenance matters for the money fields: if "Funded Amount" doesn't resolve
 * and we quietly substitute something else, every number on the board is wrong
 * in a way nobody can see. Returning the source lets diagnostics show it.
 */
function pickWithSource(cfMap, candidates) {
  for (const c of candidates) {
    const v = cfMap[normKey(c)];
    if (v !== undefined && v !== '') return { value: v, source: c };
  }
  return { value: '', source: null };
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
 * @param {object}   opts          { locationId, locationName, fieldNames, useOpportunityValue }
 */
export function normalizeOpportunities(opportunities, users, opts) {
  const { locationId, locationName, fieldNames, useOpportunityValue = true } = opts;
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

    /**
     * Funded amount is the deal size. It resolves from a "Funded Amount"
     * custom field if one exists, otherwise from the opportunity's own value
     * field — which is where PCG records it on the opportunity card.
     *
     * The source is recorded either way so /api/diagnostics can show which one
     * a given deal used, and so a deal with neither reads as $0 rather than
     * silently borrowing a number from somewhere else.
     */
    const fundedPick = pickWithSource(cfMap, fieldNames.fundedAmount);
    let fundedAmount = parseAmount(fundedPick.value);
    let fundedSource = fundedPick.source;

    if (!fundedSource && useOpportunityValue && opp.monetaryValue) {
      fundedAmount = parseAmount(opp.monetaryValue);
      fundedSource = 'opportunity value';
    }

    const commissionPick = pickWithSource(cfMap, fieldNames.commission);
    const feePick = pickWithSource(cfMap, fieldNames.fee);

    rows.push({
      id: opp.id,
      locationId,
      locationName,
      broker: owner ? owner.name : 'Unassigned',
      brokerId: ownerId || null,
      businessName: String(businessName).trim(),
      fundedAmount,
      commission: parseAmount(commissionPick.value),
      fee: parseAmount(feePick.value),
      lender: String(pick(cfMap, fieldNames.lender) || '—').trim(),
      fundedDate: resolveFundedDate(opp, cfMap, fieldNames),
      status: opp.status || '',
      monetaryValue: parseAmount(opp.monetaryValue),
      // Where each money figure came from. Consumed by /api/diagnostics only;
      // stripped before anything reaches the dashboard.
      _sources: {
        fundedAmount: fundedSource,
        commission: commissionPick.source,
        fee: feePick.source,
      },
      // Every custom field name this opportunity actually carries, so
      // diagnostics can show the real names when a mapping misses.
      _availableFields: (opp.customFields || []).map(
        (f) => f.name || f.fieldKey || f.key || f.id
      ).filter(Boolean),
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

/**
 * Summarize how well the custom field mapping resolved.
 *
 * The failure mode this guards against is silent and total: if "Funded Amount"
 * never matches, every figure on the board is wrong but the page looks fine.
 * This turns that into something the dashboard can say out loud.
 */
export function fieldHealth(rows) {
  if (!rows.length) {
    return { total: 0, fundedFromField: 0, fundedFromOppValue: 0, fundedMissing: 0,
             commissionResolved: 0, feeResolved: 0, availableFields: [], resolvedVia: {} };
  }

  const fieldSet = new Set();
  const resolvedVia = { fundedAmount: new Set(), commission: new Set(), fee: new Set() };

  let fundedFromField = 0, fundedFromOppValue = 0, fundedMissing = 0;
  let commissionResolved = 0, feeResolved = 0;

  for (const r of rows) {
    const s = r._sources || {};
    (r._availableFields || []).forEach((f) => fieldSet.add(f));

    if (!s.fundedAmount) fundedMissing++;
    else if (s.fundedAmount === 'opportunity value') fundedFromOppValue++;
    else { fundedFromField++; resolvedVia.fundedAmount.add(s.fundedAmount); }

    if (s.commission) { commissionResolved++; resolvedVia.commission.add(s.commission); }
    if (s.fee) { feeResolved++; resolvedVia.fee.add(s.fee); }
  }

  return {
    total: rows.length,
    fundedFromField, fundedFromOppValue, fundedMissing,
    commissionResolved, feeResolved,
    availableFields: [...fieldSet].sort(),
    resolvedVia: {
      fundedAmount: [...resolvedVia.fundedAmount],
      commission: [...resolvedVia.commission],
      fee: [...resolvedVia.fee],
    },
  };
}

/** Remove internal diagnostic keys before sending rows anywhere user-facing. */
export function stripInternals(row) {
  const { _sources, _availableFields, ...clean } = row;
  return clean;
}
