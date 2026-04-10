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

/**
 * Busca una request existente para el usuario y fechas dados.
 * Se llama cuando create falla por solapamiento.
 */
async function findExistingRequest(config, issuerId, policyTypeId, fromDate, toDate) {
  try {
    const params = new URLSearchParams({ issuerId, limit: 100 });
    const resp = await fetch(`${API_BASE}/vacations/requests?${params}`, {
      headers: {
        Authorization: `Bearer ${config.jwtToken}`,
        "Content-Type": "application/json",
        Origin: "https://app.humand.co",
        "x-humand-origin": "web",
      },
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const items = Array.isArray(data) ? data : (data.items || data.content || []);

    const match = items.find((r) => {
      const samePolicy = !policyTypeId || r.policyTypeId === policyTypeId || r.policyType?.id === policyTypeId;
      const fromOk = r.from?.date === fromDate || r.fromDate === fromDate;
      const toOk = r.to?.date === toDate || r.toDate === toDate;
      return samePolicy && fromOk && toOk;
    });

    return match ? { id: match.id, state: match.state, amountRequested: match.amountRequested } : null;
  } catch {
    return null;
  }
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

    const rawMsg = data.message || data.code || JSON.stringify(data);

    // Si es solapamiento, intentar recuperar la request existente
    if ((rawMsg || "").toLowerCase().includes("overlapping")) {
      const existing = await findExistingRequest(
        config,
        body.issuerId,
        body.policyTypeId,
        body.from?.date,
        body.to?.date
      );
      if (existing) {
        return {
          ok: true,
          id: existing.id,
          state: existing.state,
          amountRequested: existing.amountRequested,
          alreadyExisted: true,
        };
      }
      // No se pudo encontrar la request existente, devolver error descriptivo
      return {
        ok: false,
        status: resp.status,
        error: "Ya existe una solicitud en esas fechas (no se pudo recuperar el ID)",
        details: data,
      };
    }

    return {
      ok: false,
      status: resp.status,
      error: translateError(rawMsg, body.policyTypeId, body.issuerId),
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

  if (result.tokenExpired) {
    return res.status(401).json({ error: "TOKEN_EXPIRED" });
  }
  if (result.error) {
    return res.status(result.status || 502).json({ error: result.error, details: result.details });
  }

  const status = result.alreadyExisted ? 200 : 201;
  res.status(status).json({
    id: result.id,
    state: result.state,
    amountRequested: result.amountRequested,
    alreadyExisted: result.alreadyExisted || false,
  });
}
