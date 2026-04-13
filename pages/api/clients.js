import { put } from "@vercel/blob";
import { readBlobClients, readBlobClientsOrEmpty, writeBlobClients, getEnvClients, getClientConfig, READ_FAILED } from "./lib/auth";

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
    // Listado tolera fallos transitorios — fallback a [] sin enmascarar
    const blobClients = (await readBlobClientsOrEmpty()).map((c) => ({
      slug: c.slug, name: c.name, createdBy: c.createdBy, createdAt: c.createdAt, source: "blob",
    }));
    return res.status(200).json([...envClients, ...blobClients]);
  }

  // CRÍTICO para POST/PATCH/DELETE: si la lectura del blob falla, ABORTAR.
  // Escribir basado en lectura fallida sobreescribiría el blob con datos parciales
  // y perdería todos los demás clientes.

  if (req.method === "POST") {
    const { slug, name, apiKey, jwtToken, refreshToken, instanceId, employeeInternalId, createdBy } = req.body;
    if (!slug || !name || !apiKey) return res.status(400).json({ error: "slug, name y apiKey son obligatorios" });

    const existing = await readBlobClients();
    if (existing === READ_FAILED) {
      return res.status(503).json({ error: "No se pudo leer la lista de clientes (Blob temporalmente inaccesible). Reintentá en unos segundos." });
    }
    if (existing.some((c) => c.slug === slug)) return res.status(409).json({ error: "Ya existe una comunidad con ese slug" });

    const envClients = getEnvClients();
    if (envClients.some((c) => c.slug === slug)) return res.status(409).json({ error: "Ya existe una comunidad con ese slug" });

    existing.push({
      slug,
      name,
      apiKey,
      jwtToken: jwtToken || "",
      refreshToken: refreshToken || "",
      instanceId: instanceId || "",
      employeeInternalId: employeeInternalId || "",
      createdBy: createdBy || "",
      createdAt: new Date().toISOString(),
      jwtRefreshedAt: jwtToken ? new Date().toISOString() : null,
    });
    try {
      await writeBlobClients(existing);
    } catch (err) {
      return res.status(503).json({ error: "No se pudo guardar el cliente (Blob temporalmente inaccesible). Reintentá en unos segundos.", details: err.message });
    }
    return res.status(201).json({ success: true });
  }

  if (req.method === "PATCH") {
    const { slug, jwtToken } = req.body;
    if (!slug || !jwtToken) return res.status(400).json({ error: "slug y jwtToken son obligatorios" });

    const existing = await readBlobClients();
    if (existing === READ_FAILED) {
      return res.status(503).json({ error: "No se pudo leer la lista de clientes (Blob temporalmente inaccesible). Reintentá." });
    }
    const idx = existing.findIndex((c) => c.slug === slug);
    if (idx === -1) return res.status(404).json({ error: "Comunidad no encontrada en Blob (los clientes de env vars no se pueden actualizar aquí)" });

    existing[idx].jwtToken = jwtToken;
    try {
      await writeBlobClients(existing);
    } catch (err) {
      return res.status(503).json({ error: "No se pudo actualizar el token (Blob temporalmente inaccesible).", details: err.message });
    }
    return res.status(200).json({ success: true });
  }

  if (req.method === "DELETE") {
    const { slug } = req.body;
    if (!slug) return res.status(400).json({ error: "slug es obligatorio" });

    const existing = await readBlobClients();
    if (existing === READ_FAILED) {
      return res.status(503).json({ error: "No se pudo leer la lista de clientes (Blob temporalmente inaccesible). Reintentá." });
    }
    const filtered = existing.filter((c) => c.slug !== slug);
    if (filtered.length === existing.length) return res.status(404).json({ error: "Comunidad no encontrada" });

    try {
      await writeBlobClients(filtered);
    } catch (err) {
      return res.status(503).json({ error: "No se pudo eliminar el cliente (Blob temporalmente inaccesible).", details: err.message });
    }
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
