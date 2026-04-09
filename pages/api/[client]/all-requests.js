import { getClientConfig } from "../lib/auth";

const REDASH_URL = process.env.REDASH_URL || "https://redash.humand.co";
const REDASH_API_KEY = process.env.REDASH_API_KEY;
const REDASH_QUERY_ID = process.env.REDASH_VACATION_QUERY_ID || "5050";

const HUMAND_API_BASE = "https://api-prod.humand.co";

/**
 * Fetches instanceId from Humand API using the client's API key.
 */
async function fetchInstanceId(config) {
  const headers = { Authorization: `Basic ${config.apiKey}`, "Content-Type": "application/json" };

  // Intento 1: users/me
  try {
    const resp = await fetch(`${HUMAND_API_BASE}/public/api/v1/users/me`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      if (data.instanceId) return data.instanceId;
    }
  } catch {}

  // Intento 2: balances
  try {
    const resp = await fetch(`${HUMAND_API_BASE}/public/api/v1/time-off/balances?limit=1`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      const id = data.items?.[0]?.user?.instanceId;
      if (id) return id;
    }
  } catch {}

  return null;
}

/**
 * Maps a Redash row (query 5050) to the normalized format expected by the frontend.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches fresh results from Redash using POST with max_age:0 + polling.
 * Returns rows array or throws.
 */
async function fetchRedashFresh(instanceId) {
  const authHeader = { Authorization: `Key ${REDASH_API_KEY}`, "Content-Type": "application/json" };

  // POST to trigger fresh execution
  const postResp = await fetch(`${REDASH_URL}/api/queries/${REDASH_QUERY_ID}/results`, {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ parameters: { instanceId }, max_age: 0 }),
  });

  if (!postResp.ok) {
    const body = await postResp.text().catch(() => "");
    throw new Error(`Redash POST ${postResp.status}: ${body}`);
  }

  const postData = await postResp.json();

  // Result already available (cached hit with max_age match)
  if (postData.query_result) {
    return postData.query_result.data.rows || [];
  }

  // Job started — poll until done
  if (postData.job) {
    const jobId = postData.job.id;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(1000);

      const jobResp = await fetch(`${REDASH_URL}/api/jobs/${jobId}`, { headers: authHeader });
      if (!jobResp.ok) continue;

      const jobData = await jobResp.json();
      const status = jobData.job?.status;

      if (status === 3) {
        // Success — fetch result
        const resultId = jobData.job.query_result_id;
        const resultResp = await fetch(`${REDASH_URL}/api/query_results/${resultId}`, { headers: authHeader });
        const resultData = await resultResp.json();
        return resultData.query_result?.data?.rows || [];
      }

      if (status === 4) {
        throw new Error("Redash query falló: " + (jobData.job?.error || "error desconocido"));
      }
      // status 1 = pending, 2 = running — seguir esperando
    }
    throw new Error("Redash query timeout (>30s)");
  }

  throw new Error("Respuesta inesperada de Redash: " + JSON.stringify(postData).slice(0, 200));
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;

  const config = await getClientConfig(clientSlug);
  if (!config) return res.status(404).json({ error: "Cliente no encontrado" });

  if (!REDASH_API_KEY) {
    return res.status(500).json({ error: "REDASH_API_KEY no configurada en variables de entorno" });
  }

  // Resolve instanceId from config or Humand API
  const instanceId = config.instanceId || await fetchInstanceId(config);
  if (!instanceId) {
    return res.status(400).json({ error: "No se pudo obtener instanceId del cliente" });
  }

  let rows;
  try {
    rows = await fetchRedashFresh(instanceId);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const items = rows.map(mapRedashRow);
  res.status(200).json({ items, total: items.length });
}
