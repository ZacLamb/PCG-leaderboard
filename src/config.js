/**
 * Environment-driven configuration.
 *
 * Two locations are configured independently so each office can have its own
 * Private Integration Token, its own pipeline, and even differently-named
 * custom fields — which is common when two sub-accounts were built separately.
 */

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
     * Whether the opportunity's own value field counts as the funded amount
     * when no "Funded Amount" custom field is present. True for PCG — that is
     * where funded amount lives on the opportunity card. Set
     * USE_OPPORTUNITY_VALUE=false to require a custom field instead.
     */
    useOpportunityValue: String(process.env.USE_OPPORTUNITY_VALUE || 'true').toLowerCase() !== 'false',

    /**
     * Custom field names to look for, in priority order. Matching is
     * case/space/punctuation-insensitive, so "Funded Amount", "funded_amount",
     * and "FundedAmount" all resolve to the same field.
     */
    fieldNames: {
      fundedAmount: splitNames(process.env.FIELD_FUNDED_AMOUNT, [
        'Funded Amount', 'funded_amount', 'Amount Funded', 'Deal Size',
      ]),
      commission: splitNames(process.env.FIELD_COMMISSION, [
        'Commission Amount', 'Commision Amount', 'commission_amount', 'Commission',
      ]),
      fee: splitNames(process.env.FIELD_FEE, [
        'Fee', 'FEE', 'fee', 'PSF', 'Fee Amount',
      ]),
      lender: splitNames(process.env.FIELD_LENDER, [
        'Lender', 'lender', 'Lenders', 'Lender/s', 'Funder',
      ]),
      businessName: splitNames(process.env.FIELD_BUSINESS_NAME, [
        'Business Name', 'business_name', 'Company Name', 'DBA',
      ]),
      fundedDate: splitNames(process.env.FIELD_FUNDED_DATE, [
        'Funded Date', 'funded_date', 'Date Funded',
      ]),
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
