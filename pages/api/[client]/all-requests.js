import { callWithRetry } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co";
const PAGE_SIZE = 100;

/**
 * Fetches instanceId from the balances endpoint if not cached in config.
 * Returns null if it can't be obtained.
 */
async function fetchInstanceId(config) {
  try {
    const resp = await fetch(`${API_BASE}/public/api/v1/time-off/balances?limit=1`, {
      headers: {
        Authorization: `Basic ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.items?.[0]?.user?.instanceId || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;

  const result = await callWithRetry(clientSlug, async (config) => {
    // Resolve instanceId: from config cache or from balances endpoint
    const instanceId = config.instanceId || await fetchInstanceId(config);

    const allItems = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const paramObj = {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      };

      // Include instanceId if we have it (required by Humand for listing all requests)
      if (instanceId) paramObj.instanceId = instanceId;

      const params = new URLSearchParams(paramObj);

      const resp = await fetch(`${API_BASE}/api/v1/vacations/requests?${params}`, {
        headers: {
          Authorization: `Bearer ${config.jwtToken}`,
          "Content-Type": "application/json",
          Origin: "https://app.humand.co",
          "x-humand-origin": "web",
        },
      });

      if (!resp.ok) {
        // Try to get the real Humand error message for debugging
        const data = await resp.json().catch(() => ({}));
        const humandMsg = data.message || data.code || data.error || JSON.stringify(data);

        if (resp.status === 401 || resp.status === 403) {
          return { tokenExpired: true, status: resp.status, data };
        }
        return {
          ok: false,
          status: resp.status,
          error: `Error ${resp.status} de Humand: ${humandMsg}`,
          humandError: data,
          instanceIdUsed: instanceId || "(ninguno)",
        };
      }

      const data = await resp.json();
      const items = Array.isArray(data) ? data : (data.items || data.content || data.data || []);
      const total = data.total ?? data.totalElements ?? null;

      allItems.push(...items);

      // Stop if: fewer items than pageSize, or reached total, or direct array (no pagination)
      if (
        items.length < PAGE_SIZE ||
        (total !== null && allItems.length >= total) ||
        Array.isArray(data)
      ) {
        hasMore = false;
      } else {
        page++;
      }

      // Safety cap: max 20 pages (2000 requests)
      if (page >= 20) hasMore = false;
    }

    return { ok: true, items: allItems, total: allItems.length };
  });

  if (result.error) {
    return res.status(result.status || 502).json({
      error: result.error,
      humandError: result.humandError,
      instanceIdUsed: result.instanceIdUsed,
    });
  }

  res.status(200).json({ items: result.items, total: result.total });
}
