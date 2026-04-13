import { readBlobClients, writeBlobClients, READ_FAILED } from "../lib/auth";

const API_BASE = "https://api-prod.humand.co";

/**
 * Lookup directo del cliente: busca en blob primero, luego intenta
 * construir la config desde env vars usando el slug directamente.
 * NO depende de getEnvClients() (que requiere CLIENT_X_NAME configurado).
 */
async function findClient(slug) {
  const lower = slug.toLowerCase();

  // 1. Buscar en blob (máxima prioridad — tiene tokens más frescos)
  // readBlobClients ya tiene retry interno (3 intentos con backoff)
  try {
    const blobClients = await readBlobClients();
    if (Array.isArray(blobClients)) {
      const blobMatch = blobClients.find((c) => c.slug === lower);
      if (blobMatch) return { client: blobMatch, source: "blob" };
    }
  } catch {}

  // 2. Buscar en env vars directo usando el slug
  // Probamos múltiples formatos de nombre: ANUNCIAR, anunciar, ANUNCIAR_COM, etc.
  const variants = [
    slug.toUpperCase().replace(/-/g, "_"),           // anunciar → ANUNCIAR
    slug.toLowerCase().replace(/-/g, "_"),            // anunciar → anunciar
    slug.replace(/-/g, "_"),                          // as-is
  ];

  for (const variant of variants) {
    const apiKey = process.env[`CLIENT_${variant}_API_KEY`];
    if (apiKey) {
      return {
        client: {
          slug: lower,
          name: process.env[`CLIENT_${variant}_NAME`] || slug,
          apiKey,
          jwtToken: process.env[`CLIENT_${variant}_JWT_TOKEN`] || "",
          refreshToken: process.env[`CLIENT_${variant}_REFRESH_TOKEN`] || "",
          instanceId: "",
          employeeInternalId: "",
          source: "env_direct",
        },
        source: "env",
      };
    }
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;
  const { password } = req.body;

  const found = await findClient(clientSlug);
  if (!found) {
    return res.status(404).json({
      error: `Cliente '${clientSlug}' no encontrado en blob ni en variables de entorno`,
    });
  }

  const { client } = found;

  // Mutable array de blob para hacer upsert al final.
  // CRÍTICO: si la lectura falló, dejamos blobClients como READ_FAILED para que
  // saveToBlob aborte (no queremos sobreescribir el blob con datos parciales).
  let blobClients = [];
  let clientIdx = -1;
  let readFailed = false;
  try {
    const r = await readBlobClients();
    if (r === READ_FAILED) {
      readFailed = true;
    } else {
      blobClients = r;
      clientIdx = blobClients.findIndex((c) => c.slug === clientSlug.toLowerCase());
    }
  } catch {
    readFailed = true;
  }

  // Helper: guarda el token actualizado en blob (upsert)
  const saveToBlob = async (newJwt, newRefreshToken, extraFields = {}) => {
    if (readFailed) {
      console.error(`[refresh-token] saveToBlob abortado para ${clientSlug}: lectura previa falló`);
      return new Date().toISOString();
    }
    const now = new Date().toISOString();
    const updated = {
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
      source: found.source === "blob" ? "blob" : "env_migrated",
      ...extraFields,
    };

    if (clientIdx !== -1) {
      blobClients[clientIdx] = { ...blobClients[clientIdx], ...updated };
    } else {
      blobClients.push(updated);
    }

    try {
      await writeBlobClients(blobClients);
    } catch (e) {
      console.error("[refresh-token] Error escribiendo en blob:", e.message);
      // No es fatal — el token fue obtenido igual
    }
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
          const refreshedAt = await saveToBlob(
            refreshData.accessToken,
            refreshData.refreshToken || client.refreshToken
          );
          return res.status(200).json({
            success: true,
            method: "refresh_token",
            refreshedAt,
            expiresIn: "~15 minutos",
          });
        }
      }
      console.log("[refresh-token] Refresh token no funcionó, requiere contraseña");
    }

    // Estrategia 2: re-login con contraseña
    if (!password) {
      return res.status(400).json({
        error: "Ingresá la contraseña de Humand para renovar la sesión.",
      });
    }

    // Obtener employeeInternalId e instanceId (desde cache o via API)
    let employeeInternalId = client.employeeInternalId;
    let instanceId = client.instanceId;

    if (!employeeInternalId) {
      const meRes = await fetch(`${API_BASE}/public/api/v1/users/me`, {
        headers: { Authorization: `Basic ${client.apiKey}`, "Content-Type": "application/json" },
      });
      if (!meRes.ok) {
        const meText = await meRes.text().catch(() => "");
        return res.status(401).json({ error: `API Key inválida (status ${meRes.status}): ${meText.slice(0, 100)}` });
      }
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

    // Login
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
    res.status(502).json({ error: "Error de conexión: " + err.message });
  }
}
