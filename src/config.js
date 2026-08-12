/**
 * Environment-driven configuration.
 *
 * Two locations are configured independently so each office can have its own
 * Private Integration Token, its own pipeline, and even differently-named
 * custom fields — which is common when two sub-accounts were built separately.
 */

/**
 * Field keys, matched before display names.
 *
 * A key like "opportunity.funded_amount" states its model explicitly, so it
 * can't collide with the identically-named contact field. Keys are also
 * derived from the field name, so they're consistent across both sub-accounts
 * — unlike field IDs, which differ per location.
 *
 * funded_amount, fee, and lenders_funded are confirmed against both offices.
 * business_name is inferred from GHL's naming convention; the display-name
 * fallback below covers it if wrong.
 */
export const FIELD_KEYS = {
  fundedAmount: ['opportunity.funded_amount'],
  commission:   ['opportunity.commission_amount', 'opportunity.commission'],
  fee:          ['opportunity.fee'],
  lender:       ['opportunity.lenders_funded', 'opportunity.lender_s_funded', 'opportunity.lender'],
  businessName: ['opportunity.business_name'],
  fundedDate:   ['opportunity.funded_date'],
};

function splitNames(value, fallback) {
  const list = String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

/**
 * The two PCG offices are baked in. Railway only needs the ID and token for
 * each — names, slugs, and display order are fixed here so there is nothing
 * else to get wrong in the dashboard.
 */
const OFFICES = [
  { slot: 'NY',    key: 'ny',    name: 'New York' },
  { slot: 'MIAMI', key: 'miami', name: 'Miami' },
];

export function loadConfig() {
  const locations = [];

  for (const office of OFFICES) {
    const id = process.env[`${office.slot}_LOCATION_ID`];
    const token = process.env[`${office.slot}_TOKEN`];

    if (!id || !token) continue;

    locations.push({
      ...office,
      id,
      token,
      // Optional: pin an exact pipeline/stage instead of resolving by name.
      pipelineId: process.env[`${office.slot}_PIPELINE_ID`] || null,
      stageId: process.env[`${office.slot}_STAGE_ID`] || null,
      /**
       * Optional exact custom field IDs, e.g. NY_FIELD_ID_FUNDED_AMOUNT.
       * These are per-office because field IDs differ between sub-accounts
       * even when the field names match. Highest priority of all — use when
       * name and key matching both land on the wrong field.
       */
      fieldIds: {
        fundedAmount: process.env[`${office.slot}_FIELD_ID_FUNDED_AMOUNT`] || null,
        commission:   process.env[`${office.slot}_FIELD_ID_COMMISSION`] || null,
        fee:          process.env[`${office.slot}_FIELD_ID_FEE`] || null,
        lender:       process.env[`${office.slot}_FIELD_ID_LENDER`] || null,
        businessName: process.env[`${office.slot}_FIELD_ID_BUSINESS_NAME`] || null,
        fundedDate:   process.env[`${office.slot}_FIELD_ID_FUNDED_DATE`] || null,
      },
    });
  }

  return {
    locations,
    port: Number(process.env.PORT) || 3000,
    tz: process.env.REPORT_TZ || 'America/New_York',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    jwtSecret: process.env.JWT_SECRET || '',
    fundedStageName: process.env.FUNDED_STAGE_NAME || 'Funded',
    cacheTtlMs: (Number(process.env.CACHE_TTL_MINUTES) || 10) * 60 * 1000,
    barMax: Number(process.env.BAR_MAX) || 30000,

    /**
     * Whether the opportunity's Value field holds the commission. True for PCG:
     * the card shows Value = $2,700 against a Funded Amount of $30,000. A
     * dedicated commission custom field, if one exists, always takes priority.
     */
    commissionFromValue: String(process.env.COMMISSION_FROM_VALUE || 'true').toLowerCase() !== 'false',

    /**
     * Candidates for each value, tried in order. Field keys come first because
     * they name their model explicitly ("opportunity.funded_amount"), which
     * avoids binding to a same-named contact field. Display names follow as a
     * fallback. Matching ignores case, spaces, and punctuation.
     */
    fieldNames: {
      fundedAmount: [...FIELD_KEYS.fundedAmount, ...splitNames(process.env.FIELD_FUNDED_AMOUNT, [
        'Funded Amount', 'funded_amount', 'Amount Funded', 'Deal Size',
      ])],
      // PCG records commission in the opportunity's Value field, so this list
      // is only used if a dedicated commission field is added later.
      commission: [...FIELD_KEYS.commission, ...splitNames(process.env.FIELD_COMMISSION, [
        'Commission Amount', 'Commision Amount', 'commission_amount', 'Commission',
      ])],
      fee: [...FIELD_KEYS.fee, ...splitNames(process.env.FIELD_FEE, [
        'Fee', 'FEE', 'fee', 'PSF', 'Fee Amount',
      ])],
      lender: [...FIELD_KEYS.lender, ...splitNames(process.env.FIELD_LENDER, [
        'Lender/s Funded', 'Lenders Funded', 'Lender', 'Lenders', 'Lender/s', 'Funder',
      ])],
      businessName: [...FIELD_KEYS.businessName, ...splitNames(process.env.FIELD_BUSINESS_NAME, [
        'Business name', 'Business Name', 'business_name', 'Company Name', 'DBA',
      ])],
      fundedDate: [...FIELD_KEYS.fundedDate, ...splitNames(process.env.FIELD_FUNDED_DATE, [
        'Funded Date', 'funded_date', 'Date Funded',
      ])],
    },
  };
}

/**
 * Fail fast at boot with an actionable message rather than a 500 later.
 *
 * `errors` block the dashboard — nothing useful can render without them.
 * `warnings` are surfaced but still allow the app to run, so a single
 * configured office isn't held hostage to the second one's credentials.
 */
export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];

  if (cfg.locations.length === 0) {
    errors.push(
      'No offices configured. Set NY_LOCATION_ID + NY_TOKEN and MIAMI_LOCATION_ID + MIAMI_TOKEN in Railway → Variables.'
    );
  } else if (cfg.locations.length === 1) {
    const missing = cfg.locations[0].key === 'ny' ? 'MIAMI' : 'NY';
    warnings.push(
      `Only ${cfg.locations[0].name} is configured. Add ${missing}_LOCATION_ID and ${missing}_TOKEN to enable the joint view.`
    );
  }

  if (!cfg.jwtSecret || cfg.jwtSecret.length < 32) {
    errors.push(
      'JWT_SECRET must be a random string of at least 32 characters. Generate one with: openssl rand -base64 32'
    );
  }

  if (!cfg.adminPassword) {
    errors.push('ADMIN_PASSWORD must be set — commission data is gated behind it.');
  } else if (cfg.adminPassword.length < 8) {
    warnings.push('ADMIN_PASSWORD is short. Use at least 12 characters — this guards commission data.');
  }

  return { errors, warnings };
}
