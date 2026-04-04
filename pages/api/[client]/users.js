import { getClientConfig } from "../clients";

const API_BASE = "https://api-prod.humand.co/public/api/v1";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const config = getClientConfig(req.query.client);
  if (!config) return res.status(404).json({ error: "Client not configured" });

  try {
    const allUsers = [];
    let page = 1;
    const limit = 50;
    while (true) {
      const resp = await fetch(`${API_BASE}/users?limit=${limit}&page=${page}`, {
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
      for (const u of data.users) {
        allUsers.push({
          id: u.id,
          email: u.email,
          employeeInternalId: u.employeeInternalId,
          firstName: u.firstName,
          lastName: u.lastName,
        });
      }
      if (allUsers.length >= data.count) break;
      page++;
    }
    res.status(200).json(allUsers);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch users", details: err.message });
  }
}
