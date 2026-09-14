// Backfill del histórico de curvas: reconstruye bond_price_snapshots para
// fechas pasadas a partir de los cierres de BYMA.
//
//   DESDE=2025-01-01 node .github/scripts/backfill-curvas.js
//   DRY_RUN=1 node .github/scripts/backfill-curvas.js        (no escribe nada)
//
// Igual que snapshot.js, corre la app real en un navegador headless y usa SU
// código de valuación. Acá importa todavía más: si reimplementara la TIR en
// Node, el histórico reconstruido no sería comparable con lo que la app calcula
// en vivo, y las curvas mezclarían dos matemáticas distintas.
//
// Para valuar en una fecha pasada alcanza con mover G_LIQ. TODAY es const, pero
// no participa de la matemática de precios: todas las funciones toman la
// liquidación de `G_LIQ || addHabiles(TODAY,1)`. Los índices CER, TAMAR y A3500
// ya vienen con su historia completa desde el BCRA, así que la valuación de una
// rueda de 2025 usa el índice de esa rueda y no el de hoy.
//
// ── Fuente de precios: data912 primero, BYMA de respaldo ──────────────────
// Las dos sirven, pero NO son equivalentes para los bonos que amortizan.
//
// BYMA reexpresa la serie histórica al residual de hoy, como un precio de
// acción ajustado por split: el precio no cae en las amortizaciones. data912
// la devuelve como se cotizó, con la caída en la fecha ex. Comparado el mismo
// día, 08/07/2025: data912 marca AL30D en −11,94% y BYMA no se mueve.
//
// Eso importa porque la app valúa con el residual de CADA fecha. Con precios de
// BYMA, el desfasaje se anualiza y salían TIR imposibles: AL30 en 38,83% en
// julio de 2025 contra un 13,07% real, AL29 y GD29 con saltos de 22 puntos en
// cada fecha de pago, y TX26 llegando a 1,3e13%.
//
// data912 cubre unos catorce bonos —los viejos: AL, GD, TX26, TX28, DICP— que
// son justamente los que amortizan. Para LECAPs, TAMAR, DLK y Bopreales no
// tiene datos, pero esos no amortizan, así que BYMA alcanza.
//
// cerAjustePrecio queda como red por si aparece un bono que amortice y data912
// no cubra: reescala por la razón de residuales. Es una aproximación —deja
// saltos de 3 a 5 puntos— así que sólo se aplica a precios de BYMA.
//
// Requiere los secrets SUPABASE_BOT_EMAIL y SUPABASE_BOT_PASSWORD.

const { chromium } = require('playwright');

const APP_URL  = 'https://santosechezarreta5.github.io/bonos-ar/';
const EMAIL    = process.env.SUPABASE_BOT_EMAIL;
const PASSWORD = process.env.SUPABASE_BOT_PASSWORD;
const DESDE    = process.env.DESDE || '2025-01-01';
const HASTA    = process.env.HASTA ||
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const DRY      = process.env.DRY_RUN === '1';
const SOBRESCRIBIR = process.env.SOBRESCRIBIR === '1';
// Reparación quirúrgica: limita el backfill a unos tickers concretos. Sin esto,
// pisar el histórico para arreglar tres bonos reescribiría también las filas que
// el snapshot diario tomó en vivo para los otros setenta y seis.
//   SOLO_TICKERS=TX26,TX28,DICP SOBRESCRIBIR=1 node .github/scripts/backfill-curvas.js
const SOLO = (process.env.SOLO_TICKERS || '').split(',').map(s => s.trim()).filter(Boolean);

const BYMA_HIST = 'https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free'
                + '/chart/historical-series/history';
const PAUSA_MS = 1100;   // BYMA pide no más de 1 req/s
const LOTE     = 500;    // filas por upsert

const dormir = ms => new Promise(r => setTimeout(r, ms));
const fatal = m => { console.error(`\n✗ ${m}\n`); process.exit(1); };

// Serie diaria de cierres tal como se cotizaron, sin reexpresar. Es la fuente
// preferida para todo lo que amortiza: data912 refleja la caída del precio en
// la fecha ex, que es el día hábil anterior al pago. Verificado sobre AL30D
// (−11,94% el 08/07/2025), TX26 (−25,97% el 08/05/2025, con el residual pasando
// de 80% a 60%) y TX28 (−13,73%, de 80% a 70%).
//
// Cubre unos catorce bonos, justamente los viejos — los AL, GD, TX26, TX28 y
// DICP — que son los que amortizan. Para el resto no hay nada que corregir.
async function serie912(symbol) {
  const r = await fetch(`https://data912.com/historical/bonds/${encodeURIComponent(symbol)}`,
                        { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return [];
  const d = await r.json();
  if (!Array.isArray(d)) return [];
  const out = [];
  for (const x of d) {
    const fecha = String(x.date || '').slice(0, 10);
    const c = x.c;
    if (!(c > 0) || fecha < DESDE || fecha > HASTA) continue;
    out.push({ fecha, cierre: c });
  }
  return out;
}

// Serie diaria de cierres. Los timestamps caen siempre en día hábil leyéndolos
// en UTC — verificado contra GD30D: 410 ruedas, ningún sábado ni domingo.
//
// ⚠ BYMA REEXPRESA la serie histórica al residual de hoy, como un precio de
// acción ajustado por split: el precio no cae en las amortizaciones. Sirve para
// los bonos que no amortizan; para los que sí, usar serie912.
async function serieByma(symbol) {
  const from = Math.floor(Date.parse(DESDE + 'T00:00:00Z') / 1000) - 86400 * 5;
  const to   = Math.floor(Date.parse(HASTA + 'T00:00:00Z') / 1000) + 86400 * 2;
  const url  = `${BYMA_HIST}?symbol=${encodeURIComponent(symbol + ' 24HS')}`
             + `&resolution=D&from=${from}&to=${to}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (d.s !== 'ok' || !Array.isArray(d.t)) return [];
  const out = [];
  for (let i = 0; i < d.t.length; i++) {
    const c = d.c[i];
    if (!(c > 0)) continue;
    const fecha = new Date(d.t[i] * 1000).toISOString().slice(0, 10);
    if (fecha >= DESDE && fecha <= HASTA) out.push({ fecha, cierre: c });
  }
  return out;
}

(async () => {
  if (!EMAIL || !PASSWORD) fatal('Faltan los secrets SUPABASE_BOT_EMAIL / SUPABASE_BOT_PASSWORD.');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => console.error('  [pageerror]', e.message));

  console.log(`\nBackfill de curvas — ${DESDE} a ${HASTA}${DRY ? '  (DRY RUN)' : ''}\n`);

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof supa !== 'undefined' && supa.auth, null, { timeout: 60000 });

  const login = await page.evaluate(async ([email, password]) => {
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    return error ? { ok: false, error: error.message } : { ok: true, uid: data.user.id };
  }, [EMAIL, PASSWORD]);
  if (!login.ok) fatal(`Login rechazado: ${login.error}`);
  console.log(`→ autenticado (uid ${login.uid.slice(0, 8)}…)`);

  // Definiciones y los índices que necesita la valuación histórica.
  console.log('→ esperando definiciones e índices…');
  await page.evaluate(async () => {
    if (typeof cerFetchIndex === 'function' && !CER_INDEX.length) await cerFetchIndex();
    if (typeof tamarFetchIndex === 'function' && !TAMAR_INDEX.length) await tamarFetchIndex();
    if (typeof dlkFetchIndex === 'function' && !DLK_INDEX.length) await dlkFetchIndex();
  });
  await page.waitForFunction(() => {
    const defs = [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().length > 0 && CER_BONDS.length > 0;
    return defs && CER_INDEX.length > 0 && TAMAR_INDEX.length > 0 && DLK_INDEX.length > 0;
  }, null, { timeout: 120000 });

  // Qué símbolo de BYMA le corresponde a cada bono. Para los que cotizan en
  // dólares es el símbolo MEP de la tabla de equivalencias de la app, la misma
  // que usa para pedir precios en vivo — no se adivina el sufijo.
  const objetivo = await page.evaluate(() => {
    const eq = new Map((typeof EQUIV_DATA !== 'undefined' ? EQUIV_DATA : [])
      .map(e => [e.ticker, e.mep || e.cable]));
    const out = [];
    for (const [arr, sector] of [[BOP_BONDS, 'BOP'], [BON_BONDS, 'BON'], [GLO_BONDS, 'GLO']])
      for (const b of arr || []) out.push({ ticker: b.ticker, sector, symbol: eq.get(b.ticker) || null });
    for (const [arr, sector] of [
      [typeof LECAPS      !== 'undefined' ? LECAPS      : [], 'TF'],
      [typeof CER_BONDS   !== 'undefined' ? CER_BONDS   : [], 'CER'],
      [typeof TAMAR_BONDS !== 'undefined' ? TAMAR_BONDS : [], 'TAMAR'],
      [typeof DLK_BONDS   !== 'undefined' ? DLK_BONDS   : [], 'DLK'],
    ]) for (const b of arr || []) out.push({ ticker: b.ticker, sector, symbol: b.ticker });
    // Un mismo ticker puede estar en dos sectores (TXMJ0 en CER y TAMAR): el
    // precio es el mismo, así que se pide una sola vez.
    const vistos = new Set();
    return out.filter(o => o.symbol && !vistos.has(o.symbol) && vistos.add(o.symbol));
  });

  console.log(`→ ${objetivo.length} símbolos a pedir (~${Math.round(objetivo.length * PAUSA_MS / 1000)}s)\n`);

  // precios[fecha][ticker] = cierre
  const precios = {};
  // De dónde salió cada ticker. Importa para saber si hay que corregir el
  // precio de los que amortizan: data912 ya viene bien, BYMA no.
  const fuente = {};
  let conDatos = 0, de912 = 0;
  const sinDatos = [];
  for (const o of objetivo) {
    let serie = [];
    // data912 primero: trae el precio como se cotizó. BYMA sólo si no lo tiene.
    try { serie = await serie912(o.symbol); } catch (e) { serie = []; }
    if (serie.length > 20) { fuente[o.ticker] = '912'; de912++; }
    else {
      try { serie = await serieByma(o.symbol); }
      catch (e) { sinDatos.push(`${o.ticker} (${o.symbol}): ${e.message}`); await dormir(PAUSA_MS); continue; }
      fuente[o.ticker] = 'byma';
    }
    await dormir(PAUSA_MS);
    if (!serie.length) { sinDatos.push(`${o.ticker} (${o.symbol}): sin ruedas`); continue; }
    conDatos++;
    for (const { fecha, cierre } of serie) {
      (precios[fecha] || (precios[fecha] = {}))[o.ticker] = cierre;
    }
    process.stdout.write(`  ${o.ticker} ${serie.length}\r`);
  }
  console.log(`  ${conDatos} series traídas (${de912} de data912, ${conDatos - de912} de BYMA)`
              + ` · ${sinDatos.length} sin datos          `);
  if (sinDatos.length) for (const s of sinDatos.slice(0, 12)) console.log(`    · ${s}`);

  let fechas = Object.keys(precios).sort();
  if (!fechas.length) fatal('BYMA no devolvió ninguna rueda en el rango.');

  // No pisar lo que ya guardó el snapshot diario, que se tomó con precios en
  // vivo. Se recorta el backfill hasta la primera fecha existente.
  if (!SOBRESCRIBIR) {
    const primera = await page.evaluate(async () => {
      const { data } = await supa.from('bond_price_snapshots')
        .select('snapshot_date').order('snapshot_date', { ascending: true }).limit(1);
      return data && data.length ? data[0].snapshot_date : null;
    });
    if (primera) {
      const antes = fechas.length;
      fechas = fechas.filter(f => f < primera);
      console.log(`→ ya hay snapshots desde ${primera}: se omiten ${antes - fechas.length} ruedas`
                + ' (SOBRESCRIBIR=1 para pisarlas)');
    }
  }
  console.log(`→ ${fechas.length} ruedas a reconstruir\n`);

  // De a un mes: acota lo que viaja al navegador y da progreso visible.
  const meses = [...new Set(fechas.map(f => f.slice(0, 7)))].sort();
  let totalFilas = 0, totalGuardadas = 0;
  const omitidosTotal = {};

  for (const mes of meses) {
    const delMes = fechas.filter(f => f.startsWith(mes));
    const px = {};
    for (const f of delMes) px[f] = precios[f];

    const res = await page.evaluate(async ({ delMes, px, dry, solo, fuente }) => {
      const bkLiq = G_LIQ, bkTC = dlkTCOverride;
      const filas = [];
      const omitidos = {};
      // Filtro de reparación: si viene una lista, sólo esos tickers se recalculan.
      const incluir = t => !solo.length || solo.includes(t);

      // ── Las últimas ruedas antes del vencimiento no entran ─────────────────
      // A tres días del pago, mover el precio medio punto mueve la tasa
      // anualizada decenas de puntos: no es información sobre la curva, es
      // aritmética de anualizar un plazo que tiende a cero. Quedaban cosas como
      // D31L6 en −198% a un día del vencimiento, o TZV26 en +112%.
      const DIAS_MIN = 4;
      const diasHasta = (vto, liqStr) => {
        if (!vto) return null;
        const d = parseDate(String(vto).slice(0, 10));
        return d && !isNaN(d) ? diasACT(parseDate(liqStr), d) : null;
      };
      const muyCerca = (vto, liqStr) => {
        const n = diasHasta(vto, liqStr);
        return n != null && n < DIAS_MIN;
      };
      // Red de seguridad: una tasa de tres dígitos largos no es una cotización,
      // es un cálculo que se fue de escala. Mejor no guardarla que ensuciar el
      // eje de todos los gráficos con un solo punto.
      const sano = t => t != null && isFinite(t) && Math.abs(t) < 500;

      // ── Precio de un CER que amortiza, traído a la base de su rueda ──────
      //
      // BYMA y data912 —que coinciden al centavo— reexpresan la serie histórica
      // al residual de HOY, como un precio de acción ajustado por split: la
      // serie queda continua a través de los pagos de capital. Verificado: el
      // precio de TX26 no cae en ninguna de sus cuatro amortizaciones.
      //
      // La app, en cambio, valúa con el residual de CADA fecha. Las dos cosas
      // están en bases distintas y el desfasaje es residual(t)/residual(hoy).
      // En TX26 eso es 80/20 = 4 veces en enero de 2025, y de ahí salían las
      // tasas de 1,3e13%. En TX28 es 80/50 = 1,6 y la distorsión no se notaba,
      // que es peor.
      //
      // Al multiplicar por esa razón, la paridad de TX26 pasa de saltar
      // 0,22 → 0,30 → 0,48 → 1,00 en cada cuota, a converger suave de 0,88 a
      // 1,00 en veinte meses, que es lo que tiene que hacer.
      // El residual se calcula con las funciones de la app, no a mano: DICP
      // capitaliza intereses y su saldo no es una resta de cuotas. Reimplementarlo
      // daba 75% donde la app dice 68,25%, y el ajuste habría quedado sesgado.
      // Esto replica el PASO 1 de cerBuildFlujosProy.
      const residualPct = (b, hasta) => {
        if (b.tipo !== 'cupon') return b.vnInicial || 100;
        const freq = b.freq || 6;
        const dates = cerCouponDates(b.emision, b.vcto, freq, b.primerCupon || null);
        const amortTable = cerBuildAmortTable(b, dates, freq);
        const lim = parseDate(hasta);
        if (b.cuponSchedule && b.cuponSchedule.length) {
          const amortMap = new Map(amortTable.map(a => [a.fecha, a.pct]));
          let vn = 100;
          for (const d of dates) {
            if (d > lim) break;
            const tramo = b.cuponSchedule.find(t => d > parseDate(t.desde) && d <= parseDate(t.hasta));
            const pik = ((tramo && tramo.tasaPIK) || 0) / 100 * (freq / 12);
            vn = Math.max(0, vn * (1 + pik) - (amortMap.get(fmtDate(d)) || 0));
          }
          return vn;
        }
        let vn = b.vnInicial || 100;
        amortTable.forEach(a => { if (parseDate(a.fecha) <= lim) vn = Math.max(0, vn - a.pct); });
        return vn;
      };
      const hoyStr = fmtDate(TODAY);
      // Sólo hace falta con precios de BYMA. Si el precio vino de data912 ya
      // trae la caída de la amortización y reescalarlo sería corromperlo.
      const cerAjustePrecio = (b, liqStr) => {
        if (fuente[b.ticker] !== 'byma') return 1;
        const tieneCuotas = (b.amortSchedule || []).length > 0 || (b.amortAuto && b.amortAuto.first);
        if (!tieneCuotas) return 1;
        const rt = residualPct(b, liqStr), rHoy = residualPct(b, hoyStr);
        if (!(rt > 0) || !(rHoy > 0)) return 1;
        return rt / rHoy;
      };

      try {
        for (const fecha of delMes) {
          const p = px[fecha] || {};
          // Liquidación de esa rueda: T+1 hábil, el plazo por defecto de la app.
          G_LIQ = addHabiles(parseDate(fecha), 1);
          const liqStr = fmtDate(G_LIQ);

          // A3500 vigente en esa liquidación, para los dollar linked. Sin esto
          // dlkTCHoy() devolvería el tipo de cambio de hoy y la TNA saldría mal.
          let tc = null;
          for (const r of DLK_INDEX) if (r.fecha <= liqStr && r.valor > 0 && (!tc || r.fecha > tc.fecha)) tc = r;
          dlkTCOverride = tc ? tc.valor : null;

          for (const [arr, sector] of [[BOP_BONDS, 'BOP'], [BON_BONDS, 'BON'], [GLO_BONDS, 'GLO']])
            for (const b of arr || []) {
              const v = p[b.ticker]; if (v == null) continue;
              if (!incluir(b.ticker)) continue;
              if (muyCerca(b.vencimiento, liqStr)) continue;
              try {
                const r = usdResCalcRow({ ...b, lastPrecio: v }, liqStr);
                if (r.tir == null || isNaN(r.tir) || r.md == null || !sano(r.tir)) continue;
                filas.push({ snapshot_date: fecha, ticker: b.ticker, sector, price: +v.toFixed(4),
                             tir: +r.tir.toFixed(6), md: +r.md.toFixed(4),
                             dias: diasHasta(b.vencimiento, liqStr) });
              } catch (e) {}
            }

          for (const b of (typeof LECAPS !== 'undefined' ? LECAPS : [])) {
            const v = p[b.ticker]; if (v == null) continue;
            if (!incluir(b.ticker)) continue;
            if (muyCerca(b.vcto, liqStr)) continue;
            try {
              const e = enrich({ ...b, precio: v });
              if (!e || isNaN(e.tna) || !(e.dias > 0) || !sano(e.tna)) continue;
              filas.push({ snapshot_date: fecha, ticker: b.ticker, sector: 'TF', price: +v.toFixed(4),
                           tir: +e.tna.toFixed(6),
                           md: (!isNaN(e.modDuration) && e.modDuration > 0) ? +e.modDuration.toFixed(4) : null,
                           dias: e.dias });
            } catch (ex) {}
          }

          for (const b of (typeof CER_BONDS !== 'undefined' ? CER_BONDS : [])) {
            const v0 = p[b.ticker]; if (v0 == null) continue;
            if (!incluir(b.ticker)) continue;
            if (muyCerca(b.vcto, liqStr)) continue;
            // Los CER que amortizan necesitan que el precio se traiga a la base
            // del día. Ver el comentario de residualPct: la serie histórica
            // viene reexpresada al residual de hoy.
            const v = v0 * cerAjustePrecio(b, liqStr);
            try {
              const e = cerEnrich({ ...b, precio: v });
              if (!e || isNaN(e.tir) || !(e.dias > 0) || !sano(e.tir)) continue;
              filas.push({ snapshot_date: fecha, ticker: b.ticker, sector: 'CER', price: +v.toFixed(4),
                           tir: +e.tir.toFixed(6),
                           md: (!isNaN(e.modDuration) && e.modDuration > 0) ? +e.modDuration.toFixed(4) : null,
                           dias: e.dias });
            } catch (ex) {}
          }

          for (const b of (typeof TAMAR_BONDS !== 'undefined' ? TAMAR_BONDS : [])) {
            const v = p[b.ticker]; if (v == null) continue;
            if (!incluir(b.ticker)) continue;
            if (muyCerca(b.vcto, liqStr)) continue;
            try {
              const e = tamarEnrich({ ...b, precio: v });
              if (!e || isNaN(e.margenTNA) || !(e.dias > 0) || !sano(e.margenTNA)) continue;
              filas.push({ snapshot_date: fecha, ticker: b.ticker, sector: 'TAMAR', price: +v.toFixed(4),
                           tir: +e.margenTNA.toFixed(6),
                           md: (!isNaN(e.modDuration) && e.modDuration > 0) ? +e.modDuration.toFixed(4) : null,
                           dias: e.dias });
            } catch (ex) {}
          }

          for (const b of (typeof DLK_BONDS !== 'undefined' ? DLK_BONDS : [])) {
            const v = p[b.ticker]; if (v == null) continue;
            if (!incluir(b.ticker)) continue;
            if (muyCerca(b.vcto, liqStr)) continue;
            try {
              const e = dlkEnrich({ ...b, precio: v });
              if (!e || e.tna == null || isNaN(e.tna) || !(e.dias > 0) || !sano(e.tna)) continue;
              filas.push({ snapshot_date: fecha, ticker: b.ticker, sector: 'DLK', price: +v.toFixed(4),
                           tir: +e.tna.toFixed(6),
                           md: (e.dias > 0) ? +(e.dias / 365 / (1 + e.tna / 100)).toFixed(4) : null,
                           dias: e.dias });
            } catch (ex) {}
          }
        }
      } finally { G_LIQ = bkLiq; dlkTCOverride = bkTC; }

      if (dry) return { filas: filas.length, guardadas: 0, error: null, omitidos };

      // Un ticker puede vivir en dos sectores; la clave única incluye sector,
      // así que se deduplica por (fecha, ticker, sector) antes de mandar.
      const clave = r => `${r.snapshot_date}|${r.ticker}|${r.sector}`;
      const unicas = [...new Map(filas.map(r => [clave(r), r])).values()];
      let guardadas = 0;
      for (let i = 0; i < unicas.length; i += 500) {
        const lote = unicas.slice(i, i + 500);
        const { error } = await supa.from('bond_price_snapshots')
          .upsert(lote, { onConflict: 'snapshot_date,ticker,sector' });
        if (error) return { filas: filas.length, guardadas, error: error.message, omitidos };
        guardadas += lote.length;
      }
      return { filas: filas.length, guardadas, error: null, omitidos };
    }, { delMes, px, dry: DRY, solo: SOLO, fuente });

    totalFilas += res.filas;
    totalGuardadas += res.guardadas;
    Object.assign(omitidosTotal, res.omitidos || {});
    const estado = res.error ? `\x1b[31mERROR ${res.error}\x1b[0m` : `${res.guardadas} guardadas`;
    console.log(`  ${mes}  ${delMes.length} ruedas · ${res.filas} filas · ${DRY ? 'dry run' : estado}`);
    if (res.error) { await browser.close(); fatal(`Falló el upsert en ${mes}`); }
  }

  const om = Object.keys(omitidosTotal);
  if (om.length) {
    console.log(`\nBonos omitidos del histórico (${om.length}): ${om.sort().join(', ')}`);
  }

  console.log(`\n${totalFilas} filas calculadas · ${DRY ? '0 guardadas (dry run)' : totalGuardadas + ' guardadas'}\n`);
  await browser.close();
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
