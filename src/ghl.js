/**
 * GoHighLevel API v2 client.
 *
 * Auth: Private Integration Token (PIT) per location.
 * Create one per sub-account: Settings > Private Integrations > Create.
 * Required scopes: opportunities.readonly, users.readonly, locations.readonly
 *
 * Rate limit: 100 requests / 10 seconds per location. We throttle below that
 * and cache aggressively, because a leaderboard refresh can otherwise fan out
 * into hundreds of paginated calls.
 */

const API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

/**
 * Where this module reports problems. The server swaps in a sink that also
 * writes to the HTTP-readable log buffer, so a failing GHL call is visible
 * without shell access to the container.
 */
let report = (msg) => console.log(msg);
export function setLogger(fn) { report = fn; }

/** Simple token-bucket throttle: max N requests per window, per key. */
class Throttle {
  constructor(maxRequests = 80, windowMs = 10_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> number[] (timestamps)
  }

  async take(key) {
    const now = Date.now();
    const times = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);

    if (times.length >= this.maxRequests) {
      const waitMs = this.windowMs - (now - times[0]) + 50;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.take(key);
    }

    times.push(now);
    this.hits.set(key, times);
  }
}

const throttle = new Throttle();

/** Fetch with throttling, timeout, and exponential backoff on 429/5xx. */
async function ghlFetch(path, { token, locationId, params = {}, retries = 3 } = {}) {
  await throttle.take(locationId);

  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: API_VERSION,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (res.status === 429 || res.status >= 500) {
      if (retries > 0) {
        const backoff = (4 - retries) ** 2 * 500 + 500;
        await new Promise((r) => setTimeout(r, backoff));
        return ghlFetch(path, { token, locationId, params, retries: retries - 1 });
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Surface the real reason in Railway logs — a 401 (bad token) and a 422
      // (bad params) need completely different fixes, and a silent throw makes
      // them indistinguishable.
      report(`[GHL] ${res.status} ${path} — ${body.slice(0, 300)}`);
      const err = new Error(`GHL ${res.status} on ${path}: ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch every opportunity in a location, following pagination.
 * The v2 search endpoint returns { opportunities: [], meta: { nextPageUrl, ... } }.
 */
export async function fetchOpportunities({ token, locationId, pipelineId, stageId }) {
  const all = [];
  let page = 1;
  const limit = 100;
  const MAX_PAGES = 200; // hard stop; 20k opportunities

  while (page <= MAX_PAGES) {
    const data = await ghlFetch('/opportunities/search', {
      token,
      locationId,
      params: {
        location_id: locationId,
        limit,
        page,
        ...(pipelineId ? { pipeline_id: pipelineId } : {}),
        ...(stageId ? { pipeline_stage_id: stageId } : {}),
      },
    });

    const batch = data.opportunities || [];

    // One-time shape check: if the response doesn't have an `opportunities`
    // array, the query succeeded but we're reading the wrong key — worth
    // saying out loud rather than silently returning zero deals.
    if (page === 1 && !Array.isArray(data.opportunities)) {
      report(
        `[GHL] /opportunities/search returned no "opportunities" array. ` +
        `Top-level keys: ${Object.keys(data).join(', ')}`
      );
    }

    all.push(...batch);

    if (batch.length < limit) break;
    page += 1;
  }

  return all;
}

/**
 * Custom field definitions for a location, restricted to opportunity fields.
 *
 * Two things make this necessary:
 *
 * 1. Opportunity payloads return custom fields as { id, fieldValue } with no
 *    name, so without this map there is no way to tell "Funded Amount" from
 *    "Turnover".
 * 2. The same display name often exists on BOTH models — PCG has a "Funded
 *    Amount" on contact (contact.funded_amount) and another on opportunity
 *    (opportunity.funded_amount). Matching on display name alone could bind to
 *    the contact field and silently read the wrong number, so anything that
 *    isn't an opportunity field is dropped here.
 *
 * Returns fieldId -> { name, fieldKey, model }.
 */
export async function fetchCustomFieldDefs({ token, locationId }) {
  let data;
  try {
    data = await ghlFetch(`/locations/${locationId}/customFields`, {
      token,
      locationId,
      params: { model: 'opportunity' },
    });
  } catch {
    // Some accounts reject the model filter; retry unfiltered and filter below.
    data = await ghlFetch(`/locations/${locationId}/customFields`, {
      token,
      locationId,
    });
  }

  const fields = data.customFields || data.customField || [];

  if (!Array.isArray(data.customFields) && !Array.isArray(data.customField)) {
    report(
      `[GHL] /locations/${locationId}/customFields returned no field array. ` +
      `Top-level keys: ${Object.keys(data).join(', ')}`
    );
  } else {
    // Model breakdown as GHL reported it — this is the fastest way to see
    // whether opportunity fields are coming back at all.
    const byModel = fields.reduce((a, f) => {
      const m = f.model || f.objectType ||
        (String(f.fieldKey || '').split('.')[0] || 'unknown');
      a[m] = (a[m] || 0) + 1;
      return a;
    }, {});
    report(`[GHL] customFields for ${locationId}: ${fields.length} total ${JSON.stringify(byModel)}`);
  }

  const map = {};
  let skippedNonOpportunity = 0;
  let keptUnknownModel = 0;

  for (const f of fields) {
    if (!f.id) continue;

    const fieldKey = f.fieldKey || f.key || '';
    const model = f.model || f.objectType || '';

    /**
     * Decide the model from whichever signal exists. If neither the model nor
     * a prefixed fieldKey is present, KEEP the field rather than dropping it —
     * excluding everything on missing metadata would empty the map and make
     * every value read as zero, which is a far worse failure than tolerating
     * an occasional contact field (fieldKey matching still disambiguates).
     */
    let isOpportunity;
    if (model) {
      isOpportunity = String(model).toLowerCase() === 'opportunity';
    } else if (fieldKey.includes('.')) {
      isOpportunity = fieldKey.startsWith('opportunity.');
    } else {
      isOpportunity = true;
      keptUnknownModel++;
    }

    if (!isOpportunity) {
      skippedNonOpportunity++;
      continue;
    }

    map[f.id] = {
      name: f.name || fieldKey,
      fieldKey,
      model: model || (fieldKey.startsWith('opportunity.') ? 'opportunity' : 'unknown'),
    };
  }

  // Non-enumerable so it never shows up in JSON responses.
  Object.defineProperty(map, '__meta', {
    value: {
      total: fields.length,
      kept: Object.keys(map).length,
      skippedNonOpportunity,
      keptUnknownModel,
    },
    enumerable: false,
  });

  return map;
}

/** Fetch one opportunity in full. The search endpoint omits custom fields. */
export async function fetchOpportunityDetail({ token, locationId, opportunityId }) {
  const data = await ghlFetch(`/opportunities/${opportunityId}`, { token, locationId });
  return data.opportunity || data;
}

/**
 * Fill in custom fields that the search endpoint didn't return.
 *
 * GHL's opportunity search returns a lean object — custom fields are commonly
 * absent even when the opportunity has values set. Without this, every custom
 * field reads empty and the board shows $0 across the board.
 *
 * We check the search results first and skip all of this if they already
 * carry custom fields, so we don't spend hundreds of calls for nothing.
 */
export async function enrichWithCustomFields({ token, locationId, opportunities, concurrency = 6 }) {
  if (!opportunities.length) return { opportunities, enriched: false };

  const alreadyHasFields = opportunities.some(
    (o) => Array.isArray(o.customFields) && o.customFields.length > 0
  );
  if (alreadyHasFields) return { opportunities, enriched: false };

  const out = new Array(opportunities.length);
  let cursor = 0;
  let failures = 0;

  async function worker() {
    while (cursor < opportunities.length) {
      const i = cursor++;
      const opp = opportunities[i];
      try {
        const full = await fetchOpportunityDetail({
          token,
          locationId,
          opportunityId: opp.id,
        });
        // Keep the search fields (they include contact and stage data) and
        // layer the detail response's custom fields on top.
        out[i] = { ...opp, ...full, customFields: full.customFields || opp.customFields || [] };
      } catch {
        failures++;
        out[i] = opp; // Degrade to the lean record rather than losing the deal.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, opportunities.length) }, worker));

  return { opportunities: out, enriched: true, failures };
}

/** Map of userId -> display name, for resolving the opportunity owner (broker). */
export async function fetchUsers({ token, locationId }) {
  const data = await ghlFetch('/users/', {
    token,
    locationId,
    params: { locationId },
  });

  const map = {};
  for (const u of data.users || []) {
    const name =
      u.name ||
      [u.firstName, u.lastName].filter(Boolean).join(' ') ||
      u.email ||
      'Unknown';
    map[u.id] = { name, email: u.email || '' };
  }
  return map;
}

/** Pipelines + stages, used to resolve the "Funded" stage id by name. */
export async function fetchPipelines({ token, locationId }) {
  const data = await ghlFetch('/opportunities/pipelines', {
    token,
    locationId,
    params: { locationId },
  });
  return data.pipelines || [];
}

/**
 * Resolve the pipeline + stage whose name matches FUNDED_STAGE_NAME.
 * Returns { pipelineId, stageId } or nulls if not found.
 */
export async function resolveFundedStage({ token, locationId, stageName }) {
  const pipelines = await fetchPipelines({ token, locationId });
  const wanted = String(stageName || 'funded').toLowerCase().trim();

  for (const p of pipelines) {
    for (const s of p.stages || []) {
      if (String(s.name || '').toLowerCase().trim() === wanted) {
        return { pipelineId: p.id, stageId: s.id, pipelineName: p.name, stageName: s.name };
      }
    }
  }

  // Fall back to a fuzzy contains-match before giving up.
  for (const p of pipelines) {
    for (const s of p.stages || []) {
      if (String(s.name || '').toLowerCase().includes(wanted)) {
        return { pipelineId: p.id, stageId: s.id, pipelineName: p.name, stageName: s.name };
      }
    }
  }

  return { pipelineId: null, stageId: null, pipelineName: null, stageName: null };
}

export { ghlFetch };
