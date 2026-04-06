import { getClientConfig } from "../clients";

const API_BASE = "https://api-prod.humand.co/api/v1";

function translateError(msg, policyTypeId, userId) {
  const m = (msg || "").toLowerCase();
  if (m.includes("overlapping")) return "Ya existe una solicitud en esas fechas (solapamiento)";
  if (m.includes("policy") && m.includes("not defined")) return `El usuario no tiene asignada esta politica (policyTypeId=${policyTypeId})`;
  if (m.includes("approver") && m.includes("not available")) return "No hay aprobador configurado para este usuario";
  if (m.includes("minimum") && m.includes("amount")) return "La cantidad de dias es menor al minimo permitido por la politica";
  if (m.includes("maximum") && m.includes("amount")) return "La cantidad de dias supera el maximo permitido por la politica";
  if (m.includes("balance") && m.includes("insufficient")) return "Saldo insuficiente para esta solicitud";
  if (m.includes("retroactive") || m.includes("past")) return "La politica no permite solicitudes retroactivas (fechas en el pasado)";
  if (m.includes("advance") && m.includes("days")) return "No cumple los dias minimos de anticipacion";
  if (m.includes("not found")) return "Usuario no encontrado en la comunidad";
  return msg;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const config = await getClientConfig(req.query.client);
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
      const msg = data.message || data.code || JSON.stringify(data);
      return res.status(resp.status).json({ error: translateError(msg, policyTypeId, issuerId), details: data });
    }
    res.status(201).json({ id: data.id, state: data.state, amountRequested: data.amountRequested });
  } catch (err) {
    res.status(502).json({ error: "Failed to create request", details: err.message });
  }
}
