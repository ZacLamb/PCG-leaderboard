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
 * Pull the value out of one custom field entry.
 *
 * GHL returns typed value properties rather than a single `value` key, and
 * which one is populated depends on the field's type. Text fields commonly
 * arrive as fieldValueString while NUMERICAL fields use a numeric property —
 * so checking only the string-ish keys silently zeroes every money field while
 * text fields like Lender resolve fine.
 *
 * Ordered by specificity, then a catch-all scan for any fieldValue* property
 * so a type we haven't seen still resolves.
 */
const VALUE_KEYS = [
  'fieldValue',
  'fieldValueString',
  'fieldValueNumber',
  'fieldValueNumerical',
  'numerical',
  'fieldValueDate',
  'fieldValueArray',
  'selectedOptions',
  'value',
  'text',
  'date',
];

function extractFieldValue(f) {
  const usable = (v) => {
    if (v === undefined || v === null || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    return typeof v !== 'object'; // skip nested objects, no sensible scalar
  };
  const flatten = (v) => (Array.isArray(v) ? v.filter(Boolean).join(', ') : v);

  for (const k of VALUE_KEYS) {
    if (usable(f[k])) return flatten(f[k]);
  }

  // Catch-all: any other fieldValue* property this payload happens to carry.
  for (const [k, v] of Object.entries(f)) {
    if (!/^fieldValue/i.test(k)) continue;
    if (usable(v)) return flatten(v);
  }

  return '';
}

/**
 * Build a lookup of normalized custom-field-name -> value for one opportunity.
 *
 * GHL v2 returns opportunity custom fields as { id, <typed value> } with no
 * name, so `fieldDefs` (fieldId -> { name, fieldKey }) is what makes them
 * readable. Anything the payload does carry inline is indexed too.
 */
function customFieldMap(opp, fieldDefs = {}) {
  const map = {};
  const fields = opp.customFields || opp.customField || [];

  for (const f of fields) {
    const value = extractFieldValue(f);
    if (value === '' || value === null || value === undefined) continue;

    const def = f.id ? fieldDefs[f.id] : null;

    const identifiers = [
      def?.name,        // resolved via the definitions map — the usual path
      def?.fieldKey,
      f.name,           // inline, if GHL ever provides it
      f.fieldKey,
      f.key,
      f.id,
    ];

    for (const ident of identifiers) {
      if (!ident) continue;
      // fieldKey looks like "opportunity.funded_amount" — index the tail too.
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
 * Same as pick(), but reports which candidate actually matched.
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
 * Read a value by exact custom field ID. Highest priority — an ID names one
 * specific field on one specific sub-account, so it cannot collide with a
 * same-named field on another model.
 */
function pickById(opp, fieldId) {
  if (!fieldId) return { value: '', source: null };
  const fields = opp.customFields || opp.customField || [];
  for (const f of fields) {
    if (f.id !== fieldId) continue;
    const v = extractFieldValue(f);
    if (v !== '' && v !== null && v !== undefined) {
      return { value: v, source: `field id ${fieldId}` };
    }
  }
  return { value: '', source: null };
}

/** Try an exact field ID first, then fall back to key/name candidates. */
function resolveField(opp, cfMap, fieldId, candidates) {
  const byId = pickById(opp, fieldId);
  if (byId.source) return byId;
  return pickWithSource(cfMap, candidates);
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
function resolveFundedDate(opp, cfMap, fieldNames, fieldIds = {}) {
  const custom = resolveField(opp, cfMap, fieldIds.fundedDate, fieldNames.fundedDate).value;
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
 * @param {object}   opts          { locationId, locationName, fieldNames, fieldDefs, commissionFromValue }
 */
export function normalizeOpportunities(opportunities, users, opts) {
  const {
    locationId,
    locationName,
    fieldNames,
    fieldDefs = {},
    fieldIds = {},
    commissionFromValue = true,
  } = opts;
  const rows = [];

  for (const opp of opportunities) {
    const cfMap = customFieldMap(opp, fieldDefs);

    const ownerId = opp.assignedTo || opp.assigned_to || opp.userId || null;
    const owner = ownerId && users[ownerId] ? users[ownerId] : null;

    /**
     * Business name is its own opportunity custom field here, which is more
     * reliable than the contact's company — the contact record is often just
     * the signer's personal details.
     */
    const contact = opp.contact || {};
    const businessName =
      resolveField(opp, cfMap, fieldIds.businessName, fieldNames.businessName).value ||
      contact.companyName ||
      contact.company ||
      opp.name ||
      contact.name ||
      '—';

    /**
     * Funded amount is the deal size and lives ONLY in the "Funded Amount"
     * custom field. The opportunity's Value field is the commission, so it is
     * never substituted here — doing so would report commission as funded
     * volume, off by roughly an order of magnitude.
     */
    const fundedPick = resolveField(opp, cfMap, fieldIds.fundedAmount, fieldNames.fundedAmount);
    const fundedAmount = parseAmount(fundedPick.value);

    /**
     * Commission is the opportunity's Value field. If a dedicated commission
     * custom field exists it wins, so this keeps working if one is added later.
     */
    const commissionPick = resolveField(opp, cfMap, fieldIds.commission, fieldNames.commission);
    let commission = parseAmount(commissionPick.value);
    let commissionSource = commissionPick.source;

    if (!commissionSource && commissionFromValue && opp.monetaryValue) {
      commission = parseAmount(opp.monetaryValue);
      commissionSource = 'opportunity Value field';
    }

    const feePick = resolveField(opp, cfMap, fieldIds.fee, fieldNames.fee);

    /**
     * Lead source. GHL opportunities carry a native `source` property, and some
     * accounts also keep one as a custom field — check the native value first,
     * then fall back, so either setup resolves.
     */
    const sourcePick = resolveField(opp, cfMap, fieldIds.source, fieldNames.source);
    const source = String(opp.source || sourcePick.value || '').trim() || '—';

    rows.push({
      id: opp.id,
      locationId,
      locationName,
      broker: owner ? owner.name : 'Unassigned',
      brokerId: ownerId || null,
      businessName: String(businessName).trim(),
      fundedAmount,
      commission,
      fee: parseAmount(feePick.value),
      lender: String(resolveField(opp, cfMap, fieldIds.lender, fieldNames.lender).value || '—').trim(),
      source,
      fundedDate: resolveFundedDate(opp, cfMap, fieldNames, fieldIds),
      status: opp.status || '',
      monetaryValue: parseAmount(opp.monetaryValue),
      // Where each money figure came from. Consumed by /api/diagnostics only;
      // the client payload is built from an explicit allowlist.
      _sources: {
        fundedAmount: fundedPick.source,
        commission: commissionSource,
        fee: feePick.source,
        leadSource: opp.source ? 'native opportunity.source' : sourcePick.source,
      },
      // Every custom field name this opportunity carries, resolved through the
      // definitions map — so diagnostics can show the real names.
      // Raw entries for the first few fields, so diagnostics can show the
      // exact payload shape rather than us inferring it.
      _rawCustomFields: (opp.customFields || []).slice(0, 6),
      _availableFields: (opp.customFields || [])
        .map((f) => (f.id && fieldDefs[f.id]?.name) || f.name || f.fieldKey || f.id)
        .filter(Boolean),
    });
  }

  return rows;
}

/**
 * Aggregate flat rows into per-broker leaderboard entries.
 * commission/fee/total are omitted entirely when includeCommission is false —
 * they are never sent to a non-admin client, not merely hidden in the UI.
 */
/**
 * Aggregate flat rows into per-broker leaderboard entries.
 *
 * Fee is visible to everyone; commission is admin-only. The combined total is
 * gated with commission, not with fee — publishing total alongside fee would
 * let anyone compute commission by subtraction, which would defeat the gate.
 * Gated values are omitted from the object entirely rather than hidden in the
 * UI, so there is nothing to recover from the network response.
 */
export function aggregateByBroker(rows, { includeCommission, includeFee = true }) {
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

    if (includeFee) base.fee = Math.round(b.fee);

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
export function buildTotals(rows, { includeCommission, includeFee = true }) {
  const totals = {
    deals: rows.length,
    fundedAmount: Math.round(rows.reduce((s, r) => s + r.fundedAmount, 0)),
    brokers: new Set(rows.map((r) => r.broker)).size,
  };

  if (includeFee) {
    totals.fee = Math.round(rows.reduce((s, r) => s + r.fee, 0));
  }

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
    return { total: 0, fundedResolved: 0, fundedMissing: 0,
             commissionFromField: 0, commissionFromValue: 0, commissionMissing: 0,
             feeResolved: 0, availableFields: [], resolvedVia: {} };
  }

  const fieldSet = new Set();
  const resolvedVia = { fundedAmount: new Set(), commission: new Set(), fee: new Set() };

  let fundedResolved = 0, fundedMissing = 0;
  let commissionFromField = 0, commissionFromValue = 0, commissionMissing = 0;
  let feeResolved = 0;

  for (const r of rows) {
    const s = r._sources || {};
    (r._availableFields || []).forEach((f) => fieldSet.add(f));

    if (!s.fundedAmount) fundedMissing++;
    else { fundedResolved++; resolvedVia.fundedAmount.add(s.fundedAmount); }

    if (!s.commission) commissionMissing++;
    else if (s.commission === 'opportunity Value field') commissionFromValue++;
    else { commissionFromField++; resolvedVia.commission.add(s.commission); }

    if (s.fee) { feeResolved++; resolvedVia.fee.add(s.fee); }
  }

  return {
    total: rows.length,
    fundedResolved, fundedMissing,
    commissionFromField, commissionFromValue, commissionMissing,
    feeResolved,
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
  const { _sources, _availableFields, _rawCustomFields, ...clean } = row;
  return clean;
}

/**
 * Funded volume and deal count grouped by lead source, biggest first.
 * Commission and fee are only included when the caller is allowed to see them.
 */
export function summarizeBySource(rows, { includeCommission, includeFee = true }) {
  const map = new Map();

  for (const r of rows) {
    const key = r.source && r.source !== '—' ? r.source : 'Unattributed';
    if (!map.has(key)) {
      map.set(key, { source: key, deals: 0, fundedAmount: 0, commission: 0, fee: 0 });
    }
    const s = map.get(key);
    s.deals += 1;
    s.fundedAmount += r.fundedAmount;
    s.commission += r.commission;
    s.fee += r.fee;
  }

  return [...map.values()]
    .map((s) => {
      const base = {
        source: s.source,
        deals: s.deals,
        fundedAmount: Math.round(s.fundedAmount),
      };
      if (includeFee) base.fee = Math.round(s.fee);
      if (includeCommission) {
        base.commission = Math.round(s.commission);
        base.total = Math.round(s.commission + s.fee);
      }
      return base;
    })
    .sort((a, b) => b.fundedAmount - a.fundedAmount || b.deals - a.deals);
}
