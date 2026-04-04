import { getClientConfig } from "../clients";

const API_BASE = "https://api-prod.humand.co/api/v1";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const config = getClientConfig(req.query.client);
  if (!config) return res.status(404).json({ error: "Client not configured" });

  try {
    const resp = await fetch(`${API_BASE}/vacations/policy-types`, {
      headers: {
        Authorization: `Bearer ${config.jwtToken}`,
        "Content-Type": "application/json",
        Origin: "https://app.humand.co",
        "x-humand-origin": "web",
      },
    });
    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: "Humand API error", details: err });
    }
    const data = await resp.json();
    const types = data.map((pt) => ({ id: pt.id, name: pt.name, icon: pt.icon, unit: pt.unit }));
    res.status(200).json(types);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch policy types", details: err.message });
  }
}
