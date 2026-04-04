import { useState, useEffect } from "react";
import Head from "next/head";
import Link from "next/link";

function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getLocalClients() {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem("humand_clients") || "[]");
  } catch {
    return [];
  }
}

function saveLocalClients(clients) {
  localStorage.setItem("humand_clients", JSON.stringify(clients));
}

export default function Home() {
  const [envClients, setEnvClients] = useState([]);
  const [localClients, setLocalClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", apiKey: "", password: "" });
  const [formError, setFormError] = useState("");
  const [formLoading, setFormLoading] = useState(false);

  useEffect(() => {
    fetch("/api/clients")
      .then((r) => r.json())
      .then(setEnvClients)
      .finally(() => setLoading(false));
    setLocalClients(getLocalClients());
  }, []);

  const allClients = [
    ...envClients.map((c) => ({ ...c, source: "env" })),
    ...localClients.map((c) => ({ ...c, source: "local" })),
  ];

  const filtered = allClients.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.slug.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = async () => {
    setFormError("");
    if (!form.name.trim()) return setFormError("El nombre es obligatorio");
    if (!form.apiKey.trim()) return setFormError("La API Key es obligatoria");
    if (!form.password.trim()) return setFormError("La contraseña es obligatoria");
    const slug = slugify(form.name);
    if (!slug) return setFormError("Nombre invalido");
    if (allClients.some((c) => c.slug === slug)) return setFormError(`Ya existe un cliente con slug "${slug}"`);

    setFormLoading(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: form.apiKey.trim(), password: form.password.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setFormError(data.error); setFormLoading(false); return; }

      const newClient = {
        slug,
        name: data.instanceName || form.name.trim(),
        apiKey: form.apiKey.trim(),
        jwtToken: data.jwtToken,
        authUser: data.userName,
      };
      const updated = [...localClients, newClient];
      saveLocalClients(updated);
      setLocalClients(updated);
      setForm({ name: "", apiKey: "", password: "" });
      setShowForm(false);
    } catch (e) {
      setFormError("Error de conexion: " + e.message);
    }
    setFormLoading(false);
  };

  const removeLocal = (slug) => {
    const updated = localClients.filter((c) => c.slug !== slug);
    saveLocalClients(updated);
    setLocalClients(updated);
  };

  return (
    <>
      <Head>
        <title>Cargador de Ausencias - Humand</title>
      </Head>
      <div style={styles.container}>
        <div style={styles.content}>
          <h1 style={styles.title}>Cargador Masivo de Ausencias</h1>
          <p style={styles.subtitle}>
            Selecciona o crea un cliente para cargar ausencias desde un Excel o CSV.
          </p>

          <div style={styles.toolbar}>
            <input
              type="text"
              placeholder="Buscar comunidad..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={styles.searchInput}
            />
            <button style={styles.btnPrimary} onClick={() => setShowForm(!showForm)}>
              {showForm ? "Cancelar" : "+ Nueva comunidad"}
            </button>
          </div>

          {showForm && (
            <div style={styles.formCard}>
              <h3 style={styles.formTitle}>Nueva comunidad</h3>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Nombre de la comunidad *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ej: Beyond Agency"
                  style={styles.input}
                />
                {form.name && (
                  <span style={styles.slugPreview}>URL: /{slugify(form.name)}</span>
                )}
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>API Key *</label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder="API Key del usuario admin"
                  style={styles.input}
                />
                <a
                  href="https://ops.humand.co/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.helpLink}
                >
                  Como crear un API Key
                </a>
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Contraseña de Humand *</label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="Contraseña del usuario admin en Humand"
                  style={styles.input}
                />
                <span style={styles.helpText}>
                  La contraseña del usuario que creo la API Key. Se usa para autenticarse y no se almacena.
                </span>
              </div>
              {formError && <p style={styles.formError}>{formError}</p>}
              <button style={{ ...styles.btnPrimary, opacity: formLoading ? 0.6 : 1 }} onClick={handleCreate} disabled={formLoading}>
                {formLoading ? "Conectando..." : "Crear comunidad"}
              </button>
            </div>
          )}

          {loading ? (
            <p style={styles.loading}>Cargando...</p>
          ) : filtered.length === 0 ? (
            <p style={styles.emptyText}>
              {search ? "No se encontraron comunidades" : "No hay comunidades configuradas"}
            </p>
          ) : (
            <div style={styles.grid}>
              {filtered.map((c) => (
                <div key={`${c.source}-${c.slug}`} style={styles.cardRow}>
                  <Link href={`/${c.slug}`} style={styles.card}>
                    <div style={styles.cardName}>{c.name}</div>
                    <div style={styles.cardMeta}>
                      <span style={styles.cardSlug}>/{c.slug}</span>
                      {c.source === "local" && <span style={styles.localBadge}>local</span>}
                    </div>
                  </Link>
                  {c.source === "local" && (
                    <button
                      style={styles.removeBtn}
                      onClick={() => removeLocal(c.slug)}
                      title="Eliminar"
                    >
                      x
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#f1f5f9",
    display: "flex",
    justifyContent: "center",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  content: { maxWidth: 560, width: "100%", padding: "48px 24px" },
  title: { fontSize: 24, fontWeight: 700, color: "#0f172a", margin: 0 },
  subtitle: { fontSize: 14, color: "#64748b", margin: "8px 0 24px" },
  toolbar: { display: "flex", gap: 10, marginBottom: 16 },
  searchInput: {
    flex: 1,
    padding: "8px 12px",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    fontSize: 14,
    backgroundColor: "#fff",
    outline: "none",
  },
  btnPrimary: {
    backgroundColor: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  formCard: {
    backgroundColor: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: 20,
    marginBottom: 16,
  },
  formTitle: { fontSize: 16, fontWeight: 600, color: "#0f172a", margin: "0 0 16px" },
  formGroup: { marginBottom: 14 },
  formLabel: { display: "block", fontSize: 13, fontWeight: 500, color: "#334155", marginBottom: 4 },
  input: {
    width: "100%",
    padding: "8px 10px",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    fontSize: 14,
    backgroundColor: "#fff",
    boxSizing: "border-box",
  },
  slugPreview: { fontSize: 12, color: "#64748b", marginTop: 2, display: "block" },
  helpLink: { fontSize: 12, color: "#2563eb", textDecoration: "none", display: "inline-block", marginTop: 4 },
  helpText: { fontSize: 12, color: "#94a3b8", marginTop: 2, display: "block" },
  formError: { color: "#dc2626", fontSize: 13, margin: "0 0 10px" },
  loading: { color: "#64748b", fontSize: 14 },
  emptyText: { color: "#94a3b8", fontSize: 14, textAlign: "center", marginTop: 24 },
  grid: { display: "flex", flexDirection: "column", gap: 6 },
  cardRow: { display: "flex", alignItems: "center", gap: 4 },
  card: {
    flex: 1,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    padding: "10px 14px",
    textDecoration: "none",
    cursor: "pointer",
  },
  cardName: { fontSize: 14, fontWeight: 600, color: "#0f172a" },
  cardMeta: { display: "flex", alignItems: "center", gap: 8 },
  cardSlug: { fontSize: 12, color: "#94a3b8" },
  localBadge: {
    fontSize: 10,
    color: "#64748b",
    backgroundColor: "#f1f5f9",
    padding: "1px 6px",
    borderRadius: 4,
    fontWeight: 500,
  },
  removeBtn: {
    background: "none",
    border: "none",
    color: "#94a3b8",
    fontSize: 14,
    cursor: "pointer",
    padding: "4px 8px",
  },
};
