export function getClients() {
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
        clients.push({ slug: slug.toLowerCase(), name });
      }
    }
  }
  return clients;
}

export function getClientConfig(clientSlug, req) {
  // 1. Try env vars
  const slug = clientSlug.toUpperCase();
  const envApiKey = process.env[`CLIENT_${slug}_API_KEY`];
  const envJwt = process.env[`CLIENT_${slug}_JWT_TOKEN`];
  const envName = process.env[`CLIENT_${slug}_NAME`];
  if (envApiKey) {
    return { slug: clientSlug, name: envName || clientSlug, apiKey: envApiKey, jwtToken: envJwt || "" };
  }

  // 2. Try headers (from localStorage clients)
  if (req) {
    const hApiKey = req.headers["x-humand-api-key"];
    const hJwt = req.headers["x-humand-jwt-token"] || "";
    if (hApiKey) {
      return { slug: clientSlug, name: clientSlug, apiKey: hApiKey, jwtToken: hJwt };
    }
  }

  return null;
}

export default function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.status(200).json(getClients());
}
