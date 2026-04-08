import { getClientConfig, isTokenExpiredError, callWithRetry } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co/api/v1";

function translateError(msg, policyTypeId, userId) {
  const m = (msg || "").toLowerCase();
  if (m.includes("overlapping")) return "Ya existe una solicitud en esas fechas (solapamiento)";
  if (m.includes("policy") && m.includes("not defined")) return `El usuario no tiene asignada esta política (policyTypeId=${policyTypeId})`;
  if (m.includes("approver") && m.includes("not available")) return "No hay aprobador configurado para este usuario";
  if (m.includes("minimum") && m.includes("amount")) return "La cantidad de días es menor al mínimo permitido por la política";
  if (m.includes("maximum") && m.includes("amount")) return "La cantidad de días supera el máximo permitido por la política";
  if (m.includes("balance") && m.includes("insufficient")) return "Saldo insuficiente para esta solicitud";
  if (m.includes("retroactive") || m.includes("past")) return "La política no permite solicitudes retroactivas (fechas en el pasado)";
  if (m.includes("advance") && m.includes("days")) return "No cumple los días mínimos de anticipación";
  if (m.includes("not found")) return "Usuario no encontrado en la comunidad";
  return msg;
}

async function createRequest(config, body) {
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
    // Verificar si es error de token expirado
    if (isTokenExpiredError(resp.status, data)) {
      return { tokenExpired: true, status: resp.status, data };
    }
    return { 
      ok: false, 
      status: resp.status, 
      error: translateError(data.message || data.code || JSON.stringify(data), body.policyTypeId, body.issuerId),
      details: data 
    };
  }
  
  return { 
    ok: true, 
    id: data.id, 
    state: data.state, 
    amountRequested: data.amountRequested 
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;
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

  const result = await callWithRetry(clientSlug, (config) => createRequest(config, body));

  if (result.error) {
    return res.status(result.status || 502).json({ error: result.error, details: result.details });
  }

  res.status(201).json({ id: result.id, state: result.state, amountRequested: result.amountRequested });
}
