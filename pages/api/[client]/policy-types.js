import { getClientConfig } from "../clients";
import { fetchAllPages } from "../lib/humand-paginate";

const API_BASE = "https://api-prod.humand.co/public/api/v1";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const config = await getClientConfig(req.query.client);
  if (!config) return res.status(404).json({ error: "Client not configured" });

  try {
    const headers = {
      Authorization: `Basic ${config.apiKey}`,
      "Content-Type": "application/json",
    };

    // /time-off/balances tiene 1 item por (usuario × política asignada).
    // Para descubrir las políticas únicas + contar usuarios por política,
    // necesitamos recorrer todos los items — pero en paralelo (no secuencial).
    const { all: allItems } = await fetchAllPages(
      (page, limit) => `${API_BASE}/time-off/balances?limit=${limit}&page=${page}`,
      headers,
      { limit: 50, concurrency: 10, itemsKey: "items" }
    );

    const policiesMap = {};
    for (const item of allItems) {
      const p = item.policy;
      const pt = item.policyType;
      if (!policiesMap[p.id]) {
        policiesMap[p.id] = {
          policyId: p.id,
          policyName: p.name,
          policyTypeId: pt.id,
          policyTypeName: pt.name,
          icon: pt.icon,
          unit: pt.unit,
          noRetroactiveRequests: p.noRetroactiveRequests,
          minimumAmountPerRequest: p.minimumAmountPerRequest,
          maximumAmountPerRequest: p.maximumAmountPerRequest,
          minimumAdvanceDays: p.minimumAdvanceDays,
          minimumBalance: p.minimumBalance,
          allowHalfDayRequests: p.allowHalfDayRequests,
          countingMethod: p.countingMethod,
          allowanceType: p.allowanceType,
          userCount: 0,
        };
      }
      policiesMap[p.id].userCount++;
    }

    res.status(200).json(Object.values(policiesMap));
  } catch (err) {
    res.status(err.status || 502).json({ error: "Failed to fetch policies", details: err.message });
  }
}
