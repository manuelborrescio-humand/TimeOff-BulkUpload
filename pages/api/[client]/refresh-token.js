import { getClientConfig, readBlobClients, writeBlobClients } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;
  const { password } = req.body;

  // Buscar el cliente (busca en blob Y en env vars)
  const client = await getClientConfig(clientSlug);

  if (!client) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

  // Para el upsert en blob necesitamos el array mutable
  const clients = await readBlobClients();
  const clientIdx = clients.findIndex((c) => c.slug === clientSlug.toLowerCase());

  // Helper: guarda el token actualizado en blob (upsert — crea entrada si el cliente es de env vars)
  const saveToBlob = async (newJwt, newRefreshToken, extraFields = {}) => {
    const now = new Date().toISOString();
    if (clientIdx !== -1) {
      clients[clientIdx] = {
        ...clients[clientIdx],
        jwtToken: newJwt,
        jwtRefreshedAt: now,
        ...(newRefreshToken ? { refreshToken: newRefreshToken } : {}),
        ...extraFields,
      };
    } else {
      // Cliente de env vars: insertar en blob para que los próximos getClientConfig() usen el token fresco
      clients.push({
        slug: clientSlug.toLowerCase(),
        name: client.name || clientSlug,
        apiKey: client.apiKey || "",
        jwtToken: newJwt,
        refreshToken: newRefreshToken || client.refreshToken || "",
        instanceId: client.instanceId || "",
        employeeInternalId: client.employeeInternalId || "",
        createdBy: client.createdBy || "env",
        createdAt: client.createdAt || now,
        jwtRefreshedAt: now,
        source: "env_migrated",
        ...extraFields,
      });
    }
    await writeBlobClients(clients);
    return now;
  };

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
          const refreshedAt = await saveToBlob(refreshData.accessToken, refreshData.refreshToken || null);
          return res.status(200).json({
            success: true,
            method: "refresh_token",
            refreshedAt,
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

    const refreshedAt = await saveToBlob(
      loginData.accessToken,
      loginData.refreshToken || null,
      { instanceId, employeeInternalId }
    );

    res.status(200).json({
      success: true,
      method: "password_login",
      refreshedAt,
      expiresIn: "~15 minutos",
    });

  } catch (err) {
    res.status(502).json({ error: "Error de conexión", details: err.message });
  }
}
