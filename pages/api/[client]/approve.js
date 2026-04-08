import { getClientConfig, isTokenExpiredError, callWithRetry } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co/api/v1";

async function approveRequest(config, requestId) {
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

  if (resp.status === 204) {
    return { ok: true };
  }

  const text = await resp.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  // Verificar si es error de token expirado
  if (isTokenExpiredError(resp.status, data)) {
    return { tokenExpired: true, status: resp.status, data };
  }

  return { 
    ok: false, 
    status: resp.status, 
    error: "Failed to approve", 
    details: data 
  };
}

export default async function handler(req, res) {
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;
  const { requestId } = req.body;
  
  if (!requestId) return res.status(400).json({ error: "Missing requestId" });

  const result = await callWithRetry(clientSlug, (config) => approveRequest(config, requestId));

  if (result.error) {
    return res.status(result.status || 502).json({ error: result.error, details: result.details });
  }

  res.status(200).json({ success: true });
}
