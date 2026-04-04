import { useState, useEffect } from "react";
import Head from "next/head";
import Link from "next/link";

export default function Home() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/clients")
      .then((r) => r.json())
      .then(setClients)
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <Head>
        <title>Cargador de Ausencias - Humand</title>
      </Head>
      <div style={styles.container}>
        <div style={styles.content}>
          <h1 style={styles.title}>Cargador Masivo de Ausencias</h1>
          <p style={styles.subtitle}>
            Selecciona un cliente para cargar ausencias/vacaciones desde un Excel o CSV.
          </p>

          {loading ? (
            <p style={styles.loading}>Cargando clientes...</p>
          ) : clients.length === 0 ? (
            <div style={styles.empty}>
              <p style={{ margin: 0, fontWeight: 600, color: "#0f172a" }}>
                No hay clientes configurados
              </p>
              <p style={{ margin: "8px 0 0", color: "#64748b", fontSize: 14 }}>
                Agrega variables de entorno con el patrón:
              </p>
              <pre style={styles.code}>
{`CLIENT_{SLUG}_API_KEY=...
CLIENT_{SLUG}_JWT_TOKEN=...
CLIENT_{SLUG}_NAME=Nombre del Cliente`}
              </pre>
              <p style={{ margin: "8px 0 0", color: "#64748b", fontSize: 13 }}>
                <a
                  href="https://humand-api-docs.vercel.app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#2563eb" }}
                >
                  Como crear un API Key
                </a>
              </p>
            </div>
          ) : (
            <div style={styles.grid}>
              {clients.map((c) => (
                <Link key={c.slug} href={`/${c.slug}`} style={styles.card}>
                  <div style={styles.cardIcon}>📋</div>
                  <div>
                    <div style={styles.cardName}>{c.name}</div>
                    <div style={styles.cardSlug}>/{c.slug}</div>
                  </div>
                </Link>
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
  content: {
    maxWidth: 600,
    width: "100%",
    padding: "48px 24px",
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: "#0f172a",
    margin: 0,
  },
  subtitle: {
    fontSize: 15,
    color: "#64748b",
    margin: "8px 0 32px",
  },
  loading: { color: "#64748b", fontSize: 14 },
  empty: {
    backgroundColor: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: 24,
  },
  code: {
    backgroundColor: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    padding: 12,
    fontSize: 13,
    fontFamily: "monospace",
    overflow: "auto",
    margin: "12px 0 0",
  },
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  card: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    backgroundColor: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: "16px 20px",
    textDecoration: "none",
    transition: "border-color 0.15s",
    cursor: "pointer",
  },
  cardIcon: { fontSize: 28 },
  cardName: { fontSize: 16, fontWeight: 600, color: "#0f172a" },
  cardSlug: { fontSize: 13, color: "#94a3b8", marginTop: 2 },
};
