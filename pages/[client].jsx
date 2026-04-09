import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import Link from "next/link";
import * as XLSX from "xlsx";
import { getHistory, addHistoryEntry, deleteHistoryEntry, updateHistoryEntry, generateEntryId, getDedupMap, saveDedupEntry, dedupMakeKey } from "../lib/history";

const COLUMN_PATTERNS = {
  email: [/usuario/i, /email/i, /correo/i, /mail/i, /empleado/i],
  policy: [/poli[ct]i[ck]a/i, /tipo/i, /licencia/i, /ausencia/i],
  fromDate: [/inicio/i, /desde/i, /from/i, /comienzo/i],
  toDate: [/fin/i, /hasta/i, /to\b/i, /end/i],
  days: [/d[ií]as/i, /cantidad/i, /cant/i, /amount/i],
};

function detectColumn(headers, patterns) {
  for (const p of patterns) {
    const found = headers.find((h) => p.test(normalizeStr(h)));
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

function countDays(fromDate, toDate, countingMethod) {
  if (!fromDate || !toDate) return null;
  const from = new Date(fromDate + "T00:00:00");
  const to = new Date(toDate + "T00:00:00");
  if (isNaN(from) || isNaN(to) || from > to) return null;
  let count = 0;
  const d = new Date(from);
  while (d <= to) {
    if (countingMethod === "BUSINESS_DAYS") {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) count++;
    } else {
      count++;
    }
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function findUser(input, users) {
  const val = normalizeStr(input);
  if (!val) return { user: null, method: null };

  const byEmail = users.find((u) => normalizeStr(u.email) === val);
  if (byEmail) return { user: byEmail, method: "email" };

  const byIntId = users.find((u) => normalizeStr(u.employeeInternalId) === val);
  if (byIntId) return { user: byIntId, method: "internalId" };

  const byNick = users.find((u) => u.nickname && normalizeStr(u.nickname) === val);
  if (byNick) return { user: byNick, method: "nickname" };

  const byFullName = users.find((u) => {
    const fn = normalizeStr(u.firstName);
    const ln = normalizeStr(u.lastName);
    return val === `${fn} ${ln}` || val === `${ln} ${fn}` || val === `${ln}, ${fn}`;
  });
  if (byFullName) return { user: byFullName, method: "nombre completo" };

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
  if (pt.minimumAdvanceDays && pt.minimumAdvanceDays > 0) blockers.push(`Requiere ${pt.minimumAdvanceDays} días de anticipación`);
  if (pt.minimumAmountPerRequest && pt.minimumAmountPerRequest > 1) warnings.push(`Mínimo ${pt.minimumAmountPerRequest} días por solicitud`);
  if (pt.maximumAmountPerRequest) warnings.push(`Máximo ${pt.maximumAmountPerRequest} días por solicitud`);
  return { blockers, warnings };
}

// Detectar si un error indica token expirado
function isAuthError(error) {
  const msg = (error || "").toLowerCase();
  return msg.includes("client not configured") || 
         msg.includes("unauthorized") || 
         msg.includes("token") ||
         msg.includes("401") ||
         msg.includes("403");
}

export default function ClientPage() {
  const [clientSlug, setClientSlug] = useState(null);
  const [clientName, setClientName] = useState("");
  const [step, setStep] = useState("loading");
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
  const [fileName, setFileName] = useState("");
  const [history, setHistory] = useState([]);
  
  // Estados para refresh de token
  const [showRefreshModal, setShowRefreshModal] = useState(false);
  const [refreshPassword, setRefreshPassword] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [tokenStatus, setTokenStatus] = useState(null); // 'ok', 'expiring', 'expired'
  const [authErrorCount, setAuthErrorCount] = useState(0);

  // Contraseña de sesión (en memoria, nunca persistida) para auto-refresh durante carga
  const [sessionPassword, setSessionPassword] = useState("");
  
  // Estado para exportación consolidada
  const [exporting, setExporting] = useState(false);
  
  // Estado para verificación de pendientes
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const verifyFileRef = useRef(null);

  // Estado para visor de solicitudes Humand
  const [showRequestsModal, setShowRequestsModal] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsData, setRequestsData] = useState(null);
  const [requestsError, setRequestsError] = useState("");
  
  const fileRef = useRef(null);

  useEffect(() => {
    const slug = window.location.pathname.replace("/", "");
    setClientSlug(slug);

    fetch(`/api/clients?slug=${slug}`)
      .then((r) => r.json())
      .then((c) => { 
        if (c.name) setClientName(c.name);
        // Verificar estado del token
        if (c.jwtRefreshedAt) {
          const refreshedAt = new Date(c.jwtRefreshedAt);
          const hoursSinceRefresh = (Date.now() - refreshedAt.getTime()) / (1000 * 60 * 60);
          if (hoursSinceRefresh > 1) {
            setTokenStatus('expired');
          } else if (hoursSinceRefresh > 0.75) {
            setTokenStatus('expiring');
          } else {
            setTokenStatus('ok');
          }
        }
      });

    Promise.all([
      fetch(`/api/${slug}/users`).then((r) => r.json()),
      fetch(`/api/${slug}/policy-types`).then((r) => r.json()),
    ]).then(([usersRes, ptRes]) => {
      if (usersRes.error) { setLoadError(usersRes.details || usersRes.error); setStep("policies"); return; }
      setUsers(Array.isArray(usersRes) ? usersRes : []);
      setPolicyTypes(Array.isArray(ptRes) ? ptRes : []);
      setStep("policies");
      setHistory(getHistory(slug));
    }).catch((e) => { setLoadError(e.message); setStep("policies"); setHistory(getHistory(slug)); });
  }, []);

  const handleRefreshToken = async () => {
    const pwdToUse = refreshPassword.trim() || sessionPassword.trim();
    if (!pwdToUse) {
      setRefreshError("La contraseña es obligatoria");
      return;
    }
    setRefreshing(true);
    setRefreshError("");

    try {
      const res = await fetch(`/api/${clientSlug}/refresh-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwdToUse }),
      });
      const data = await res.json();
      
      if (!res.ok) {
        setRefreshError(data.error || "Error al refrescar token");
        setRefreshing(false);
        return;
      }
      
      setTokenStatus('ok');
      setShowRefreshModal(false);
      // Guardar la contraseña en sesión para auto-refresh futuro
      if (refreshPassword && !sessionPassword) setSessionPassword(refreshPassword);
      setRefreshPassword("");
      setAuthErrorCount(0);
      alert("✅ Token refrescado exitosamente. Ya puedes continuar con la carga.");
    } catch (err) {
      setRefreshError("Error de conexión: " + err.message);
    }
    setRefreshing(false);
  };

  const exportConsolidated = async () => {
    const entriesWithBlob = history.filter((e) => e.blobUrl && e.successCount > 0);
    if (entriesWithBlob.length === 0) {
      alert("No hay cargas exitosas para exportar.");
      return;
    }

    setExporting(true);
    const allSuccessRows = [];

    // Función para formatear fecha a dd/mm/yyyy
    const formatDate = (val) => {
      if (!val) return "";
      let d;
      if (val instanceof Date) {
        d = val;
      } else if (typeof val === "number") {
        // Excel serial date
        d = new Date((val - 25569) * 86400 * 1000);
      } else {
        const s = String(val).trim();
        // Intentar parsear yyyy-mm-dd
        const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (isoMatch) {
          return `${isoMatch[3].padStart(2, "0")}/${isoMatch[2].padStart(2, "0")}/${isoMatch[1]}`;
        }
        // Intentar parsear mm/dd/yy o m/d/yy
        const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (usMatch) {
          const year = usMatch[3].length === 2 ? "20" + usMatch[3] : usMatch[3];
          return `${usMatch[2].padStart(2, "0")}/${usMatch[1].padStart(2, "0")}/${year}`;
        }
        return s;
      }
      if (isNaN(d.getTime())) return String(val);
      const day = String(d.getDate()).padStart(2, "0");
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const year = d.getFullYear();
      return `${day}/${month}/${year}`;
    };

    try {
      for (const entry of entriesWithBlob) {
        try {
          const response = await fetch(entry.blobUrl);
          if (!response.ok) continue;
          
          const arrayBuffer = await response.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);
          const workbook = XLSX.read(data, { type: "array", cellDates: true });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
          
          // Filtrar solo las filas exitosas (resultado empieza con "OK" o "Ya existía")
          const successRows = rows.filter((row) => {
            const resultado = (row.Resultado || "").toString();
            return resultado.startsWith("OK") || resultado.startsWith("Ya existía");
          });

          // Agregar metadata de la carga
          for (const row of successRows) {
            // Extraer el Request ID del resultado "OK (#123456)" o "Ya existía (#123456)"
            const match = (row.Resultado || "").match(/\(#(\d+)\)/);
            const requestId = match ? match[1] : "";
            
            allSuccessRows.push({
              "Fecha de Carga": new Date(entry.timestamp).toLocaleString("es-AR", { 
                day: "2-digit", month: "2-digit", year: "numeric", 
                hour: "2-digit", minute: "2-digit" 
              }),
              "Archivo Origen": entry.fileName,
              "Usuario Excel": row.Usuario || "",
              "Usuario Resuelto": row["Usuario Resuelto"] || "",
              "Email": row["Email Resuelto"] || "",
              "Match": row.Match || "",
              "Política Excel": row.Politicas || "",
              "Política Resuelta": row["Politica Resuelta"] || row["Política Resuelta"] || "",
              "Fecha Inicio": formatDate(row["Día de Inicio"] || row["Fecha Inicio"] || ""),
              "Fecha Fin": formatDate(row["Día de fin"] || row["Fecha Fin"] || ""),
              "Días Solicitados": row["Cant de días habiles solicitados"] || row["Cant de dias habiles solicitados"] || "",
              "Días Esperados": row["Dias Esperados"] || row["Días Esperados"] || "",
              "Días Humand": row["Dias Humand"] || row["Días Humand"] || "",
              "Conteo": row.Conteo || "",
              "Discrepancia": row.Discrepancia || "",
              "Request ID": requestId,
            });
          }
        } catch (err) {
          console.error(`Error procesando ${entry.fileName}:`, err);
        }
      }

      if (allSuccessRows.length === 0) {
        alert("No se encontraron registros exitosos en los archivos.");
        setExporting(false);
        return;
      }

      // Ordenar por Request ID (más reciente primero)
      allSuccessRows.sort((a, b) => {
        const idA = parseInt(a["Request ID"]) || 0;
        const idB = parseInt(b["Request ID"]) || 0;
        return idB - idA;
      });

      // Crear el Excel consolidado
      const ws = XLSX.utils.json_to_sheet(allSuccessRows);
      
      // Ajustar anchos de columna
      ws["!cols"] = [
        { wch: 18 }, // Fecha de Carga
        { wch: 40 }, // Archivo Origen
        { wch: 28 }, // Usuario Excel
        { wch: 28 }, // Usuario Resuelto
        { wch: 32 }, // Email
        { wch: 10 }, // Match
        { wch: 15 }, // Política Excel
        { wch: 22 }, // Política Resuelta
        { wch: 12 }, // Fecha Inicio
        { wch: 12 }, // Fecha Fin
        { wch: 10 }, // Días Solicitados
        { wch: 10 }, // Días Esperados
        { wch: 10 }, // Días Humand
        { wch: 10 }, // Conteo
        { wch: 35 }, // Discrepancia
        { wch: 12 }, // Request ID
      ];
      
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Ausencias Cargadas");
      
      const fileName = `ausencias-consolidado-${clientSlug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, fileName);
      
    } catch (err) {
      alert("Error al exportar: " + err.message);
    }
    
    setExporting(false);
  };

  // Función para normalizar fechas a formato comparable yyyy-mm-dd
  const normalizeDateForCompare = (val) => {
    if (!val) return "";
    if (val instanceof Date) {
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, "0");
      const d = String(val.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    const s = String(val).trim();
    // yyyy-mm-dd
    const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    // dd/mm/yyyy
    const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`;
    // m/d/yy o mm/dd/yy (formato US)
    const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    if (usMatch) {
      const year = "20" + usMatch[3];
      return `${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
    }
    // m/d/yyyy (formato US)
    const usMatch2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (usMatch2) {
      return `${usMatch2[3]}-${usMatch2[1].padStart(2, "0")}-${usMatch2[2].padStart(2, "0")}`;
    }
    return s;
  };

  // Crear clave única para comparar filas
  const createRowKey = (email, policy, fromDate, toDate) => {
    const e = normalizeStr(email).split("@")[0]; // solo la parte antes del @
    const p = normalizeStr(policy);
    const f = normalizeDateForCompare(fromDate);
    const t = normalizeDateForCompare(toDate);
    return `${e}|${p}|${f}|${t}`;
  };

  const verifyPendientes = async (file) => {
    if (!file) return;
    setVerifying(true);
    
    try {
      // 1. Leer el archivo original
      const reader = new FileReader();
      const originalRows = await new Promise((resolve, reject) => {
        reader.onload = (e) => {
          try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: "array", cellDates: true });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
            resolve(rows);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      });

      // 2. Obtener todas las filas exitosas del historial
      const entriesWithBlob = history.filter((e) => e.blobUrl && e.successCount > 0);
      const successfulKeys = new Set();
      const successfulRows = [];

      for (const entry of entriesWithBlob) {
        try {
          const response = await fetch(entry.blobUrl);
          if (!response.ok) continue;
          
          const arrayBuffer = await response.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);
          const workbook = XLSX.read(data, { type: "array", cellDates: true });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
          
          for (const row of rows) {
            const resultado = (row.Resultado || "").toString();
            if (resultado.startsWith("OK")) {
              const email = row["Email Resuelto"] || row.Usuario || "";
              const policy = row["Politica Resuelta"] || row["Política Resuelta"] || row.Politicas || "";
              const fromDate = row["Día de Inicio"] || row["Fecha Inicio"] || "";
              const toDate = row["Día de fin"] || row["Fecha Fin"] || "";
              const key = createRowKey(email, policy, fromDate, toDate);
              successfulKeys.add(key);
              
              // Extraer Request ID
              const match = resultado.match(/OK \(#(\d+)\)/);
              successfulRows.push({
                ...row,
                _key: key,
                _requestId: match ? match[1] : "",
                _cargaTimestamp: entry.timestamp,
                _cargaArchivo: entry.fileName,
              });
            }
          }
        } catch (err) {
          console.error(`Error procesando ${entry.fileName}:`, err);
        }
      }

      // 3. Detectar columnas del archivo original
      const headers = Object.keys(originalRows[0] || {});
      const emailCol = headers.find(h => /usuario|email|correo|mail/i.test(h)) || headers[0];
      const policyCol = headers.find(h => /poli[ct]i[ck]a|tipo|licencia/i.test(h)) || headers[1];
      const fromCol = headers.find(h => /inicio|desde|from/i.test(h)) || headers[2];
      const toCol = headers.find(h => /fin|hasta|to\b|end/i.test(h)) || headers[3];

      // 4. Clasificar filas del archivo original
      const pendientes = [];
      const cargadas = [];

      for (const row of originalRows) {
        const email = row[emailCol] || "";
        const policy = row[policyCol] || "";
        const fromDate = row[fromCol] || "";
        const toDate = row[toCol] || "";
        const key = createRowKey(email, policy, fromDate, toDate);

        if (successfulKeys.has(key)) {
          // Buscar el registro exitoso correspondiente
          const successRow = successfulRows.find(r => r._key === key);
          cargadas.push({
            "Usuario": email,
            "Política": policy,
            "Fecha Inicio": fromDate,
            "Fecha Fin": toDate,
            ...Object.fromEntries(
              Object.entries(row).filter(([k]) => ![emailCol, policyCol, fromCol, toCol].includes(k))
            ),
            "Estado": "✓ CARGADA",
            "Request ID": successRow?._requestId || "",
            "Fecha de Carga": successRow?._cargaTimestamp ? new Date(successRow._cargaTimestamp).toLocaleString("es-AR") : "",
          });
        } else {
          pendientes.push({
            "Usuario": email,
            "Política": policy,
            "Fecha Inicio": fromDate,
            "Fecha Fin": toDate,
            ...Object.fromEntries(
              Object.entries(row).filter(([k]) => ![emailCol, policyCol, fromCol, toCol].includes(k))
            ),
            "Estado": "⚠ PENDIENTE",
          });
        }
      }

      // 5. Generar Excel con 2 hojas
      const wb = XLSX.utils.book_new();
      
      // Hoja de resumen
      const resumenData = [
        { "Métrica": "Total en archivo original", "Cantidad": originalRows.length },
        { "Métrica": "Cargadas exitosamente", "Cantidad": cargadas.length },
        { "Métrica": "Pendientes de cargar", "Cantidad": pendientes.length },
        { "Métrica": "Porcentaje completado", "Cantidad": `${Math.round((cargadas.length / originalRows.length) * 100)}%` },
      ];
      const wsResumen = XLSX.utils.json_to_sheet(resumenData);
      wsResumen["!cols"] = [{ wch: 25 }, { wch: 15 }];
      XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen");

      // Hoja de cargadas
      if (cargadas.length > 0) {
        const wsCargadas = XLSX.utils.json_to_sheet(cargadas);
        wsCargadas["!cols"] = [
          { wch: 30 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
          { wch: 12 }, { wch: 12 }, { wch: 20 },
        ];
        XLSX.utils.book_append_sheet(wb, wsCargadas, "Cargadas OK");
      }

      // Hoja de pendientes
      if (pendientes.length > 0) {
        const wsPendientes = XLSX.utils.json_to_sheet(pendientes);
        wsPendientes["!cols"] = [
          { wch: 30 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
          { wch: 15 },
        ];
        XLSX.utils.book_append_sheet(wb, wsPendientes, "Pendientes");
      }

      const fileName = `verificacion-${clientSlug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, fileName);

      setShowVerifyModal(false);
      alert(`✅ Verificación completada:\n\n• ${cargadas.length} cargadas OK\n• ${pendientes.length} pendientes\n\nSe descargó el archivo "${fileName}"`);
      
    } catch (err) {
      alert("Error al verificar: " + err.message);
    }
    
    setVerifying(false);
  };

  const handleFile = useCallback(
    (file) => {
      if (!file) return;
      setFileName(file.name);
      const isCsv = /\.(csv|tsv|txt)$/i.test(file.name);
      const reader = new FileReader();
      reader.onload = (e) => {
        let wb;
        if (isCsv) {
          wb = XLSX.read(e.target.result, { type: "string", cellDates: true });
        } else {
          const data = new Uint8Array(e.target.result);
          wb = XLSX.read(data, { type: "array", cellDates: true });
        }
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
      if (isCsv) {
        reader.readAsText(file, "UTF-8");
      } else {
        reader.readAsArrayBuffer(file);
      }
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
      const pt = policyTypes.find((p) => normalizeStr(p.policyTypeName) === policyName || normalizeStr(p.policyName) === policyName);
      const errors = [];
      const warnings = [];
      if (!userInput) errors.push("Usuario vacío");
      else if (ambiguous) errors.push(`Ambiguo: ${ambiguous.join(", ")}`);
      else if (!user) errors.push(`Usuario "${userInput}" no encontrado`);
      else if (matchMethod && matchMethod !== "email") warnings.push(`Match por ${matchMethod}`);
      if (!policyName) errors.push("Política vacía");
      else if (!pt) errors.push(`Tipo de política "${row[columnMap.policy]}" no encontrado`);
      if (!fromDate) errors.push("Fecha inicio inválida");
      if (!toDate) errors.push("Fecha fin inválida");
      if (fromDate && toDate && fromDate > toDate) errors.push("Fecha inicio > fecha fin");
      if (pt) {
        const { blockers } = getPolicyBlockers(pt);
        if (blockers.length > 0) errors.push(`Política bloqueada: ${blockers[0]}`);
      }
      const cm = pt?.countingMethod || "CALENDAR_DAYS";
      const expectedDays = countDays(fromDate, toDate, cm);
      const excelDays = row[columnMap.days] ? Number(row[columnMap.days]) : null;
      if (expectedDays && excelDays && excelDays !== expectedDays) {
        warnings.push(`Excel dice ${excelDays} días, calculados: ${expectedDays} ${cm === "BUSINESS_DAYS" ? "hábiles" : "corridos"}`);
      }
      return {
        raw: row,
        email: row[columnMap.email],
        policyName: row[columnMap.policy],
        fromDate,
        toDate,
        days: row[columnMap.days],
        expectedDays,
        countingMethod: cm,
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

  const loadAllRequests = async () => {
    setRequestsLoading(true);
    setRequestsError("");
    setRequestsData(null);
    setShowRequestsModal(true);
    try {
      const res = await fetch(`/api/${clientSlug}/all-requests`);
      const data = await res.json();
      if (!res.ok) { setRequestsError(data.error || "Error cargando solicitudes"); setRequestsLoading(false); return; }

      const items = data.items || [];

      // Normalizar campos (distintos formatos posibles de la API)
      const normalized = items.map((r) => ({
        id: r.id,
        userId: r.issuerId || r.userId || r.issuer?.id,
        userName: r.issuer ? `${r.issuer.firstName || ""} ${r.issuer.lastName || ""}`.trim() : (r.userName || ""),
        userEmail: r.issuer?.email || r.userEmail || "",
        policy: r.policyType?.name || r.policyTypeName || r.policy || "",
        policyTypeId: r.policyTypeId || r.policyType?.id || "",
        fromDate: r.from?.date || r.fromDate || "",
        toDate: r.to?.date || r.toDate || "",
        state: r.state || "",
        amount: r.amountRequested ?? r.amount ?? "",
        createdAt: r.createdAt || r.requestedAt || "",
      }));

      // Detectar duplicados: mismo userId + policyTypeId + fromDate + toDate
      const seen = {};
      normalized.forEach((r) => {
        const key = `${r.userId}|${r.policyTypeId}|${r.fromDate}|${r.toDate}`;
        if (!seen[key]) seen[key] = [];
        seen[key].push(r.id);
      });
      const withDup = normalized.map((r) => {
        const key = `${r.userId}|${r.policyTypeId}|${r.fromDate}|${r.toDate}`;
        return { ...r, isDuplicate: seen[key].length > 1, dupIds: seen[key] };
      });

      const dupCount = withDup.filter((r) => r.isDuplicate).length;
      setRequestsData({ items: withDup, total: withDup.length, dupCount });
    } catch (e) {
      setRequestsError("Error de conexión: " + e.message);
    }
    setRequestsLoading(false);
  };

  // Auto-refresh silencioso usando la contraseña de sesión
  // Devuelve true si el refresh fue exitoso
  const doAutoRefresh = async (pwd) => {
    if (!pwd) return false;
    try {
      const res = await fetch(`/api/${clientSlug}/refresh-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd }),
      });
      if (res.ok) {
        setTokenStatus("ok");
        setAuthErrorCount(0);
        return true;
      }
    } catch {}
    return false;
  };

  const executeAll = async () => {
    setProcessing(true);
    setStep("executing");
    setAuthErrorCount(0);
    const newResults = {};
    let consecutiveAuthErrors = 0;
    // Cada PROACTIVE_REFRESH_EVERY requests exitosos, refrescamos token preventivamente
    const PROACTIVE_REFRESH_EVERY = 5;
    let successfulRequests = 0;

    // Índice de dedup desde localStorage — previene crear solicitudes duplicadas
    const dedupMap = getDedupMap(clientSlug);

    for (let i = 0; i < validatedRows.length; i++) {
      const row = validatedRows[i];
      if (!row.valid) {
        newResults[i] = { ok: false, error: row.errors.join(", "), skipped: true };
        setResults({ ...newResults });
        continue;
      }

      // ── Deduplicación: si ya fue procesada exitosamente, no volver a crear ──
      const dk = dedupMakeKey(row.userId, row.policyTypeId, row.fromDate, row.toDate);
      if (dedupMap[dk]) {
        newResults[i] = { ok: true, requestId: dedupMap[dk].requestId, alreadyExisted: true };
        setResults({ ...newResults });
        successfulRequests++;
        continue;
      }

      // Refresh preventivo: cada N requests exitosos refrescamos el token
      if (sessionPassword && successfulRequests > 0 && successfulRequests % PROACTIVE_REFRESH_EVERY === 0) {
        console.log(`[Auth] Refresh preventivo después de ${successfulRequests} requests exitosos`);
        await doAutoRefresh(sessionPassword);
      }

      // Si hay muchos errores de auth consecutivos, pausar y pedir refresh manual
      if (consecutiveAuthErrors >= 3) {
        setTokenStatus('expired');
        setShowRefreshModal(true);
        setProcessing(false);
        // Guardar progreso parcial
        setResults({ ...newResults });
        return;
      }

      setCurrentIndex(i);
      try {
        let createRes = await fetch(`/api/${clientSlug}/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            issuerId: row.userId,
            policyTypeId: row.policyTypeId,
            fromDate: row.fromDate,
            toDate: row.toDate,
          }),
        });
        let createData = await createRes.json();

        // Si falló por auth, intentar auto-refresh y reintentar una vez
        if (!createRes.ok && isAuthError(createData.error || "")) {
          const refreshed = await doAutoRefresh(sessionPassword);
          if (refreshed) {
            console.log(`[Auth] Auto-refresh exitoso, reintentando fila ${i + 1}...`);
            createRes = await fetch(`/api/${clientSlug}/create`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                issuerId: row.userId,
                policyTypeId: row.policyTypeId,
                fromDate: row.fromDate,
                toDate: row.toDate,
              }),
            });
            createData = await createRes.json();
          }
        }

        if (!createRes.ok) {
          const errorMsg = createData.error || "Error al crear";
          newResults[i] = { ok: false, error: errorMsg };

          // Detectar error de autenticación
          if (isAuthError(errorMsg)) {
            consecutiveAuthErrors++;
            setAuthErrorCount((prev) => prev + 1);
          } else {
            consecutiveAuthErrors = 0;
          }

          setResults({ ...newResults });
          continue;
        }

        consecutiveAuthErrors = 0; // Reset si create fue exitoso
        successfulRequests++;

        // Si la request ya existía (solapamiento detectado por Humand), no hay que aprobar
        if (createData.alreadyExisted) {
          newResults[i] = {
            ok: true,
            requestId: createData.id,
            days: createData.amountRequested,
            expectedDays: row.expectedDays,
            alreadyExisted: true,
          };
          // Guardar en dedup para próximas cargas
          saveDedupEntry(clientSlug, row.userId, row.policyTypeId, row.fromDate, row.toDate, createData.id);
          dedupMap[dk] = { requestId: createData.id };
          setResults({ ...newResults });
          continue;
        }

        let approveRes = await fetch(`/api/${clientSlug}/approve`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: createData.id }),
        });

        // Si approve falló por auth, auto-refresh y reintentar
        if (!approveRes.ok) {
          const approveDataTmp = await approveRes.json().catch(() => ({}));
          const errTmp = approveDataTmp.error || "Creada pero no se pudo aprobar";
          if (isAuthError(errTmp)) {
            const refreshed = await doAutoRefresh(sessionPassword);
            if (refreshed) {
              console.log(`[Auth] Auto-refresh exitoso, reintentando approve de fila ${i + 1}...`);
              approveRes = await fetch(`/api/${clientSlug}/approve`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId: createData.id }),
              });
            }
          }
        }

        if (approveRes.ok) {
          const humandDays = createData.amountRequested;
          const expected = row.expectedDays;
          const discrepancy = expected && humandDays && humandDays !== expected ? `Humand contó ${humandDays}, esperados: ${expected} ${row.countingMethod === "BUSINESS_DAYS" ? "hábiles" : "corridos"}` : null;
          newResults[i] = { ok: true, requestId: createData.id, days: humandDays, expectedDays: expected, discrepancy };
          // Guardar en dedup para evitar crear esta solicitud de nuevo en el futuro
          saveDedupEntry(clientSlug, row.userId, row.policyTypeId, row.fromDate, row.toDate, createData.id);
          dedupMap[dk] = { requestId: createData.id };
        } else {
          const approveData = await approveRes.json().catch(() => ({}));
          const errorMsg = approveData.error || "Creada pero no se pudo aprobar";
          newResults[i] = { ok: false, error: errorMsg, requestId: createData.id };

          if (isAuthError(errorMsg)) {
            consecutiveAuthErrors++;
            setAuthErrorCount((prev) => prev + 1);
          }
        }
      } catch (err) {
        newResults[i] = { ok: false, error: err.message };
      }
      setResults({ ...newResults });
    }
    setProcessing(false);
    setStep("done");

    const entryId = generateEntryId();
    const successN = Object.values(newResults).filter((r) => r.ok).length;
    const errorN = Object.values(newResults).filter((r) => !r.ok && !r.skipped).length;
    const skippedN = Object.values(newResults).filter((r) => r.skipped).length;
    addHistoryEntry(clientSlug, {
      id: entryId,
      timestamp: new Date().toISOString(),
      fileName: fileName || "archivo",
      totalRows: validatedRows.length,
      successCount: successN,
      errorCount: errorN,
      skippedCount: skippedN,
      blobUrl: null,
    });
    setHistory(getHistory(clientSlug));

    try {
      const exportRows = validatedRows.map((row, i) => {
        const r = newResults[i];
        const resultado = r?.ok
          ? (r.alreadyExisted ? `Ya existía (#${r.requestId})` : `OK (#${r.requestId})`)
          : r?.error || "Sin procesar";
        return { ...row.raw, "Usuario Resuelto": row.userName || "", "Email Resuelto": row.userEmail || "", "Match": row.matchMethod || "", "Política Resuelta": row.policyTypeName || "", "Días Esperados": row.expectedDays || "", "Conteo": row.countingMethod === "BUSINESS_DAYS" ? "Hábiles" : "Corridos", "Días Humand": r?.days || "", "Discrepancia": r?.discrepancy || "", Resultado: resultado };
      });
      const ws = XLSX.utils.json_to_sheet(exportRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Resultados");
      const wbOut = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
      const blobRes = await fetch("/api/blob", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: `resultados-${clientSlug}-${entryId}.xlsx`, base64: wbOut }),
      });
      if (blobRes.ok) {
        const { url } = await blobRes.json();
        updateHistoryEntry(clientSlug, entryId, { blobUrl: url });
        setHistory(getHistory(clientSlug));
      }
    } catch {}
  };

  const successCount = Object.values(results).filter((r) => r.ok && !r.alreadyExisted).length;
  const alreadyExistedCount = Object.values(results).filter((r) => r.ok && r.alreadyExisted).length;
  const errorCount = Object.values(results).filter((r) => !r.ok && !r.skipped).length;
  const skippedCount = Object.values(results).filter((r) => r.skipped).length;
  const validCount = validatedRows.filter((r) => r.valid).length;

  const downloadResults = () => {
    const exportRows = validatedRows.map((row, i) => {
      const r = results[i];
      const resultado = r?.ok
        ? (r.alreadyExisted ? `Ya existía (#${r.requestId})` : `OK (#${r.requestId})`)
        : r?.error || "Sin procesar";
      return {
        ...row.raw,
        "Usuario Resuelto": row.userName || "",
        "Email Resuelto": row.userEmail || "",
        "Match": row.matchMethod || "",
        "Política Resuelta": row.policyTypeName || "",
        "Días Esperados": row.expectedDays || "",
        "Conteo": row.countingMethod === "BUSINESS_DAYS" ? "Hábiles" : "Corridos",
        "Días Humand": r?.days || "",
        "Discrepancia": r?.discrepancy || "",
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
      
      {/* Modal de refresh de token */}
      {showRefreshModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <h3 style={styles.modalTitle}>🔐 Sesión expirada</h3>
            <p style={styles.modalText}>
              El token expiró. Ingresá la contraseña para continuar desde donde se pausó.
              {sessionPassword && <span style={{ color: "#16a34a", display: "block", marginTop: 4, fontSize: 12 }}>
                (ya tenés la contraseña guardada en sesión — hacé clic en "Refrescar")
              </span>}
            </p>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Contraseña de Humand</label>
              <input
                type="password"
                value={refreshPassword || sessionPassword}
                onChange={(e) => setRefreshPassword(e.target.value)}
                placeholder="Tu contraseña de Humand"
                style={styles.input}
                onKeyDown={(e) => e.key === "Enter" && handleRefreshToken()}
              />
            </div>
            {refreshError && <p style={styles.formError}>{refreshError}</p>}
            <div style={styles.modalActions}>
              <button 
                style={styles.btnSecondary} 
                onClick={() => { setShowRefreshModal(false); setStep("done"); }}
              >
                Cancelar
              </button>
              <button 
                style={{ ...styles.btnPrimary, opacity: refreshing ? 0.6 : 1 }} 
                onClick={handleRefreshToken}
                disabled={refreshing}
              >
                {refreshing ? "Refrescando..." : "Refrescar y continuar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: solicitudes en Humand con detección de duplicados */}
      {showRequestsModal && (
        <div style={{ ...styles.modalOverlay, alignItems: "flex-start", paddingTop: 40 }}>
          <div style={{ ...styles.modal, width: "min(95vw, 1100px)", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ ...styles.modalTitle, margin: 0 }}>
                📋 Solicitudes en Humand — {clientName}
              </h3>
              <button style={{ ...styles.btnSmall, fontSize: 18, lineHeight: 1 }} onClick={() => setShowRequestsModal(false)}>✕</button>
            </div>

            {requestsLoading && (
              <div style={{ textAlign: "center", padding: 40, color: "#64748b" }}>
                Cargando solicitudes... (puede tardar si hay muchas)
              </div>
            )}

            {requestsError && (
              <div style={{ padding: 16, backgroundColor: "#fef2f2", borderRadius: 6, color: "#991b1b", marginBottom: 12 }}>
                {requestsError}
              </div>
            )}

            {requestsData && (
              <>
                <div style={{ display: "flex", gap: 16, marginBottom: 16, fontSize: 13 }}>
                  <span style={{ color: "#334155" }}>
                    <strong>{requestsData.total}</strong> solicitudes en total
                  </span>
                  {requestsData.dupCount > 0 ? (
                    <span style={{ color: "#991b1b", fontWeight: 600 }}>
                      ⚠️ {requestsData.dupCount} filas con duplicados detectados
                    </span>
                  ) : (
                    <span style={{ color: "#166534", fontWeight: 600 }}>✅ Sin duplicados</span>
                  )}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    {requestsData.dupCount > 0 && (
                      <button
                        style={{ ...styles.btnSmall, backgroundColor: "#fef2f2", color: "#991b1b", fontWeight: 600 }}
                        onClick={() => {
                          // Agrupar duplicados: para cada key, conservar el más antiguo (menor ID)
                          // y marcar el resto para eliminar
                          const groups = {};
                          requestsData.items.forEach((r) => {
                            const key = `${r.userId}|${r.policyTypeId}|${r.fromDate}|${r.toDate}`;
                            if (!groups[key]) groups[key] = [];
                            groups[key].push(r);
                          });

                          const toDelete = [];
                          Object.values(groups).forEach((group) => {
                            if (group.length <= 1) return;
                            // Ordenar por ID ascendente → el menor es el original
                            const sorted = [...group].sort((a, b) => Number(a.id) - Number(b.id));
                            // Los demás (índice 1+) son duplicados a eliminar
                            sorted.slice(1).forEach((r) => toDelete.push(r.id));
                          });

                          // Generar CSV: columna requestId
                          const csv = "requestId\n" + toDelete.join("\n");
                          const blob = new Blob([csv], { type: "text/csv" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `duplicados-para-eliminar-${clientSlug}-${new Date().toISOString().slice(0, 10)}.csv`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        🗑️ Exportar CSV para eliminar ({
                          (() => {
                            const groups = {};
                            requestsData.items.forEach((r) => {
                              const key = `${r.userId}|${r.policyTypeId}|${r.fromDate}|${r.toDate}`;
                              if (!groups[key]) groups[key] = [];
                              groups[key].push(r);
                            });
                            return Object.values(groups).filter(g => g.length > 1).reduce((sum, g) => sum + g.length - 1, 0);
                          })()
                        } IDs)
                      </button>
                    )}
                    <button
                      style={styles.btnSmall}
                      onClick={() => {
                        const rows = requestsData.items.map((r) => ({
                          "Request ID": r.id,
                          "Usuario": r.userName,
                          "Email": r.userEmail,
                          "Política": r.policy,
                          "Desde": r.fromDate,
                          "Hasta": r.toDate,
                          "Días": r.amount,
                          "Estado": r.state,
                          "Creada": r.createdAt ? new Date(r.createdAt).toLocaleString("es-AR") : "",
                          "Duplicado": r.isDuplicate ? `Sí (IDs: ${r.dupIds.join(", ")})` : "No",
                        }));
                        const ws = XLSX.utils.json_to_sheet(rows);
                        ws["!cols"] = [{ wch: 12 }, { wch: 22 }, { wch: 30 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 20 }, { wch: 35 }];
                        const wb = XLSX.utils.book_new();
                        XLSX.utils.book_append_sheet(wb, ws, "Solicitudes");
                        XLSX.writeFile(wb, `solicitudes-${clientSlug}-${new Date().toISOString().slice(0, 10)}.xlsx`);
                      }}
                    >
                      📥 Exportar Excel
                    </button>
                  </div>
                </div>

                <div style={{ overflowY: "auto", flex: 1, borderRadius: 6, border: "1px solid #e2e8f0" }}>
                  <table style={{ ...styles.table, margin: 0 }}>
                    <thead style={{ position: "sticky", top: 0, backgroundColor: "#f8fafc", zIndex: 1 }}>
                      <tr>
                        <th style={styles.th}>ID</th>
                        <th style={styles.th}>Usuario</th>
                        <th style={styles.th}>Política</th>
                        <th style={styles.th}>Desde</th>
                        <th style={styles.th}>Hasta</th>
                        <th style={styles.th}>Días</th>
                        <th style={styles.th}>Estado</th>
                        <th style={styles.th}>Creada</th>
                        <th style={styles.th}>Dup.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requestsData.items
                        .sort((a, b) => {
                          // Duplicados primero, luego por usuario
                          if (a.isDuplicate !== b.isDuplicate) return a.isDuplicate ? -1 : 1;
                          return (a.userName || "").localeCompare(b.userName || "");
                        })
                        .map((r) => (
                          <tr key={r.id} style={{ backgroundColor: r.isDuplicate ? "#fff1f2" : "transparent" }}>
                            <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 12 }}>#{r.id}</td>
                            <td style={styles.td}>
                              <div style={{ fontWeight: 500 }}>{r.userName}</div>
                              <div style={{ fontSize: 11, color: "#94a3b8" }}>{r.userEmail}</div>
                            </td>
                            <td style={styles.td}>{r.policy}</td>
                            <td style={styles.td}>{r.fromDate}</td>
                            <td style={styles.td}>{r.toDate}</td>
                            <td style={{ ...styles.td, textAlign: "center" }}>{r.amount}</td>
                            <td style={styles.td}>
                              <span style={{
                                padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                                backgroundColor: r.state === "APPROVED" ? "#dcfce7" : r.state === "PENDING" ? "#fef9c3" : "#f1f5f9",
                                color: r.state === "APPROVED" ? "#166534" : r.state === "PENDING" ? "#854d0e" : "#475569",
                              }}>
                                {r.state === "APPROVED" ? "Aprobada" : r.state === "PENDING" ? "Pendiente" : r.state || "-"}
                              </span>
                            </td>
                            <td style={{ ...styles.td, fontSize: 12, color: "#64748b" }}>
                              {r.createdAt ? new Date(r.createdAt).toLocaleDateString("es-AR") : "-"}
                            </td>
                            <td style={{ ...styles.td, textAlign: "center" }}>
                              {r.isDuplicate && (
                                <span title={`IDs duplicados: ${r.dupIds.join(", ")}`} style={{ color: "#dc2626", fontWeight: 700, fontSize: 16 }}>⚠️</span>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button style={styles.btnSecondary} onClick={() => setShowRequestsModal(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de verificación de pendientes */}
      {showVerifyModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <h3 style={styles.modalTitle}>🔍 Verificar pendientes</h3>
            <p style={styles.modalText}>
              Sube el archivo original con todas las ausencias que debían cargarse. 
              Se comparará contra las cargas exitosas del historial y generará un reporte con:
            </p>
            <ul style={{ fontSize: 13, color: "#64748b", margin: "0 0 16px", paddingLeft: 20 }}>
              <li>Resumen de completitud</li>
              <li>Listado de ausencias ya cargadas (con Request ID)</li>
              <li>Listado de ausencias pendientes</li>
            </ul>
            <input
              ref={verifyFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files[0]) verifyPendientes(e.target.files[0]);
              }}
            />
            <div style={styles.modalActions}>
              <button 
                style={styles.btnSecondary} 
                onClick={() => setShowVerifyModal(false)}
              >
                Cancelar
              </button>
              <button 
                style={{ ...styles.btnPrimary, opacity: verifying ? 0.6 : 1 }} 
                onClick={() => verifyFileRef.current?.click()}
                disabled={verifying}
              >
                {verifying ? "Verificando..." : "Seleccionar archivo"}
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div style={styles.container}>
        <div style={styles.content}>
          <div style={styles.header}>
            <Link href="/" style={styles.back}>
              ← Volver
            </Link>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h1 style={styles.title}>{clientName || clientSlug}</h1>
              {tokenStatus === 'expired' && (
                <span style={styles.tokenBadgeExpired} onClick={() => setShowRefreshModal(true)}>
                  ⚠️ Token expirado
                </span>
              )}
              {tokenStatus === 'expiring' && (
                <span style={styles.tokenBadgeExpiring} onClick={() => setShowRefreshModal(true)}>
                  ⏰ Token por expirar
                </span>
              )}
            </div>
            <p style={styles.subtitle}>Carga masiva de ausencias/vacaciones</p>
          </div>

          {step === "loading" && (
            <div style={styles.section}>
              <p style={styles.loading}>Cargando información de la comunidad...</p>
            </div>
          )}

          {step === "policies" && (
            <>
              {/* Alerta de token expirado */}
              {tokenStatus === 'expired' && (
                <div style={styles.tokenAlert}>
                  <div>
                    <strong>⚠️ Token de sesión expirado</strong>
                    <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                      El token de autenticación ha expirado. Refresca el token antes de cargar ausencias para evitar errores.
                    </p>
                  </div>
                  <button style={styles.btnWarning} onClick={() => setShowRefreshModal(true)}>
                    Refrescar token
                  </button>
                </div>
              )}
              
              <div style={styles.section}>
                <h2 style={styles.sectionTitle}>Políticas de ausencia ({policyTypes.length})</h2>
                {loadError && (
                  <div style={styles.blockerNote}>Error al cargar datos: {loadError}</div>
                )}
                {!loadError && policyTypes.length === 0 ? (
                  <p style={{ color: "#991b1b", fontSize: 14 }}>No se encontraron políticas. Verifica que la API Key sea válida.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={styles.th}>Tipo de Política</th>
                          <th style={styles.th}>Política</th>
                          <th style={styles.th}>Usuarios</th>
                          <th style={styles.th}>Conteo</th>
                          <th style={styles.th}>Min días</th>
                          <th style={styles.th}>Max días</th>
                          <th style={styles.th}>Retroactivo</th>
                          <th style={styles.th}>Anticipación</th>
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
                              <td style={styles.td}>{pt.countingMethod === "CALENDAR_DAYS" ? "Corridos" : "Hábiles"}</td>
                              <td style={styles.td}>{pt.minimumAmountPerRequest || "-"}</td>
                              <td style={styles.td}>{pt.maximumAmountPerRequest || "Sin límite"}</td>
                              <td style={{ ...styles.td, color: pt.noRetroactiveRequests ? "#991b1b" : "#166534", fontWeight: 600 }}>
                                {pt.noRetroactiveRequests ? "NO" : "SÍ"}
                              </td>
                              <td style={styles.td}>{pt.minimumAdvanceDays ? `${pt.minimumAdvanceDays} días` : "Ninguna"}</td>
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
                    Las políticas marcadas como BLOQUEADA no permiten crear ausencias en el pasado.
                    Desactiva "No permitir solicitudes retroactivas" y/o "Días mínimos de anticipación" en la configuración de la política desde el panel de Humand antes de continuar.
                  </div>
                )}
              </div>
              <div style={styles.section}>
                <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
                  {users.length} usuarios cargados en esta comunidad
                </p>
              </div>

              {history.length > 0 && (
                <div style={styles.section}>
                  <h2 style={styles.sectionTitle}>Historial de cargas ({history.length})</h2>
                  <div style={{ overflowX: "auto" }}>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={styles.th}>Fecha</th>
                          <th style={styles.th}>Archivo</th>
                          <th style={styles.th}>Total</th>
                          <th style={styles.th}>OK</th>
                          <th style={styles.th}>Errores</th>
                          <th style={styles.th}>Omitidas</th>
                          <th style={styles.th}>Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((entry) => (
                            <tr key={entry.id}>
                              <td style={styles.td}>{new Date(entry.timestamp).toLocaleString("es-AR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                              <td style={styles.td}>{entry.fileName}</td>
                              <td style={styles.td}>{entry.totalRows}</td>
                              <td style={{ ...styles.td, color: "#166534" }}>{entry.successCount}</td>
                              <td style={{ ...styles.td, color: entry.errorCount > 0 ? "#991b1b" : "#334155" }}>{entry.errorCount}</td>
                              <td style={styles.td}>{entry.skippedCount}</td>
                              <td style={styles.td}>
                                <div style={{ display: "flex", gap: 6 }}>
                                  {entry.blobUrl && (
                                    <a href={entry.blobUrl} download style={{ ...styles.btnSmall, textDecoration: "none", display: "inline-block" }}>Descargar</a>
                                  )}
                                  <button style={{ ...styles.btnSmall, color: "#991b1b", backgroundColor: "#fef2f2" }} onClick={async () => {
                                    if (entry.blobUrl) {
                                      try { await fetch("/api/blob", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: entry.blobUrl }) }); } catch {}
                                    }
                                    deleteHistoryEntry(clientSlug, entry.id);
                                    setHistory(getHistory(clientSlug));
                                  }}>Eliminar</button>
                                </div>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {/* Resumen y botones de exportar */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, paddingTop: 16, borderTop: "1px solid #e2e8f0" }}>
                    <div style={{ fontSize: 13, color: "#64748b" }}>
                      Total: <strong style={{ color: "#166534" }}>{history.reduce((sum, e) => sum + (e.successCount || 0), 0)}</strong> exitosas, {" "}
                      <strong style={{ color: "#991b1b" }}>{history.reduce((sum, e) => sum + (e.errorCount || 0), 0)}</strong> errores
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        style={styles.btnSecondary}
                        onClick={loadAllRequests}
                      >
                        🔎 Ver solicitudes en Humand
                      </button>
                      <button
                        style={styles.btnSecondary}
                        onClick={() => setShowVerifyModal(true)}
                      >
                        🔍 Verificar pendientes
                      </button>
                      <button
                        style={{ ...styles.btnSecondary, opacity: exporting ? 0.6 : 1 }}
                        onClick={exportConsolidated}
                        disabled={exporting}
                      >
                        {exporting ? "Exportando..." : "📥 Exportar exitosas"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div style={styles.actions}>
                <button style={styles.btnSecondary} onClick={() => setShowRefreshModal(true)}>
                  🔐 Refrescar token
                </button>
                <button style={styles.btnPrimary} onClick={() => setStep("upload")}>
                  Continuar a carga de archivo
                </button>
              </div>
            </>
          )}

          {step === "upload" && (
            <>
              {/* Contraseña de sesión — al inicio, antes del archivo */}
              <div style={{ marginBottom: 16, padding: "14px 16px", backgroundColor: sessionPassword ? "#f0fdf4" : "#fff7ed", borderRadius: 8, border: `1px solid ${sessionPassword ? "#bbf7d0" : "#fed7aa"}` }}>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 6 }}>
                  🔐 Contraseña de admin Humand
                  {!sessionPassword && <span style={{ color: "#ea580c", marginLeft: 6 }}>— necesaria para auto-refresh del token</span>}
                </label>
                <input
                  type="password"
                  value={sessionPassword}
                  onChange={(e) => setSessionPassword(e.target.value)}
                  placeholder="Ingresá tu contraseña de Humand"
                  style={{ ...styles.input, marginBottom: 4, borderColor: sessionPassword ? "#86efac" : "#fdba74" }}
                  autoComplete="current-password"
                />
                <p style={{ margin: 0, fontSize: 12, color: sessionPassword ? "#16a34a" : "#9a3412" }}>
                  {sessionPassword
                    ? "✅ El token se refrescará automáticamente si expira durante la carga."
                    : "⚠️ Sin contraseña, la carga se pausará cada ~10 min para pedir autenticación manual."}
                </p>
              </div>

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
                  Arrastra un archivo Excel o CSV aquí
                </p>
                <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
                  o haz clic para seleccionar
                </p>
              </div>
            </>
          )}

          {step === "mapping" && (
            <>
              <div style={styles.section}>
                <h2 style={styles.sectionTitle}>Mapeo de columnas</h2>
                <div style={styles.mappingGrid}>
                  {Object.entries({ email: "Usuario (email/nombre)", policy: "Política", fromDate: "Fecha inicio", toDate: "Fecha fin", days: "Días (info)" }).map(
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

              {loadingMeta && <p style={styles.loading}>Cargando usuarios y políticas del cliente...</p>}

              {!loadingMeta && validatedRows.length > 0 && (
                <>
                  <div style={styles.section}>
                    <h2 style={styles.sectionTitle}>
                      Vista previa ({validCount} válidas de {validatedRows.length})
                    </h2>
                    <div style={{ overflowX: "auto" }}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>#</th>
                            <th style={styles.th}>Usuario</th>
                            <th style={styles.th}>Política</th>
                            <th style={styles.th}>Desde</th>
                            <th style={styles.th}>Hasta</th>
                            <th style={styles.th}>Días</th>
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
                              <td style={styles.td}>
                                {row.expectedDays != null && (
                                  <>
                                    <div>{row.expectedDays}</div>
                                    <div style={{ fontSize: 11, color: "#64748b" }}>{row.countingMethod === "BUSINESS_DAYS" ? "hábiles" : "corridos"}</div>
                                  </>
                                )}
                              </td>
                              <td style={styles.td}>
                                {row.valid ? (
                                  row.warnings?.length > 0 ? (
                                    <span style={styles.badge.warning} title={row.warnings.join("\n")}>OK ({row.warnings[0]})</span>
                                  ) : (
                                    <span style={styles.badge.ok}>OK</span>
                                  )
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
              {authErrorCount > 0 && step === "executing" && (
                <div style={styles.authWarning}>
                  ⚠️ Se detectaron {authErrorCount} errores de autenticación. El token puede estar expirando.
                </div>
              )}
              {step === "done" && (
                <div style={styles.summary}>
                  {successCount > 0 && <span style={styles.summaryOk}>{successCount} creadas</span>}
                  {alreadyExistedCount > 0 && <span style={styles.summaryExisted}>{alreadyExistedCount} ya existían</span>}
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
                      <th style={styles.th}>Política</th>
                      <th style={styles.th}>Desde</th>
                      <th style={styles.th}>Hasta</th>
                      <th style={styles.th}>Días</th>
                      <th style={styles.th}>Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validatedRows.map((row, i) => {
                      const r = results[i];
                      const isProcessing = step === "executing" && i === currentIndex;
                      const isAuthErr = r && !r.ok && isAuthError(r.error);
                      return (
                        <tr key={i} style={{ backgroundColor: isProcessing ? "#fffbeb" : isAuthErr ? "#fef2f2" : r?.discrepancy ? "#fffbeb" : r?.ok ? "#f0fdf4" : r?.error ? "#fef2f2" : "#fff" }}>
                          <td style={styles.td}>{i + 1}</td>
                          <td style={styles.td}>{row.email}</td>
                          <td style={styles.td}>{row.policyTypeName || row.policyName}</td>
                          <td style={styles.td}>{row.fromDate}</td>
                          <td style={styles.td}>{row.toDate}</td>
                          <td style={styles.td}>
                            {r?.ok ? (
                              <div>
                                <div>{r.days}</div>
                                {r.discrepancy && <div style={{ fontSize: 11, color: "#d97706" }}>Esperados: {r.expectedDays}</div>}
                              </div>
                            ) : row.expectedDays != null ? (
                              <span>{row.expectedDays}</span>
                            ) : ""}
                          </td>
                          <td style={styles.td}>
                            {isProcessing && <span style={{ color: "#d97706" }}>...</span>}
                            {r?.ok && r.alreadyExisted && <span style={styles.badge.existed}>Ya existía (#{r.requestId})</span>}
                            {r?.ok && !r.alreadyExisted && !r.discrepancy && <span style={styles.badge.ok}>OK (#{r.requestId})</span>}
                            {r?.ok && !r.alreadyExisted && r.discrepancy && <span style={styles.badge.warning} title={r.discrepancy}>OK (#{r.requestId}) — {r.discrepancy}</span>}
                            {r && !r.ok && (
                              <span style={isAuthErr ? styles.badge.auth : styles.badge.error} title={r.error}>
                                {r.skipped ? "Omitida" : isAuthErr ? "🔐 " + r.error : r.error}
                              </span>
                            )}
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
    auth: {
      backgroundColor: "#fef3c7",
      color: "#92400e",
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 500,
    },
    existed: {
      backgroundColor: "#dbeafe",
      color: "#1e40af",
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
  btnWarning: {
    backgroundColor: "#f59e0b",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnSmall: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 4,
    padding: "3px 10px",
    fontSize: 12,
    cursor: "pointer",
    color: "#334155",
  },
  summary: { display: "flex", gap: 12, marginBottom: 16 },
  summaryOk: { color: "#166534", fontWeight: 600, fontSize: 14 },
  summaryExisted: { color: "#1e40af", fontWeight: 600, fontSize: 14 },
  summaryError: { color: "#991b1b", fontWeight: 600, fontSize: 14 },
  summarySkip: { color: "#92400e", fontWeight: 600, fontSize: 14 },
  
  // Modal styles
  modalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 24,
    maxWidth: 400,
    width: "90%",
    boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
  },
  modalTitle: { fontSize: 18, fontWeight: 600, color: "#0f172a", margin: "0 0 12px" },
  modalText: { fontSize: 14, color: "#64748b", margin: "0 0 16px", lineHeight: 1.5 },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  formGroup: { marginBottom: 12 },
  formLabel: { display: "block", fontSize: 13, fontWeight: 500, color: "#334155", marginBottom: 4 },
  input: { width: "100%", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 14, backgroundColor: "#fff", boxSizing: "border-box" },
  formError: { color: "#dc2626", fontSize: 13, margin: "0 0 10px" },
  
  // Token status badges
  tokenBadgeExpired: {
    backgroundColor: "#fef2f2",
    color: "#991b1b",
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },
  tokenBadgeExpiring: {
    backgroundColor: "#fffbeb",
    color: "#92400e",
    padding: "4px 10px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },
  tokenAlert: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  authWarning: {
    backgroundColor: "#fef3c7",
    border: "1px solid #fcd34d",
    borderRadius: 6,
    padding: 12,
    marginBottom: 16,
    fontSize: 13,
    color: "#92400e",
  },
};
