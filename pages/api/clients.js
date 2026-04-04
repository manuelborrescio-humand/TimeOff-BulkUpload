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
      const hasJwt = !!process.env[`CLIENT_${slug}_JWT_TOKEN`];
      if (name && hasApiKey && hasJwt) {
        clients.push({ slug: slug.toLowerCase(), name });
      }
    }
  }
  return clients;
}

export function getClientConfig(clientSlug) {
  const slug = clientSlug.toUpperCase();
  const apiKey = process.env[`CLIENT_${slug}_API_KEY`];
  const jwtToken = process.env[`CLIENT_${slug}_JWT_TOKEN`];
  const name = process.env[`CLIENT_${slug}_NAME`];
  if (!apiKey || !jwtToken || !name) return null;
  return { slug: clientSlug, name, apiKey, jwtToken };
}

export default function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.status(200).json(getClients());
}
