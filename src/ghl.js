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
    all.push(...batch);

    if (batch.length < limit) break;
    page += 1;
  }

  return all;
}

/**
 * Custom field definitions for a location.
 *
 * This is required, not optional: opportunity payloads return custom fields as
 * { id, fieldValue } with no name attached, so without this map there is no way
 * to tell "Funded Amount" from "Turnover". Returns fieldId -> { name, fieldKey }.
 */
export async function fetchCustomFieldDefs({ token, locationId }) {
  const map = {};

  // Opportunity-model fields are what we need, but the param is inconsistent
  // across GHL versions — ask for all and filter locally.
  let data;
  try {
    data = await ghlFetch(`/locations/${locationId}/customFields`, {
      token,
      locationId,
      params: { model: 'opportunity' },
    });
  } catch {
    // Some accounts reject the model filter; retry unfiltered.
    data = await ghlFetch(`/locations/${locationId}/customFields`, {
      token,
      locationId,
    });
  }

  const fields = data.customFields || data.customField || [];
  for (const f of fields) {
    if (!f.id) continue;
    map[f.id] = {
      name: f.name || f.fieldKey || f.key || '',
      fieldKey: f.fieldKey || f.key || '',
      model: f.model || f.objectType || '',
    };
  }

  return map;
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
