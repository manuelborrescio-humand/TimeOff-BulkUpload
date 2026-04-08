import { put, list } from "@vercel/blob";

const API_BASE = "https://api-prod.humand.co";
const BLOB_KEY = "config/clients.json";

// JWT tokens de Humand típicamente expiran en ~1 hora, refrescamos a los 45 min
const TOKEN_REFRESH_THRESHOLD_MS = 45 * 60 * 1000;

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
 * Obtiene un nuevo JWT usando la API Key
 */
async function refreshJwtToken(apiKey) {
  // 1. Obtener employeeInternalId del usuario
  const meRes = await fetch(`${API_BASE}/public/api/v1/users/me`, {
    headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" },
  });
  if (!meRes.ok) {
    throw new Error("API Key inválida o expirada");
  }
  const meData = await meRes.json();
  const employeeInternalId = meData.employeeInternalId;

  // 2. Obtener instanceId desde balances
  const balRes = await fetch(`${API_BASE}/public/api/v1/time-off/balances?limit=1`, {
    headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" },
  });
  if (!balRes.ok) {
    throw new Error("No se pudo obtener instanceId");
  }
  const balData = await balRes.json();
  if (!balData.items || balData.items.length === 0) {
    throw new Error("No hay políticas de ausencia configuradas");
  }
  const instanceId = balData.items[0].user.instanceId;

  // 3. Login usando API key como password (método alternativo sin contraseña del usuario)
  // Humand permite autenticación con la API key en ciertos endpoints
  // Intentamos obtener un token de sesión usando el endpoint de service account
  const loginRes = await fetch(`${API_BASE}/api/v1/auth/service-login`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      Authorization: `Basic ${apiKey}`,
    },
    body: JSON.stringify({ employeeInternalId, instanceId }),
  });
  
  if (loginRes.ok) {
    const loginData = await loginRes.json();
    return loginData.accessToken;
  }

  // Si service-login no funciona, intentamos con el endpoint público
  // que permite crear requests usando solo la API key
  return null;
}

/**
 * Actualiza el JWT en el blob storage
 */
async function updateClientJwt(slug, newJwt) {
  const clients = await readBlobClients();
  const idx = clients.findIndex((c) => c.slug === slug.toLowerCase());
  if (idx !== -1) {
    clients[idx].jwtToken = newJwt;
    clients[idx].jwtRefreshedAt = new Date().toISOString();
    await writeBlobClients(clients);
  }
}

/**
 * Obtiene la configuración del cliente, refrescando el JWT si es necesario
 */
export async function getClientConfig(clientSlug) {
  // 1. Buscar en env vars
  const envClients = getEnvClients();
  const envMatch = envClients.find((c) => c.slug === clientSlug.toLowerCase());
  if (envMatch) return envMatch;

  // 2. Buscar en Blob
  const blobClients = await readBlobClients();
  const blobMatch = blobClients.find((c) => c.slug === clientSlug.toLowerCase());
  
  if (!blobMatch) return null;

  // 3. Verificar si el JWT necesita refresh
  if (isTokenExpiringSoon(blobMatch.jwtToken)) {
    console.log(`[Auth] JWT expirando para ${clientSlug}, intentando refresh...`);
    try {
      const newJwt = await refreshJwtToken(blobMatch.apiKey);
      if (newJwt) {
        await updateClientJwt(clientSlug, newJwt);
        blobMatch.jwtToken = newJwt;
        console.log(`[Auth] JWT refrescado exitosamente para ${clientSlug}`);
      }
    } catch (err) {
      console.error(`[Auth] Error refrescando JWT para ${clientSlug}:`, err.message);
      // Continuamos con el token actual, puede que aún funcione
    }
  }

  return blobMatch;
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
      
      // Si el resultado indica token expirado, intentar refresh
      if (result.tokenExpired && attempt < maxRetries) {
        console.log(`[Auth] Token expirado detectado para ${clientSlug}, refrescando...`);
        try {
          const newJwt = await refreshJwtToken(config.apiKey);
          if (newJwt) {
            await updateClientJwt(clientSlug, newJwt);
            config = { ...config, jwtToken: newJwt };
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
