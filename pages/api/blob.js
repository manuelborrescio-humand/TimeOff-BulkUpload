import { put, del } from "@vercel/blob";

export default async function handler(req, res) {
  if (req.method === "POST") {
    const { fileName, base64 } = req.body;
    if (!fileName || !base64) return res.status(400).json({ error: "fileName and base64 required" });

    try {
      const buffer = Buffer.from(base64, "base64");
      const blob = await put(`results/${fileName}`, buffer, {
        access: "public",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      return res.status(200).json({ url: blob.url });
    } catch (err) {
      return res.status(500).json({ error: "Failed to upload", details: err.message });
    }
  }

  if (req.method === "DELETE") {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      await del(url);
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: "Failed to delete", details: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
