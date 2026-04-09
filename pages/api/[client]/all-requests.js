import { getClientConfig } from "../lib/auth";

const REDASH_URL = process.env.REDASH_URL || "https://redash.humand.co";
const REDASH_API_KEY = process.env.REDASH_API_KEY;
const REDASH_QUERY_ID = process.env.REDASH_VACATION_QUERY_ID || "5050";

const API_BASE = "https://api-prod.humand.co";

/**
 * Fetches instanceId from Humand API using the client's API key.
 * Returns { instanceId, source, raw } for debugging.
 */
async function fetchInstanceId(config) {
  const headers = {
    Authorization: `Basic ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  // Intento 1: /public/api/v1/users/me → puede tener instanceId directo
  try {
    const resp = await fetch(`${API_BASE}/public/api/v1/users/me`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      if (data.instanceId) return { instanceId: data.instanceId, source: "users/me", raw: data };
    }
  } catch {}

  // Intento 2: /public/api/v1/time-off/balances → items[0].user.instanceId
  try {
    const resp = await fetch(`${API_BASE}/public/api/v1/time-off/balances?limit=1`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      const id = data.items?.[0]?.user?.instanceId;
      if (id) return { instanceId: id, source: "balances.user.instanceId", raw: data.items?.[0]?.user };
      // Devolver info de debug aunque no haya instanceId
      return { instanceId: null, source: "balances (sin instanceId)", raw: data };
    }
  } catch (e) {
    return { instanceId: null, source: "balances (error)", raw: e.message };
  }

  return { instanceId: null, source: "no endpoint funcionó", raw: null };
}

/**
 * Maps a Redash row (query 5050) to the normalized format expected by the frontend.
 * Columns confirmed: requestId, user_id, user, policy_type_id, policy_type_name,
 *                   from_date, to_date, status, days_asked, policy_id, policy_name,
 *                   user_employee_internal_id
 */
function mapRedashRow(row) {
  return {
    id: row.requestId,
    issuerId: row.user_id,
    userId: row.user_id,
    userName: row.user,
    policyTypeId: row.policy_type_id,
    policy: row.policy_type_name,
    fromDate: row.from_date,
    toDate: row.to_date,
    state: row.status,
    amount: row.days_asked,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;

  const config = await getClientConfig(clientSlug);
  if (!config) return res.status(404).json({ error: "Cliente no encontrado" });

  // Resolve instanceId from config cache or Humand API
  let instanceId = config.instanceId;
  let fetchDebug = null;
  if (!instanceId) {
    const fetched = await fetchInstanceId(config);
    instanceId = fetched.instanceId;
    fetchDebug = { source: fetched.source, raw: fetched.raw };
  }

  if (!instanceId) {
    return res.status(400).json({
      error: "No se pudo obtener instanceId del cliente",
      fetchDebug,
      hint: "Revisá la respuesta de fetchDebug.raw para entender qué devuelve el API key de Humand",
    });
  }

  if (!REDASH_API_KEY) {
    return res.status(500).json({ error: "REDASH_API_KEY no configurada en variables de entorno" });
  }

  const url = `${REDASH_URL}/api/queries/${REDASH_QUERY_ID}/results.json?api_key=${REDASH_API_KEY}&p_instanceId=${instanceId}`;

  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    return res.status(502).json({ error: `Error de conexión con Redash: ${err.message}` });
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return res.status(resp.status).json({ error: `Error Redash ${resp.status}: ${body}` });
  }

  const data = await resp.json();
  const rows = data?.query_result?.data?.rows || [];
  const items = rows.map(mapRedashRow);

  res.status(200).json({ items, total: items.length, _debug: { instanceId, fetchDebug, rowsFromRedash: rows.length } });
}
