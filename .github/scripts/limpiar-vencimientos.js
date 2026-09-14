// Lista las ruedas demasiado pegadas al vencimiento y arma el SQL para sacarlas.
//
//   node .github/scripts/limpiar-vencimientos.js
//
// NO borra, y eso es a propósito: bond_price_snapshots no tiene policy de
// DELETE. policies.sql lo dice con todas las letras — "es el dato que no se
// puede reconstruir: si se corrompe, no hay API que devuelva la TIR de un bono
// de hace tres meses". Un delete desde el cliente no falla, simplemente no
// afecta ninguna fila, así que un script que contara iteraciones reportaría un
// éxito que nunca ocurrió. Este verifica.
//
// Por qué molestan esas filas: a tres días del pago, mover el precio medio
// punto mueve la tasa anualizada decenas de puntos. No dice nada de la curva,
// es aritmética de anualizar un plazo que tiende a cero. Quedaban D31L6 en
// −198% a un día del vencimiento y TZV26 en +112%.
//
// La app ya no las lee —el filtro está en las consultas, contra
// CURVAS_DIAS_MIN— y ni el snapshot diario ni el backfill las generan. Esto es
// para el caso de querer sacarlas también de la tabla.
//
// El corte se lee de index.html, para que no haya dos números que se puedan
// desincronizar. Los bonos en dólares se guardaban con `dias` en null, así que
// el plazo se recalcula contra la definición del bono.
//
// Requiere los secrets SUPABASE_BOT_EMAIL y SUPABASE_BOT_PASSWORD.

const { chromium } = require('playwright');
const fs = require('fs');

const APP_URL  = 'https://santosechezarreta5.github.io/bonos-ar/';
const EMAIL    = process.env.SUPABASE_BOT_EMAIL;
const PASSWORD = process.env.SUPABASE_BOT_PASSWORD;
const SALIDA   = 'supabase/limpiar-vencimientos.sql';

const fatal = m => { console.error(`\n✗ ${m}\n`); process.exit(1); };

(async () => {
  if (!EMAIL || !PASSWORD) fatal('Faltan los secrets SUPABASE_BOT_EMAIL / SUPABASE_BOT_PASSWORD.');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => console.error('  [pageerror]', e.message));

  console.log('\nRuedas pegadas al vencimiento en el histórico de curvas\n');

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof supa !== 'undefined' && supa.auth, null, { timeout: 60000 });

  const login = await page.evaluate(async ([email, password]) => {
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    return error ? { ok: false, error: error.message } : { ok: true, uid: data.user.id };
  }, [EMAIL, PASSWORD]);
  if (!login.ok) fatal(`Login rechazado: ${login.error}`);
  console.log(`→ autenticado (uid ${login.uid.slice(0, 8)}…)`);

  await page.waitForFunction(() =>
    [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().length > 0 && CER_BONDS.length > 0,
    null, { timeout: 120000 });

  const res = await page.evaluate(async () => {
    // Vencimiento por ticker: los de pesos usan `vcto`, los de dólares `vencimiento`.
    const vto = new Map();
    for (const arr of [LECAPS, CER_BONDS, TAMAR_BONDS, DLK_BONDS])
      for (const b of arr || []) if (b.vcto) vto.set(b.ticker, String(b.vcto).slice(0, 10));
    for (const arr of [BOP_BONDS, BON_BONDS, GLO_BONDS])
      for (const b of arr || []) if (b.vencimiento) vto.set(b.ticker, String(b.vencimiento).slice(0, 10));

    const filas = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await supa.from('bond_price_snapshots')
        .select('snapshot_date,ticker,sector,tir,dias')
        .order('snapshot_date', { ascending: true })
        .range(desde, desde + 999);
      if (error) return { error: error.message };
      if (!data.length) break;
      filas.push(...data);
      if (data.length < 1000) break;
    }

    const sobran = [];
    const sinVto = new Set();
    for (const f of filas) {
      const v = vto.get(f.ticker);
      if (!v) { sinVto.add(f.ticker); continue; }
      const liq = addHabiles(parseDate(f.snapshot_date), 1);
      const n = curvasDiasHasta(v, liq);
      if (n != null && n < CURVAS_DIAS_MIN) sobran.push({ ...f, restantes: n });
    }

    // ¿La tabla acepta borrado? Se prueba sobre una fila y se verifica que haya
    // desaparecido de verdad. Sin policy de DELETE vuelve sin error y sin efecto.
    let puedeBorrar = null;
    if (sobran.length) {
      const f = sobran[0];
      const { error } = await supa.from('bond_price_snapshots').delete()
        .eq('snapshot_date', f.snapshot_date).eq('ticker', f.ticker).eq('sector', f.sector);
      const { data: quedo } = await supa.from('bond_price_snapshots')
        .select('ticker').eq('snapshot_date', f.snapshot_date)
        .eq('ticker', f.ticker).eq('sector', f.sector);
      puedeBorrar = !error && (!quedo || quedo.length === 0);
    }

    return {
      total: filas.length, corte: CURVAS_DIAS_MIN, sobran: sobran.length, puedeBorrar,
      sinVto: [...sinVto],
      porSector: sobran.reduce((a, f) => (a[f.sector] = (a[f.sector] || 0) + 1, a), {}),
      muestra: [...sobran].sort((a, b) => Math.abs(b.tir || 0) - Math.abs(a.tir || 0)).slice(0, 12)
        .map(f => ({ t: f.ticker, s: f.sector, f: f.snapshot_date, d: f.restantes, tir: f.tir })),
      sql: sobran.map(f =>
        `delete from public.bond_price_snapshots where snapshot_date='${f.snapshot_date}'`
        + ` and ticker='${f.ticker}' and sector='${f.sector}';`),
    };
  });

  if (res.error) fatal(res.error);

  console.log(`→ ${res.total} filas revisadas · corte en ${res.corte} días`);
  if (res.sinVto.length) console.log(`  sin vencimiento en la app: ${res.sinVto.join(', ')}`);
  console.log(`\n${res.sobran} filas a menos de ${res.corte} días del vencimiento`);
  if (res.sobran) console.log(`  por sector: ${JSON.stringify(res.porSector)}`);

  if (res.muestra.length) {
    console.log(`\n  ${'ticker'.padEnd(8)}${'sec'.padEnd(7)}${'fecha'.padEnd(12)}${'días'.padStart(5)}${'tir'.padStart(12)}`);
    for (const m of res.muestra)
      console.log(`  ${m.t.padEnd(8)}${m.s.padEnd(7)}${m.f.padEnd(12)}${String(m.d).padStart(5)}` +
                  `${(m.tir == null ? '—' : m.tir.toFixed(2)).padStart(12)}`);
  }

  if (res.puedeBorrar === false) {
    console.log('\n  La tabla no acepta borrado desde el cliente, que es como está diseñada.');
    console.log('  La app ya no lee estas filas. Para sacarlas también de la tabla, correr');
    console.log('  el SQL generado como admin en el editor de Supabase.');
  } else if (res.puedeBorrar === true) {
    console.log('\n  ⚠ El borrado desde el cliente funcionó sobre una fila de prueba, y');
    console.log('  policies.sql dice que no debería. Conviene revisar las policies.');
  }

  if (res.sql.length) {
    fs.writeFileSync(SALIDA,
      `-- Ruedas a menos de ${res.corte} días del vencimiento: la tasa anualizada ahí\n` +
      '-- deja de decir algo sobre la curva. La app ya no las lee; esto las saca\n' +
      '-- de la tabla. Generado por .github/scripts/limpiar-vencimientos.js\n\n' +
      'begin;\n' + res.sql.join('\n') + '\ncommit;\n');
    console.log(`\n  ${res.sql.length} sentencias escritas en ${SALIDA}`);
  }
  console.log('');
  await browser.close();
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
