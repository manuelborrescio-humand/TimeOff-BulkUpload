import { callWithRetry } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co/api/v1";
const PAGE_SIZE = 100;
const HUMAND_BASE = "https://api-prod.humand.co";

async function fetchInstanceId(config) {
  const headers = { Authorization: `Basic ${config.apiKey}`, "Content-Type": "application/json" };
  try {
    const resp = await fetch(`${HUMAND_BASE}/public/api/v1/users/me`, { headers });
    if (resp.ok) { const d = await resp.json(); if (d.instanceId) return d.instanceId; }
  } catch {}
  try {
    const resp = await fetch(`${HUMAND_BASE}/public/api/v1/time-off/balances?limit=1`, { headers });
    if (resp.ok) { const d = await resp.json(); return d.items?.[0]?.user?.instanceId || null; }
  } catch {}
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;

  const result = await callWithRetry(clientSlug, async (config) => {
    const instanceId = config.instanceId || await fetchInstanceId(config);
    if (!instanceId) {
      return { ok: false, status: 400, error: "No se pudo obtener instanceId del cliente" };
    }

    const allItems = [];
    const seenIds = new Set(); // safety net: detectar si la API devuelve repetidos
    let page = 1; // Humand /vacations/requests usa ?page=N (1-indexed). NO usa ?offset=
    let hasMore = true;
    const MAX_PAGES = 50; // 50 × 100 = 5000 solicitudes max — margen amplio

    while (hasMore) {
      const params = new URLSearchParams({
        limit: PAGE_SIZE,
        page,
        instanceId,
        role: "MANAGER",   // único valor válido para ver solicitudes de otros usuarios
      });

      const resp = await fetch(`${API_BASE}/vacations/requests?${params}`, {
        headers: {
          Authorization: `Bearer ${config.jwtToken}`,
          "Content-Type": "application/json",
          Origin: "https://app.humand.co",
          "x-humand-origin": "web",
        },
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        const humandMsg = data.message || data.code || data.error || JSON.stringify(data);
        if (resp.status === 401 || resp.status === 403) {
          return { tokenExpired: true, status: resp.status, data };
        }
        return { ok: false, status: resp.status, error: `Error ${resp.status}: ${humandMsg}`, humandError: data };
      }

      const data = await resp.json();
      const items = Array.isArray(data) ? data : (data.items || data.content || data.data || []);
      const total = data.total ?? data.totalElements ?? null;

      // Safety net: si la API ignora el param de paginación (como pasaba antes
      // con `offset`) y devuelve siempre la misma página, lo detectamos por IDs
      // ya vistos y abortamos. Esto previene la inflación 20x del bug anterior.
      const newItems = items.filter((it) => {
        if (seenIds.has(it.id)) return false;
        seenIds.add(it.id);
        return true;
      });
      if (items.length > 0 && newItems.length === 0) {
        // La página devolvió solo items ya vistos → la paginación está rota,
        // no tiene sentido seguir.
        hasMore = false;
        break;
      }
      allItems.push(...newItems);

      if (items.length < PAGE_SIZE || (total !== null && allItems.length >= total) || Array.isArray(data)) {
        hasMore = false;
      } else {
        page++;
      }

      if (page > MAX_PAGES) hasMore = false;
    }

    return { ok: true, items: allItems, total: allItems.length };
  });

  if (result.error) {
    return res.status(result.status || 502).json({ error: result.error, humandError: result.humandError });
  }

  res.status(200).json({ items: result.items, total: result.total });
}
