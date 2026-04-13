/**
 * Helper para paginar endpoints de la Humand API en paralelo.
 *
 * En lugar de loop secuencial (página tras página), hace:
 * 1. Fetch página 1 (necesario para conocer data.count)
 * 2. Fetch páginas 2..N en paralelo, con concurrencia limitada
 *
 * Ganancia típica: 100 calls secuenciales (~15s) → 10 batches paralelos (~1.5s).
 */

/**
 * @param {(page: number, limit: number) => string} buildUrl - Función que arma la URL para cada página
 * @param {Record<string,string>} headers - Headers HTTP (Authorization, etc.)
 * @param {{ limit?: number, concurrency?: number, itemsKey?: string }} opts
 * @returns {Promise<{ all: any[], pages: number, count: number }>}
 */
export async function fetchAllPages(buildUrl, headers, opts = {}) {
  const { limit = 50, concurrency = 10, itemsKey } = opts;

  const extractItems = (data) => {
    if (itemsKey) return data[itemsKey] ?? [];
    // Fallback: probar las keys conocidas de la API de Humand
    return data.items ?? data.users ?? [];
  };

  // Fetch página 1 — necesaria sí o sí para conocer el total
  const firstRes = await fetch(buildUrl(1, limit), { headers });
  if (!firstRes.ok) {
    const errText = await firstRes.text();
    const err = new Error(`Humand API ${firstRes.status} on page 1: ${errText}`);
    err.status = firstRes.status;
    err.details = errText;
    throw err;
  }
  const firstData = await firstRes.json();
  const count = firstData.count ?? 0;
  const all = [...extractItems(firstData)];

  if (all.length >= count || count === 0) {
    return { all, pages: 1, count };
  }

  const totalPages = Math.ceil(count / limit);

  // Generar lista de páginas pendientes (2..totalPages)
  const remaining = [];
  for (let p = 2; p <= totalPages; p++) remaining.push(p);

  // Ejecutar en chunks de `concurrency` para no saturar Humand
  for (let i = 0; i < remaining.length; i += concurrency) {
    const chunk = remaining.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (page) => {
        const r = await fetch(buildUrl(page, limit), { headers });
        if (!r.ok) {
          const errText = await r.text();
          const err = new Error(`Humand API ${r.status} on page ${page}: ${errText}`);
          err.status = r.status;
          err.details = errText;
          throw err;
        }
        return await r.json();
      })
    );
    for (const data of results) {
      all.push(...extractItems(data));
    }
  }

  return { all, pages: totalPages, count };
}
