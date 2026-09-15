// Siembra el monto operado en las filas que ya existen de bond_price_snapshots.
//
//   node .github/scripts/backfill-volumen.js
//   DESDE=2026-06-01 DRY_RUN=1 node .github/scripts/backfill-volumen.js
//
// La columna `monto` se agregó después de 19.701 filas, así que el histórico
// arranca vacío y se llenaría una rueda por día. BYMA publica el volumen de las
// últimas ~72 ruedas por instrumento y responde fuera de rueda, así que el
// tramo reciente se puede sembrar de una.
//
// ── Sólo actualiza, nunca crea ──────────────────────────────────────────────
// Se leen las filas que ya están y se les agrega el monto; nada se inserta. Un
// upsert con sólo la clave y el monto insertaría filas con price, tir y md en
// null cuando la rueda no existiera, y eso ensucia las curvas con puntos que no
// son una valuación. Por eso se reescribe la fila completa con lo que ya tenía.
//
// ── El volumen viene en NOMINALES ───────────────────────────────────────────
// Igual que en data912: AL30 marcó 127.970.816 nominales el 14/09, que al
// cierre de 85.250 por cada 100 son 109 mil millones de pesos. El corte del
// semáforo de la app está en pesos, así que hay que pasar por el precio.
//
// ── Los bonos en dólares ────────────────────────────────────────────────────
// El histórico guarda su precio en base MEP, así que el volumen se toma del
// mismo ticker en dólares y se pasa a pesos con el MEP de ESA rueda, que sale
// de AL30 sobre AL30D en data912. Emparejar el volumen de un día con el MEP de
// otro daría un monto que nadie operó.
//
// Requiere los secrets SUPABASE_BOT_EMAIL y SUPABASE_BOT_PASSWORD.

const { chromium } = require('playwright');

const APP_URL  = 'https://santosechezarreta5.github.io/bonos-ar/';
const EMAIL    = process.env.SUPABASE_BOT_EMAIL;
const PASSWORD = process.env.SUPABASE_BOT_PASSWORD;
const DRY      = process.env.DRY_RUN === '1';
// BYMA da unas 72 ruedas: pedir más no rompe, simplemente no trae nada antes.
const DESDE = process.env.DESDE || (() => {
  const d = new Date(); d.setDate(d.getDate() - 150);
  return d.toISOString().slice(0, 10);
})();
const HASTA = process.env.HASTA ||
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const SOLO = (process.env.SOLO_TICKERS || '').split(',').map(s => s.trim()).filter(Boolean);

const fatal = m => { console.error(`\n✗ ${m}\n`); process.exit(1); };

(async () => {
  if (!EMAIL || !PASSWORD) fatal('Faltan los secrets SUPABASE_BOT_EMAIL / SUPABASE_BOT_PASSWORD.');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', e => console.error('  [pageerror]', e.message));

  console.log(`\nSembrado del monto operado — ${DESDE} a ${HASTA}${DRY ? '  (DRY RUN)' : ''}\n`);

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof supa !== 'undefined' && supa.auth, null, { timeout: 60000 });

  const login = await page.evaluate(async ([email, password]) => {
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    return error ? { ok: false, error: error.message } : { ok: true, uid: data.user.id };
  }, [EMAIL, PASSWORD]);
  if (!login.ok) fatal(`Login rechazado: ${login.error}`);
  console.log(`→ autenticado (uid ${login.uid.slice(0, 8)}…)`);

  await page.waitForFunction(() =>
    [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().length > 0 && CER_BONDS.length > 0 &&
    typeof EQUIV_DATA !== 'undefined',
    null, { timeout: 120000 });

  const res = await page.evaluate(async ({ desde, hasta, dry, solo }) => {
    const BYMA = 'https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free'
               + '/chart/historical-series/history';
    const pausa = ms => new Promise(r => setTimeout(r, ms));
    const incluir = t => !solo.length || solo.includes(t);

    // Símbolo de BYMA por ticker, y si ese símbolo cotiza en pesos.
    // Los de pesos son el ticker tal cual; los USD, la especie D del histórico.
    const eq = new Map((EQUIV_DATA || []).map(e => [e.ticker, e.mep || e.cable]));
    const simbolo = new Map();
    for (const arr of [LECAPS, CER_BONDS, TAMAR_BONDS, DLK_BONDS])
      for (const b of arr || []) if (b && b.ticker) simbolo.set(b.ticker, { sym: b.ticker, pesos: true });
    for (const arr of [BOP_BONDS, BON_BONDS, GLO_BONDS])
      for (const b of arr || []) {
        const s = eq.get(b.ticker);
        if (s) simbolo.set(b.ticker, { sym: s, pesos: false });
      }

    // ── Cierres con volumen, por ticker ──────────────────────────────────────
    const hist = new Map();       // ticker -> Map(fecha -> {c, v})
    const sinDatos = [];
    for (const [ticker, { sym }] of simbolo) {
      if (!incluir(ticker)) continue;
      try {
        const p = new URLSearchParams({
          symbol: sym + ' 24HS', resolution: 'D',
          from: String(Math.floor(Date.parse(desde + 'T00:00:00Z') / 1000) - 86400 * 5),
          to: String(Math.floor(Date.parse(hasta + 'T00:00:00Z') / 1000) + 86400 * 2),
        });
        const r = await fetch(BYMA + '?' + p, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        const m = new Map();
        const t = d.t || [], c = d.c || [], v = d.v || [];
        for (let i = 0; i < t.length; i++) {
          const f = new Date(t[i] * 1000).toISOString().slice(0, 10);
          if (f < desde || f > hasta) continue;
          if (!(c[i] > 0) || !(v[i] > 0)) continue;
          m.set(f, { c: +c[i], v: +v[i] });
        }
        if (m.size) hist.set(ticker, m); else sinDatos.push(`${ticker} (${sym})`);
      } catch (e) { sinDatos.push(`${ticker} (${sym}): ${e.message}`); }
      await pausa(1100);   // BYMA pide no más de un pedido por segundo
    }

    // ── MEP por rueda, para pasar a pesos el volumen de los bonos en dólares ─
    const mep = new Map();
    try {
      const serie = async s => {
        const r = await fetch(`https://data912.com/historical/bonds/${s}`);
        const d = await r.json();
        const m = new Map();
        for (const x of d || []) if (x && x.date && x.c > 0) m.set(String(x.date).slice(0, 10), +x.c);
        return m;
      };
      const [ars, usd] = await Promise.all([serie('AL30'), serie('AL30D')]);
      for (const [f, a] of ars) { const u = usd.get(f); if (u > 0) mep.set(f, a / u); }
    } catch (e) { /* sin MEP los USD quedan sin monto, y se reporta */ }

    // ── Filas existentes en el rango ─────────────────────────────────────────
    const filas = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supa.from('bond_price_snapshots')
        .select('id,snapshot_date,ticker,sector,price,tir,md,dias,monto,spread')
        .gte('snapshot_date', desde).lte('snapshot_date', hasta)
        .order('snapshot_date', { ascending: true }).range(off, off + 999);
      if (error) return { error: error.message };
      if (!data.length) break;
      filas.push(...data);
      if (data.length < 1000) break;
    }

    // ── Merge: sólo se toca `monto`, el resto viaja tal cual ─────────────────
    const aEscribir = [];
    let yaTenian = 0, sinPrecioUsd = 0;
    for (const f of filas) {
      if (!incluir(f.ticker)) continue;
      if (f.monto != null) { yaTenian++; continue; }
      const h = hist.get(f.ticker);
      const d = h && h.get(f.snapshot_date);
      if (!d) continue;
      const info = simbolo.get(f.ticker);
      let monto = d.v * d.c / 100;
      if (info && !info.pesos) {
        const tc = mep.get(f.snapshot_date);
        if (!(tc > 0)) { sinPrecioUsd++; continue; }
        monto *= tc;
      }
      if (!isFinite(monto) || monto <= 0) continue;
      aEscribir.push({ ...f, monto: +monto.toFixed(2) });
    }

    let guardadas = 0;
    const fallos = [];
    if (!dry) {
      for (let i = 0; i < aEscribir.length; i += 500) {
        const lote = aEscribir.slice(i, i + 500);
        const { error } = await supa.from('bond_price_snapshots')
          .upsert(lote, { onConflict: 'snapshot_date,ticker,sector' });
        if (error) fallos.push(error.message); else guardadas += lote.length;
      }
    }

    const porSector = aEscribir.reduce((a, f) => (a[f.sector] = (a[f.sector] || 0) + 1, a), {});
    return {
      tickers: simbolo.size, conHistoria: hist.size, sinDatos: sinDatos.slice(0, 12),
      ruedasMep: mep.size, filas: filas.length, yaTenian, sinPrecioUsd,
      candidatas: aEscribir.length, guardadas, porSector, fallos,
      muestra: aEscribir.slice(0, 6).map(f => ({ f: f.snapshot_date, t: f.ticker, s: f.sector, m: f.monto })),
    };
  }, { desde: DESDE, hasta: HASTA, dry: DRY, solo: SOLO });

  if (res.error) fatal(res.error);

  console.log(`→ ${res.conHistoria}/${res.tickers} tickers con volumen en BYMA · ${res.ruedasMep} ruedas con MEP`);
  if (res.sinDatos.length) console.log(`  sin datos: ${res.sinDatos.join(', ')}`);
  console.log(`→ ${res.filas} filas en el rango · ${res.yaTenian} ya tenían monto`);
  if (res.sinPrecioUsd) console.log(`  ${res.sinPrecioUsd} filas USD sin MEP de esa rueda`);
  console.log(`\n${res.candidatas} filas a completar${DRY ? '  (DRY RUN, no se escribió)' : ` · ${res.guardadas} guardadas`}`);
  if (Object.keys(res.porSector).length) console.log(`  por sector: ${JSON.stringify(res.porSector)}`);
  if (res.muestra.length) {
    console.log(`\n  ${'fecha'.padEnd(12)}${'ticker'.padEnd(8)}${'sec'.padEnd(7)}${'monto'.padStart(18)}`);
    for (const m of res.muestra)
      console.log(`  ${m.f.padEnd(12)}${m.t.padEnd(8)}${m.s.padEnd(7)}${m.m.toLocaleString('es-AR').padStart(18)}`);
  }
  if (res.fallos.length) { console.log(''); res.fallos.forEach(f => console.error('  ✗ ' + f)); }
  console.log('');
  await browser.close();
  if (res.fallos.length) process.exit(1);
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
