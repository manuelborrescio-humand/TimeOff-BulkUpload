import { getClientConfig } from "../lib/auth";

const REDASH_URL = process.env.REDASH_URL || "https://redash.humand.co";
const REDASH_API_KEY = process.env.REDASH_API_KEY;
const REDASH_QUERY_ID = process.env.REDASH_VACATION_QUERY_ID || "5050";

const API_BASE = "https://api-prod.humand.co";

/**
 * Fetches instanceId from the balances endpoint if not cached in config.
 */
async function fetchInstanceId(config) {
  try {
    const resp = await fetch(`${API_BASE}/public/api/v1/time-off/balances?limit=1`, {
      headers: {
        Authorization: `Basic ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.items?.[0]?.user?.instanceId || null;
  } catch {
    return null;
  }
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

  // Resolve instanceId from config cache or balances endpoint
  const instanceId = config.instanceId || await fetchInstanceId(config);
  if (!instanceId) {
    return res.status(400).json({ error: "No se pudo obtener instanceId del cliente" });
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

  res.status(200).json({ items, total: items.length, _debug: { instanceId, rowsFromRedash: rows.length } });
}
