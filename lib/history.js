const MAX_ENTRIES = 50;

function storageKey(slug) {
  return `humand_history_${slug}`;
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

export function updateHistoryEntry(slug, entryId, updates) {
  if (typeof window === "undefined") return;
  const history = getHistory(slug);
  const idx = history.findIndex((e) => e.id === entryId);
  if (idx !== -1) {
    history[idx] = { ...history[idx], ...updates };
    localStorage.setItem(storageKey(slug), JSON.stringify(history));
  }
}

export function deleteHistoryEntry(slug, entryId) {
  if (typeof window === "undefined") return;
  const history = getHistory(slug).filter((e) => e.id !== entryId);
  localStorage.setItem(storageKey(slug), JSON.stringify(history));
}

export function clearHistory(slug) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(storageKey(slug));
}

// ─── Deduplication index ─────────────────────────────────────────────────────
// Clave compuesta: userId|policyTypeId|fromDate|toDate
// Guarda el requestId de la solicitud para evitar crear duplicados.

function dedupKey(slug) {
  return `humand_dedup_${slug}`;
}

export function dedupMakeKey(userId, policyTypeId, fromDate, toDate) {
  return `${userId}|${policyTypeId}|${fromDate}|${toDate}`;
}

export function getDedupMap(slug) {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(dedupKey(slug)) || "{}");
  } catch {
    return {};
  }
}

export function saveDedupEntry(slug, userId, policyTypeId, fromDate, toDate, requestId) {
  if (typeof window === "undefined") return;
  const map = getDedupMap(slug);
  map[dedupMakeKey(userId, policyTypeId, fromDate, toDate)] = { requestId, savedAt: new Date().toISOString() };
  localStorage.setItem(dedupKey(slug), JSON.stringify(map));
}

export function clearDedupMap(slug) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(dedupKey(slug));
}
