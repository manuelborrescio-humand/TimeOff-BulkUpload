import { callWithRetry } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co/api/v1";
const PAGE_SIZE = 100;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;

  const result = await callWithRetry(clientSlug, async (config) => {
    const allItems = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
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
