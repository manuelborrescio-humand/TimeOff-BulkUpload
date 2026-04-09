import { callWithRetry } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co";
const PAGE_SIZE = 100;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;

  const result = await callWithRetry(clientSlug, async (config) => {
    // instanceId is required by Humand API — fetch it if not cached in config
    let instanceId = config.instanceId;
    if (!instanceId) {
      const balRes = await fetch(`${API_BASE}/public/api/v1/time-off/balances?limit=1`, {
        headers: {
          Authorization: `Basic ${config.apiKey}`,
          "Content-Type": "application/json",
        },
      });
      if (!balRes.ok) {
        return { ok: false, status: balRes.status, error: "No se pudo obtener instanceId para listar solicitudes" };
      }
      const balData = await balRes.json();
      instanceId = balData.items?.[0]?.user?.instanceId;
      if (!instanceId) {
        return { ok: false, status: 400, error: "No se encontró instanceId en las políticas del cliente" };
      }
    }

    const allItems = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        instanceId,
      });

      const resp = await fetch(`${API_BASE}/api/v1/vacations/requests?${params}`, {
        headers: {
          Authorization: `Bearer ${config.jwtToken}`,
          "Content-Type": "application/json",
          Origin: "https://app.humand.co",
          "x-humand-origin": "web",
        },
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401 || resp.status === 403) {
          return { tokenExpired: true, status: resp.status, data };
        }
        return { ok: false, status: resp.status, error: data.message || `Error ${resp.status}` };
      }

      const data = await resp.json();
      const items = Array.isArray(data) ? data : (data.items || data.content || data.data || []);
      const total = data.total ?? data.totalElements ?? null;

      allItems.push(...items);

      // Parar si: menos items que el pageSize, o llegamos al total, o array directo (sin paginación)
      if (
        items.length < PAGE_SIZE ||
        (total !== null && allItems.length >= total) ||
        Array.isArray(data)
      ) {
        hasMore = false;
      } else {
        page++;
      }

      // Safety cap: máximo 20 páginas (2000 solicitudes)
      if (page >= 20) hasMore = false;
    }

    return { ok: true, items: allItems, total: allItems.length };
  });

  if (result.error) {
    return res.status(result.status || 502).json({ error: result.error });
  }

  res.status(200).json({ items: result.items, total: result.total });
}
