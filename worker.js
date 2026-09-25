// ═══════════════════════════════════════════════════════════════════════════════
// royal-resonance-d470  —  worker.js
// Rutas: /mae · /test-snapshot (POST) · BCRA proxy (default)
//        scheduled cron (weekdays 20:15 UTC = 17:15 ART)
//
// /rofex y /iol se eliminaron: /rofex apuntaba al entorno demo de Primary
// (api.remarkets.primary.com.ar) y /iol exigía credenciales personales de IOL que
// nunca funcionaron para market data. Los futuros de dólar ahora salen del MAE,
// que es público y no pide autenticación.
//
// Variables de entorno a agregar en Cloudflare Dashboard → Settings → Variables:
//   SUPABASE_URL          https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (bypasa RLS)          [encrypted]
//   SNAPSHOT_TOKEN        secreto para POST /test-snapshot        [encrypted]
//                         Sin esta variable, /test-snapshot devuelve 503.
//                         Generar con: openssl rand -hex 32
//
// Seguridad (ver ALLOWED_ORIGINS / MAE_ALLOWED_PATHS más abajo):
//   · CORS restringido a los orígenes de la app (antes era '*')
//   · /mae sólo acepta paths de una allowlist, no una URL del llamador
//   · /test-snapshot exige X-Snapshot-Token (antes: sin autenticación)
//   · Los parámetros del proxy BCRA se validan antes de interpolarse
//
// Cron trigger: 15 20 * * 1-5
//   Cloudflare Dashboard → Workers & Pages → royal-resonance-d470
//   → Triggers → Cron Triggers → Add Cron Trigger → "15 20 * * 1-5"
// ═══════════════════════════════════════════════════════════════════════════════

// Devuelve 'YYYY-MM-DD' en hora argentina (UTC-3, sin DST)
function todayAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// ── Precios data912.com ────────────────────────────────────────────────────────
function apiBestPrice(api) {
  if (!api) return null;
  if (api.c > 0) return api.c;
  const bid = api.px_bid||0, ask = api.px_ask||0;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return ask || bid || null;
}
async function fetchData912() {
  const ts = Date.now();
  const [rN, rB] = await Promise.all([
    fetch(`https://data912.com/live/arg_notes?_=${ts}`).then(r => r.json()),
    fetch(`https://data912.com/live/arg_bonds?_=${ts}`).then(r => r.json()),
  ]);
  return new Map([...rN, ...rB].map(x => [x.symbol, x]));
}

// ── Supabase helpers ───────────────────────────────────────────────────────────
function supaHeaders(env) {
  return {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}
async function supaGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: supaHeaders(env) });
  if (!res.ok) throw new Error(`Supabase GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}
async function supaUpsert(env, table, rows, onConflict) {
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: { ...supaHeaders(env), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table} → ${res.status}: ${await res.text()}`);
}

// ── Snapshot diario ────────────────────────────────────────────────────────────
// El Worker solo guarda precios. El frontend calcula TIR/MD desde el precio
// histórico + la definición estática del bono.
//
// Para USD (BOP/BON/GLO) los precios en data912 no están bajo bond.ticker sino
// bajo los símbolos de EQUIV_DATA (ej. "GD30D" para MEP de GD30).
// Se usa el precio MEP (row.mep) como precio USD de referencia.
async function takeDailySnapshot(env) {
  const todayStr = todayAR();

  const KEYS = [
    'bonosAR_glo_v1', 'bonosAR_bon_v1', 'bonosAR_bop_v1',
    'bonosAR_lecaps_v1', 'bonosAR_cer_bonds_v1',
    'bonosAR_tamar_bonds_v1', 'bonosAR_dlk_bonds_v1',
    'bonosAR_equiv_v1',
  ];
  const USD_SECTORS = new Set(['GLO', 'BON', 'BOP']);
  const SECTOR = {
    bonosAR_glo_v1:         'GLO',
    bonosAR_bon_v1:         'BON',
    bonosAR_bop_v1:         'BOP',
    bonosAR_lecaps_v1:      'TF',
    bonosAR_cer_bonds_v1:   'CER',
    bonosAR_tamar_bonds_v1: 'TAMAR',
    bonosAR_dlk_bonds_v1:   'DLK',
  };

  const [priceMap, sharedRows] = await Promise.all([
    fetchData912(),
    supaGet(env, `shared_data?key=in.(${KEYS.join(',')})&select=key,value`),
  ]);

  // Construir mapa equiv: bond.ticker → {ars, mep, cable}
  const equivRaw = sharedRows.find(r => r.key === 'bonosAR_equiv_v1');
  const equivList = equivRaw ? (Array.isArray(equivRaw.value) ? equivRaw.value : JSON.parse(equivRaw.value)) : [];
  const equivMap = new Map(equivList.map(e => [e.ticker, e]));

  const rows = [];
  for (const row of sharedRows) {
    const sector = SECTOR[row.key];
    if (!sector) continue; // bonosAR_equiv_v1 no tiene sector
    const bonds = Array.isArray(row.value) ? row.value : JSON.parse(row.value);

    for (const bond of bonds) {
      let price = null;

      if (USD_SECTORS.has(sector)) {
        // USD: buscar por símbolo MEP (precio en dólares)
        const eq = equivMap.get(bond.ticker);
        const sym = eq?.mep || eq?.cable;
        if (sym) price = apiBestPrice(priceMap.get(sym));
      } else {
        // ARS: buscar directamente por ticker
        price = apiBestPrice(priceMap.get(bond.ticker));
      }

      if (!price) continue;
      rows.push({ snapshot_date: todayStr, ticker: bond.ticker, sector, price: +price.toFixed(4) });
    }
  }

  // Deduplicar por (sector, ticker): hay tickers que viven en dos sectores
  // (TXMJ9/TXMJ8/TXMD8/TXMD9/TXMJ0 en CER y TAMAR; TMVE8 en TAMAR y DLK).
  // Con clave sólo por ticker se perdía una de las dos filas en silencio.
  const deduped = [...new Map(rows.map(r => [`${r.sector}|${r.ticker}`, r])).values()];

  if (deduped.length) await supaUpsert(env, 'bond_price_snapshots', deduped, 'snapshot_date,ticker,sector');
  return deduped.length;
}

// ── Seguridad ──────────────────────────────────────────────────────────────────
// Orígenes autorizados a llamar al Worker desde un navegador.
// Si algún día servís la app desde otro dominio, agregalo acá.
const ALLOWED_ORIGINS = [
  'https://gmacap.github.io',
  // El origen viejo queda mientras dure la mudanza: sacarlo antes de que todo
  // esté verde dejaría la app sin API justo en el medio del cambio.
  'https://santosechezarreta5.github.io',
  'http://localhost:8000',
  'http://localhost:5500',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:5500',
];

// Proxy MAE: el mercado mayorista no manda header CORS, así que el navegador no
// puede pedirle directo. A diferencia del viejo proxy /iol, que aceptaba una URL
// arbitraria por querystring y hubo que endurecer después, acá la allowlist es de
// paths completos: no hay parámetro que el llamador pueda torcer.
const MAE_BASE = 'https://api.marketdata.mae.com.ar';
const MAE_ALLOWED_PATHS = [
  '/api/mercado/resumen/FOR',   // FOREX mayorista — UST$T plazo 000 es el contado
  '/api/mercado/resumen/DDF',   // Dólar Diferido a Fix — curva de futuros
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Snapshot-Token',
    'Vary': 'Origin',
  };
  if (ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function jsonError(msg, status, cors) {
  return new Response(JSON.stringify({ ok: false, error: msg }),
    { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

// Comparación en tiempo constante para no filtrar el token por timing
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // ── Snapshot manual ────────────────────────────────────────────────────────
    // Escribe con SERVICE_ROLE (saltea RLS) → exige token compartido.
    // Configurar SNAPSHOT_TOKEN en Cloudflare → Settings → Variables (encrypted).
    if (url.pathname === '/test-snapshot') {
      if (request.method !== 'POST') return jsonError('POST required', 405, cors);
      if (!env.SNAPSHOT_TOKEN) return jsonError('SNAPSHOT_TOKEN no configurado en el Worker', 503, cors);
      if (!safeEqual(request.headers.get('X-Snapshot-Token') || '', env.SNAPSHOT_TOKEN))
        return jsonError('No autorizado', 401, cors);
      try {
        const n = await takeDailySnapshot(env);
        return new Response(JSON.stringify({ ok: true, rows: n, date: todayAR() }),
          { headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (e) {
        console.error('test-snapshot:', e.message);
        return jsonError(e.message, 500, cors);
      }
    }

    // ── Proxy MAE ──────────────────────────────────────────────────────────────
    // GET /mae?path=/api/mercado/resumen/DDF
    // El path tiene que estar en la allowlist tal cual: no se arma por
    // concatenación ni se aceptan querystrings del llamador.
    if (url.pathname === '/mae') {
      if (request.method !== 'GET') return jsonError('GET required', 405, cors);
      const path = url.searchParams.get('path') || '';
      if (!MAE_ALLOWED_PATHS.includes(path))
        return jsonError(`Path no permitido: ${path}`, 400, cors);

      const maeRes = await fetch(MAE_BASE + path, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      });
      const body = await maeRes.text();
      return new Response(body, {
        status: maeRes.status,
        // El MAE es intradiario: cachear acá escondería el último tick.
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
      });
    }

    // ── Proxy BCRA (default) ───────────────────────────────────────────────────
    // Todos los parámetros se validan antes de interpolarse en la URL.
    const rxInt = /^\d{1,7}$/, rxDate = /^\d{4}-\d{2}-\d{2}$/;
    const id     = url.searchParams.get('id')     || '30';
    const desde  = url.searchParams.get('desde')  || '2002-01-01';
    const limit  = url.searchParams.get('limit')  || '15000';
    const offset = url.searchParams.get('offset') || '0';

    if (!rxInt.test(id))      return jsonError('id inválido', 400, cors);
    if (!rxDate.test(desde))  return jsonError('desde inválido (YYYY-MM-DD)', 400, cors);
    if (!rxInt.test(limit))   return jsonError('limit inválido', 400, cors);
    if (!rxInt.test(offset))  return jsonError('offset inválido', 400, cors);

    const lim = Math.min(parseInt(limit, 10), 15000);
    const bcraTarget = `https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias/${id}?desde=${desde}&limit=${lim}&offset=${parseInt(offset, 10)}`;
    const resp = await fetch(bcraTarget, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: { 'Content-Type': 'application/json', ...cors } });
  },

  // Cron: 15 20 * * 1-5  (lunes-viernes 20:15 UTC = 17:15 ART)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(takeDailySnapshot(env));
  },
};

