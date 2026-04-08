import { readBlobClients, writeBlobClients } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: "La contraseña es obligatoria para refrescar el token" });
  }

  // Buscar el cliente
  const clients = await readBlobClients();
  const clientIdx = clients.findIndex((c) => c.slug === clientSlug.toLowerCase());
  
  if (clientIdx === -1) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

  const client = clients[clientIdx];

  try {
    // 1. Obtener employeeInternalId
    const meRes = await fetch(`${API_BASE}/public/api/v1/users/me`, {
      headers: { Authorization: `Basic ${client.apiKey}`, "Content-Type": "application/json" },
    });
    if (!meRes.ok) {
      return res.status(401).json({ error: "API Key inválida" });
    }
    const meData = await meRes.json();
    const employeeInternalId = meData.employeeInternalId;

    // 2. Obtener instanceId
    const balRes = await fetch(`${API_BASE}/public/api/v1/time-off/balances?limit=1`, {
      headers: { Authorization: `Basic ${client.apiKey}`, "Content-Type": "application/json" },
    });
    if (!balRes.ok) {
      return res.status(500).json({ error: "No se pudo obtener instanceId" });
    }
    const balData = await balRes.json();
    if (!balData.items || balData.items.length === 0) {
      return res.status(400).json({ error: "No hay políticas de ausencia configuradas" });
    }
    const instanceId = balData.items[0].user.instanceId;

    // 3. Login para obtener nuevo JWT
    const loginRes = await fetch(`${API_BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeInternalId, instanceId, password }),
    });
    const loginData = await loginRes.json();
    
    if (!loginRes.ok) {
      const msg = loginData.message || loginData.code || "Login fallido";
      return res.status(401).json({ 
        error: msg === "WRONG_CREDENTIALS" ? "Contraseña incorrecta" : msg 
      });
    }

    // 4. Actualizar el cliente con el nuevo token
    clients[clientIdx].jwtToken = loginData.accessToken;
    clients[clientIdx].jwtRefreshedAt = new Date().toISOString();
    await writeBlobClients(clients);

    res.status(200).json({ 
      success: true, 
      refreshedAt: clients[clientIdx].jwtRefreshedAt,
      expiresIn: "~1 hora (aproximado)",
    });

  } catch (err) {
    res.status(502).json({ error: "Error de conexión", details: err.message });
  }
}
