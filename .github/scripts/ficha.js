// Extrae la ficha de mercado de la app, para que alguien escriba el comentario.
//
//   node .github/scripts/ficha.js
//   node .github/scripts/ficha.js --local --salida ficha.json
//   node .github/scripts/ficha.js --periodo dia --envivo
//
// No calcula nada: abre la app publicada y le pide fichaConstruir(), que es la
// misma funcion que dibuja el panel. Esa es toda la gracia — si la ficha se
// calculara de nuevo acá en Node, el texto del comentario y lo que se ve en
// pantalla podrian decir cosas distintas del mismo dia y nadie sabria cual
// creer. Aca hay un navegador y una llamada, no una segunda implementacion.
//
// Tampoco escribe el comentario. Eso lo hace quien lea esta salida: ver la
// skill `comentario` en .claude/skills/. La separacion es deliberada — los
// numeros salen de una funcion determinista y la prosa de otro lado, asi que
// un error de redaccion nunca puede ensuciar una cifra.
//
// No necesita login: el SELECT de bond_price_snapshots es publico.

const fs = require('fs');
const path = require('path');

// require() resuelve desde la carpeta del script, no desde donde lo corrés, así
// que tener playwright instalado en otro lado no alcanza. Se prueban los
// lugares razonables y, si no está en ninguno, se dice qué hacer en vez de
// escupir un stack de módulos.
function cargarPlaywright() {
  const candidatos = [
    'playwright',
    process.env.PW_DIR && path.join(process.env.PW_DIR, 'node_modules', 'playwright'),
    path.join(process.cwd(), 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const c of candidatos) {
    try { return require(c); } catch (e) { /* el siguiente */ }
  }
  console.error(`
✗ No encuentro playwright.

  Una vez, en la raíz del repo:
      npm install playwright && npx playwright install chromium

  O, si ya lo tenés instalado en otra carpeta:
      PW_DIR=/ruta/a/esa/carpeta node .github/scripts/ficha.js
`);
  process.exit(2);
}
const { chromium } = cargarPlaywright();

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const APP = flag('local') ? 'http://localhost:8000/index.html'
                         : (process.env.APP_URL || 'https://santosechezarreta5.github.io/bonos-ar/');
const SALIDA = opt('salida', null);
const UNO = opt('periodo', null);
// Por defecto la rueda cerrada, no los precios en vivo: esto termina commiteado
// y tiene que ser reproducible. --envivo es para mirar durante la rueda.
const SOLO_ARCHIVADO = !flag('envivo');

const fatal = m => { console.error(`\n✗ ${m}\n`); process.exit(1); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', e => console.error('  [pageerror]', e.message));

  console.error(`Midiendo la curva — ${APP}${SOLO_ARCHIVADO ? '' : '  (en vivo)'}`);

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof fichaConstruir === 'function', null, { timeout: 90000 })
    .catch(() => fatal('la app no expone fichaConstruir: ¿está publicada esta versión?'));
  // Los índices tardan: sin CER no hay curva CER, y sin precios no hay rueda en
  // vivo. Se espera lo que se pueda y se sigue: la ficha reporta lo que tiene.
  await page.waitForFunction(() => CER_INDEX.length > 0, null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(8000);

  const periodos = UNO ? [UNO] : ['dia', 'semana', 'mes', 'trimestre', 'anio'];
  const out = { generado: new Date().toISOString(), app: APP, enVivo: !SOLO_ARCHIVADO,
                ruedaFin: null, preambulo: null, periodos: {} };

  out.preambulo = await page.evaluate(() => typeof FICHA_PREAMBULO === 'string' ? FICHA_PREAMBULO : null);

  for (const p of periodos) {
    const r = await page.evaluate(async ([p, solo]) => {
      try {
        const f = await fichaConstruir(p, { soloArchivado: solo });
        if (!f) return null;
        // El objeto entero mas su texto. El texto es lo que se le da a quien
        // redacta; el objeto queda para que el panel muestre los numeros del
        // dia en que se escribio y no los que el navegador recalcule despues.
        return { ficha: f, texto: fichaTexto(f) };
      } catch (e) { return { error: e.message }; }
    }, [p, SOLO_ARCHIVADO]);

    if (!r) { console.error(`  -- ${p}: sin historia suficiente`); continue; }
    if (r.error) { console.error(`  ✗ ${p}: ${r.error}`); continue; }
    out.periodos[p] = r;
    if (!out.ruedaFin) out.ruedaFin = r.ficha.fin;
    const b = r.ficha.bloques.length;
    console.error(`  ✓ ${p.padEnd(10)} ${r.ficha.ini} → ${r.ficha.fin}  ${String(b).padStart(2)} sectores  ${r.texto.length} chars`);
  }

  await browser.close();

  if (!Object.keys(out.periodos).length) fatal('no salió ninguna ficha');

  const json = JSON.stringify(out, null, 2);
  if (SALIDA) {
    const dest = path.resolve(SALIDA);
    fs.writeFileSync(dest, json, 'utf8');
    console.error(`\n→ ${dest}  (${(json.length / 1024).toFixed(1)} KB)\n`);
  } else {
    // A stdout, para poder encadenarlo. Los avisos van a stderr a propósito.
    process.stdout.write(json);
  }
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
