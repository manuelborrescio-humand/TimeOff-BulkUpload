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

    const { all: rawUsers } = await fetchAllPages(
      (page, limit) => `${API_BASE}/users?limit=${limit}&page=${page}`,
      headers,
      { limit: 50, concurrency: 10, itemsKey: "users" }
    );

    const allUsers = rawUsers.map((u) => ({
      id: u.id,
      email: u.email,
      employeeInternalId: u.employeeInternalId,
      firstName: u.firstName,
      lastName: u.lastName,
      nickname: u.nickname,
    }));

    res.status(200).json(allUsers);
  } catch (err) {
    res.status(err.status || 502).json({ error: "Failed to fetch users", details: err.message });
  }
}
