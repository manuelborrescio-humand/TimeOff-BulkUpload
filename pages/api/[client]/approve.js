import { getClientConfig } from "../clients";

const API_BASE = "https://api-prod.humand.co/api/v1";

export default async function handler(req, res) {
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const config = getClientConfig(req.query.client, req);
  if (!config) return res.status(404).json({ error: "Client not configured" });

  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: "Missing requestId" });

  try {
    const resp = await fetch(`${API_BASE}/vacations/requests/${requestId}/state`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.jwtToken}`,
        "Content-Type": "application/json",
        Origin: "https://app.humand.co",
        "x-humand-origin": "web",
      },
      body: JSON.stringify({ state: "APPROVED" }),
    });
    if (resp.status === 204) return res.status(200).json({ success: true });
    const data = await resp.text();
    return res.status(resp.status).json({ error: "Failed to approve", details: data });
  } catch (err) {
    res.status(502).json({ error: "Failed to approve request", details: err.message });
  }
}
