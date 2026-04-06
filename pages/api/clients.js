import { put, list, head } from "@vercel/blob";

const BLOB_KEY = "config/clients.json";

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

export async function getClientConfig(clientSlug) {
  // 1. Try env vars
  const envClients = getEnvClients();
  const envMatch = envClients.find((c) => c.slug === clientSlug.toLowerCase());
  if (envMatch) return envMatch;

  // 2. Try Blob
  const blobClients = await readBlobClients();
  const blobMatch = blobClients.find((c) => c.slug === clientSlug.toLowerCase());
  return blobMatch || null;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { slug } = req.query;

    if (slug) {
      const config = await getClientConfig(slug);
      if (!config) return res.status(404).json({ error: "Client not found" });
      return res.status(200).json(config);
    }

    const envClients = getEnvClients().map((c) => ({
      slug: c.slug, name: c.name, source: "env",
    }));
    const blobClients = (await readBlobClients()).map((c) => ({
      slug: c.slug, name: c.name, createdBy: c.createdBy, createdAt: c.createdAt, source: "blob",
    }));
    return res.status(200).json([...envClients, ...blobClients]);
  }

  if (req.method === "POST") {
    const { slug, name, apiKey, jwtToken, createdBy } = req.body;
    if (!slug || !name || !apiKey) return res.status(400).json({ error: "slug, name y apiKey son obligatorios" });

    const existing = await readBlobClients();
    if (existing.some((c) => c.slug === slug)) return res.status(409).json({ error: "Ya existe una comunidad con ese slug" });

    const envClients = getEnvClients();
    if (envClients.some((c) => c.slug === slug)) return res.status(409).json({ error: "Ya existe una comunidad con ese slug" });

    existing.push({ slug, name, apiKey, jwtToken: jwtToken || "", createdBy: createdBy || "", createdAt: new Date().toISOString() });
    await writeBlobClients(existing);
    return res.status(201).json({ success: true });
  }

  if (req.method === "DELETE") {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: "slug es obligatorio" });

    const existing = await readBlobClients();
    const filtered = existing.filter((c) => c.slug !== slug);
    if (filtered.length === existing.length) return res.status(404).json({ error: "Comunidad no encontrada" });

    await writeBlobClients(filtered);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
