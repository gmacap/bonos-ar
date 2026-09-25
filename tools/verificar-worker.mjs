// Verifica que el Worker desplegado tenga aplicados los fixes de seguridad.
//   node tools/verificar-worker.mjs
// Con token (opcional, para probar /test-snapshot):
//   SNAPSHOT_TOKEN=xxxx node tools/verificar-worker.mjs

const W = process.env.WORKER_URL || 'https://royal-resonance-d470.santosechezarreta5.workers.dev';
const APP = 'https://gmacap.github.io';
const TOKEN = process.env.SNAPSHOT_TOKEN || '';

let ok = 0, bad = 0;
const check = (cond, label, detail = '') => {
  if (cond) { ok++;  console.log(`  \x1b[32mOK\x1b[0m    ${label}`); }
  else      { bad++; console.log(`  \x1b[31mFALLA\x1b[0m ${label}${detail ? '  → ' + detail : ''}`); }
};

const get = async (path, init = {}) => {
  try {
    const r = await fetch(W + path, { ...init, headers: { Origin: APP, ...(init.headers || {}) } });
    return { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: await r.text() };
  } catch (e) { return { status: 0, error: e.message, body: '' }; }
};

console.log(`\nVerificando ${W}\n`);

// El proxy /iol se eliminó del Worker: aceptaba una URL arbitraria por
// querystring y se había endurecido a mano. Estas dos pruebas verificaban ese
// endurecimiento, y quedaron pidiendo un 403 que ya no puede llegar porque la
// ruta no existe. Que no exista es más fuerte que que rechace bien, así que lo
// que se verifica ahora es eso: que no haya vuelto.
console.log('SEC-1 · el proxy /iol no existe más');
const evil = await get('/iol?url=' + encodeURIComponent('https://example.com/'));
check(evil.status >= 400 && !/example\.com/i.test(evil.body),
  'no proxea un host arbitrario', `devolvió ${evil.status}`);
const plain = await get('/iol?url=' + encodeURIComponent('http://169.254.169.254/'));
check(plain.status >= 400 && !/ami-id|instance-id/i.test(plain.body),
  'no alcanza la metadata interna por http://', `devolvió ${plain.status}`);

console.log('\nSEC-3 · /test-snapshot');
const noTok = await get('/test-snapshot', { method: 'POST' });
check(noTok.status === 401 || noTok.status === 503,
  noTok.status === 503 ? 'sin token (falta SNAPSHOT_TOKEN en Cloudflare)' : 'sin token rechazado',
  `devolvió ${noTok.status}`);
const badTok = await get('/test-snapshot', { method: 'POST', headers: { 'X-Snapshot-Token': 'incorrecto' } });
check(badTok.status === 401 || badTok.status === 503, 'token incorrecto rechazado', `devolvió ${badTok.status}`);
if (TOKEN) {
  const good = await get('/test-snapshot', { method: 'POST', headers: { 'X-Snapshot-Token': TOKEN } });
  check(good.status !== 401 && good.status !== 503, 'token correcto autoriza', `devolvió ${good.status}`);
} else {
  console.log('  \x1b[90m—     token correcto: no probado (pasá SNAPSHOT_TOKEN=... para incluirlo)\x1b[0m');
}

console.log('\nSEC-5 · parámetros BCRA');
check((await get('/cer?id=30%2F..%2Fadmin')).status === 400, 'path traversal en id rechazado');
check((await get('/cer?id=30&desde=ayer')).status === 400, 'fecha malformada rechazada');
check((await get('/cer?id=30&limit=abc')).status === 400, 'limit no numérico rechazado');

console.log('\nSEC-6 · CORS');
const mine = await get('/cer?id=30&limit=1');
check(mine.cors === APP, 'origen de la app permitido', `devolvió ${mine.cors}`);
const other = await fetch(W + '/cer?id=30&limit=1', { headers: { Origin: 'https://sitio-ajeno.com' } });
check(!other.headers.get('access-control-allow-origin'), 'origen ajeno sin header CORS');

console.log('\nFuncionamiento normal');
check(mine.status === 200 && mine.body.includes('results'), 'el proxy BCRA sigue respondiendo datos');

console.log(`\n${ok} OK · ${bad} fallas\n`);
if (bad) console.log('Si todo falla, probablemente el Worker todavía no está desplegado.\n');
process.exit(bad ? 1 : 0);
