import { getClientConfig } from "../lib/auth";

const REDASH_URL = process.env.REDASH_URL || "https://redash.humand.co";
const REDASH_API_KEY = process.env.REDASH_API_KEY;
const REDASH_QUERY_ID = process.env.REDASH_VACATION_QUERY_ID || "5050";

const HUMAND_API_BASE = "https://api-prod.humand.co";

async function fetchInstanceId(config) {
  const headers = { Authorization: `Basic ${config.apiKey}`, "Content-Type": "application/json" };

  try {
    const resp = await fetch(`${HUMAND_API_BASE}/public/api/v1/users/me`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      if (data.instanceId) return data.instanceId;
    }
  } catch {}

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
 * Estrategia 1: GET con max_age=0 (ejecución fresca sincrónica — rápido si Redash responde < 30s)
 */
async function tryGetFresh(instanceId) {
  const url = `${REDASH_URL}/api/queries/${REDASH_QUERY_ID}/results.json?api_key=${REDASH_API_KEY}&p_instanceId=${instanceId}&max_age=0`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(28000) });
  if (!resp.ok) return null;
  const data = await resp.json();
  // Redash puede devolver un job en lugar de resultados directos
  if (data.job) return null; // necesita polling
  return data?.query_result?.data?.rows ?? null;
}

/**
 * Estrategia 2: POST con max_age:0 + polling (hasta 50s)
 */
async function tryPostWithPolling(instanceId) {
  const authHeader = { Authorization: `Key ${REDASH_API_KEY}`, "Content-Type": "application/json" };

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

  if (postData.query_result) {
    return postData.query_result.data.rows || [];
  }

  if (!postData.job) {
    throw new Error("Respuesta inesperada de Redash: " + JSON.stringify(postData).slice(0, 200));
  }

  const jobId = postData.job.id;
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(1000);
    try {
      const jobResp = await fetch(`${REDASH_URL}/api/jobs/${jobId}`, { headers: authHeader });
      if (!jobResp.ok) continue;
      const jobData = await jobResp.json();
      const status = jobData.job?.status;

      if (status === 3) {
        const resultId = jobData.job.query_result_id;
        const resultResp = await fetch(`${REDASH_URL}/api/query_results/${resultId}`, { headers: authHeader });
        const resultData = await resultResp.json();
        return resultData.query_result?.data?.rows || [];
      }

      if (status === 4) {
        throw new Error("Redash query falló: " + (jobData.job?.error || "error desconocido"));
      }
    } catch (e) {
      if (e.message.includes("Redash query")) throw e;
      // Error de red — seguir intentando
    }
  }

  throw new Error("Redash query timeout (>50s)");
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const clientSlug = req.query.client;

  const config = await getClientConfig(clientSlug);
  if (!config) return res.status(404).json({ error: "Cliente no encontrado" });

  if (!REDASH_API_KEY) {
    return res.status(500).json({ error: "REDASH_API_KEY no configurada en variables de entorno" });
  }

  const instanceId = config.instanceId || await fetchInstanceId(config);
  if (!instanceId) {
    return res.status(400).json({ error: "No se pudo obtener instanceId del cliente" });
  }

  let rows;
  try {
    // Intentar GET fresco primero (más simple, menos overhead)
    rows = await tryGetFresh(instanceId);

    // Si GET no funcionó (devolvió job o null), usar POST+polling
    if (rows === null) {
      rows = await tryPostWithPolling(instanceId);
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const items = rows.map(mapRedashRow);
  res.status(200).json({ items, total: items.length });
}
