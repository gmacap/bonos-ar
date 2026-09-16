// Verifica un comentario antes de commitearlo.
//
//   node .github/scripts/comentario-verificar.js comentario.json ficha.json
//
// El texto lo escribe un modelo de lenguaje y termina en manos de un cliente.
// Que suene bien no dice nada: lo que hay que atajar es una cifra inventada y
// una causa atribuida a una noticia. Las dos cosas se pueden chequear sin
// leer, y esto las chequea.
//
//   1. La forma: los cinco períodos, con titular, movimiento y contexto.
//   2. Los números: todo lo que en `movimiento` lleve %, bps o un sufijo de
//      monto tiene que estar también en la ficha de ESE período. Se compara por
//      valor y no por texto, porque la ficha imprime 25.30 y en castellano se
//      escribe 25,30.
//   3. La causalidad: en `movimiento` no puede haber un conector causal. El
//      movimiento describe, el contexto enmarca, y ninguno de los dos explica
//      al otro.
//
// No prueba que el comentario sea correcto — el modelo puede acertar el número
// y errarle a la palabra. Prueba que no haya inventado una cifra, que es el
// error que un cliente no puede detectar.

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

// ── 1. Forma ────────────────────────────────────────────────────────────────
console.log('\nForma');
if (!com || typeof com !== 'object') { mal('el comentario no es un objeto'); process.exit(1); }
for (const k of ['generado', 'ruedaFin', 'periodos'])
  if (!com[k]) mal(`falta el campo ${k}`);
if (!Array.isArray(com.fuentes)) ojo('no hay lista de fuentes');

const esperados = Object.keys(fichas.periodos || {});
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  if (!x) { mal(`falta el período ${p}`); continue; }
  for (const c of ['titular', 'movimiento', 'contexto'])
    if (typeof x[c] !== 'string' || !x[c].trim()) mal(`${p}: ${c} vacío`);
  const f = fichas.periodos[p].ficha;
  if (x.ini !== f.ini || x.fin !== f.fin)
    mal(`${p}: las fechas no coinciden con la ficha (${x.ini}→${x.fin} vs ${f.ini}→${f.fin})`);
}
if (com.ruedaFin !== fichas.ruedaFin)
  mal(`ruedaFin ${com.ruedaFin} no coincide con la ficha (${fichas.ruedaFin})`);
if (!errores) bien('los cinco períodos, con sus tres campos y las fechas de la ficha');

// ── 2. Números ──────────────────────────────────────────────────────────────
// Dos cosas complican esto y las dos son de idioma.
//
// La unidad se escribe de varias formas. La ficha imprime "bps" y "MM", pero
// nadie redacta así para un cliente: escribe "puntos básicos" y "mil millones".
// Buscar sólo la abreviatura dejaba sin verificar justo la forma que se usa al
// redactar, o sea casi todo el texto.
//
// El separador decimal tampoco es uno. La ficha imprime 25.30 y en castellano
// se escribe 25,30; y "1.226" son mil doscientos veintiséis, no uno coma dos.
// Por eso no se compara el texto: se generan las lecturas plausibles de cada
// número y alcanza con que una esté en la ficha. Es deliberadamente indulgente
// —lo que importa es que no pase una cifra inventada, no cazar un redondeo.
const UNIDAD = String.raw`%|bps|pbs|pb|pp|MM|B|M|k|puntos?\s+b[áa]sicos?|puntos?\s+porcentuales?|mil(?:es)?\s+de\s+millones|mil\s+millones|millones|billones`;
const NUM_CON_UNIDAD = new RegExp(String.raw`(-?\d[\d.,]*)\s*(?:${UNIDAD})\b`, 'gi');
const NUM_SUELTO = /-?\d[\d.,]*/g;

// Todas las lecturas razonables de un número escrito. "1.226" puede ser mil
// doscientos veintiséis o uno coma dos dos seis según quién lo escriba, así que
// se devuelven las dos y gana la que coincida.
function lecturas(txt) {
  const s = String(txt).replace(/[^\d.,-]/g, '');
  const out = new Set();
  const agregar = v => {
    if (!isFinite(v)) return;
    out.add(v.toFixed(2));
    out.add(Math.abs(v).toFixed(2));
    // El redondeo a entero es una lectura legítima, pero sólo de diez para
    // arriba. Abajo vuelve vacía la comparación: 1,226 redondea a 1, y un 1
    // está en cualquier ficha, así que un número inventado pasaría por ahí.
    if (Math.abs(v) >= 10) {
      out.add(String(Math.round(v)));
      out.add(String(Math.round(Math.abs(v))));
    }
  };
  // castellano: punto de miles, coma decimal
  agregar(parseFloat(s.replace(/\./g, '').replace(',', '.')));
  // inglés y el formato de la ficha: coma de miles, punto decimal
  agregar(parseFloat(s.replace(/,/g, '')));
  // y la lectura literal, por si el punto era decimal
  agregar(parseFloat(s.replace(',', '.')));
  return out;
}

function valores(txt) {
  const s = new Set();
  for (const m of String(txt).matchAll(NUM_SUELTO))
    for (const v of lecturas(m[0])) s.add(v);
  return s;
}

console.log('\nNúmeros');
let huerfanos = 0;
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  if (!x || typeof x.movimiento !== 'string') continue;
  const enFicha = valores(fichas.periodos[p].texto);
  const sueltos = [];
  let revisados = 0;
  for (const m of String(x.movimiento).matchAll(NUM_CON_UNIDAD)) {
    revisados++;
    const cands = [...lecturas(m[1])];
    if (!cands.length || !cands.some(c => enFicha.has(c))) sueltos.push(m[0].trim());
  }
  if (sueltos.length) { huerfanos += sueltos.length; mal(`${p}: ${sueltos.length} de ${revisados} número(s) no están en la ficha → ${sueltos.slice(0, 6).join(', ')}`); }
  // Un movimiento largo sin una sola cifra chequeable suele querer decir que la
  // unidad se escribió de una forma que el patrón no reconoce, no que el texto
  // no tenga números. Es peor que un error: es una verificación que no verifica.
  else if (revisados === 0 && String(x.movimiento).length > 300)
    ojo(`${p}: no se pudo chequear ningún número — ¿la unidad está escrita de otra forma?`);
  else if (!sueltos.length) bien(`${p}: ${revisados} cifras, todas en la ficha`);
}
if (!huerfanos) bien('ningún número inventado en el movimiento');

// ── 3. Causalidad ───────────────────────────────────────────────────────────
// La lista es corta a propósito: son las formas que aparecen solas cuando
// alguien redacta rápido, no un filtro de lenguaje.
const CAUSALES = [
  'porque', 'debido a', 'impulsad', 'a raíz de', 'a raiz de', 'producto de',
  'tras conocerse', 'en respuesta a', 'como consecuencia', 'gracias a',
  'motivad', 'explicad por', 'ante la noticia', 'luego del anuncio',
];
console.log('\nCausalidad');
let causales = 0;
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  if (!x || typeof x.movimiento !== 'string') continue;
  const t = x.movimiento.toLowerCase();
  const hay = CAUSALES.filter(c => t.includes(c));
  if (hay.length) { causales += hay.length; mal(`${p}: conector causal en el movimiento → ${hay.join(', ')}`); }
}
if (!causales) bien('el movimiento describe y no explica');

// ── 4. Higiene ──────────────────────────────────────────────────────────────
console.log('\nHigiene');
const todo = JSON.stringify(com);
if (/undefined|NaN|\[object Object\]/.test(todo)) mal('hay undefined, NaN o [object Object] en el texto');
else bien('sin undefined ni NaN');
for (const p of esperados) {
  const x = com.periodos && com.periodos[p];
  if (x && typeof x.movimiento === 'string' && x.movimiento.length < 200)
    ojo(`${p}: el movimiento tiene ${x.movimiento.length} caracteres, parece corto`);
}

console.log(`\n${errores} error(es) · ${avisos} aviso(s)\n`);
process.exit(errores ? 1 : 0);
