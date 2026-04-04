import { getClientConfig } from "../clients";

const API_BASE = "https://api-prod.humand.co/api/v1";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const config = getClientConfig(req.query.client);
  if (!config) return res.status(404).json({ error: "Client not configured" });

  const { issuerId, policyTypeId, fromDate, toDate, description } = req.body;
  if (!issuerId || !policyTypeId || !fromDate || !toDate) {
    return res.status(400).json({ error: "Missing required fields: issuerId, policyTypeId, fromDate, toDate" });
  }

  const body = {
    issuerId,
    policyTypeId,
    from: { date: fromDate, consumptionType: "FULL_DAY" },
    to: { date: toDate, consumptionType: "FULL_DAY" },
  };
  if (description) body.description = description;

  try {
    const resp = await fetch(`${API_BASE}/vacations/requests`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.jwtToken}`,
        "Content-Type": "application/json",
        Origin: "https://app.humand.co",
        "x-humand-origin": "web",
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "Failed to create request", details: data });
    }
    res.status(201).json({ id: data.id, state: data.state, amountRequested: data.amountRequested });
  } catch (err) {
    res.status(502).json({ error: "Failed to create request", details: err.message });
  }
}
