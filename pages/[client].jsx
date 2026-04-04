import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import Link from "next/link";
import * as XLSX from "xlsx";

const COLUMN_PATTERNS = {
  email: [/usuario/i, /email/i, /correo/i, /mail/i, /empleado/i],
  policy: [/poli[ct]i[ck]a/i, /tipo/i, /licencia/i, /ausencia/i],
  fromDate: [/inicio/i, /desde/i, /from/i, /comienzo/i],
  toDate: [/fin/i, /hasta/i, /to\b/i, /end/i],
  days: [/d[ií]as/i, /cantidad/i, /cant/i, /amount/i],
};

function detectColumn(headers, patterns) {
  for (const p of patterns) {
    const found = headers.find((h) => p.test(h));
    if (found) return found;
  }
  return null;
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
  const slashMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (slashMatch) return `${slashMatch[3]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[1].padStart(2, "0")}`;
  return null;
}

function normalizeStr(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function findUser(input, users) {
  const val = normalizeStr(input);
  if (!val) return { user: null, method: null };

  // 1. Exact email match
  const byEmail = users.find((u) => normalizeStr(u.email) === val);
  if (byEmail) return { user: byEmail, method: "email" };

  // 2. Exact employeeInternalId match
  const byIntId = users.find((u) => normalizeStr(u.employeeInternalId) === val);
  if (byIntId) return { user: byIntId, method: "internalId" };

  // 3. Exact nickname match
  const byNick = users.find((u) => u.nickname && normalizeStr(u.nickname) === val);
  if (byNick) return { user: byNick, method: "nickname" };

  // 4. Exact full name match: "firstName lastName" or "lastName firstName"
  const byFullName = users.find((u) => {
    const fn = normalizeStr(u.firstName);
    const ln = normalizeStr(u.lastName);
    return val === `${fn} ${ln}` || val === `${ln} ${fn}` || val === `${ln}, ${fn}`;
  });
  if (byFullName) return { user: byFullName, method: "nombre completo" };

  // 5. Partial: input contains both firstName and lastName (any order)
  const byParts = users.filter((u) => {
    const fn = normalizeStr(u.firstName);
    const ln = normalizeStr(u.lastName);
    if (!fn || !ln) return false;
    const fnParts = fn.split(/\s+/);
    const lnParts = ln.split(/\s+/);
    const allParts = [...fnParts, ...lnParts];
    return allParts.every((part) => part.length > 1 && val.includes(part));
  });
  if (byParts.length === 1) return { user: byParts[0], method: "nombre parcial" };
  if (byParts.length > 1) return { user: null, method: null, ambiguous: byParts.map((u) => `${u.firstName} ${u.lastName} (${u.email})`) };

  // 6. Email prefix match (before @)
  const valPrefix = val.split("@")[0];
  if (valPrefix && valPrefix.length > 2) {
    const byPrefix = users.find((u) => {
      const uPrefix = normalizeStr(u.email).split("@")[0];
      return uPrefix === valPrefix;
    });
    if (byPrefix) return { user: byPrefix, method: "email prefix" };
  }

  return { user: null, method: null };
}

function getPolicyBlockers(pt) {
  const blockers = [];
  const warnings = [];
  if (pt.noRetroactiveRequests) blockers.push("No permite solicitudes retroactivas");
  if (pt.minimumAdvanceDays && pt.minimumAdvanceDays > 0) blockers.push(`Requiere ${pt.minimumAdvanceDays} dias de anticipacion`);
  if (pt.minimumAmountPerRequest && pt.minimumAmountPerRequest > 1) warnings.push(`Minimo ${pt.minimumAmountPerRequest} dias por solicitud`);
  if (pt.maximumAmountPerRequest) warnings.push(`Maximo ${pt.maximumAmountPerRequest} dias por solicitud`);
  return { blockers, warnings };
}

function getLocalClient(slug) {
  if (typeof window === "undefined") return null;
  try {
    const clients = JSON.parse(localStorage.getItem("humand_clients") || "[]");
    return clients.find((c) => c.slug === slug) || null;
  } catch {
    return null;
  }
}

export default function ClientPage() {
  const [clientSlug, setClientSlug] = useState(null);
  const [clientName, setClientName] = useState("");
  const [credHeaders, setCredHeaders] = useState({});
  const [step, setStep] = useState("loading"); // loading | policies | upload | mapping | executing | done
  const [rows, setRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [columnMap, setColumnMap] = useState({});
  const [users, setUsers] = useState([]);
  const [policyTypes, setPolicyTypes] = useState([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [validatedRows, setValidatedRows] = useState([]);
  const [results, setResults] = useState({});
  const [processing, setProcessing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [dragOver, setDragOver] = useState(false);
  const [loadError, setLoadError] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    const slug = window.location.pathname.replace("/", "");
    setClientSlug(slug);

    // Build auth headers: env client needs none, local client passes creds
    let authHeaders = {};
    const local = getLocalClient(slug);
    if (local) {
      setClientName(local.name);
      authHeaders = { "x-humand-api-key": local.apiKey };
      if (local.jwtToken) authHeaders["x-humand-jwt-token"] = local.jwtToken;
    } else {
      fetch("/api/clients")
        .then((r) => r.json())
        .then((clients) => {
          const c = clients.find((x) => x.slug === slug);
          if (c) setClientName(c.name);
        });
    }
    setCredHeaders(authHeaders);

    Promise.all([
      fetch(`/api/${slug}/users`, { headers: authHeaders }).then((r) => r.json()),
      fetch(`/api/${slug}/policy-types`, { headers: authHeaders }).then((r) => r.json()),
    ]).then(([usersRes, ptRes]) => {
      if (usersRes.error) { setLoadError(usersRes.details || usersRes.error); setStep("policies"); return; }
      setUsers(Array.isArray(usersRes) ? usersRes : []);
      setPolicyTypes(Array.isArray(ptRes) ? ptRes : []);
      setStep("policies");
    }).catch((e) => { setLoadError(e.message); setStep("policies"); });
  }, []);

  const handleFile = useCallback(
    (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        if (json.length === 0) return;
        const hdrs = Object.keys(json[0]);
        setHeaders(hdrs);
        setRows(json);
        const map = {
          email: detectColumn(hdrs, COLUMN_PATTERNS.email),
          policy: detectColumn(hdrs, COLUMN_PATTERNS.policy),
          fromDate: detectColumn(hdrs, COLUMN_PATTERNS.fromDate),
          toDate: detectColumn(hdrs, COLUMN_PATTERNS.toDate),
          days: detectColumn(hdrs, COLUMN_PATTERNS.days),
        };
        setColumnMap(map);
        setStep("mapping");
      };
      reader.readAsArrayBuffer(file);
    },
    []
  );

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  useEffect(() => {
    if (step !== "mapping" || users.length === 0 || policyTypes.length === 0) return;
    const validated = rows.map((row) => {
      const userInput = (row[columnMap.email] || "").toString().trim();
      const policyName = normalizeStr(row[columnMap.policy]);
      const fromDate = parseDate(row[columnMap.fromDate]);
      const toDate = parseDate(row[columnMap.toDate]);
      const { user, method: matchMethod, ambiguous } = findUser(userInput, users);
      const pt = policyTypes.find((p) => normalizeStr(p.policyTypeName) === policyName);
      const errors = [];
      const warnings = [];
      if (!userInput) errors.push("Usuario vacio");
      else if (ambiguous) errors.push(`Ambiguo: ${ambiguous.join(", ")}`);
      else if (!user) errors.push(`Usuario "${userInput}" no encontrado`);
      else if (matchMethod && matchMethod !== "email") warnings.push(`Match por ${matchMethod}`);
      if (!policyName) errors.push("Politica vacia");
      else if (!pt) errors.push(`Tipo de politica "${row[columnMap.policy]}" no encontrado`);
      if (!fromDate) errors.push("Fecha inicio invalida");
      if (!toDate) errors.push("Fecha fin invalida");
      if (fromDate && toDate && fromDate > toDate) errors.push("Fecha inicio > fecha fin");
      if (pt) {
        const { blockers } = getPolicyBlockers(pt);
        if (blockers.length > 0) errors.push(`Politica bloqueada: ${blockers[0]}`);
      }
      return {
        raw: row,
        email: row[columnMap.email],
        policyName: row[columnMap.policy],
        fromDate,
        toDate,
        days: row[columnMap.days],
        userId: user?.id,
        userName: user ? `${user.firstName} ${user.lastName}` : null,
        userEmail: user?.email,
        matchMethod,
        policyTypeId: pt?.policyTypeId,
        policyTypeName: pt?.policyTypeName,
        policyDetail: pt?.policyName,
        errors,
        warnings,
        valid: errors.length === 0,
      };
    });
    setValidatedRows(validated);
  }, [step, rows, users, policyTypes, columnMap]);

  const executeAll = async () => {
    setProcessing(true);
    setStep("executing");
    const newResults = {};
    for (let i = 0; i < validatedRows.length; i++) {
      const row = validatedRows[i];
      if (!row.valid) {
        newResults[i] = { ok: false, error: row.errors.join(", "), skipped: true };
        setResults({ ...newResults });
        continue;
      }
      setCurrentIndex(i);
      try {
        const createRes = await fetch(`/api/${clientSlug}/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...credHeaders },
          body: JSON.stringify({
            issuerId: row.userId,
            policyTypeId: row.policyTypeId,
            fromDate: row.fromDate,
            toDate: row.toDate,
          }),
        });
        const createData = await createRes.json();
        if (!createRes.ok) {
          newResults[i] = { ok: false, error: createData.error || "Error al crear" };
          setResults({ ...newResults });
          continue;
        }
        const approveRes = await fetch(`/api/${clientSlug}/approve`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...credHeaders },
          body: JSON.stringify({ requestId: createData.id }),
        });
        if (approveRes.ok) {
          newResults[i] = { ok: true, requestId: createData.id, days: createData.amountRequested };
        } else {
          newResults[i] = { ok: false, error: "Creada pero no se pudo aprobar", requestId: createData.id };
        }
      } catch (err) {
        newResults[i] = { ok: false, error: err.message };
      }
      setResults({ ...newResults });
    }
    setProcessing(false);
    setStep("done");
  };

  const successCount = Object.values(results).filter((r) => r.ok).length;
  const errorCount = Object.values(results).filter((r) => !r.ok && !r.skipped).length;
  const skippedCount = Object.values(results).filter((r) => r.skipped).length;
  const validCount = validatedRows.filter((r) => r.valid).length;

  const downloadResults = () => {
    const exportRows = validatedRows.map((row, i) => {
      const r = results[i];
      const resultado = r?.ok ? `OK (#${r.requestId})` : r?.error || "Sin procesar";
      return {
        ...row.raw,
        "Usuario Resuelto": row.userName || "",
        "Email Resuelto": row.userEmail || "",
        "Match": row.matchMethod || "",
        "Politica Resuelta": row.policyTypeName || "",
        Resultado: resultado,
      };
    });
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Resultados");
    XLSX.writeFile(wb, `resultados-${clientSlug}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <>
      <Head>
        <title>{clientName || clientSlug} - Cargador de Ausencias</title>
      </Head>
      <div style={styles.container}>
        <div style={styles.content}>
          <div style={styles.header}>
            <Link href="/" style={styles.back}>
              ← Volver
            </Link>
            <h1 style={styles.title}>{clientName || clientSlug}</h1>
            <p style={styles.subtitle}>Carga masiva de ausencias/vacaciones</p>
          </div>

          {step === "loading" && (
            <div style={styles.section}>
              <p style={styles.loading}>Cargando informacion de la comunidad...</p>
            </div>
          )}

          {step === "policies" && (
            <>
              <div style={styles.section}>
                <h2 style={styles.sectionTitle}>Politicas de ausencia ({policyTypes.length})</h2>
                {loadError && (
                  <div style={styles.blockerNote}>Error al cargar datos: {loadError}</div>
                )}
                {!loadError && policyTypes.length === 0 ? (
                  <p style={{ color: "#991b1b", fontSize: 14 }}>No se encontraron politicas. Verifica que la API Key sea valida.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={styles.th}>Tipo de Politica</th>
                          <th style={styles.th}>Politica</th>
                          <th style={styles.th}>Usuarios</th>
                          <th style={styles.th}>Conteo</th>
                          <th style={styles.th}>Min dias</th>
                          <th style={styles.th}>Max dias</th>
                          <th style={styles.th}>Retroactivo</th>
                          <th style={styles.th}>Anticipacion</th>
                          <th style={styles.th}>Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {policyTypes.map((pt) => {
                          const { blockers, warnings } = getPolicyBlockers(pt);
                          const hasBlocker = blockers.length > 0;
                          return (
                            <tr key={pt.policyId} style={{ backgroundColor: hasBlocker ? "#fef2f2" : warnings.length > 0 ? "#fffbeb" : "#f0fdf4" }}>
                              <td style={styles.td}><strong>{pt.policyTypeName}</strong></td>
                              <td style={styles.td}>{pt.policyName}</td>
                              <td style={styles.td}>{pt.userCount}</td>
                              <td style={styles.td}>{pt.countingMethod === "CALENDAR_DAYS" ? "Corridos" : "Habiles"}</td>
                              <td style={styles.td}>{pt.minimumAmountPerRequest || "-"}</td>
                              <td style={styles.td}>{pt.maximumAmountPerRequest || "Sin limite"}</td>
                              <td style={{ ...styles.td, color: pt.noRetroactiveRequests ? "#991b1b" : "#166534", fontWeight: 600 }}>
                                {pt.noRetroactiveRequests ? "NO" : "SI"}
                              </td>
                              <td style={styles.td}>{pt.minimumAdvanceDays ? `${pt.minimumAdvanceDays} dias` : "Ninguna"}</td>
                              <td style={styles.td}>
                                {hasBlocker ? (
                                  <span style={styles.badge.error} title={blockers.join("\n")}>BLOQUEADA</span>
                                ) : warnings.length > 0 ? (
                                  <span style={styles.badge.warning} title={warnings.join("\n")}>ADVERTENCIA</span>
                                ) : (
                                  <span style={styles.badge.ok}>OK</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {policyTypes.some((pt) => getPolicyBlockers(pt).blockers.length > 0) && (
                  <div style={styles.blockerNote}>
                    Las politicas marcadas como BLOQUEADA no permiten crear ausencias en el pasado.
                    Desactiva "No permitir solicitudes retroactivas" y/o "Dias minimos de anticipacion" en la configuracion de la politica desde el panel de Humand antes de continuar.
                  </div>
                )}
              </div>
              <div style={styles.section}>
                <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
                  {users.length} usuarios cargados en esta comunidad
                </p>
              </div>
              <div style={styles.actions}>
                <button style={styles.btnPrimary} onClick={() => setStep("upload")}>
                  Continuar a carga de archivo
                </button>
              </div>
            </>
          )}

          {step === "upload" && (
            <div
              style={{ ...styles.dropzone, borderColor: dragOver ? "#2563eb" : "#cbd5e1", backgroundColor: dragOver ? "#eff6ff" : "#fff" }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: "none" }}
                onChange={(e) => handleFile(e.target.files[0])}
              />
              <div style={{ fontSize: 40, marginBottom: 8 }}>📄</div>
              <p style={{ margin: 0, fontWeight: 600, color: "#334155" }}>
                Arrastra un archivo Excel o CSV aqui
              </p>
              <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
                o haz click para seleccionar
              </p>
            </div>
          )}

          {step === "mapping" && (
            <>
              <div style={styles.section}>
                <h2 style={styles.sectionTitle}>Mapeo de columnas</h2>
                <div style={styles.mappingGrid}>
                  {Object.entries({ email: "Usuario (email/nombre)", policy: "Politica", fromDate: "Fecha inicio", toDate: "Fecha fin", days: "Dias (info)" }).map(
                    ([key, label]) => (
                      <div key={key} style={styles.mappingRow}>
                        <label style={styles.mappingLabel}>{label}</label>
                        <select
                          value={columnMap[key] || ""}
                          onChange={(e) => setColumnMap({ ...columnMap, [key]: e.target.value || null })}
                          style={styles.select}
                        >
                          <option value="">-- No mapear --</option>
                          {headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    )
                  )}
                </div>
              </div>

              {loadingMeta && <p style={styles.loading}>Cargando usuarios y politicas del cliente...</p>}

              {!loadingMeta && validatedRows.length > 0 && (
                <>
                  <div style={styles.section}>
                    <h2 style={styles.sectionTitle}>
                      Vista previa ({validCount} validas de {validatedRows.length})
                    </h2>
                    <div style={{ overflowX: "auto" }}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>#</th>
                            <th style={styles.th}>Usuario</th>
                            <th style={styles.th}>Politica</th>
                            <th style={styles.th}>Desde</th>
                            <th style={styles.th}>Hasta</th>
                            <th style={styles.th}>Dias</th>
                            <th style={styles.th}>Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {validatedRows.map((row, i) => (
                            <tr key={i} style={{ backgroundColor: row.valid ? "#fff" : "#fef2f2" }}>
                              <td style={styles.td}>{i + 1}</td>
                              <td style={styles.td}>
                                <div>{row.email}</div>
                                {row.userName && <div style={{ fontSize: 12, color: "#64748b" }}>{row.userName}{row.matchMethod !== "email" ? ` (${row.userEmail})` : ""}</div>}
                                {row.matchMethod && row.matchMethod !== "email" && (
                                  <div style={{ fontSize: 11, color: "#d97706" }}>Match: {row.matchMethod}</div>
                                )}
                              </td>
                              <td style={styles.td}>{row.policyTypeName || row.policyName}</td>
                              <td style={styles.td}>{row.fromDate || "?"}</td>
                              <td style={styles.td}>{row.toDate || "?"}</td>
                              <td style={styles.td}>{row.days}</td>
                              <td style={styles.td}>
                                {row.valid ? (
                                  <span style={styles.badge.ok}>OK</span>
                                ) : (
                                  <span style={styles.badge.error} title={row.errors.join("\n")}>
                                    {row.errors[0]}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div style={styles.actions}>
                    <button style={styles.btnSecondary} onClick={() => { setStep("upload"); setRows([]); setValidatedRows([]); setResults({}); }}>
                      Cancelar
                    </button>
                    <button style={{ ...styles.btnPrimary, opacity: validCount === 0 ? 0.5 : 1 }} disabled={validCount === 0} onClick={executeAll}>
                      Crear {validCount} ausencias
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {(step === "executing" || step === "done") && (
            <div style={styles.section}>
              <h2 style={styles.sectionTitle}>
                {step === "executing" ? `Procesando ${currentIndex + 1} de ${validatedRows.length}...` : "Resultado"}
              </h2>
              {step === "done" && (
                <div style={styles.summary}>
                  {successCount > 0 && <span style={styles.summaryOk}>{successCount} creadas</span>}
                  {errorCount > 0 && <span style={styles.summaryError}>{errorCount} con error</span>}
                  {skippedCount > 0 && <span style={styles.summarySkip}>{skippedCount} omitidas</span>}
                </div>
              )}
              <div style={{ overflowX: "auto" }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>#</th>
                      <th style={styles.th}>Usuario</th>
                      <th style={styles.th}>Politica</th>
                      <th style={styles.th}>Desde</th>
                      <th style={styles.th}>Hasta</th>
                      <th style={styles.th}>Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validatedRows.map((row, i) => {
                      const r = results[i];
                      const isProcessing = step === "executing" && i === currentIndex;
                      return (
                        <tr key={i} style={{ backgroundColor: isProcessing ? "#fffbeb" : r?.ok ? "#f0fdf4" : r?.error ? "#fef2f2" : "#fff" }}>
                          <td style={styles.td}>{i + 1}</td>
                          <td style={styles.td}>{row.email}</td>
                          <td style={styles.td}>{row.policyTypeName || row.policyName}</td>
                          <td style={styles.td}>{row.fromDate}</td>
                          <td style={styles.td}>{row.toDate}</td>
                          <td style={styles.td}>
                            {isProcessing && <span style={{ color: "#d97706" }}>...</span>}
                            {r?.ok && <span style={styles.badge.ok}>OK (#{r.requestId})</span>}
                            {r && !r.ok && <span style={styles.badge.error} title={r.error}>{r.skipped ? "Omitida" : r.error}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {step === "done" && (
                <div style={{ ...styles.actions, marginTop: 16 }}>
                  <button style={styles.btnSecondary} onClick={() => { setStep("upload"); setRows([]); setValidatedRows([]); setResults({}); }}>
                    Cargar otro archivo
                  </button>
                  <button style={styles.btnPrimary} onClick={downloadResults}>
                    Descargar resultados (.xlsx)
                  </button>
                </div>
              )}
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
  content: { maxWidth: 1200, width: "100%", padding: "32px 16px" },
  header: { marginBottom: 24 },
  back: { color: "#64748b", fontSize: 13, textDecoration: "none" },
  title: { fontSize: 24, fontWeight: 700, color: "#0f172a", margin: "8px 0 0" },
  subtitle: { fontSize: 14, color: "#64748b", margin: "4px 0 0" },
  dropzone: {
    border: "2px dashed #cbd5e1",
    borderRadius: 12,
    padding: "48px 24px",
    textAlign: "center",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  section: { backgroundColor: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: 20, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontWeight: 600, color: "#0f172a", margin: "0 0 16px" },
  mappingGrid: { display: "flex", flexDirection: "column", gap: 10 },
  mappingRow: { display: "flex", alignItems: "center", gap: 12 },
  mappingLabel: { width: 120, fontSize: 14, fontWeight: 500, color: "#334155" },
  select: {
    flex: 1,
    padding: "6px 10px",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    fontSize: 14,
    backgroundColor: "#fff",
  },
  loading: { color: "#64748b", fontSize: 14 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    borderBottom: "2px solid #e2e8f0",
    color: "#64748b",
    fontWeight: 600,
    fontSize: 12,
    textTransform: "uppercase",
  },
  td: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", color: "#334155" },
  badge: {
    ok: {
      backgroundColor: "#dcfce7",
      color: "#166534",
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 500,
    },
    error: {
      backgroundColor: "#fef2f2",
      color: "#991b1b",
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 500,
    },
    warning: {
      backgroundColor: "#fffbeb",
      color: "#92400e",
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 500,
    },
  },
  blockerNote: {
    marginTop: 16,
    padding: 12,
    backgroundColor: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 6,
    fontSize: 13,
    color: "#991b1b",
    lineHeight: 1.5,
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 },
  btnPrimary: {
    backgroundColor: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnSecondary: {
    backgroundColor: "#fff",
    color: "#334155",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  },
  summary: { display: "flex", gap: 12, marginBottom: 16 },
  summaryOk: { color: "#166534", fontWeight: 600, fontSize: 14 },
  summaryError: { color: "#991b1b", fontWeight: 600, fontSize: 14 },
  summarySkip: { color: "#92400e", fontWeight: 600, fontSize: 14 },
};
