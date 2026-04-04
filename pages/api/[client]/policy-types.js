import { getClientConfig } from "../clients";

const API_BASE = "https://api-prod.humand.co/public/api/v1";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const config = getClientConfig(req.query.client, req);
  if (!config) return res.status(404).json({ error: "Client not configured" });

  try {
    const allItems = [];
    let page = 1;
    while (true) {
      const resp = await fetch(`${API_BASE}/time-off/balances?limit=50&page=${page}`, {
        headers: {
          Authorization: `Basic ${config.apiKey}`,
          "Content-Type": "application/json",
        },
      });
      if (!resp.ok) {
        const err = await resp.text();
        return res.status(resp.status).json({ error: "Humand API error", details: err });
      }
      const data = await resp.json();
      allItems.push(...data.items);
      if (allItems.length >= data.count) break;
      page++;
    }

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
    res.status(502).json({ error: "Failed to fetch policies", details: err.message });
  }
}
