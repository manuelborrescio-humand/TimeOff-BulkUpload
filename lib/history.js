const MAX_ENTRIES = 50;

function storageKey(slug) {
  return `humand_history_${slug}`;
}

function sessionKey(entryId) {
  return `humand_session_${entryId}`;
}

export function generateEntryId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function getHistory(slug) {
  if (typeof window === "undefined") return [];
  try {
    const data = JSON.parse(localStorage.getItem(storageKey(slug)) || "[]");
    return data.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch {
    return [];
  }
}

export function addHistoryEntry(slug, entry) {
  if (typeof window === "undefined") return;
  const history = getHistory(slug);
  history.unshift(entry);
  if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
  localStorage.setItem(storageKey(slug), JSON.stringify(history));
}

export function deleteHistoryEntry(slug, entryId) {
  if (typeof window === "undefined") return;
  const history = getHistory(slug).filter((e) => e.id !== entryId);
  localStorage.setItem(storageKey(slug), JSON.stringify(history));
  try { sessionStorage.removeItem(sessionKey(entryId)); } catch {}
}

export function clearHistory(slug) {
  if (typeof window === "undefined") return;
  const history = getHistory(slug);
  history.forEach((e) => { try { sessionStorage.removeItem(sessionKey(e.id)); } catch {} });
  localStorage.removeItem(storageKey(slug));
}

export function saveSessionData(entryId, data) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(sessionKey(entryId), JSON.stringify(data));
  } catch {}
}

export function getSessionData(entryId) {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(sessionKey(entryId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
