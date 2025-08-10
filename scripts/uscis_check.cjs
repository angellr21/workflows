// scripts/uscis_check.cjs
/* eslint-disable no-console */

/**
 * USCIS queue checker
 * - Lee API_BASE y API_TOKEN de los env vars del workflow
 * - Normaliza API_BASE (quita / finales y NO permite que termine en /queue)
 * - Llama a {API_BASE}/queue y muestra la URL exacta usada
 * - Imprime resultados en español y sale con código apropiado
 *
 * Requiere Node 20+ (fetch nativo).
 */

const REQUIRED_ENV = ["API_BASE", "API_TOKEN"];

/** Utilidad: corta un string largo para logs de error */
function clip(text, max = 800) {
  if (!text || typeof text !== "string") return "";
  return text.length > max ? text.slice(0, max) + "…[clipped]" : text;
}

/** Normaliza la base para que nunca termine en /, ni en /queue */
function normalizeBase(raw) {
  let b = String(raw || "").trim();

  // quitar query/fragment
  b = b.replace(/[?#].*$/, "");
  // quitar slash(es) finales
  b = b.replace(/\/+$/, "");
  // si vino con /queue pegado, quitarlo
  b = b.replace(/\/queue$/i, "");

  if (!/^https?:\/\//i.test(b)) {
    throw new Error(
      `API_BASE inválido: "${raw}". Debe incluir el esquema (https://).`
    );
  }
  return b;
}

/** GET al endpoint de queue y devuelve JSON */
async function fetchQueue(apiBase, token) {
  const url = `${apiBase}/queue`;
  console.log(`URL de cola: ${url}`);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Queue error ${res.status}: ${clip(body)}`);
  }

  const data = await res.json();
  return data;
}

(async () => {
  console.log("USCIS Actions: iniciando…");

  // Validar env vars
  for (const k of REQUIRED_ENV) {
    if (!process.env[k] || String(process.env[k]).trim() === "") {
      throw new Error(`Falta variable de entorno requerida: ${k}`);
    }
  }

  const rawBase = process.env.API_BASE;
  const apiBase = normalizeBase(rawBase);
  const token = String(process.env.API_TOKEN).trim();

  console.log(`API_BASE (raw): ${rawBase}`);
  console.log(`API_BASE (normalizada): ${apiBase}`);

  const data = await fetchQueue(apiBase, token);

  const queue = Array.isArray(data?.queue) ? data.queue : [];
  console.log(`Se recibieron ${queue.length} item(s) para revisar.`);

  if (queue.length === 0) {
    console.log("Nada para hacer.");
    process.exit(0);
  }

  for (const it of queue) {
    const rn = it?.receipt_number ?? "(sin receipt_number)";
    console.log(`• Pendiente: ${rn}`);
  }

  process.exit(0);
})().catch((err) => {
  console.error(
    `Proceso falló: ${
      err instanceof Error ? err.stack || err.message : String(err)
    }`
  );
  process.exit(1);
});
