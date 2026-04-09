import { readBlobClients, writeBlobClients } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;
  const { password } = req.body;

  // Buscar el cliente
  const clients = await readBlobClients();
  const clientIdx = clients.findIndex((c) => c.slug === clientSlug.toLowerCase());

  if (clientIdx === -1) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

  const client = clients[clientIdx];

  try {
    // Estrategia 1: usar el refresh token guardado (sin necesitar contraseña)
    if (client.refreshToken) {
      const refreshRes = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${client.refreshToken}`,
        },
        body: JSON.stringify({ refreshToken: client.refreshToken }),
      });

      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        if (refreshData.accessToken) {
          clients[clientIdx].jwtToken = refreshData.accessToken;
          clients[clientIdx].jwtRefreshedAt = new Date().toISOString();
          if (refreshData.refreshToken) {
            clients[clientIdx].refreshToken = refreshData.refreshToken;
          }
          await writeBlobClients(clients);
          return res.status(200).json({
            success: true,
            method: "refresh_token",
            refreshedAt: clients[clientIdx].jwtRefreshedAt,
            expiresIn: "~15 minutos",
          });
        }
      }
      console.log("[refresh-token] Refresh token falló, intentando con contraseña...");
    }

    // Estrategia 2: re-login con contraseña (fallback)
    if (!password) {
      return res.status(400).json({
        error: "El refresh token expiró o no está disponible. Ingresá la contraseña para renovar la sesión.",
      });
    }

    // Usar instanceId y employeeInternalId guardados si están disponibles
    let employeeInternalId = client.employeeInternalId;
    let instanceId = client.instanceId;

    // Si no están guardados, obtenerlos de la API
    if (!employeeInternalId) {
      const meRes = await fetch(`${API_BASE}/public/api/v1/users/me`, {
        headers: { Authorization: `Basic ${client.apiKey}`, "Content-Type": "application/json" },
      });
      if (!meRes.ok) return res.status(401).json({ error: "API Key inválida" });
      const meData = await meRes.json();
      employeeInternalId = meData.employeeInternalId;
    }

    if (!instanceId) {
      const balRes = await fetch(`${API_BASE}/public/api/v1/time-off/balances?limit=1`, {
        headers: { Authorization: `Basic ${client.apiKey}`, "Content-Type": "application/json" },
      });
      if (!balRes.ok) return res.status(500).json({ error: "No se pudo obtener instanceId" });
      const balData = await balRes.json();
      if (!balData.items || balData.items.length === 0) {
        return res.status(400).json({ error: "No hay políticas de ausencia configuradas" });
      }
      instanceId = balData.items[0].user.instanceId;
    }

    // Login para obtener nuevo JWT y refresh token
    const loginRes = await fetch(`${API_BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeInternalId, instanceId, password }),
    });
    const loginData = await loginRes.json();

    if (!loginRes.ok) {
      const msg = loginData.message || loginData.code || "Login fallido";
      return res.status(401).json({
        error: msg === "WRONG_CREDENTIALS" ? "Contraseña incorrecta" : msg,
      });
    }

    // Actualizar JWT, refresh token e instanceId guardados
    clients[clientIdx].jwtToken = loginData.accessToken;
    clients[clientIdx].jwtRefreshedAt = new Date().toISOString();
    if (loginData.refreshToken) clients[clientIdx].refreshToken = loginData.refreshToken;
    if (instanceId) clients[clientIdx].instanceId = instanceId;
    if (employeeInternalId) clients[clientIdx].employeeInternalId = employeeInternalId;
    await writeBlobClients(clients);

    res.status(200).json({
      success: true,
      method: "password_login",
      refreshedAt: clients[clientIdx].jwtRefreshedAt,
      expiresIn: "~15 minutos",
    });

  } catch (err) {
    res.status(502).json({ error: "Error de conexión", details: err.message });
  }
}
