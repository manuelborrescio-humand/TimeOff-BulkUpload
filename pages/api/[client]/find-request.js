import { callWithRetry } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co/api/v1";

/**
 * Busca una request de ausencia existente para un usuario, política y fechas dados.
 * Útil para recuperar el requestId cuando create falla por solapamiento.
 *
 * GET /api/{client}/find-request?issuerId=...&policyTypeId=...&fromDate=...&toDate=...
 */
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;
  const { issuerId, policyTypeId, fromDate, toDate } = req.query;

  if (!issuerId || !fromDate || !toDate) {
    return res.status(400).json({ error: "issuerId, fromDate y toDate son obligatorios" });
  }

  const result = await callWithRetry(clientSlug, async (config) => {
    // Humand API: GET /api/v1/vacations/requests con filtros por usuario
    const params = new URLSearchParams({ issuerId, limit: 100 });
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
      return { ok: false, status: resp.status, error: data.message || "Error buscando requests", data };
    }

    const data = await resp.json();
    // La respuesta puede ser un array directo o { items: [...] }
    const items = Array.isArray(data) ? data : (data.items || data.content || []);

    // Buscar la request que coincida con política y fechas
    const match = items.find((r) => {
      const samePolicy = !policyTypeId || r.policyTypeId === policyTypeId || r.policyType?.id === policyTypeId;
      const fromOk = r.from?.date === fromDate || r.fromDate === fromDate;
      const toOk = r.to?.date === toDate || r.toDate === toDate;
      return samePolicy && fromOk && toOk;
    });

    if (match) {
      return { ok: true, found: true, id: match.id, state: match.state, amountRequested: match.amountRequested };
    }

    return { ok: true, found: false };
  });

  if (result.error) {
    return res.status(result.status || 502).json({ error: result.error });
  }

  res.status(200).json(result);
}
