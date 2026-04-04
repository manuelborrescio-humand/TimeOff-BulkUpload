const API_BASE = "https://api-prod.humand.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { apiKey, password } = req.body;
  if (!apiKey || !password) return res.status(400).json({ error: "API Key y contraseña son obligatorios" });

  try {
    // 1. Get employeeInternalId from /users/me
    const meRes = await fetch(`${API_BASE}/public/api/v1/users/me`, {
      headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" },
    });
    if (!meRes.ok) return res.status(401).json({ error: "API Key invalida" });
    const meData = await meRes.json();
    const employeeInternalId = meData.employeeInternalId;

    // 2. Get instanceId from /time-off/balances
    const balRes = await fetch(`${API_BASE}/public/api/v1/time-off/balances?limit=1`, {
      headers: { Authorization: `Basic ${apiKey}`, "Content-Type": "application/json" },
    });
    if (!balRes.ok) return res.status(500).json({ error: "No se pudo obtener instanceId" });
    const balData = await balRes.json();
    if (!balData.items || balData.items.length === 0) {
      return res.status(400).json({ error: "No se encontraron politicas de ausencia en esta comunidad" });
    }
    const instanceId = balData.items[0].user.instanceId;

    // 3. Login to get JWT
    const loginRes = await fetch(`${API_BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeInternalId, instanceId, password }),
    });
    const loginData = await loginRes.json();
    if (!loginRes.ok) {
      const msg = loginData.message || loginData.code || "Login fallido";
      return res.status(401).json({ error: msg === "WRONG_CREDENTIALS" ? "Contraseña incorrecta" : msg });
    }

    res.status(200).json({
      jwtToken: loginData.accessToken,
      instanceName: loginData.instance?.name || "",
      userName: `${loginData.user?.firstName || ""} ${loginData.user?.lastName || ""}`.trim(),
      userEmail: loginData.user?.email || "",
    });
  } catch (err) {
    res.status(502).json({ error: "Error de conexion", details: err.message });
  }
}
