import { put } from "@vercel/blob";
import { readBlobClients, writeBlobClients, getEnvClients, getClientConfig } from "./lib/auth";

export { getClientConfig };

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

    existing.push({ 
      slug, 
      name, 
      apiKey, 
      jwtToken: jwtToken || "", 
      createdBy: createdBy || "", 
      createdAt: new Date().toISOString(),
      jwtRefreshedAt: jwtToken ? new Date().toISOString() : null,
    });
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
