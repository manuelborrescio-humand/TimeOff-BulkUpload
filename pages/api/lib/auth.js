import { put, list } from "@vercel/blob";

const API_BASE = "https://api-prod.humand.co";
const BLOB_KEY = "config/clients.json";

// JWT tokens de Humand duran 15 minutos, refrescamos a los 10 min
const TOKEN_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

async function readBlobClients() {
  try {
    const { blobs } = await list({ prefix: BLOB_KEY });
    if (blobs.length === 0) return [];
    const resp = await fetch(blobs[0].url);
    return await resp.json();
  } catch {
    return [];
  }
}

async function writeBlobClients(clients) {
  await put(BLOB_KEY, JSON.stringify(clients), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

function getEnvClients() {
  const clients = [];
  const seen = new Set();
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^CLIENT_(.+?)_(API_KEY|JWT_TOKEN|NAME)$/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      const slug = match[1];
      const name = process.env[`CLIENT_${slug}_NAME`];
      const hasApiKey = !!process.env[`CLIENT_${slug}_API_KEY`];
      if (name && hasApiKey) {
        clients.push({
          slug: slug.toLowerCase(),
          name,
          apiKey: process.env[`CLIENT_${slug}_API_KEY`],
          jwtToken: process.env[`CLIENT_${slug}_JWT_TOKEN`] || "",
          source: "env",
        });
      }
    }
  }
  return clients;
}

/**
 * Decodifica un JWT y extrae el payload (sin verificar firma)
 */
function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verifica si el token está próximo a expirar o ya expiró
 */
function isTokenExpiringSoon(token) {
  if (!token) return true;
  const payload = decodeJwt(token);
  if (!payload || !payload.exp) return true;
  const expiresAt = payload.exp * 1000; // exp está en segundos
  const now = Date.now();
  return now >= expiresAt - TOKEN_REFRESH_THRESHOLD_MS;
}

/**
 * Refresca el JWT usando el refresh token de Humand (sin necesitar contraseña)
 * Devuelve { accessToken, refreshToken } o null si falla
 */
async function refreshJwtToken(client) {
  const { refreshToken, instanceId, employeeInternalId, apiKey } = client || {};

  // Estrategia 1: usar el refresh token (método correcto según Humand)
  if (refreshToken) {
    const refreshRes = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshToken}`,
      },
      body: JSON.stringify({ refreshToken }),
    });
    if (refreshRes.ok) {
      const data = await refreshRes.json();
      if (data.accessToken) {
        console.log("[Auth] JWT refrescado con refresh token");
        return { accessToken: data.accessToken, refreshToken: data.refreshToken || refreshToken };
      }
    }
    console.log("[Auth] Refresh token falló, intentando re-login con datos guardados...");
  }

  // Estrategia 2: re-login usando instanceId y employeeInternalId guardados (requiere apiKey como contraseña)
  // Esto no funciona sin contraseña del usuario — solo como fallback informativo
  return null;
}

/**
 * Actualiza el JWT (y opcionalmente el refresh token) en el blob storage.
 * Si el cliente no existe en blob (es de env vars), lo agrega como entrada nueva (upsert).
 */
async function updateClientJwt(slug, newJwt, newRefreshToken = null, clientFallback = null) {
  const clients = await readBlobClients();
  const idx = clients.findIndex((c) => c.slug === slug.toLowerCase());
  if (idx !== -1) {
    clients[idx].jwtToken = newJwt;
    clients[idx].jwtRefreshedAt = new Date().toISOString();
    if (newRefreshToken) clients[idx].refreshToken = newRefreshToken;
  } else {
    // Cliente de env vars: crear entrada en blob para poder persistir tokens actualizados
    const base = clientFallback || {};
    clients.push({
      slug: slug.toLowerCase(),
      name: base.name || slug,
      apiKey: base.apiKey || "",
      jwtToken: newJwt,
      refreshToken: newRefreshToken || base.refreshToken || "",
      instanceId: base.instanceId || "",
      employeeInternalId: base.employeeInternalId || "",
      createdBy: base.createdBy || "env",
      createdAt: base.createdAt || new Date().toISOString(),
      jwtRefreshedAt: new Date().toISOString(),
      source: "env_migrated",
    });
  }
  await writeBlobClients(clients);
}

/**
 * Obtiene la configuración del cliente, refrescando el JWT si es necesario.
 * Blob tiene prioridad sobre env vars para que los tokens actualizados (refresh) sean respetados.
 */
export async function getClientConfig(clientSlug) {
  const slug = clientSlug.toLowerCase();

  // 1. Buscar en Blob primero (puede tener token más fresco que env vars)
  const blobClients = await readBlobClients();
  const blobMatch = blobClients.find((c) => c.slug === slug);

  // 2. Si no está en blob, buscar en env vars
  const envClients = getEnvClients();
  const envMatch = envClients.find((c) => c.slug === slug);

  // Usar blob si existe, sino env vars
  const match = blobMatch || envMatch || null;
  if (!match) return null;

  // Enriquecer con instanceId desde env var si no está en el config
  // Patrón: CLIENT_{SLUG}_INSTANCE_ID (ej: CLIENT_ANUNCIAR_INSTANCE_ID=176290)
  if (!match.instanceId) {
    const slugUpper = slug.toUpperCase().replace(/-/g, "_");
    const envInstanceId = process.env[`CLIENT_${slugUpper}_INSTANCE_ID`];
    if (envInstanceId) match.instanceId = envInstanceId;
  }

  // 3. Verificar si el JWT necesita refresh (dura 15 min, threshold a los 10 min)
  if (isTokenExpiringSoon(match.jwtToken)) {
    console.log(`[Auth] JWT expirando para ${clientSlug}, intentando refresh con refresh token...`);
    try {
      const tokens = await refreshJwtToken(match);
      if (tokens) {
        await updateClientJwt(clientSlug, tokens.accessToken, tokens.refreshToken, match);
        match.jwtToken = tokens.accessToken;
        if (tokens.refreshToken) match.refreshToken = tokens.refreshToken;
        console.log(`[Auth] JWT refrescado exitosamente para ${clientSlug}`);
      }
    } catch (err) {
      console.error(`[Auth] Error refrescando JWT para ${clientSlug}:`, err.message);
      // Continuamos con el token actual, puede que aún funcione
    }
  }

  return match;
}

/**
 * Verifica si un error de API indica que el token expiró
 */
export function isTokenExpiredError(status, data) {
  if (status === 401) return true;
  if (status === 403) return true;
  const msg = (data?.message || data?.code || "").toLowerCase();
  if (msg.includes("token") && (msg.includes("expired") || msg.includes("invalid"))) return true;
  if (msg.includes("unauthorized")) return true;
  return false;
}

/**
 * Ejecuta una llamada a la API con retry automático si el token expiró
 */
export async function callWithRetry(clientSlug, apiCall, maxRetries = 1) {
  let config = await getClientConfig(clientSlug);
  if (!config) {
    return { error: "Client not configured", status: 404 };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await apiCall(config);
      
      // Si el resultado indica token expirado, intentar refresh con refresh token
      if (result.tokenExpired && attempt < maxRetries) {
        console.log(`[Auth] Token expirado detectado para ${clientSlug}, refrescando con refresh token...`);
        try {
          const tokens = await refreshJwtToken(config);
          if (tokens) {
            await updateClientJwt(clientSlug, tokens.accessToken, tokens.refreshToken, config);
            config = { ...config, jwtToken: tokens.accessToken };
            if (tokens.refreshToken) config.refreshToken = tokens.refreshToken;
            continue; // Reintentar con nuevo token
          }
        } catch (refreshErr) {
          console.error(`[Auth] Error en refresh:`, refreshErr.message);
        }
      }
      
      return result;
    } catch (err) {
      if (attempt === maxRetries) {
        return { error: err.message, status: 500 };
      }
    }
  }

  return { error: "Max retries exceeded", status: 500 };
}

// Re-exportar funciones para clients.js
export { readBlobClients, writeBlobClients, getEnvClients };
