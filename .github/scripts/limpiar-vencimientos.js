// Saca del histórico de curvas las ruedas demasiado pegadas al vencimiento.
//
//   DRY_RUN=1 node .github/scripts/limpiar-vencimientos.js
//   node .github/scripts/limpiar-vencimientos.js            (borra de verdad)
//
// Por qué: a tres días del pago, mover el precio medio punto mueve la tasa
// anualizada decenas de puntos. Eso no dice nada de la curva, es aritmética de
// anualizar un plazo que tiende a cero, y ensucia el eje de todos los gráficos.
// Quedaban cosas como D31L6 en −198% a un día del vencimiento y TZV26 en +112%.
//
// El corte vive en index.html como CURVAS_DIAS_MIN y se lee de ahí, para que no
// haya dos números que se puedan desincronizar. Las dos rutas que escriben
// historia —el snapshot diario y el backfill— ya lo respetan; esto limpia lo
// que quedó guardado desde antes.
//
// Los bonos en dólares se guardaban con `dias` en null, así que el plazo se
// recalcula contra la definición del bono y no contra la columna.
//
// Requiere los secrets SUPABASE_BOT_EMAIL y SUPABASE_BOT_PASSWORD.

const { chromium } = require('playwright');

const APP_URL  = 'https://santosechezarreta5.github.io/bonos-ar/';
const EMAIL    = process.env.SUPABASE_BOT_EMAIL;
const PASSWORD = process.env.SUPABASE_BOT_PASSWORD;
const DRY      = process.env.DRY_RUN === '1';

const fatal = m => { console.error(`\n✗ ${m}\n`); process.exit(1); };

(async () => {
  if (!EMAIL || !PASSWORD) fatal('Faltan los secrets SUPABASE_BOT_EMAIL / SUPABASE_BOT_PASSWORD.');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => console.error('  [pageerror]', e.message));

  console.log(`\nLimpieza de ruedas pegadas al vencimiento${DRY ? '  (DRY RUN)' : ''}\n`);

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

  const res = await page.evaluate(async (dry) => {
    // Vencimiento de cada ticker, del lado de la app: los de pesos usan `vcto`
    // y los de dólares `vencimiento`.
    const vto = new Map();
    for (const arr of [LECAPS, CER_BONDS, TAMAR_BONDS, DLK_BONDS])
      for (const b of arr || []) if (b.vcto) vto.set(b.ticker, String(b.vcto).slice(0, 10));
    for (const arr of [BOP_BONDS, BON_BONDS, GLO_BONDS])
      for (const b of arr || []) if (b.vencimiento) vto.set(b.ticker, String(b.vencimiento).slice(0, 10));

    // Traer todo el histórico, paginado.
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

    const aBorrar = [];
    const sinVto = new Set();
    for (const f of filas) {
      const v = vto.get(f.ticker);
      if (!v) { sinVto.add(f.ticker); continue; }
      // Liquidación de esa rueda: T+1 hábil, igual que cuando se guardó.
      const liq = addHabiles(parseDate(f.snapshot_date), 1);
      const n = curvasDiasHasta(v, liq);
      if (n != null && n < CURVAS_DIAS_MIN) aBorrar.push({ ...f, restantes: n });
    }

    const detalle = {};
    for (const f of aBorrar) {
      const k = `${f.ticker}|${f.sector}`;
      (detalle[k] || (detalle[k] = [])).push(f);
    }

    let borradas = 0;
    if (!dry) {
      for (const f of aBorrar) {
        const { error } = await supa.from('bond_price_snapshots').delete()
          .eq('snapshot_date', f.snapshot_date).eq('ticker', f.ticker).eq('sector', f.sector);
        if (error) return { error: `${f.ticker} ${f.snapshot_date}: ${error.message}`, borradas };
        borradas++;
      }
    }
    return {
      total: filas.length, corte: CURVAS_DIAS_MIN, aBorrar: aBorrar.length, borradas,
      sinVto: [...sinVto],
      muestra: aBorrar.sort((a, b) => Math.abs(b.tir || 0) - Math.abs(a.tir || 0)).slice(0, 15)
        .map(f => ({ t: f.ticker, s: f.sector, f: f.snapshot_date, d: f.restantes, tir: f.tir })),
      porSector: aBorrar.reduce((a, f) => (a[f.sector] = (a[f.sector] || 0) + 1, a), {}),
    };
  }, DRY);

  if (res.error) fatal(res.error);

  console.log(`→ ${res.total} filas revisadas · corte en ${res.corte} días`);
  if (res.sinVto.length) console.log(`  sin vencimiento en la app: ${res.sinVto.join(', ')}`);
  console.log(`\n${res.aBorrar} filas a menos de ${res.corte} días del vencimiento`);
  console.log(`  por sector: ${JSON.stringify(res.porSector)}`);
  if (res.muestra.length) {
    console.log(`\n  ${'ticker'.padEnd(8)}${'sec'.padEnd(7)}${'fecha'.padEnd(12)}${'días'.padStart(5)}${'tir'.padStart(12)}`);
    for (const m of res.muestra)
      console.log(`  ${m.t.padEnd(8)}${m.s.padEnd(7)}${m.f.padEnd(12)}${String(m.d).padStart(5)}` +
                  `${(m.tir == null ? '—' : m.tir.toFixed(2)).padStart(12)}`);
  }
  console.log(`\n${DRY ? '0 borradas (dry run)' : res.borradas + ' borradas'}\n`);
  await browser.close();
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
