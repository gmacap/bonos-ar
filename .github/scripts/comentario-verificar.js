// Verifica un comentario antes de commitearlo.
//
//   node .github/scripts/comentario-verificar.js comentario.json ficha.json
//
// El texto lo escribe un modelo de lenguaje y termina en manos de un cliente.
// Que suene bien no dice nada: lo que hay que atajar es una cifra inventada, una
// causa atribuida a una noticia, y un comentario que se saltea una parte. Las
// tres cosas se pueden chequear sin leer, y esto las chequea.
//
//   1. La forma: los cinco períodos, con pesos y dólares por separado y un
//      párrafo por cada curva de pesos que la ficha trae.
//   2. Dólares: que se relacionen con los Treasuries y con el riesgo país, y que
//      si alguno de los dos está desfasado se diga.
//   3. Los números: todo lo que en pesos, dólares, titular o Twitter lleve %, bps
//      o un sufijo de monto tiene que estar en la ficha de ESE período.
//   4. La causalidad: ningún conector causal fuera del contexto.
//   5. Twitter: el hilo del día, de 3 a 5 tweets numerados, de hasta 280
//      caracteres contados como los cuenta Twitter, con gráficos que existan.
//
// No prueba que el comentario sea correcto — el modelo puede acertar el número y
// errarle a la palabra. Prueba que no haya inventado una cifra, que es el error
// que un cliente no puede detectar.

const fs = require('fs');

const [, , comPath, fichaPath] = process.argv;
if (!comPath || !fichaPath) {
  console.error('uso: node comentario-verificar.js <comentario.json> <ficha.json>');
  process.exit(2);
}

const leer = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
                    catch (e) { console.error(`✗ no se pudo leer ${p}: ${e.message}`); process.exit(2); } };

const com = leer(comPath), fichas = leer(fichaPath);
let errores = 0, avisos = 0;
const mal = m => { errores++; console.log(`  ✗ ${m}`); };
const ojo = m => { avisos++; console.log(`  ! ${m}`); };
const bien = m => console.log(`  ✓ ${m}`);

const SECT_ARS = ['TF', 'CER', 'TAMAR', 'DLK'];
const NOMBRE = { TF: 'tasa fija', CER: 'CER', TAMAR: 'TAMAR', DLK: 'dollar linked' };
const txt = v => typeof v === 'string' && v.trim() ? v : null;
const tweetsDe = x => (Array.isArray(x && x.twitter) ? x.twitter : [])
  .map(t => typeof t === 'string' ? { texto: t, graficos: [] } : (t || {}));

// ── 1. Forma ────────────────────────────────────────────────────────────────
console.log('\nForma');
if (!com || typeof com !== 'object') { mal('el comentario no es un objeto'); process.exit(1); }
for (const k of ['generado', 'ruedaFin', 'periodos'])
  if (!com[k]) mal(`falta el campo ${k}`);
if (!Array.isArray(com.fuentes)) ojo('no hay lista de fuentes');

const esperados = Object.keys(fichas.periodos || {});
const erroresAntes = errores;
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  if (!x) { mal(`falta el período ${p}`); continue; }
  const f = fichas.periodos[p].ficha;
  if (x.movimiento != null && !x.pesos)
    mal(`${p}: tiene la forma vieja, un solo "movimiento"; pesos y dólares van por separado`);
  if (!txt(x.titular)) mal(`${p}: titular vacío`);
  if (!txt(x.contexto)) mal(`${p}: contexto vacío`);
  if (!x.pesos || !txt(x.pesos.resumen)) mal(`${p}: falta el resumen de pesos`);
  // Un párrafo por cada curva que la ficha trae. Si la ficha no la trae —el año
  // no tiene tasa fija común entre las dos puntas— el párrafo puede faltar.
  const presentes = new Set((f.bloques || []).map(b => b.sector));
  for (const s of SECT_ARS)
    if (presentes.has(s) && !(x.pesos && txt(x.pesos[s])))
      mal(`${p}: falta el párrafo de ${NOMBRE[s]}`);
  if (!x.dolares || !txt(x.dolares.resumen)) mal(`${p}: falta la parte de dólares`);
  if (x.ini !== f.ini || x.fin !== f.fin)
    mal(`${p}: las fechas no coinciden con la ficha (${x.ini}→${x.fin} vs ${f.ini}→${f.fin})`);
}
if (com.ruedaFin !== fichas.ruedaFin)
  mal(`ruedaFin ${com.ruedaFin} no coincide con la ficha (${fichas.ruedaFin})`);
if (errores === erroresAntes) bien('los cinco períodos, con pesos por curva, dólares, contexto y fechas de la ficha');

// ── 2. Dólares contra Treasuries y riesgo país ──────────────────────────────
// Es lo que pidió quien lee esto: la curva en dólares no se comenta sola. Y si
// el dato de afuera todavía no se publicó, el texto tiene que decirlo — una
// descomposición contra el Treasury de ayer no es la del día.
console.log('\nDólares');
const erroresDol = errores;
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  const d = x && x.dolares && txt(x.dolares.resumen);
  if (!d) continue;
  const f = fichas.periodos[p].ficha, t = d.toLowerCase();
  if (f.ust) {
    // En tono coloquial nadie escribe siempre "Treasuries": también "los bonos
    // del Tesoro americano" o "las tasas de EE.UU.".
    if (!/treasur|tesoro (de )?(los )?(estados unidos|ee\.?\s?uu\.?|americano|estadounidense)|tasas? (largas? )?(de|en) (estados unidos|ee\.?\s?uu)|\bust\b/.test(t))
      mal(`${p}: la parte de dólares no menciona los Treasuries`);
    if (f.ust.desfasado && !/desfas|todavía no (se )?public|todavia no (se )?public|pendiente|sin cierre/.test(t))
      mal(`${p}: los Treasuries están desfasados (al ${f.ust.fechaFin}) y el texto no lo dice`);
  } else ojo(`${p}: la ficha no trae Treasuries; no se puede exigir la relación`);
  if (f.riesgoPais) {
    if (!/riesgo pa[ií]s|embi/.test(t))
      mal(`${p}: la parte de dólares no menciona el riesgo país`);
    if (f.riesgoPais.desfasado && !/desfas|todavía no (se )?public|todavia no (se )?public|pendiente|sin dato/.test(t))
      mal(`${p}: el riesgo país está desfasado (al ${f.riesgoPais.fechaFin}) y el texto no lo dice`);
  } else ojo(`${p}: la ficha no trae riesgo país; no se puede exigir la relación`);
}
if (errores === erroresDol) bien('dólares relacionados con Treasuries y riesgo país, con los desfases dichos');

// ── 3. Números ──────────────────────────────────────────────────────────────
// Dos cosas complican esto y las dos son de idioma.
//
// La unidad se escribe de varias formas. La ficha imprime "bps" y "MM", pero
// nadie redacta así para un cliente: escribe "puntos básicos" y "mil millones".
// Buscar sólo la abreviatura dejaba sin verificar justo la forma que se usa al
// redactar, o sea casi todo el texto.
//
// El separador decimal tampoco es uno. La ficha imprime 25.30 y en castellano se
// escribe 25,30; y "1.226" son mil doscientos veintiséis, no uno coma dos. Por
// eso no se compara el texto: se generan las lecturas plausibles de cada número
// y alcanza con que una esté en la ficha. Es deliberadamente indulgente —lo que
// importa es que no pase una cifra inventada, no cazar un redondeo.
// "puntos" solo va al final de la lista para que "puntos básicos" gane primero.
// Es lo que escribe cualquiera en tono coloquial ("bajó 20 puntos"): dejarlo
// afuera haría que el texto más natural fuera justo el que no se verifica.
const UNIDAD = String.raw`%|bps|pbs|pb|pp|MM|B|M|k|puntos?\s+b[áa]sicos?|puntos?\s+porcentuales?|mil(?:es)?\s+de\s+millones|mil\s+millones|millones|billones|puntos?`;
const NUM_CON_UNIDAD = new RegExp(String.raw`(-?\d[\d.,]*)\s*(?:${UNIDAD})\b`, 'gi');
const NUM_SUELTO = /-?\d[\d.,]*/g;

function lecturas(s0) {
  const s = String(s0).replace(/[^\d.,-]/g, '');
  const out = new Set();
  const agregar = v => {
    if (!isFinite(v)) return;
    out.add(v.toFixed(2));
    out.add(Math.abs(v).toFixed(2));
    // Un decimal también: "25,3%" por 25,30% o "1,8% mensual" por 1,78% es como
    // se escribe para alguien que lee, y sigue siendo el número de la ficha.
    out.add(v.toFixed(1));
    out.add(Math.abs(v).toFixed(1));
    // El redondeo a entero es una lectura legítima, pero sólo de diez para
    // arriba. Abajo vuelve vacía la comparación: 1,226 redondea a 1, y un 1 está
    // en cualquier ficha, así que un número inventado pasaría por ahí.
    if (Math.abs(v) >= 10) {
      out.add(String(Math.round(v)));
      out.add(String(Math.round(Math.abs(v))));
    }
  };
  agregar(parseFloat(s.replace(/\./g, '').replace(',', '.')));   // castellano
  agregar(parseFloat(s.replace(/,/g, '')));                        // formato de la ficha
  agregar(parseFloat(s.replace(',', '.')));                        // punto decimal literal
  return out;
}
function valores(t) {
  const s = new Set();
  for (const m of String(t).matchAll(NUM_SUELTO)) for (const v of lecturas(m[0])) s.add(v);
  return s;
}

// Los campos que se verifican contra la ficha, con un nombre legible. El
// contexto no entra: sus números vienen de la búsqueda web, no de la ficha.
function camposVerificables(x) {
  const out = [];
  if (!x) return out;
  if (x.pesos) {
    if (txt(x.pesos.resumen)) out.push(['pesos', x.pesos.resumen]);
    for (const s of SECT_ARS) if (txt(x.pesos[s])) out.push([NOMBRE[s], x.pesos[s]]);
  }
  if (x.dolares && txt(x.dolares.resumen)) out.push(['dólares', x.dolares.resumen]);
  tweetsDe(x).forEach((t, i) => { if (txt(t.texto)) out.push([`tweet ${i + 1}`, t.texto]); });
  return out;
}

console.log('\nNúmeros');
let huerfanos = 0;
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  if (!x) continue;
  // El titular va sin números: es lo primero que se lee y lo que se replica
  // suelto, sin el párrafo que diría de qué período y en qué unidad.
  if (txt(x.titular) && /\d/.test(x.titular)) mal(`${p}: el titular tiene números`);
  const enFicha = valores(fichas.periodos[p].texto);
  let revisados = 0;
  const sueltos = [];
  for (const [nombre, t] of camposVerificables(x)) {
    let delCampo = 0;
    for (const m of String(t).matchAll(NUM_CON_UNIDAD)) {
      revisados++; delCampo++;
      if (![...lecturas(m[1])].some(c => enFicha.has(c))) sueltos.push(`${nombre}: ${m[0].trim()}`);
    }
    // Un párrafo largo sin una sola cifra chequeable suele querer decir que la
    // unidad se escribió de una forma que el patrón no reconoce. Es peor que un
    // error: es una verificación que no verifica.
    if (delCampo === 0 && t.length > 300)
      ojo(`${p}/${nombre}: no se pudo chequear ningún número — ¿la unidad está escrita de otra forma?`);
  }
  if (sueltos.length) {
    huerfanos += sueltos.length;
    mal(`${p}: ${sueltos.length} de ${revisados} número(s) no están en la ficha → ${sueltos.slice(0, 6).join(' | ')}`);
  } else bien(`${p}: ${revisados} cifras, todas en la ficha`);
}
if (!huerfanos) bien('ningún número inventado');

// ── 4. Causalidad ───────────────────────────────────────────────────────────
// La lista es corta a propósito: son las formas que aparecen solas cuando
// alguien redacta rápido, no un filtro de lenguaje. La descomposición contra los
// Treasuries se escribe como resta —"3 corresponden a los Treasuries"— y no
// dispara nada de acá.
const CAUSALES = [
  'porque', 'debido a', 'impulsad', 'a raíz de', 'a raiz de', 'producto de',
  'tras conocerse', 'en respuesta a', 'como consecuencia', 'gracias a',
  'motivad', 'explicad por', 'ante la noticia', 'luego del anuncio',
];
console.log('\nCausalidad');
let causales = 0;
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  for (const [nombre, t] of camposVerificables(x)) {
    const hay = CAUSALES.filter(c => t.toLowerCase().includes(c));
    if (hay.length) { causales += hay.length; mal(`${p}/${nombre}: conector causal → ${hay.join(', ')}`); }
  }
}
if (!causales) bien('pesos, dólares y Twitter describen y no explican');

// ── 5. Twitter ──────────────────────────────────────────────────────────────
// Cómo cuenta Twitter: la mayoría de los caracteres latinos pesa uno, casi todo
// lo demás —flechas, emojis— pesa dos, y un link pesa 23 sin importar su largo.
// Es la regla de twitter-text. La misma función está en index.html: si cambia
// una, cambia la otra.
function twLargo(t) {
  let n = 0;
  const sinUrl = String(t || '').normalize('NFC').replace(/https?:\/\/\S+/g, () => { n += 23; return ''; });
  for (const ch of sinUrl) {
    const c = ch.codePointAt(0);
    n += (c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247)) ? 1 : 2;
  }
  return n;
}

console.log('\nTwitter');
const erroresTw = errores;
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  if (!x) continue;
  const tw = tweetsDe(x);
  // El hilo es obligatorio para el día, que es lo que se publica todos los días.
  // Para los otros períodos es opcional, pero si está se verifica igual.
  if (!tw.length) { if (p === 'dia') mal('dia: falta el hilo de Twitter'); continue; }
  if (tw.length < 3 || tw.length > 5) mal(`${p}: el hilo tiene ${tw.length} tweets, tienen que ser entre 3 y 5`);
  const conGrafico = new Set((fichas.periodos[p].ficha.bloques || []).filter(b => b.grafico).map(b => b.sector));
  tw.forEach((t, i) => {
    const n = twLargo(t.texto);
    if (!txt(t.texto)) { mal(`${p}: el tweet ${i + 1} está vacío`); return; }
    if (n > 280) mal(`${p}: el tweet ${i + 1} tiene ${n} caracteres`);
    if (!new RegExp(`(^|\\s)${i + 1}/${tw.length}(\\s|$)`).test(t.texto))
      mal(`${p}: el tweet ${i + 1} no lleva la numeración ${i + 1}/${tw.length}`);
    const g = Array.isArray(t.graficos) ? t.graficos : [];
    if (g.length > 4) mal(`${p}: el tweet ${i + 1} adjunta ${g.length} imágenes, Twitter acepta 4`);
    const inexistentes = g.filter(s => !conGrafico.has(s));
    if (inexistentes.length)
      mal(`${p}: el tweet ${i + 1} adjunta gráficos que la ficha no genera → ${inexistentes.join(', ')}`);
  });
}
if (errores === erroresTw) bien('hilo del día de 3 a 5 tweets, numerados, de hasta 280, con gráficos que existen');

// ── 6. Higiene ──────────────────────────────────────────────────────────────
console.log('\nHigiene');
if (/undefined|NaN|\[object Object\]/.test(JSON.stringify(com))) mal('hay undefined, NaN o [object Object] en el texto');
else bien('sin undefined ni NaN');

console.log(`\n${errores} error(es) · ${avisos} aviso(s)\n`);
process.exit(errores ? 1 : 0);
