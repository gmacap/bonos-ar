// Snapshot diario de precios + TIR + MD.
//
// Abre la app real en un navegador headless y ejecuta su propio código de
// valuación, en vez de reimplementarlo acá. Así la TIR guardada es
// exactamente la que ve el equipo en pantalla.
//
// Desde que RLS restringe la escritura (supabase/policies.sql), el script
// tiene que autenticarse con la cuenta 'snapshot' antes de guardar.
// Requiere los secrets SUPABASE_BOT_EMAIL y SUPABASE_BOT_PASSWORD.

const { chromium } = require('playwright');

const { appUrl } = require('./app-url');
const APP_URL = appUrl();
const EMAIL = process.env.SUPABASE_BOT_EMAIL;
const PASSWORD = process.env.SUPABASE_BOT_PASSWORD;

function fatal(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

(async () => {
  if (!EMAIL || !PASSWORD)
    fatal('Faltan los secrets SUPABASE_BOT_EMAIL / SUPABASE_BOT_PASSWORD.');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  page.on('console', m => {
    if (['error', 'warning'].includes(m.type())) console.log(`  [${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', e => console.error('  [pageerror]', e.message));

  // "Failed to load resource: 404" en la consola no dice qué recurso falló.
  // Estos dos handlers sí dan la URL, que es lo único accionable.
  page.on('response', r => {
    if (r.status() >= 400) console.log(`  [HTTP ${r.status()}] ${r.url().slice(0, 160)}`);
  });
  page.on('requestfailed', r =>
    console.log(`  [request fallida] ${r.url().slice(0, 160)} — ${r.failure()?.errorText || '?'}`));

  try {
    console.log('→ Abriendo la app...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    // Esperar a que el cliente de Supabase exista antes de intentar el login
    await page.waitForFunction(() => typeof supa !== 'undefined' && supa.auth, null, { timeout: 60000 });

    console.log('→ Autenticando como bot...');
    const login = await page.evaluate(async ([email, password]) => {
      const { data, error } = await supa.auth.signInWithPassword({ email, password });
      return error ? { ok: false, error: error.message } : { ok: true, uid: data.user.id };
    }, [EMAIL, PASSWORD]);

    if (!login.ok) fatal(`Login rechazado: ${login.error}`);
    console.log(`  autenticado (uid ${login.uid.slice(0, 8)}…)`);

    // El cron corre de lunes a viernes, pero los feriados de Argentina caen en
    // día de semana. Si el mercado no operó no hay cierre que guardar, y salir
    // con éxito evita una falla diaria que después nadie mira.
    const dia = await page.evaluate(() => ({
      fecha: hoyAR(),
      habil: esHabil(parseDate(hoyAR())),
    }));
    if (!dia.habil) {
      console.log(`\n${dia.fecha} no es día hábil en Argentina — nada que guardar.\n`);
      await browser.close();
      process.exit(0);
    }

    // El login dispara onAuthStateChange → carga de datos compartidos y precios.
    console.log('→ Esperando la carga de precios (25 s)...');
    await page.waitForTimeout(25000);

    console.log('→ Ejecutando el snapshot...');
    const err = await page.evaluate(async () => {
      try {
        localStorage.removeItem('bonosAR_curvas_snap_date_v1');
        await curvasSnapshotToday();
        return null;
      } catch (e) { return e.message; }
    });
    if (err) fatal(`El snapshot lanzó una excepción: ${err}`);

    await page.waitForTimeout(5000);

    // Verificación real: contar lo que quedó en la tabla, no lo que dice
    // localStorage. Es la diferencia entre "creo que guardó" y "guardó".
    console.log('→ Verificando contra Supabase...');
    const res = await page.evaluate(async () => {
      const hoy = hoyAR();
      const { data, error } = await supa
        .from('bond_price_snapshots')
        .select('sector,tir')
        .eq('snapshot_date', hoy);
      if (error) return { error: error.message };
      const porSector = {};
      let conTir = 0;
      for (const r of data) {
        porSector[r.sector] = (porSector[r.sector] || 0) + 1;
        if (r.tir != null) conTir++;
      }
      return { fecha: hoy, total: data.length, conTir, porSector };
    });

    if (res.error) fatal(`No se pudo verificar: ${res.error}`);

    console.log(`\n  fecha        ${res.fecha}`);
    console.log(`  filas        ${res.total}`);
    console.log(`  con TIR      ${res.conTir}`);
    console.log('  por sector   ' + (Object.entries(res.porSector)
      .map(([s, n]) => `${s}:${n}`).join('  ') || '(ninguno)'));

    if (res.total === 0) fatal('No se guardó ninguna fila.');
    if (res.conTir === 0) fatal('Se guardaron precios pero ninguna TIR — la valuación no corrió.');

    const faltantes = ['TF', 'CER', 'TAMAR', 'DLK', 'BOP', 'BON', 'GLO']
      .filter(s => !res.porSector[s]);
    if (faltantes.length) console.log(`\n  ⚠ sectores sin datos: ${faltantes.join(', ')}`);

    console.log('\n✓ Snapshot guardado.\n');
  } finally {
    await browser.close();
  }
})().catch(e => fatal(e.message));
