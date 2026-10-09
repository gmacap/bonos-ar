// Smoke test de la app publicada.
//
//   node .github/scripts/smoke.js
//
// No reemplaza a una suite de tests, pero cubre la clase de error que este
// archivo produce con más frecuencia: identificadores usados antes de
// declararse, y funciones que dejan de existir o cambian de firma tras un
// refactor. Ambos son invisibles hasta que alguien abre la pestaña afectada.
//
// Ya atajó dos: usdFamDRenderFlows con nombres de parámetro equivocados
// (ReferenceError al abrir cualquier bono USD) y onclick generados que
// apuntaban siempre a bop. Los dos pasaban node --check sin problema.

const { chromium } = require('playwright');

const USD_LABEL = { bop: 'Bopreales', bon: 'Bonares', glo: 'Globales' };
const { appUrl } = require('./app-url');
const APP = appUrl();

let ok = 0, bad = 0;
const check = (cond, label, detalle = '') => {
  if (cond) { ok++;  console.log(`  \x1b[32mOK\x1b[0m    ${label}`); }
  else      { bad++; console.log(`  \x1b[31mFALLA\x1b[0m ${label}${detalle ? '  → ' + detalle : ''}`); }
};
// Para lo que depende de que el mercado haya operado. Sin precios en vivo la
// aserción no prueba nada, y hacerla fallar convertiría el domingo en un rojo
// que nadie mira.
const omitir = (label, motivo) =>
  console.log(`  \x1b[33m--\x1b[0m    ${label}: ${motivo}`);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  const errores = [];
  const req400 = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) req400.push(`${r.status()} ${r.url().slice(0, 120)}`); });

  console.log(`\nSmoke test — ${APP}\n`);

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof supa !== 'undefined', null, { timeout: 60000 });

  // Esperar la CONDICIÓN, no un tiempo fijo. Los precios USD dependen de que
  // supaLoadSharedData() traiga primero las equivalencias ticker → símbolo MEP,
  // y ese encadenamiento tarda distinto según de dónde se sirva la app. Con un
  // waitForTimeout el test quedaba atado a la suerte del timing.
  try {
    await page.waitForFunction(() => {
      const ars = typeof LECAPS !== 'undefined' && LECAPS.some(b => b.precio != null);
      const usd = [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().some(b => b.lastPrecio != null);
      return ars && usd;
    }, null, { timeout: 90000 });
  } catch (e) {
    // Si no llegan, seguimos igual: los checks de abajo reportan qué faltó.
    const d = await page.evaluate(async () => {
      const out = {
        equiv: typeof EQUIV_DATA !== 'undefined' ? EQUIV_DATA.length : -1,
        usdBonos: [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().length,
        moneda: typeof usdCurrency !== 'undefined' ? usdCurrency : '?',
        api: String(USD_PRICE_API),
        mercado: typeof mercadoActivo === 'function' ? mercadoActivo() : '?',
      };
      // Reproducir el camino real y ver dónde se corta
      try {
        const r = await usdFetchPriceMap();
        out.mapSize = Object.keys(r.map || {}).length;
        out.gd30d = r.map ? r.map['GD30D'] : undefined;
        const eq = (EQUIV_DATA || []).find(e => e.ticker === 'GD30');
        out.equivGD30 = eq ? JSON.stringify(eq) : 'no está';
      } catch (e) { out.errFetch = e.message; }
      try {
        await usdRefreshPrices();
        out.trasRefresh = [BOP_BONDS, BON_BONDS, GLO_BONDS].flat()
          .filter(b => b.lastPrecio != null).length;
      } catch (e) { out.errRefresh = e.message; }
      return out;
    });
    console.log('  \x1b[33m(timeout esperando precios)\x1b[0m');
    for (const [k, v] of Object.entries(d)) console.log(`     ${k}: ${v}`);
  }
  await page.waitForTimeout(3000);

  console.log('Fechas y días hábiles');
  const u = await page.evaluate(() => ({
    hoy: hoyAR(),
    fmt: fmtDate(parseDate('2026-03-01')),
    sab: esHabil(parseDate('2026-09-05')),
    lun: esHabil(parseDate('2026-09-07')),
    mercado: typeof mercadoActivo === 'function',
  }));
  check(/^\d{4}-\d{2}-\d{2}$/.test(u.hoy), 'hoyAR() con formato válido', u.hoy);
  check(u.fmt === '2026-03-01', 'fmtDate hace round-trip', u.fmt);
  check(u.sab === false, 'sábado no es hábil');
  check(u.lun === true, 'lunes sí es hábil');
  check(u.mercado, 'mercadoActivo() existe');

  console.log('\nCarga de precios');
  const px = await page.evaluate(() => ({
    ars: (typeof LECAPS !== 'undefined' ? LECAPS : []).filter(b => b.precio != null).length,
    arsTot: (typeof LECAPS !== 'undefined' ? LECAPS : []).length,
    usd: [BOP_BONDS, BON_BONDS, GLO_BONDS].flat().filter(b => b.lastPrecio != null).length,
    api: String(USD_PRICE_API),
  }));
  check(px.api.startsWith('https://'), 'USD_PRICE_API definido al arrancar', px.api);
  check(px.ars > 0, `LECAPS con precio: ${px.ars}/${px.arsTot}`);
  check(px.usd > 0, `bonos USD con precio: ${px.usd}`);

  // Libro: puntas y volumen. data912 mandaba seis campos por instrumento y la
  // app usaba uno. El monto es lo que decide si un spread se puede pagar.
  console.log('\nLibro: spread y volumen');
  const libro = await page.evaluate(async () => {
    await fetchAllPrices();
    await new Promise(r => setTimeout(r, 6000));
    const pesos = [LECAPS, CER_BONDS, TAMAR_BONDS, DLK_BONDS].flat();
    const usd = [BOP_BONDS, GLO_BONDS, BON_BONDS].flat();
    const conLibro = pesos.filter(b => b.bid > 0 && b.ask > 0);
    const conMonto = pesos.filter(b => b.monto > 0);
    // El spread es (ask − bid) sobre el medio, y el monto es nominales por
    // precio sobre 100: el campo crudo viene en láminas, no en plata.
    const x = conMonto[0] || null;
    return {
      pesos: pesos.length, conLibro: conLibro.length, conMonto: conMonto.length,
      usdConLibro: usd.filter(b => b.lastBid > 0 && b.lastAsk > 0).length,
      usdConMonto: usd.filter(b => b.lastMonto > 0).length,
      spreadOk: conLibro.every(b => {
        const s = libroSpread(b.bid, b.ask);
        return s == null || Math.abs(s - (b.ask - b.bid) / ((b.ask + b.bid) / 2) * 100) < 1e-9;
      }),
      montoOk: x ? Math.abs(x.monto - x.vol * x.precio / 100) < 1e-6 : null,
      montoDistintoDeVol: x ? x.monto !== x.vol : null,
      // Los cortes del semáforo, contra los que se pintan los colores.
      sem: [libroSemaforo(2e9), libroSemaforo(5e7), libroSemaforo(5e6), libroSemaforo(0)],
      // Un spread negativo o cruzado no es un spread.
      cruzado: libroSpread(101, 100),
      sinPuntas: libroSpread(0, 100),
      hora: new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false }),
    };
  });
  // Antes de la apertura data912 ya publica las puntas, pero el monto operado
  // está en cero, y en la primera media hora operan pocos bonos. Hasta las 11:30
  // un volumen flaco no prueba nada; después sí es una falla, así que el
  // margen no esconde un campo de volumen que dejó de llegar.
  const [hh, mm] = String(libro.hora || '').split(':').map(Number);
  const antesDeOperar = hh * 60 + mm < 11 * 60 + 30 && libro.conMonto <= 10;
  if (!libro.conLibro) {
    omitir('libro de puntas y volumen', 'data912 no devolvió precios ahora');
  } else {
    check(libro.conLibro > 10, 'las puntas llegan a los bonos en pesos',
          libro.conLibro + '/' + libro.pesos + ' con libro');
    if (antesDeOperar) {
      omitir('el volumen', `la rueda todavía no operó: ${libro.conMonto} bonos con monto a las ${libro.hora}`);
      check(libro.usdConLibro > 0, 'y las puntas a los bonos en dólares', libro.usdConLibro + ' con libro');
    } else {
      check(libro.conMonto > 10, 'el volumen también', libro.conMonto + ' con monto');
      check(libro.usdConLibro > 0 && libro.usdConMonto > 0,
            'y a los bonos en dólares, las tres familias',
            libro.usdConLibro + ' con libro, ' + libro.usdConMonto + ' con monto');
    }
    check(libro.spreadOk, 'el spread es punta a punta sobre el medio');
    // La cuenta del monto se puede chequear con un solo bono que haya operado.
    if (libro.montoOk == null && antesDeOperar) {
      omitir('el monto es nominales por precio', 'ningún bono operó todavía');
    } else {
      check(libro.montoOk === true, 'el monto es nominales por precio, no el campo crudo');
      check(libro.montoDistintoDeVol === true, 'el monto no es el volumen en láminas');
    }
    check(JSON.stringify(libro.sem) === JSON.stringify(['verde', 'amarillo', 'rojo', null]),
          'el semáforo corta en mil y en diez millones', JSON.stringify(libro.sem));
    check(libro.cruzado === null && libro.sinPuntas === null,
          'un libro cruzado o sin punta no devuelve spread');
  }

  // Las siete tablas tienen las dos columnas, y los encabezados cuadran con las
  // celdas: una columna de más en el thead desalinea toda la fila.
  const tablas = [];
  for (const [sec, tab, body] of [
    ['pesos', 'lecap', 'table-body'], ['pesos', 'cer', 'cer-table-body'],
    ['pesos', 'tamar', 'tamar-table-body'], ['pesos', 'dlk', 'dlk-table-body'],
    ['usd', 'usd-globales', 'glo-summary-tbody'], ['usd', 'usd-bonares', 'bon-summary-tbody'],
    ['usd', 'usd-bopreales', 'bop-summary-tbody'],
  ]) {
    await page.evaluate(([s, t]) => { switchSection(s); (s === 'usd' ? switchUsdTab : switchTab)(t); }, [sec, tab]);
    await page.waitForTimeout(1400);
    const r = await page.evaluate(id => {
      const tb = document.getElementById(id);
      const tr = tb && tb.querySelector('tr');
      const tabla = tb && tb.closest('table');
      return {
        tds: tr ? tr.querySelectorAll('td').length : 0,
        ths: tabla ? tabla.querySelectorAll('thead th').length : 0,
        cab: tabla ? tabla.querySelector('thead').textContent.toUpperCase() : '',
      };
    }, body);
    tablas.push({ tab, ...r });
  }
  const cuadran = tablas.filter(t => t.tds > 0 && t.tds === t.ths);
  const conCols = tablas.filter(t => /SPREAD/.test(t.cab) && /MONTO/.test(t.cab));
  check(conCols.length === 7, 'las siete tablas tienen spread y monto',
        conCols.map(t => t.tab).join(', '));
  check(cuadran.length === tablas.filter(t => t.tds > 0).length,
        'los encabezados cuadran con las celdas',
        tablas.map(t => t.tab + ' ' + t.tds + '/' + t.ths).join(' · '));

  // Datos de mercado: no viajan a Supabase, igual que los precios.
  const noViaja = await page.evaluate(() =>
    ['bid', 'ask', 'vol', 'ops', 'monto'].every(k => /precio:null/.test(supaSaveSharedKey.toString())
      && supaSaveSharedKey.toString().indexOf(k + ':null') >= 0));
  check(noViaja, 'el libro no se sincroniza: es dato de mercado, no definición');

  // Volumen en las series: barras bajo la línea de la tasa, con un solo bono
  // elegido. Las columnas pueden no existir todavía en la tabla, así que la
  // prueba simula el monto: lo que se verifica es el dibujo, no el dato.
  const vol = await page.evaluate(async () => {
    switchSection('pesos'); switchTab('series-ars');
    await new Promise(r => setTimeout(r, 6000));
    const st = seriesEstado.ars;
    const ts = [...st.cache.porBono.keys()];
    if (!ts.length) return { sinDatos: true };
    const m = new Map();
    st.cache.fechas.forEach((f, i) => m.set(f, 1e9 * (1 + (i % 5) / 4)));
    st.cache.montos = new Map([[ts[0], m]]);
    const barras = () => {
      const d = st.chart && st.chart.data.datasets.find(x => x.type === 'bar');
      return d ? d.data.filter(v => v != null).length : 0;
    };
    seriesVolumen = true;
    seriesTodos('ars', false); seriesToggle('ars', ts[0]);
    await new Promise(r => setTimeout(r, 700));
    const uno = barras();
    // El cartel de la barra es un monto, no una tasa: antes salía "5190017294.91%".
    const lbl = st.chart.options.plugins.tooltip.callbacks.label;
    const dsBar = st.chart.data.datasets.find(x => x.type === 'bar');
    const dsLinea = st.chart.data.datasets.find(x => x.type !== 'bar');
    const cartelBarra = dsBar ? lbl({ parsed: { y: 5190017294.91 }, raw: 5190017294.91, dataset: dsBar }) : '';
    const cartelLinea = dsLinea ? lbl({ parsed: { y: 21.84 }, raw: 21.84, dataset: dsLinea }) : '';
    const tope = st.chart.scales.yv ? st.chart.scales.yv.max : null;
    const mayor = Math.max(...[...m.values()]);
    const ejeTasa = st.chart.scales.y.max;
    if (ts[1]) seriesToggle('ars', ts[1]);
    await new Promise(r => setTimeout(r, 700));
    const dos = barras();
    seriesTodos('ars', false); seriesToggle('ars', ts[0]);
    await new Promise(r => setTimeout(r, 500));
    seriesToggleVolumen();
    await new Promise(r => setTimeout(r, 500));
    const apagado = barras();
    seriesToggleVolumen();
    await new Promise(r => setTimeout(r, 500));
    // Se deja como estaba: el monto simulado y el filtro no pueden quedar
    // puestos para las pruebas que vienen después.
    st.cache.montos = new Map();
    seriesTodos('ars', true);
    await new Promise(r => setTimeout(r, 500));
    return { uno, dos, apagado, tope, mayor, ejeTasa, ruedas: st.cache.fechas.length, cartelBarra, cartelLinea };
  });
  if (vol.sinDatos) {
    omitir('volumen en las series', 'no hay ruedas en el rango ahora');
  } else {
    check(vol.uno > 0, 'con un bono elegido aparecen las barras de monto', vol.uno + ' barras');
    check(vol.dos === 0, 'con dos bonos no: el monto de dos bonos no se compara en una escala');
    check(vol.apagado === 0, 'el botón de volumen las saca');
    check(vol.tope != null && Math.abs(vol.tope - vol.mayor * 4) < 1,
          'el eje del volumen se estira a cuatro veces la barra más alta',
          vol.tope + ' vs ' + vol.mayor);
    check(/\$5\.2 MM$/.test(vol.cartelBarra) && !vol.cartelBarra.includes('%') && /21\.84%$/.test(vol.cartelLinea),
          'el cartel de la barra muestra el monto abreviado y el de la línea la tasa',
          `${vol.cartelBarra} · ${vol.cartelLinea}`);
  }

  // Las páginas de pantalla completa descontaban un encabezado más chico que el
  // real y se pasaban del borde inferior. Con barras eso tapaba su base.
  const altos = [];
  for (const [sec, tab, id] of [
    ['pesos', 'series-ars', 'page-series-ars'], ['usd', 'usd-series', 'page-usd-series'],
    ['pesos', 'curvas-ars', 'page-curvas-ars'], ['usd', 'usd-curvas', 'page-usd-curvas'],
  ]) {
    await page.evaluate(([s, t]) => { switchSection(s); (s === 'usd' ? switchUsdTab : switchTab)(t); }, [sec, tab]);
    await page.waitForTimeout(1800);
    const d = await page.evaluate(i => {
      const e = document.getElementById(i).getBoundingClientRect();
      return Math.round(e.bottom - window.innerHeight);
    }, id);
    altos.push({ id, d });
  }
  check(altos.every(a => a.d <= 0), 'las páginas de pantalla completa entran en la ventana',
        altos.map(a => a.id.replace('page-', '') + ' ' + a.d).join(' · '));



  // El selector de moneda no puede tocar lo que se archiva. Viaja entre
  // dispositivos por SUPA_SHARED_KEYS y el bot del snapshot lo hereda: el
  // 03/09/2026 corrió en cable y guardó los 21 bonos en dólares ~4% abajo.
  console.log('\nBase MEP del histórico USD');
  const base = await page.evaluate(async () => {
    const todos = () => [BOP_BONDS, BON_BONDS, GLO_BONDS].flat();
    const foto = () => Object.fromEntries(todos()
      .filter(b => b.lastPrecioMEP != null).map(b => [b.ticker, b.lastPrecioMEP]));
    const prev = usdCurrency;
    usdCurrency = 'MEP'; await usdRefreshPrices();
    const mep = foto();
    const coincide = todos().filter(b => b.lastPrecioMEP != null && b.lastPrecio != null)
      .every(b => Math.abs(b.lastPrecioMEP - b.lastPrecio) < 0.011);
    usdCurrency = 'Cable'; await usdRefreshPrices();
    const cable = foto();
    const tickers = Object.keys(mep).filter(t => cable[t] != null);
    // Tolerancia de 1%: las dos fotos son dos pedidos distintos y durante la
    // rueda los precios se mueven entre uno y otro. El spread MEP/cable ronda el
    // 4%, así que sigue distinguiendo "misma base" de "se archivó el cable".
    const estable = tickers.filter(t => Math.abs(mep[t] / cable[t] - 1) < 0.01).length;
    const bajo = todos().filter(b => b.lastPrecio != null && b.lastPrecioMEP != null
      && b.lastPrecio < b.lastPrecioMEP * 0.999).length;
    const fila = curvasSnapshotFromMemory('GLO').find(r => cable[r.ticker] != null);
    const archivaMEP = fila ? Math.abs(fila.price - cable[fila.ticker]) < 0.011 : null;
    usdCurrency = prev; await usdRefreshPrices();
    return { n: tickers.length, estable, coincide, bajo, archivaMEP };
  });
  if (!base.n) {
    omitir('base MEP del histórico USD', 'data912 no devolvió precios ahora');
  } else {
    check(base.coincide, 'en MEP, el precio archivado es el de pantalla');
    check(base.estable === base.n,
          'cambiar a cable no mueve el precio que se archiva',
          `${base.estable}/${base.n} tickers estables`);
    check(base.bajo > 0, 'en cable el precio de pantalla sí baja',
          `${base.bajo} bonos por debajo de su MEP`);
    check(base.archivaMEP !== false,
          'curvasSnapshotFromMemory devuelve el precio MEP aun en cable');
  }

  // Un bono sin precio en vivo en la moneda elegida no se queda con el de otra:
  // en cable mostraba el MEP de la última vez. Va el último cierre de ESE ticker,
  // marcado, y si tampoco hay, sin precio. El cierre viejo no se archiva.
  console.log('\nDólares sin precio de hoy');
  const sinHoy = await page.evaluate(async () => {
    const realMapa = usdFetchPriceMap, realHist = seriesHist912, realByma = bymaCierresAnteriores, monedaPrev = usdCurrency;
    let base;
    try { base = await realMapa(); } catch (e) { return { sinDatos: true }; }
    const bond = [...GLO_BONDS, ...BON_BONDS].find(b => {
      const r = EQUIV_DATA.find(e => e.ticker === b.ticker);
      return r && r.cable && r.mep && r.ars && base.map[r.cable] > 0 && base.map[r.mep] > 0;
    });
    if (!bond) return { sinDatos: true };
    const row = EQUIV_DATA.find(e => e.ticker === bond.ticker);
    const ayer = fmtDate(restarHabiles(TODAY, 1));
    const sin = (...syms) => { const m = { ...base, map: { ...base.map } }; syms.forEach(x => delete m.map[x]); return m; };
    const histCon = (sym, mapa) => async x => x === sym ? mapa : realHist(x);
    const sec = GLO_BONDS.includes(bond) ? 'GLO' : 'BON';
    const enMemoria = () => curvasSnapshotFromMemory(sec).some(r => r.ticker === bond.ticker);
    const out = { ticker: bond.ticker, ayer };
    try {
      usdFetchPriceMap = async () => base;
      usdCurrency = 'MEP'; await usdRefreshPrices();
      out.mep = bond.lastPrecio;
      // En cable sin el ticker cable: su cierre anterior —no el de hoy, que
      // data912 no publica, pero si viniera tampoco vale—, no el MEP.
      usdFetchPriceMap = async () => sin(row.cable);
      seriesHist912 = histCon(row.cable, new Map([[ayer, 12.34], [hoyAR(), 99.99]]));
      usdCurrency = 'Cable'; await usdRefreshPrices();
      out.cable = { precio: bond.lastPrecio, fecha: bond.lastPrecioCierre && bond.lastPrecioCierre.fecha,
        var: bond.lastPctChange, monto: bond.lastMonto, spread: bond.lastBid };
      const html = usdSumRowHtml({ b: bond }, false, 'x', 'glo');
      out.marca = /cierre \d\d\/\d\d/.test(html) && /último operado/.test(html);
      // Si data912 no tiene historia de ese ticker —le pasa con los ilíquidos—,
      // el cierre anterior de BYMA, sin fecha.
      seriesHist912 = histCon(row.cable, new Map());
      bymaCierresAnteriores = async () => new Map([[row.cable, { h24: 45.67, ci: 45.11 }]]);
      await usdRefreshPrices();
      out.byma = { precio: bond.lastPrecio, ci: bond.lastPrecioCierre,
        marca: /cierre ant\./.test(usdSumRowHtml({ b: bond }, false, 'x', 'glo')) };
      // Sin cierre en ninguno de los dos: sin precio, nunca el MEP.
      bymaCierresAnteriores = async () => new Map();
      await usdRefreshPrices();
      out.nada = { precio: bond.lastPrecio, ci: bond.lastPrecioCierre,
        sinMarca: !/cierre (\d\d\/\d\d|ant\.)/.test(usdSumRowHtml({ b: bond }, false, 'x', 'glo')) };
      // En MEP sin MEP ni pesos: el cierre se muestra, pero no se archiva.
      usdFetchPriceMap = async () => sin(row.mep, row.ars);
      seriesHist912 = histCon(row.mep, new Map([[ayer, 23.45]]));
      usdCurrency = 'MEP'; await usdRefreshPrices();
      out.archivo = { precio: bond.lastPrecio,
        enMemoria: enMemoria() };
      // Con precio en vivo otra vez, la marca se va.
      usdFetchPriceMap = async () => base;
      seriesHist912 = realHist; bymaCierresAnteriores = realByma;
      usdCurrency = 'Cable'; await usdRefreshPrices();
      out.vuelta = { precio: bond.lastPrecio, ci: bond.lastPrecioCierre, cable: base.map[row.cable], enMemoria: enMemoria() };
    } finally {
      usdFetchPriceMap = realMapa; seriesHist912 = realHist; bymaCierresAnteriores = realByma; usdCurrency = monedaPrev;
      await usdRefreshPrices();
    }
    return out;
  });
  if (sinHoy.sinDatos) {
    omitir('dólares sin precio de hoy', 'data912 no devolvió precios ahora');
  } else {
    check(sinHoy.cable.precio === 12.34 && sinHoy.cable.fecha === sinHoy.ayer && sinHoy.cable.precio !== sinHoy.mep,
          'en cable, sin precio en vivo, el bono toma el último cierre del ticker cable y no el MEP',
          `${sinHoy.ticker}: ${JSON.stringify(sinHoy.cable)} · MEP ${sinHoy.mep}`);
    check(sinHoy.cable.var == null && sinHoy.cable.monto == null && sinHoy.cable.spread == null,
          'un precio del cierre anterior no trae variación, puntas ni monto del día');
    check(sinHoy.marca, 'la tabla lo marca con la fecha del cierre');
    check(sinHoy.byma.precio === 45.67 && sinHoy.byma.ci && sinHoy.byma.ci.fuente === 'byma' && sinHoy.byma.marca,
          'si data912 no tiene historia del ticker, usa el cierre anterior de BYMA, del mismo plazo', JSON.stringify(sinHoy.byma));
    check(sinHoy.nada.precio == null && sinHoy.nada.ci && sinHoy.nada.ci.sinPrecio && sinHoy.nada.sinMarca,
          'sin cierre en ninguno queda sin precio, nunca con el de otra moneda', JSON.stringify(sinHoy.nada));
    check(sinHoy.archivo.precio === 23.45 && !sinHoy.archivo.enMemoria && sinHoy.vuelta.enMemoria,
          'el cierre anterior se muestra pero no se archiva como precio de hoy', JSON.stringify(sinHoy.archivo));
    check(sinHoy.vuelta.precio === +sinHoy.vuelta.cable.toFixed(4) && !sinHoy.vuelta.ci,
          'con precio en vivo otra vez, la marca se va', JSON.stringify(sinHoy.vuelta));
  }

  // Lo mismo en pesos: una LECAP, un CER, un TAMAR y un DLK sin precio en vivo
  // toman el cierre anterior, marcado, en vez de quedarse con el de la última vez.
  console.log('\nPesos sin precio de hoy');
  const pesosHoy = await page.evaluate(async () => {
    const realFetch = fetchData912, realHist = seriesHist912, realByma = bymaCierresAnteriores;
    const liq = G_LIQ || addHabiles(TODAY, 1);
    const vivo = b => b && b.precio > 0 && b.vcto && diasACT(liq, parseDate(b.vcto)) > 5 && !b.manualOverride;
    const tk = (lista, fuera) => (lista.find(b => vivo(b) && !fuera.some(l => l.some(x => x.ticker === b.ticker))) || {}).ticker;
    const elegidos = {
      TF: tk(LECAPS, []), CER: tk(CER_BONDS, [TAMAR_BONDS]),
      TAMAR: tk(TAMAR_BONDS, [CER_BONDS, DLK_BONDS]), DLK: tk(DLK_BONDS, [TAMAR_BONDS]),
    };
    const quitar = new Set(Object.values(elegidos).filter(Boolean));
    if (quitar.size < 4) return { sinDatos: true, elegidos };
    const cierres = new Map([...quitar].map((t, i) => [t, { h24: 100 + i, ci: 90 + i }]));
    const de = t => [LECAPS, CER_BONDS, TAMAR_BONDS, DLK_BONDS].flat().find(b => b.ticker === t);
    const out = { elegidos };
    try {
      fetchData912 = async ep => (await realFetch(ep)).filter(x => !quitar.has(x.symbol));
      seriesHist912 = async () => new Map();
      bymaCierresAnteriores = async () => cierres;
      await fetchAllPrices(true);
      out.al = Object.fromEntries(Object.entries(elegidos).map(([sec, t]) => {
        const b = de(t);
        return [sec, { t, precio: b.precio, esperado: cierres.get(t).h24, fuente: b.precioCierre && b.precioCierre.fuente, vol: b.vol, monto: b.monto }];
      }));
      const html = id => (document.getElementById(id) || {}).innerHTML || '';
      out.marcas = {
        TF: html('table-body').includes('cierre ant.'), CER: html('cer-table-body').includes('cierre ant.'),
        TAMAR: html('tamar-table-body').includes('cierre ant.'), DLK: html('dlk-table-body').includes('cierre ant.'),
      };
      out.estado = (document.getElementById('api-status') || {}).textContent || '';
      out.enMemoria = curvasSnapshotFromMemory('TF').some(r => r.ticker === elegidos.TF);
      // Sin cierre en ninguna fuente: sin precio, no el de antes.
      bymaCierresAnteriores = async () => new Map();
      await fetchAllPrices(true);
      out.sin = Object.values(elegidos).map(t => { const b = de(t); return { t, precio: b.precio, sinPrecio: !!(b.precioCierre && b.precioCierre.sinPrecio) }; });
      out.estadoSin = (document.getElementById('api-status') || {}).textContent || '';
      // Un precio escrito a mano no se toca. Escribirlo borra la marca, así que
      // llega sin ella.
      const manual = pesosSinPrecioHoy({ ...de(elegidos.TF), manualOverride: true, precio: 99, precioCierre: null }, liq);
      out.manualIntacto = manual.precio === 99 && !manual.precioCierre;
    } finally {
      fetchData912 = realFetch; seriesHist912 = realHist; bymaCierresAnteriores = realByma;
      await fetchAllPrices(true);
    }
    out.vuelta = Object.values(elegidos).map(t => { const b = de(t); return { t, precio: b.precio, ci: b.precioCierre || null }; });
    return out;
  });
  if (pesosHoy.sinDatos) {
    omitir('pesos sin precio de hoy', 'faltan bonos con precio en alguna curva: ' + JSON.stringify(pesosHoy.elegidos));
  } else {
    const al = Object.values(pesosHoy.al);
    check(al.every(x => x.precio === x.esperado && x.fuente === 'byma'),
          'en las cuatro curvas, sin precio en vivo, el bono toma el cierre anterior de BYMA', JSON.stringify(pesosHoy.al));
    check(al.every(x => x.vol == null && x.monto == null), 'un precio del cierre anterior no trae volumen ni monto del día');
    check(Object.values(pesosHoy.marcas).every(Boolean), 'las cuatro tablas lo marcan', JSON.stringify(pesosHoy.marcas));
    check(/al cierre anterior:/.test(pesosHoy.estado), 'el estado de ↻ Precios dice cuáles quedaron al cierre', pesosHoy.estado);
    check(!pesosHoy.enMemoria, 'el cierre anterior no entra a la curva de hoy');
    check(pesosHoy.sin.every(x => x.precio == null && x.sinPrecio) && /sin precio:/.test(pesosHoy.estadoSin),
          'sin cierre en ninguna fuente queda sin precio, no con el de antes', JSON.stringify(pesosHoy.sin));
    check(pesosHoy.manualIntacto, 'un precio escrito a mano no se reemplaza');
    check(pesosHoy.vuelta.every(x => x.precio > 0 && !x.ci), 'con precio en vivo otra vez, la marca se va',
          JSON.stringify(pesosHoy.vuelta));
  }

  console.log('\nFamilias USD: descriptor y envoltorios');
  const fam = await page.evaluate(() => {
    const r = {};
    for (const id of ['bop', 'bon', 'glo']) {
      const f = USD_FAM[id];
      r[id] = {
        bonds: Array.isArray(f.bonds) ? f.bonds.length : -1,
        id: f.id,
        tieneFns: ['save', 'chartRender', 'renderSummary', 'renderRows',
                   'dRenderFlows', 'dSaveEdits', 'showDetail', 'dCalc', 'dPreviewRow']
          .every(k => typeof f[k] === 'function'),
      };
    }
    r.wrappers = ['SortBy', 'RenderSummaryRows', 'RenderSummary', 'DeleteDirect',
                  'DToggleEdit', 'DCancelEdit', 'Select', 'DSaveEdits',
                  'ShowDetail', 'ChartRender', 'DRenderFlows', 'DCalc', 'DPreviewRow']
      .flatMap(s => ['bop', 'bon', 'glo'].map(p => p + s))
      .filter(n => typeof window[n] !== 'function');
    return r;
  });
  for (const id of ['bop', 'bon', 'glo']) {
    check(fam[id].id === id, `USD_FAM.${id}.id correcto`);
    check(fam[id].bonds > 0, `USD_FAM.${id}.bonds lee la lista real`, `${fam[id].bonds} bonos`);
    check(fam[id].tieneFns, `USD_FAM.${id} tiene todas las funciones`);
  }
  check(fam.wrappers.length === 0, 'los 39 nombres originales siguen existiendo',
        fam.wrappers.length ? 'faltan: ' + fam.wrappers.join(', ') : '');

  console.log('\nPestañas USD: renderizado');
  await page.evaluate(() => switchSection('usd'));
  for (const [tab, tbody] of [
    ['usd-bopreales', 'bop-summary-tbody'],
    ['usd-bonares',   'bon-summary-tbody'],
    ['usd-globales',  'glo-summary-tbody'],
  ]) {
    await page.evaluate(t => switchUsdTab(t), tab);
    await page.waitForTimeout(1200);
    const filas = await page.evaluate(id => {
      const el = document.getElementById(id);
      return el ? el.querySelectorAll('tr').length : -1;
    }, tbody);
    check(filas > 0, `${tab} renderiza filas`, `${filas} filas`);
  }

  console.log('\nOrdenamiento');
  const sort = await page.evaluate(() => {
    bopSortBy('tir');
    const a = { col: bopSortCol, asc: bopSortAsc };
    bopSortBy('tir');
    const b = { col: bopSortCol, asc: bopSortAsc };
    return { a, b, filas: document.getElementById('bop-summary-tbody').querySelectorAll('tr').length };
  });
  check(sort.a.col === 'tir', 'bopSortBy cambia la columna', sort.a.col);
  check(sort.a.asc !== sort.b.asc, 'repetir la columna invierte el sentido');
  check(sort.filas > 0, 'la tabla sigue con filas tras ordenar', `${sort.filas}`);

  console.log('\nSelección, gráfico, flujos y cálculo');
  for (const id of ['bop', 'bon', 'glo']) {
    const tab = 'usd-' + ({ bop: 'bopreales', bon: 'bonares', glo: 'globales' })[id];
    await page.evaluate(t => switchUsdTab(t), tab);
    await page.waitForTimeout(900);
    const r = await page.evaluate(f => {
      const fm = USD_FAM[f];
      const t = fm.bonds[0] && fm.bonds[0].ticker;
      if (!t) return { err: 'sin bonos' };
      window[f + 'Select'](t);
      window[f + 'DCalc']();
      const tb = document.getElementById(f + '-d-tbody');
      const info = document.getElementById(f + '-d-flows-info');
      const dur = document.getElementById(f + '-d-dur');
      const btn = document.getElementById(f + '-d-edit-btn');
      const det = document.getElementById(f + '-view-detail');
      const nom = document.getElementById(f + '-detail-name');
      return {
        ticker: t, sel: fm.sel,
        flows: Array.isArray(fm.flows) ? fm.flows.length : -1,
        visible: det ? det.style.display : null,
        nombre: nom ? nom.textContent : null,
        chart: !!fm.chart,
        etiqueta: fm.chart && fm.chart.data.datasets[0] ? fm.chart.data.datasets[0].label : null,
        filas: tb ? tb.querySelectorAll('tr').length : -1,
        info: info ? info.textContent.slice(0, 40) : '',
        dur: dur ? dur.textContent : '',
        handler: btn ? btn.getAttribute('onclick') : null,
      };
    }, id);
    if (r.err) { check(false, `${id}Select`, r.err); continue; }
    check(r.sel === r.ticker, `${id}Select fija la selección`, `${r.sel}`);
    check(r.flows > 0, `${id}Select genera los flujos`, `${r.flows}`);
    check(r.visible === 'flex', `${id} abre el panel de detalle`, String(r.visible));
    check(r.nombre === r.ticker, `${id} muestra el ticker en el panel`, String(r.nombre));
    check(r.chart, `${id} crea la instancia del gráfico`);
    check(r.etiqueta === USD_LABEL[id], `${id} usa su propia etiqueta`, String(r.etiqueta));
    check(r.filas > 0, `${id} renderiza el flujo de fondos`, `${r.filas} filas`);
    check(/Precio:/.test(r.info), `${id}DCalc escribe precio y paridad`, r.info);
    check(/MD /.test(r.dur), `${id}DCalc escribe la duration`, r.dur);
    check(r.handler === `${id}DToggleEdit()`, `${id} genera su propio onclick`, String(r.handler));
  }

  console.log('\nSpread de legislación (solapa SLEG)');
  await page.evaluate(() => switchUsdTab('usd-curvas'));
  await page.waitForTimeout(1500);
  const sleg = await page.evaluate(async () => {
    curvasUsdSetSector('SLEG');
    await new Promise(r => setTimeout(r, 2500));
    const chips = document.getElementById('curvas-usd-bonds');
    const msg = document.getElementById('curvas-usd-msg');
    const pares = _curvasSpreadCache.pares || [];
    return {
      chipSLEG: !!document.getElementById('curvas-usd-chip-SLEG'),
      pares: pares.length,
      conDato: pares.filter(p => p.s1 != null || p.s2 != null).length,
      etiquetas: pares.slice(0, 3).map(p => p.label),
      chips: chips ? chips.querySelectorAll('button').length : 0,
      msg: msg ? msg.textContent : '',
      chart: !!curvasUsdChart,
      ejeY: curvasUsdChart ? curvasUsdChart.options.scales.y.title.text : '',
    };
  });
  check(sleg.chipSLEG, 'existe el chip Spread Leg.');
  check(sleg.pares > 0, 'arma pares Global/Bonar', `${sleg.pares}: ${sleg.etiquetas.join(', ')}`);
  check(sleg.conDato > 0, 'calcula spreads', `${sleg.conDato}/${sleg.pares} con dato`);
  check(sleg.chips === sleg.pares, 'un chip por par', `${sleg.chips} chips`);
  check(sleg.chart, 'dibuja el gráfico');
  check(/Spread/.test(sleg.ejeY), 'el eje Y es el spread', sleg.ejeY);

  const volver = await page.evaluate(async () => {
    curvasUsdSetSector('GLO');
    await new Promise(r => setTimeout(r, 2500));
    return curvasUsdChart ? curvasUsdChart.options.scales.y.title.text : '';
  });
  check(/TIR/.test(volver), 'volver a Globales restaura la curva de tasa', volver);

  console.log('\nPesos: tablas por tipo');
  await page.evaluate(() => switchSection('pesos'));
  for (const [tab, tbody, arr] of [
    ['lecap', 'table-body',       'DATA'],
    ['cer',   'cer-table-body',   'CER_DATA'],
    ['tamar', 'tamar-table-body', 'TAMAR_DATA'],
    ['dlk',   'dlk-table-body',   'DLK_DATA'],
  ]) {
    await page.evaluate(t => switchTab(t), tab);
    await page.waitForTimeout(1000);
    const r = await page.evaluate(([id, name]) => {
      const el = document.getElementById(id);
      const filas = el ? el.querySelectorAll('tr').length : -1;
      let datos = -1, conTasa = -1;
      try {
        const a = eval(name);
        if (Array.isArray(a)) {
          datos = a.length;
          conTasa = a.filter(x => [x.tna, x.tir, x.margenTNA]
            .some(v => v != null && !isNaN(v))).length;
        }
      } catch (e) {}
      return { filas, datos, conTasa };
    }, [tbody, arr]);
    check(r.filas > 0, `${tab} renderiza filas`, `${r.filas} filas`);
    check(r.conTasa > 0, `${tab} calcula tasas`, `${r.conTasa}/${r.datos} con tasa`);
  }

  console.log('\nIndicador del snapshot');
  const snap = await page.evaluate(async () => {
    await snapEstadoRefrescar();
    const el = document.getElementById('snap-estado');
    return el ? { txt: el.textContent, title: el.title } : null;
  });
  check(!!snap, 'el indicador existe');
  check(snap && /snapshot/.test(snap.txt), 'muestra la fecha del último snapshot', snap && snap.txt);
  check(snap && /bonos/.test(snap.title), 'el tooltip trae el detalle', snap && snap.title);

  console.log('\nSeries de tiempo');
  for (const [sec, tab, ir] of [
    ['ars', 'series-ars', 'switchTab'],
    ['usd', 'usd-series', 'switchUsdTab'],
  ]) {
    await page.evaluate(([t, fn]) => {
      if (fn === 'switchTab') { switchSection('pesos'); switchTab(t); }
      else { switchSection('usd'); switchUsdTab(t); }
    }, [tab, ir]);
    await page.waitForTimeout(3500);

    const r = await page.evaluate(s => {
      const st = seriesEstado[s], cfg = SERIES_CFG[s];
      const chips = document.getElementById(`series-${s}-chips`);
      const d1 = document.getElementById(`series-${s}-d1`);
      const d2 = document.getElementById(`series-${s}-d2`);
      return {
        sector: st.sector,
        sectores: cfg.sectores.map(o => o.v),
        fechas: st.cache.fechas.length,
        bonos: st.cache.porBono.size,
        chips: chips ? chips.querySelectorAll('button').length : 0,
        // Las barras de volumen son un dataset más y no una línea por bono.
        series: st.chart ? st.chart.data.datasets.filter(d => d.type !== 'bar').length : -1,
        ejeY: st.chart ? st.chart.options.scales.y.title.text : '',
        d1: d1 ? d1.value : '', d2: d2 ? d2.value : '',
      };
    }, sec);

    check(r.fechas > 0, `${sec}: trae ruedas`, `${r.fechas}`);
    check(r.bonos > 0, `${sec}: arma series por bono`, `${r.bonos}`);
    check(r.chips === r.bonos, `${sec}: un chip por bono con datos`, `${r.chips} chips`);
    check(r.series === r.bonos, `${sec}: todos seleccionados al abrir`, `${r.series} líneas`);
    check(r.d1 < r.d2, `${sec}: rango por defecto válido`, `${r.d1} a ${r.d2}`);
    check(/%/.test(r.ejeY), `${sec}: eje Y con la métrica`, r.ejeY);

    // Destildar uno saca su línea.
    // Si Supabase no devolvió ruedas no hay gráfico, y sin esta guarda el
    // evaluate tira un TypeError que aborta el smoke entero: el resto de las
    // secciones queda sin correr y el log no dice por qué.
    const tog = await page.evaluate(s => {
      const st = seriesEstado[s];
      if (!st.chart || !st.cache.porBono.size) return { sinDatos: true };
      const t = [...st.cache.porBono.keys()].sort()[0];
      const lineas = () => st.chart ? st.chart.data.datasets.filter(d => d.type !== 'bar').length : -1;
      const antes = lineas();
      seriesToggle(s, t);
      return { t, antes, despues: lineas() };
    }, sec);
    check(!tog.sinDatos && tog.despues === tog.antes - 1, `${sec}: destildar quita la línea`,
          tog.sinDatos ? 'sin ruedas: no se armó el gráfico' : `${tog.t}: ${tog.antes} → ${tog.despues}`);

    // Cambiar de sector recarga
    const otro = await page.evaluate(async s => {
      const cfg = SERIES_CFG[s];
      const dest = cfg.sectores[1].v;
      seriesSetSector(s, dest);
      await new Promise(r => setTimeout(r, 3000));
      const st = seriesEstado[s];
      return { dest, sector: st.sector, bonos: st.cache.porBono.size,
               ejeY: st.chart ? st.chart.options.scales.y.title.text : '' };
    }, sec);
    check(otro.sector === otro.dest, `${sec}: cambia de sector`, otro.dest);
    check(otro.bonos > 0, `${sec}: el sector nuevo trae datos`, `${otro.bonos} bonos`);
  }

  // Colores con pocos bonos: salen de la paleta, son distintos entre sí y cada uno
  // conserva el suyo al agregar o sacar otro. Antes el círculo cromático se
  // repartía entre todos los bonos del sector aunque se vieran tres, y dos
  // vencimientos seguidos quedaban con casi el mismo tono.
  const col = await page.evaluate(() => {
    const st = seriesEstado.ars;
    const ts = ordenarPorVencimiento([...st.cache.porBono.keys()]);
    if (!st.chart || ts.length < 4) return { sinDatos: true, n: ts.length };
    const colores = () => Object.fromEntries(st.chart.data.datasets
      .filter(d => d.type !== 'bar').map(d => [d.label, d.borderColor]));
    seriesTodos('ars', false);
    ts.slice(0, 3).forEach(t => seriesToggle('ars', t));
    const tres = colores();
    seriesToggle('ars', ts[3]);
    const cuatro = colores();
    seriesToggle('ars', ts[0]);
    const sinPrimero = colores();
    seriesTodos('ars', true);
    const todos = Object.values(colores());
    return { ts: ts.slice(0, 4), paleta: SERIES_PALETA, tres, cuatro, sinPrimero, todos };
  });
  if (col.sinDatos) omitir('colores de las series', `${col.n} bonos en el sector: hacen falta 4`);
  else {
    const [a, b, c, d] = col.ts;
    const t3 = [a, b, c].map(t => col.tres[t]);
    check(t3.every(x => col.paleta.includes(x)) && new Set(t3).size === 3,
          'series: tres bonos seguidos toman tres colores distintos de la paleta', t3.join(' '));
    check([a, b, c].every(t => col.cuatro[t] === col.tres[t]) && col.paleta.includes(col.cuatro[d])
          && !t3.includes(col.cuatro[d]),
          'series: agregar un bono no repinta a los otros', `${d}: ${col.cuatro[d]}`);
    check([b, c, d].every(t => col.sinPrimero[t] === col.cuatro[t]),
          'series: sacar un bono no repinta a los otros', [b, c, d].map(t => col.sinPrimero[t]).join(' '));
    if (col.todos.length > col.paleta.length) {
      const vecinosIguales = col.todos.filter((x, k) => k && x === col.todos[k - 1]).length;
      check(new Set(col.todos).size === col.todos.length && vecinosIguales === 0,
            'series: con muchos bonos, cada uno con su color', `${col.todos.length} bonos`);
    }
  }

  // Spread Leg. como serie temporal (solo USD)
  const slegSerie = await page.evaluate(async () => {
    seriesSetSector('usd', 'SLEG');
    await new Promise(r => setTimeout(r, 3000));
    const st = seriesEstado.usd;
    return {
      bonos: st.cache.porBono.size,
      pares: [...st.cache.porBono.keys()].slice(0, 3),
      ejeY: st.chart ? st.chart.options.scales.y.title.text : '',
    };
  });
  check(slegSerie.bonos > 0, 'usd: Spread Leg. como serie', `${slegSerie.bonos} pares: ${slegSerie.pares.join(', ')}`);
  check(/Spread/.test(slegSerie.ejeY), 'usd: eje Y del spread', slegSerie.ejeY);

  // Monedas: siete series armadas en el momento con el BCRA y data912, más un
  // breakeven por LECAP. Dos unidades que no se pueden leer sobre la misma
  // regla, así que dos paneles apilados, y cada uno aparece sólo si tiene algo.
  const fx = await page.evaluate(async () => {
    const d1 = document.getElementById('series-usd-d1');
    if (d1) d1.value = '2026-04-01';
    seriesSetSector('usd', 'FX');
    await new Promise(r => setTimeout(r, 12000));
    const st = seriesEstado.usd;
    // La última rueda del rango puede ser la de hoy: el BCRA ya publicó las
    // bandas y el mercado todavía no cerró. Se busca la última completa.
    const tiene = (k, d) => { const m = st.cache.porBono.get(k); return !!(m && m.has(d)); };
    const f = [...st.cache.fechas].reverse()
      .find(d => ['A3500', 'MEP', 'Cable'].every(k => tiene(k, d))) || st.cache.fechas[0];
    const v = (k, d) => { const m = st.cache.porBono.get(k); return m && m.has(d || f) ? m.get(d || f) : null; };
    const paneles = () => {
      const w1 = document.getElementById('series-usd-wrap1');
      const w2 = document.getElementById('series-usd-wrap2');
      return { p1: w1.style.display !== 'none', p2: w2.style.display !== 'none',
               ds1: st.chart ? st.chart.data.datasets.map(x => x.label) : null,
               ds2: st.chart2 ? st.chart2.data.datasets.map(x => x.label) : null };
    };
    const claves = [...st.cache.porBono.keys()];
    const be = claves.filter(k => k.startsWith('BE '));
    const mep = v('MEP'), cable = v('Cable'), of = v('A3500'),
          canje = v('Canje'), brecha = v('Brecha');
    const ambos = paneles();
    const ejeY = st.chart ? st.chart.options.scales.y.title.text : '';
    const pts = st.cache.puntos || [];
    const dsBE = st.chart && st.chart.data.datasets.find(dd => /BE/.test(dd.label));
    const ultimo = pts.length ? parseDate(pts[pts.length - 1].vcto).getTime() : null;
    const grafico = {
      tipoBE: dsBE ? dsBE.type : null,
      ejeTipo: st.chart ? st.chart.options.scales.x.type : null,
      enVcto: !!(dsBE && pts.length && dsBE.data.every((q, j) =>
        q.x === parseDate(pts[j].vcto).getTime() && q.ticker === pts[j].ticker)),
      llegaAlUltimo: !!(st.chart && ultimo && st.chart.options.scales.x.max >= ultimo),
    };
    // Sólo niveles
    seriesTodos('usd', false);
    ['A3500', 'MEP', 'Cable', 'Banda inf.', 'Banda sup.'].forEach(t => seriesToggle('usd', t));
    await new Promise(r => setTimeout(r, 600));
    const soloNivel = paneles();
    // Sólo porcentajes
    seriesTodos('usd', false);
    ['Canje', 'Brecha'].forEach(t => seriesToggle('usd', t));
    await new Promise(r => setTimeout(r, 600));
    const soloPct = paneles();
    // Un breakeven contra su aritmética. Cada punto trae el precio y el MEP con
    // los que se calculó, que pueden ser los de hoy o los del último cierre.
    let bePrueba = null;
    for (const x of pts) {
      const bo = LECAPS.find(b => b.ticker === x.ticker);
      if (!bo) continue;
      const vf = calcVF(bo.tem_emision, parseDate(bo.emision), parseDate(bo.vcto));
      bePrueba = { t: x.ticker, be: x.be, esperado: x.mep * vf / x.precio,
                   vence: x.vcto > fmtDate(TODAY) };
      break;
    }
    return { claves, be: be.length, f, mep, cable, of, canje, brecha,
      nPuntos: pts.length, ...grafico,
      vivas: pts.every(x => x.vcto > fmtDate(TODAY)),
      canjeOk: mep && cable && canje != null ? Math.abs((cable / mep - 1) * 100 - canje) < 1e-9 : null,
      brechaOk: mep && of && brecha != null ? Math.abs((mep / of - 1) * 100 - brecha) < 1e-9 : null,
      ambos, soloNivel, soloPct, bePrueba, ejeY,
    };
  });
  if (!fx.claves.length) {
    omitir('usd: serie de monedas', 'el BCRA o data912 no respondieron ahora');
  } else {
    check(['A3500', 'MEP', 'Cable', 'Canje', 'Brecha', 'Banda inf.', 'Banda sup.']
            .every(k => fx.claves.includes(k)),
          'usd: las cinco monedas y las dos bandas', fx.claves.slice(0, 7).join(', '));
    check(fx.of > 0 && fx.mep > 0 && fx.cable > 0, 'usd: oficial, MEP y cable en niveles',
          `${fx.f}: A3500 ${fx.of} · MEP ${fx.mep} · cable ${fx.cable}`);
    check(fx.canjeOk === true, 'usd: el canje es cable sobre MEP', String(fx.canje));
    check(fx.brechaOk === true, 'usd: la brecha es MEP sobre el oficial', String(fx.brecha));
    check(fx.ambos.p1 && fx.ambos.p2
          && fx.ambos.ds1.includes('MEP') && fx.ambos.ds2.includes('Canje')
          && !fx.ambos.ds1.includes('Canje'),
          'usd: niveles arriba y porcentajes abajo, en paneles separados',
          JSON.stringify(fx.ambos));
    check(fx.soloNivel.p1 && !fx.soloNivel.p2, 'usd: sólo niveles deja un panel',
          JSON.stringify(fx.soloNivel));
    check(!fx.soloPct.p1 && fx.soloPct.p2, 'usd: sólo porcentajes deja un panel',
          JSON.stringify(fx.soloPct));
    check(/\$/.test(fx.ejeY), 'usd: el panel de niveles se mide en pesos', fx.ejeY);
    check(fx.ejeTipo === 'linear', 'usd: el panel de niveles va por fecha, no por rueda',
          String(fx.ejeTipo));
    if (!fx.nPuntos) {
      omitir('usd: breakeven de las letras', 'ninguna LECAP tiene precio ahora');
    } else {
      check(fx.be === 1 && fx.tipoBE === 'scatter',
            'usd: los breakeven son una nube de puntos, no una serie por letra',
            `${fx.be} serie · ${fx.nPuntos} puntos · ${fx.tipoBE}`);
      check(fx.vivas, 'usd: sólo entran letras que no vencieron');
      check(fx.enVcto, 'usd: cada punto cae en el vencimiento de su letra');
      check(fx.llegaAlUltimo, 'usd: el eje llega hasta el último vencimiento');
      check(fx.bePrueba && Math.abs(fx.bePrueba.be - fx.bePrueba.esperado) < 1e-6,
            'usd: el breakeven es MEP por VF sobre precio', JSON.stringify(fx.bePrueba));
    }
  }

  // Las monedas no son una tasa con duración: en forwards no se pueden elegir.
  const fxFwd = await page.evaluate(async () => {
    seriesSetModo('usd', 'fwd');
    await new Promise(r => setTimeout(r, 2500));
    const antes = seriesEstado.usd.sector;
    seriesSetSector('usd', 'FX');
    await new Promise(r => setTimeout(r, 500));
    const despues = seriesEstado.usd.sector;
    seriesSetModo('usd', 'tasas');
    await new Promise(r => setTimeout(r, 2500));
    return { antes, despues };
  });
  check(fxFwd.antes !== 'FX' && fxFwd.despues !== 'FX',
        'usd: monedas no es elegible en forwards', JSON.stringify(fxFwd));

  // Dinero: el costo de fondearse en pesos, que hasta ahora no estaba en
  // ninguna serie. La caución sale de los pases entre terceros del BCRA porque
  // BYMA publica la rueda del día y nada de historia.
  console.log('\nSeries de pesos: Dinero');
  const din = await page.evaluate(async () => {
    switchSection('pesos'); switchTab('series-ars');
    await new Promise(r => setTimeout(r, 2000));
    const d1 = document.getElementById('series-ars-d1');
    if (d1) d1.value = '2026-03-01';
    seriesSetSector('ars', 'DINERO');
    await new Promise(r => setTimeout(r, 14000));
    const st = seriesEstado.ars, ch = st.chart;
    const claves = [...st.cache.porBono.keys()];
    const par = (a, b) => {
      const ma = st.cache.porBono.get(a), mb = st.cache.porBono.get(b);
      if (!ma || !mb) return null;
      const d = [...ma.keys()].filter(f => mb.has(f)).map(f => Math.abs(ma.get(f) - mb.get(f)));
      if (!d.length) return null;
      d.sort((x, y) => x - y);
      return d[Math.floor(d.length / 2)];
    };
    return {
      claves, ruedas: st.cache.fechas.length,
      cobertura: Object.fromEntries(claves.map(k => [k, st.cache.porBono.get(k).size])),
      // Caución y BAIBAR son el mismo dinero a un día: tienen que ir pegadas.
      difCauBaibar: par('Caución 1d', 'BAIBAR'),
      ejeY: ch ? ch.options.scales.y.title.text : null,
      tipoX: ch ? (ch.options.scales.x.type || 'category') : null,
      panel2: (document.getElementById('series-ars-wrap2') || {}).style.display,
      nota: st.cache.nota || '',
      msg: (document.getElementById('series-ars-msg') || {}).textContent || '',
      positivas: claves.every(k => [...st.cache.porBono.get(k).values()].every(v => v > 0 && v < 300)),
    };
  });
  if (!din.ruedas) {
    omitir('series de dinero', 'el BCRA no devolvió las series ahora');
  } else {
    check(din.claves.length === 4, 'las cuatro series del costo del dinero', din.claves.join(', '));
    check(din.positivas, 'todas las tasas son plausibles', JSON.stringify(din.cobertura));
    check(din.difCauBaibar != null && din.difCauBaibar < 2,
          'caución y BAIBAR van pegadas: es el mismo dinero a un día',
          din.difCauBaibar + ' puntos de diferencia mediana');
    check(/TNA/.test(din.ejeY) && din.tipoX === 'category' && din.panel2 === 'none',
          'una sola unidad, un solo panel', din.ejeY + ' · ' + din.tipoX + ' · panel2 ' + din.panel2);
    check(din.nota && din.msg.indexOf(din.nota) >= 0,
          'la nota dice de dónde sale la caución', din.nota.slice(0, 60));
  }

  // El dinero no es un bono con duración: en forwards no se puede elegir.
  const dinFwd = await page.evaluate(async () => {
    seriesSetModo('ars', 'fwd');
    await new Promise(r => setTimeout(r, 2500));
    const antes = seriesEstado.ars.sector;
    seriesSetSector('ars', 'DINERO');
    await new Promise(r => setTimeout(r, 500));
    const despues = seriesEstado.ars.sector;
    seriesSetModo('ars', 'tasas');
    await new Promise(r => setTimeout(r, 2500));
    return { antes, despues };
  });
  check(dinFwd.antes !== 'DINERO' && dinFwd.despues !== 'DINERO',
        'dinero no es elegible en forwards', JSON.stringify(dinFwd));


  console.log('\nForwards históricos');
  for (const [sec, tab, ir] of [
    ['ars', 'series-ars', 'switchTab'],
    ['usd', 'usd-series', 'switchUsdTab'],
  ]) {
    await page.evaluate(([t, fn]) => {
      if (fn === 'switchTab') { switchSection('pesos'); switchTab(t); }
      else { switchSection('usd'); switchUsdTab(t); }
    }, [tab, ir]);
    await page.waitForTimeout(800);

    // Entrar al modo forwards. La sección USD quedó en Spread Leg., que no
    // tiene duración: el propio cambio de modo tiene que sacarla de ahí.
    const ent = await page.evaluate(async s => {
      seriesSetModo(s, 'fwd');
      await new Promise(r => setTimeout(r, 3500));
      const st = seriesEstado[s];
      const bar = document.getElementById(`series-${s}-fwdbar`);
      const selC = document.getElementById(`series-${s}-fwd-corto`);
      const selL = document.getElementById(`series-${s}-fwd-largo`);
      const sleg = document.getElementById(`series-${s}-chip-SLEG`);
      const tod = document.getElementById(`series-${s}-todos`);
      return {
        modo: st.modo, sector: st.sector,
        activo: document.getElementById(`series-${s}-modo-fwd`).classList.contains('active'),
        barra: bar ? bar.style.display : '',
        todos: tod ? tod.style.display : '',
        opciones: selC ? selC.options.length : 0,
        corto: selC ? selC.value : '', largo: selL ? selL.value : '',
        bonos: st.cacheFwd.porBono.size,
        conDur: [...st.cacheFwd.porBono.values()]
          .every(m => [...m.values()].every(v => v.dur > 0 && isFinite(v.tasa))),
        slegBloqueado: sleg ? sleg.disabled : null,
        pares: st.cache.porBono.size,
        lineas: st.chart ? st.chart.data.datasets.length : 0,
      };
    }, sec);
    check(ent.modo === 'fwd' && ent.activo, `${sec}: entra en modo forwards`);
    check(ent.barra === 'flex', `${sec}: aparece la barra de combinación`, ent.barra);
    check(ent.todos === 'none', `${sec}: se esconde Todos/Ninguno`, ent.todos);
    check(ent.sector !== 'SLEG', `${sec}: el spread no queda elegido`, ent.sector);
    check(ent.bonos > 1, `${sec}: trae tasa y duración por bono`, `${ent.bonos} bonos`);
    check(ent.conDur, `${sec}: toda fila tiene duración positiva y tasa finita`);
    check(ent.opciones === ent.bonos, `${sec}: un ítem por bono con datos`, `${ent.opciones}`);
    check(!!ent.corto && !!ent.largo && ent.corto !== ent.largo,
          `${sec}: arranca con corto y largo distintos`, `${ent.corto} / ${ent.largo}`);
    // El pedido explícito: no graficar todas las combinaciones por defecto.
    check(ent.pares === 0 && ent.lineas === 0, `${sec}: no grafica nada hasta elegir`, `${ent.pares} pares`);

    const add = await page.evaluate(s => {
      const st = seriesEstado[s];
      const c = document.getElementById(`series-${s}-fwd-corto`).value;
      const l = document.getElementById(`series-${s}-fwd-largo`).value;
      seriesFwdAgregar(s);
      const ds = st.chart ? st.chart.data.datasets : [];
      const serie = st.cache.porBono.get(c + '→' + l);
      const vals = serie ? [...serie.values()] : [];
      // Recálculo del forward sobre la primera rueda con datos en ambos bonos:
      // confirma que la línea salió de ESTE par y no de otro.
      let esperado = null, obtenido = null;
      for (const f of st.cacheFwd.fechas) {
        const a = st.cacheFwd.porBono.get(c).get(f), b = st.cacheFwd.porBono.get(l).get(f);
        if (a && b && b.dur !== a.dur) {
          esperado = (b.tasa * b.dur - a.tasa * a.dur) / (b.dur - a.dur);
          obtenido = serie ? serie.get(f) : null;
          break;
        }
      }
      const guardado = (JSON.parse(localStorage.getItem('bonosAR_series_fwd_v1') || '{}').pares || {})[s] || {};
      return {
        c, l, lineas: ds.length, label: ds.length ? ds[0].label : '',
        puntos: vals.length, finitos: vals.length > 0 && vals.every(v => isFinite(v)),
        esperado, obtenido,
        ejeY: st.chart ? st.chart.options.scales.y.title.text : '',
        chips: document.getElementById(`series-${s}-chips`).querySelectorAll('button').length,
        guardadas: (guardado[st.sector] || []).length,
      };
    }, sec);
    check(add.lineas === 1, `${sec}: agregar dibuja una línea`, `${add.lineas}`);
    check(add.label === `${add.c}→${add.l}`, `${sec}: la serie se llama por el par`, add.label);
    check(add.finitos, `${sec}: la serie tiene puntos finitos`, `${add.puntos} puntos`);
    check(add.esperado !== null && Math.abs(add.esperado - add.obtenido) < 1e-9,
          `${sec}: el forward graficado es el del par elegido`, `${add.esperado} vs ${add.obtenido}`);
    check(/Forward/.test(add.ejeY), `${sec}: eje Y de forwards`, add.ejeY);
    check(add.chips === 1, `${sec}: un chip por combinación`, `${add.chips}`);
    check(add.guardadas === 1, `${sec}: la combinación queda guardada`, `${add.guardadas}`);

    const rech = await page.evaluate(s => {
      const st = seriesEstado[s];
      const n0 = st.cache.porBono.size;
      seriesFwdAgregar(s);                                  // el mismo par de nuevo
      const dup = st.cache.porBono.size;
      const selC = document.getElementById(`series-${s}-fwd-corto`);
      const selL = document.getElementById(`series-${s}-fwd-largo`);
      selL.value = selC.value;
      seriesFwdAgregar(s);                                  // un bono contra sí mismo
      return { n0, dup, igual: st.cache.porBono.size,
               msg: document.getElementById(`series-${s}-msg`).textContent };
    }, sec);
    check(rech.dup === rech.n0, `${sec}: no repite una combinación`, `${rech.dup}`);
    check(rech.igual === rech.n0, `${sec}: rechaza un bono contra sí mismo`, rech.msg);

    const quit = await page.evaluate(s => {
      const st = seriesEstado[s];
      const [c, l] = [...st.cache.porBono.keys()][0].split('→');
      seriesFwdQuitar(s, c, l);
      return { pares: st.cache.porBono.size, lineas: st.chart ? st.chart.data.datasets.length : 0 };
    }, sec);
    check(quit.pares === 0 && quit.lineas === 0, `${sec}: quitar saca la línea`, `${quit.pares}`);

    // Volver a tasas para no arrastrar el modo a las verificaciones siguientes
    await page.evaluate(async s => {
      seriesSetModo(s, 'tasas');
      await new Promise(r => setTimeout(r, 2500));
    }, sec);
    const vuelta = await page.evaluate(s => {
      const st = seriesEstado[s];
      const bar = document.getElementById(`series-${s}-fwdbar`);
      return { modo: st.modo, barra: bar ? bar.style.display : '', bonos: st.cache.porBono.size,
               ejeY: st.chart ? st.chart.options.scales.y.title.text : '' };
    }, sec);
    check(vuelta.modo === 'tasas' && vuelta.barra === 'none', `${sec}: vuelve a modo tasas`);
    check(vuelta.bonos > 0 && !/Forward/.test(vuelta.ejeY), `${sec}: recupera la serie de tasas`, vuelta.ejeY);
  }

  // Serie de precios: el mismo histórico leído en la otra columna. Lo que hay
  // que sostener es la moneda —el tipo de cambio es el MEP de CADA rueda, no el
  // de hoy— y que una rueda sin MEP no se dibuje en vez de heredar el de ayer.
  // La barra de liquidación dejó de existir: sus 58px en todas las solapas se
  // repartieron entre la barra de dólares (la fecha) y el header (las acciones).
  // Lo que hay que sostener es que nada de eso dejó de funcionar por mudarse.
  console.log('\nLa barra de liquidación, repartida');
  const bar = await page.evaluate(() => {
    // Con la sección USD activa el nav de pesos está oculto y mide 0: las barras se
    // miden paradas donde el usuario abre la app.
    switchSection('pesos');
    const caja = sel => { const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height) : null; };
    const out = {
      barraVieja: !!document.querySelector('.sbar'),
      // Los tres campos siguen existiendo, ahora en la barra de dólares.
      enUsdBar: ['g-fecha-op', 'g-plazo', 'g-liq-display']
        .map(id => { const el = document.getElementById(id); return !!el && !!el.closest('#usd-bar'); }),
      // Y las acciones, en el header.
      enHeader: ['hdr-datos-btn', 'api-status', 'g-cer-status', 'g-tamar-status', 'g-dlk-status']
        .map(id => { const el = document.getElementById(id); return !!el && !!el.closest('header.header'); }),
      altos: { header: caja('header.header'), nav: caja('#nav-pesos'), usdBar: caja('#usd-bar') },
    };
    // La fecha sigue mandando sobre la liquidación, que es con la que calcula todo.
    const f = document.getElementById('g-fecha-op'), p = document.getElementById('g-plazo');
    const fAntes = f.value, pAntes = p.value;
    f.value = '2026-09-21'; p.value = '2'; updateSettlement();
    out.liq = G_LIQ ? fmtDate(G_LIQ) : null;
    out.texto = document.getElementById('g-liq-display').textContent;
    f.value = fAntes; p.value = pAntes; updateSettlement();
    out.vuelta = G_LIQ ? fmtDate(G_LIQ) : null;
    // El menú abre, cierra con un clic afuera y con Escape.
    const m = document.getElementById('hdr-datos-menu');
    hdrDatosToggle(); out.abre = m.style.display === 'block';
    document.body.click(); out.cierraClic = m.style.display === 'none';
    hdrDatosToggle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    out.cierraEsc = m.style.display === 'none';
    // Un clic adentro no lo cierra: Import abre el diálogo de archivos y el menú
    // tiene que seguir ahí cuando el navegador devuelve el foco.
    hdrDatosToggle();
    m.querySelector('span').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.sigueAbierto = m.style.display === 'block';
    hdrDatosCerrar();
    return out;
  });
  check(!bar.barraVieja, 'la barra de liquidación ya no está');
  check(bar.enUsdBar.every(Boolean), 'fecha, plazo y liquidación viven en la barra de dólares',
        JSON.stringify(bar.enUsdBar));
  check(bar.enHeader.every(Boolean), 'los refrescos y el portafolio viven en el header',
        JSON.stringify(bar.enHeader));
  check(bar.altos.header + bar.altos.nav + bar.altos.usdBar === 113,
        'las barras fijas ocupan 113px, no 171', JSON.stringify(bar.altos));
  // 21/09/2026 es lunes: dos hábiles caen el miércoles 23.
  check(bar.liq === '2026-09-23' && /23\/09/.test(bar.texto),
        'la fecha de operación sigue mandando sobre la liquidación', `${bar.liq} · ${bar.texto}`);
  check(bar.vuelta != null, 'y vuelve al valor anterior', bar.vuelta);
  check(bar.abre && bar.cierraClic && bar.cierraEsc && bar.sigueAbierto,
        'el menú Datos abre, cierra afuera y con Escape, y no se cierra solo adentro',
        JSON.stringify([bar.abre, bar.cierraClic, bar.cierraEsc, bar.sigueAbierto]));

  // Cada página tiene que terminar donde termina la ventana: el alto sale de una
  // variable CSS, y si quedara desfasada se ve como una franja muerta o como
  // scroll de más en todas las solapas a la vez.
  const altoPaginas = await page.evaluate(() => {
    const ver = (fn, id) => { fn(); const el = document.getElementById(id);
      return { id, sobra: Math.round(window.innerHeight - el.getBoundingClientRect().bottom) }; };
    const out = [];
    out.push(ver(() => { switchSection('pesos'); switchTab('breakeven'); }, 'page-breakeven'));
    out.push(ver(() => switchTab('forwards'), 'page-forwards'));
    out.push(ver(() => { switchSection('usd'); switchUsdTab('usd-forwards'); }, 'page-usd-forwards'));
    switchSection('pesos'); switchTab('breakeven');
    return out;
  });
  check(altoPaginas.every(a => Math.abs(a.sobra) <= 1), 'cada página termina donde termina la ventana',
        JSON.stringify(altoPaginas));

  // Un pago que cae en día no hábil se cobra el hábil siguiente. El monto no se
  // toca —se devenga contra la fecha nominal, y los fixings también— pero el
  // descuento sí: un bono que vence sábado se cobra el lunes y rinde dos días
  // menos. Los bonos en dólares ya lo hacían; los de pesos descontaban contra la
  // fecha nominal y mostraban una TIR que nadie podía capturar.
  console.log('\nPago en día no hábil');
  const hab = await page.evaluate(() => {
    const out = {};
    // El helper solo: fin de semana al lunes, y un hábil no se mueve.
    const f = s => fmtDate(siguienteHabil(parseDate(s)));
    out.helper = { sabado: f('2026-11-07'), domingo: f('2026-11-08'), habil: f('2026-11-10') };
    // El de dólares quedó como alias del mismo: un solo calendario.
    out.mismoQueUsd = f('2026-11-07') === fmtDate(bopSiguienteHabil(parseDate('2026-11-07')));
    const liq = G_LIQ || addHabiles(TODAY, 1);
    // Los bonos que ya vencían en fin de semana descuentan al hábil siguiente.
    out.finde = (CER_BONDS || []).filter(b => b.vcto && !esHabil(parseDate(b.vcto)) && b.precio)
      .map(b => { const e = cerEnrich(b);
        return { t: b.ticker, vcto: b.vcto, pago: f(b.vcto),
                 dias: e.dias, nominal: diasACT(liq, parseDate(b.vcto)) }; });
    // Y uno que vence en día hábil no se mueve ni un día.
    const sano = (CER_BONDS || []).find(b => b.vcto && esHabil(parseDate(b.vcto)) && b.precio
                                             && diasACT(liq, parseDate(b.vcto)) > 5);
    if (sano) { const e = cerEnrich(sano);
      out.sano = { t: sano.ticker, dias: e.dias, nominal: diasACT(liq, parseDate(sano.vcto)) }; }
    // Declarar feriado el día del vencimiento corre el pago, alarga el plazo y
    // baja la tasa; el monto —factor CER y fecha de fixing— queda igual.
    const b = (CER_BONDS || []).find(x => x.precio && x.vcto && esHabil(parseDate(x.vcto))
                                          && diasACT(liq, parseDate(x.vcto)) > 20);
    if (b) {
      const antes = cerEnrich(b);
      const fixAntes = fmtDate(cerGetFechaCer(parseDate(b.vcto)));
      _FERIADOS_EXTRA.push({ fecha: b.vcto, desc: 'Smoke: feriado de prueba' });
      feriadosRebuildSet();
      const despues = cerEnrich(b);
      const fixDespues = fmtDate(cerGetFechaCer(parseDate(b.vcto)));
      _FERIADOS_EXTRA.pop(); feriadosRebuildSet();
      const vuelta = cerEnrich(b);
      out.feriado = { t: b.ticker, vcto: b.vcto,
        diasAntes: antes.dias, diasDespues: despues.dias, diasVuelta: vuelta.dias,
        tirAntes: antes.tir, tirDespues: despues.tir,
        factorIgual: antes.factor === despues.factor, fixIgual: fixAntes === fixDespues };
    }
    return out;
  });
  check(hab.helper.sabado === '2026-11-09' && hab.helper.domingo === '2026-11-09'
        && hab.helper.habil === '2026-11-10',
        'el fin de semana se cobra el lunes y un hábil no se mueve', JSON.stringify(hab.helper));
  check(hab.mismoQueUsd, 'los bonos en dólares usan el mismo calendario, no otro');
  if (!hab.finde.length) omitir('un vencimiento en fin de semana descuenta al hábil siguiente',
                                'ningún bono CER vence en fin de semana');
  else check(hab.finde.every(x => x.dias > x.nominal && x.pago > x.vcto),
             'un vencimiento en fin de semana descuenta al hábil siguiente',
             JSON.stringify(hab.finde));
  if (!hab.sano) omitir('un vencimiento en día hábil no se mueve', 'sin bono con vencimiento lejano');
  else check(hab.sano.dias === hab.sano.nominal, 'un vencimiento en día hábil no se mueve',
             JSON.stringify(hab.sano));
  if (!hab.feriado) omitir('declarar feriado el vencimiento corre el pago', 'sin bono CER con precio');
  else {
    check(hab.feriado.diasDespues === hab.feriado.diasAntes + 1,
          'declarar feriado el día del vencimiento agrega un día de espera',
          JSON.stringify(hab.feriado));
    check(hab.feriado.tirDespues < hab.feriado.tirAntes,
          'y con el mismo monto más lejos, la tasa baja',
          `${hab.feriado.t}: ${hab.feriado.tirAntes.toFixed(4)}% \u2192 ${hab.feriado.tirDespues.toFixed(4)}%`);
    check(hab.feriado.factorIgual && hab.feriado.fixIgual,
          'el monto no cambia: mismo factor CER y mismo fixing',
          JSON.stringify([hab.feriado.factorIgual, hab.feriado.fixIgual]));
    check(hab.feriado.diasVuelta === hab.feriado.diasAntes,
          'y sacando el feriado vuelve al plazo original', String(hab.feriado.diasVuelta));
  }

  console.log('\nSeries de precios');
  const tc = await page.evaluate(async () => {
    const t = await seriesMepSerie();
    const fs = [...t.mapa.keys()].sort();
    const medio = fs[Math.floor(fs.length / 2)];
    return { n: t.mapa.size, ult: t.ult, vivo: t.vivo,
             // Una rueda del medio tiene su propio MEP, distinto del último.
             medio, mepMedio: t.de(medio), mepUlt: t.de(t.ult),
             // Un hueco viejo no se rellena; una rueda posterior al último cierre
             // toma el MEP en vivo, que es del mismo momento que el precio en vivo.
             hueco: t.de('2021-01-04'), futura: t.de('2999-01-01') };
  });
  // El MEP sale del histórico de data912, que a veces no responde. Sin él no hay
  // nada que probar sobre la conversión: se omite, no se falla.
  const hayMep = tc.n > 0;
  if (!hayMep) omitir('el MEP histórico se arma rueda a rueda', 'data912 no devolvió el histórico de AL30');
  else {
    check(tc.n > 100 && tc.ult > '2024-01-01', 'el MEP histórico se arma rueda a rueda',
          `${tc.n} ruedas, última ${tc.ult}`);
    check(tc.mepMedio > 0 && tc.mepUlt > 0 && tc.mepMedio !== tc.mepUlt,
          'cada rueda tiene su propio MEP, no el de hoy',
          `${tc.medio}: ${tc.mepMedio && tc.mepMedio.toFixed(2)} vs ${tc.ult}: ${tc.mepUlt && tc.mepUlt.toFixed(2)}`);
    check(tc.hueco === null, 'una rueda sin MEP no hereda el del día anterior');
  }
  if (tc.vivo == null || !hayMep) omitir('la rueda que data912 no cerró toma el MEP en vivo', 'sin MEP en vivo');
  else check(tc.futura === tc.vivo, 'la rueda que data912 no cerró toma el MEP en vivo',
             String(tc.vivo && tc.vivo.toFixed(2)));

  for (const [sec, tab, ir, sector, guardaUsd] of [
    ['ars', 'series-ars', 'switchTab', 'CER', false],
    ['usd', 'usd-series', 'switchUsdTab', 'BON', true],
  ]) {
    const pr = await page.evaluate(async ([s, t, fn, sector, guardaUsd]) => {
      const esperar = ms => new Promise(r => setTimeout(r, ms));
      if (fn === 'switchTab') { switchSection('pesos'); switchTab(t); }
      else { switchSection('usd'); switchUsdTab(t); }
      const modoPrevio = seriesEstado[s].modo, monedaPrevia = seriesEstado[s].moneda;
      // La moneda "propia" del sector primero: ahí no hay conversión ninguna.
      seriesSetModo(s, 'precios');
      seriesSetSector(s, sector);
      seriesSetMoneda(s, guardaUsd ? 'USD' : 'ARS');
      await esperar(5000);
      const st = seriesEstado[s];
      const out = { modo: st.modo, ejeY: st.chart ? st.chart.options.scales.y.title.text : '',
                    bonos: st.cache.porBono.size, ruedas: st.cache.fechas.length };
      // Los chips que no son un bono quedan bloqueados en este modo.
      out.bloqueados = SERIES_CFG[s].sectores.filter(o => {
        const el = document.getElementById(`series-${s}-chip-${o.v}`);
        return el && el.disabled;
      }).map(o => o.v);
      out.sinPrecio = SERIES_CFG[s].sectores.filter(o => o.precio === false).map(o => o.v);
      if (!st.cache.porBono.size) { out.sinDatos = true; return out; }
      // El bono con más ruedas que siga cotizando en la última. El primero de la
      // lista puede ser una letra ya vencida, sin precio al final: el 08/10/2026
      // tocó la S17A6 y los tres checks de abajo fallaron sin que hubiera error.
      const fUlt = st.cache.fechas[st.cache.fechas.length - 1];
      const tk = [...st.cache.porBono.entries()].filter(([, m]) => m.has(fUlt))
        .sort((x, y) => y[1].size - x[1].size).map(([k]) => k)[0] || [...st.cache.porBono.keys()][0];
      const propia = new Map(st.cache.porBono.get(tk));
      const idx = st.cache.fechas.length - 1;
      out.tip = st.chart.options.plugins.tooltip.callbacks.label(
        { parsed: { y: propia.get(st.cache.fechas[idx]) }, raw: propia.get(st.cache.fechas[idx]),
          dataset: { label: tk }, dataIndex: idx });
      // Y ahora la otra: cada punto tiene que ser el mismo, al MEP de SU rueda.
      seriesSetMoneda(s, guardaUsd ? 'ARS' : 'USD');
      // Convertir pide el MEP histórico y el vivo: se le da aire de sobra para que
      // un data912 lento no se lea como un error de conversión.
      await esperar(9000);
      const st2 = seriesEstado[s];
      out.ejeYOtra = st2.chart ? st2.chart.options.scales.y.title.text : '';
      const elMsg = document.getElementById(`series-${s}-msg`);
      out.msg = elMsg ? elMsg.textContent : '';
      const otra = st2.cache.porBono.get(tk) || new Map();
      const t2 = await seriesMepSerie();
      let comparadas = 0, tcs = new Set();
      const malas = [], vivas = [];
      for (const [f, v] of otra) {
        const base = propia.get(f), mep = t2.de(f);
        if (base == null || !(mep > 0)) continue;
        const esperado = guardaUsd ? base * mep : base / mep;
        const error = Math.abs(v - esperado) / Math.abs(esperado);
        tcs.add(Math.round((guardaUsd ? v / base : base / v) * 100) / 100);
        // La rueda que data912 todavía no cerró se valúa con el MEP EN VIVO, que
        // se mueve entre una medición y la otra: ahí la igualdad exacta no aplica
        // —cada vista es coherente en el momento en que se dibuja— y lo que se
        // exige es que siga siendo el mismo tipo de cambio, no otro.
        if (!t2.mapa.has(f)) { if (error > 0.02) vivas.push({ f, error: +error.toFixed(5) }); continue; }
        comparadas++;
        if (error > 1e-9) malas.push({ f, v, esperado: +esperado.toFixed(6) });
      }
      out.comparadas = comparadas; out.malas = malas; out.vivas = vivas; out.tcsDistintos = tcs.size;
      out.ticker = tk;
      // Volver a tasas no puede dejar el gráfico roto.
      seriesSetModo(s, 'tasas');
      await esperar(4000);
      out.vuelta = { modo: seriesEstado[s].modo,
                     ejeY: seriesEstado[s].chart ? seriesEstado[s].chart.options.scales.y.title.text : '',
                     bonos: seriesEstado[s].cache.porBono.size };
      seriesSetModo(s, modoPrevio); seriesSetMoneda(s, monedaPrevia);
      await esperar(3000);
      return out;
    }, [sec, tab, ir, sector, guardaUsd]);

    const simb = guardaUsd ? 'US$' : '$';
    const otro = guardaUsd ? '$' : 'US$';
    check(pr.modo === 'precios' && pr.ejeY === `Precio (${simb})`,
          `${sec}: el eje dice precio y en qué moneda`, pr.ejeY);
    check(pr.sinPrecio.length > 0 && pr.sinPrecio.every(v => pr.bloqueados.includes(v)),
          `${sec}: lo que no es un bono no se puede pedir en precios`,
          `sin precio ${JSON.stringify(pr.sinPrecio)} · bloqueados ${JSON.stringify(pr.bloqueados)}`);
    if (pr.sinDatos) { omitir(`${sec}: la serie de precios`, 'sin ruedas con precio guardado'); continue; }
    check(pr.bonos > 0 && pr.ruedas > 0, `${sec}: trae un precio por bono y por rueda`,
          `${pr.bonos} bonos · ${pr.ruedas} ruedas`);
    check(Array.isArray(pr.tip) && pr.tip.length === 2 && pr.tip[0].includes(simb) && /%$/.test(pr.tip[1]),
          `${sec}: el globo muestra el precio y debajo la tasa de esa rueda`, JSON.stringify(pr.tip));
    if (!hayMep) {
      omitir(`${sec}: el precio en la otra moneda`, 'data912 no devolvió el histórico de AL30');
      check(/sin MEP/.test(pr.msg || ''), `${sec}: y el gráfico dice por qué quedó vacío`, pr.msg);
    } else {
      check(pr.ejeYOtra === `Precio (${otro})`, `${sec}: el botón de moneda cambia el eje`, pr.ejeYOtra);
      check(pr.comparadas > 0 && pr.malas.length === 0,
            `${sec}: cada punto es el mismo precio al MEP de su rueda`,
            `${pr.ticker}: ${pr.comparadas} ruedas` + (pr.malas.length ? ' \u2014 ' + JSON.stringify(pr.malas.slice(0, 3)) : ''));
      check(pr.vivas.length === 0,
            `${sec}: la rueda con MEP en vivo sigue al mismo tipo de cambio`,
            JSON.stringify(pr.vivas.slice(0, 3)));
      check(pr.tcsDistintos > 1, `${sec}: el tipo de cambio es el de cada rueda, no uno solo`,
            `${pr.tcsDistintos} valores distintos en ${pr.comparadas} ruedas`);
    }
    check(pr.vuelta.modo === 'tasas' && pr.vuelta.bonos > 0 && /%/.test(pr.vuelta.ejeY),
          `${sec}: volver a tasas recupera la serie`, pr.vuelta.ejeY);
  }

  // La moneda elegida sobrevive, como el modo: se guardan juntas.
  const monLs = await page.evaluate(() => {
    seriesFwdLoad();
    const antes = JSON.parse(JSON.stringify(seriesFwdMoneda));
    seriesFwdMoneda.ars = 'USD'; seriesFwdSave();
    seriesFwdMoneda.ars = 'ARS'; seriesFwdLoad();
    const leido = seriesFwdMoneda.ars;
    seriesFwdMoneda = antes; seriesFwdSave();
    return { leido, restaurado: seriesFwdMoneda.ars };
  });
  check(monLs.leido === 'USD', 'la moneda del precio se guarda junto al modo', JSON.stringify(monLs));

  console.log('\nMAE — mayorista y futuros de dólar');

  // Lo puro primero: no depende de la red ni del horario.
  const puro = await page.evaluate(() => ({
    // El MAE serializa la hora argentina con forma de unix UTC, así que hay que
    // leer las partes en UTC a propósito. El runner de CI corre en UTC, con lo
    // cual esto vigila el formato; la conversión en sí se ve en la app.
    hora: maeHoraART(Date.UTC(2026, 8, 9, 14, 59) / 1000),
    horaPad: maeHoraART(Date.UTC(2026, 8, 9, 9, 5) / 1000),
    // DLR + MM + YYYY
    tk: maeTickerFromVcto('2026-09-30'),
    tkEnero: maeTickerFromVcto('2027-01-15'),
    tkNulo: maeTickerFromVcto('no-es-fecha'),
    tieneCierre: typeof MAE_CIERRE_H === 'number' && MAE_CIERRE_H === 15,
  }));
  check(puro.hora === '14:59', 'lee la hora del tick del MAE', puro.hora);
  check(puro.horaPad === '09:05', 'rellena hora y minuto con cero', puro.horaPad);
  check(puro.tk === 'DLR092026', 'mapea vencimiento a contrato', puro.tk);
  check(puro.tkEnero === 'DLR012027', 'rellena el mes con cero', puro.tkEnero);
  check(puro.tkNulo === null, 'una fecha inválida no arma ticker', String(puro.tkNulo));
  check(puro.tieneCierre, 'el cierre de la rueda mayorista es a las 15');

  // Precedencia del A3500. Es la razón de ser del refactor: antes el refresco
  // escribía en dlkTCOverride y te pisaba el valor que habías puesto a mano.
  // Se controlan las tres entradas para que el resultado no dependa de si el BCRA
  // ya publicó el fix de hoy: con el índice real, el oficial tapa al intradiario
  // y no se podría ver el orden completo.
  const prec = await page.evaluate(() => {
    const bkOver = dlkTCOverride, bkLive = A3500_LIVE, bkIdx = DLK_INDEX;
    const viejo = { fecha: '2026-01-02', valor: 900 };
    const out = {};
    try {
      // Sin fix de hoy publicado: manda el intradiario del MAE.
      DLK_INDEX = [viejo];
      dlkTCOverride = null; A3500_LIVE = { valor: 1111.11, hora: '12:34' };
      out.live = dlkTCHoy(); out.fLive = dlkTCFuente().tipo;
      // Con el fix de hoy publicado: el oficial le gana al intradiario.
      DLK_INDEX = [viejo, { fecha: hoyAR(), valor: 1500 }];
      out.oficial = dlkTCHoy(); out.fOficial = dlkTCFuente().tipo;
      // Lo escrito a mano le gana a todo.
      dlkTCOverride = 2222.22;
      out.manual = dlkTCHoy(); out.fManual = dlkTCFuente().tipo;
      // Sin manual ni intradiario ni fix de hoy: último cierre disponible.
      dlkTCOverride = null; A3500_LIVE = null; DLK_INDEX = [viejo];
      out.cierre = dlkTCHoy(); out.fCierre = dlkTCFuente().tipo;
    } finally {
      dlkTCOverride = bkOver; A3500_LIVE = bkLive; DLK_INDEX = bkIdx;
    }
    return out;
  });
  check(prec.manual === 2222.22 && prec.fManual === 'manual',
        'lo escrito a mano le gana a todo', `${prec.manual} / ${prec.fManual}`);
  check(prec.oficial === 1500 && prec.fOficial === 'oficial',
        'el fix del BCRA del día le gana al intradiario', `${prec.oficial} / ${prec.fOficial}`);
  check(prec.live === 1111.11 && prec.fLive === 'mae',
        'sin fix del día, manda el mayorista del MAE', `${prec.live} / ${prec.fLive}`);
  check(prec.cierre === 900 && prec.fCierre === 'cierre',
        'sin nada más, cae al último cierre oficial', `${prec.cierre} / ${prec.fCierre}`);

  // La red, solo si la rueda está abierta: fuera de 10-15 ART no hay nada nuevo
  // que pedir y afirmar lo contrario haría fallar el build por horario.
  const red = await page.evaluate(async () => {
    if (!maeRuedaAbierta()) return { cerrada: true };
    // Un timeout suelto contra una API pública no es una regresión del código.
    // Se reintenta una vez: si el Worker o el MAE están realmente caídos, el
    // segundo intento también falla y el build se pone en rojo igual.
    const conReintento = async fn => {
      try { return await fn(); }
      catch (e) { await new Promise(r => setTimeout(r, 3000)); return fn(); }
    };
    try {
      const spot = await conReintento(() => maeFetchSpot());
      const curva = await conReintento(() => maeFetchFuturos());
      return {
        cerrada: false,
        spot: spot && spot.valor, hora: spot && spot.hora,
        n: curva.length,
        ordenada: curva.every((c, i) => i === 0 ||
          (c.anio > curva[i - 1].anio || (c.anio === curva[i - 1].anio && c.mes > curva[i - 1].mes))),
        precios: curva.every(c => c.precio > 0),
      };
    } catch (e) { return { cerrada: false, error: e.message }; }
  });
  if (red.cerrada) {
    console.log('  \x1b[33m--\x1b[0m    rueda mayorista cerrada: no se verifica la red del MAE');
  } else if (red.error) {
    // Sin el Worker redeployado con la ruta /mae esto falla, y tiene que verse.
    check(false, 'el MAE responde por el Worker', red.error);
  } else {
    check(red.spot > 0, 'llega el mayorista contado', `${red.spot} a las ${red.hora}`);
    // El MAE devuelve sólo los contratos que ya operaron ese día, así que la
    // curva se va llenando durante la rueda: a las 10:20 había 3 contratos y al
    // cierre 12. Exigir un número fijo haría fallar el build por la hora.
    check(red.n >= 1, 'llega la curva de futuros', `${red.n} contratos`);
    check(red.ordenada, 'la curva viene ordenada por vencimiento');
    check(red.precios, 'todos los contratos traen precio');
  }

  // El ciclo automático tiene que VOLCAR la curva sobre los sintéticos, no sólo
  // traerla. Traerla sin volcarla dejaba el precio del futuro viejo y era la
  // diferencia entre "se actualiza solo" y "hay que apretar el botón".
  // El pedido al MAE vive en maeRefrescar, que es por donde entran el arranque,
  // el ciclo y el botón ↻ Precios. La cadena que se verifica acá es
  // refrescoCiclo → fetchAllPrices → maeRefrescar → maeAplicarFuturos.
  const auto = await page.evaluate(() => ({
    existe: typeof maeAplicarFuturos === 'function',
    enCiclo: /maeAplicarFuturos/.test(maeRefrescar.toString())
          && /maeRefrescar/.test(fetchAllPrices.toString())
          && /fetchAllPrices/.test(refrescoCiclo.toString()),
    spotEnCiclo: /maeFetchSpot/.test(maeRefrescar.toString()),
  }));
  check(auto.existe, 'existe el volcado de la curva a los sintéticos');
  check(auto.enCiclo, 'el ciclo automático aplica la curva, no sólo la trae');
  check(auto.spotEnCiclo, 'el ciclo automático trae el mayorista');

  const volcado = await page.evaluate(() => {
    const bkS = SINT_BONDS, bkD = DLK_BONDS, bkT = currentTab;
    try {
      currentTab = 'lecap';   // que no intente redibujar la tabla de sintéticos
      DLK_BONDS = [{ ticker: 'TESTDLK', vcto: '2026-10-31' }];
      SINT_BONDS = [{ ticker: 'TESTDLK', precioFuturo: 1 }];
      const n = maeAplicarFuturos([
        { ticker: 'DLR092026', mes: 9,  anio: 2026, precio: 1529.5, hora: '14:59' },
        { ticker: 'DLR102026', mes: 10, anio: 2026, precio: 1553.5, hora: '14:59' },
      ]);
      return { n, precio: SINT_BONDS[0].precioFuturo };
    } finally {
      SINT_BONDS = bkS; DLK_BONDS = bkD; currentTab = bkT;
      sintSaveBonds();   // deshacer lo que el volcado guardó con el fixture
    }
  });
  check(volcado.n === 1 && volcado.precio === 1553.5,
        'el volcado toma el contrato del mes del vencimiento', String(volcado.precio));

  // El Resumen grafica los sintéticos y es la solapa que queda abierta todo el
  // día. Actualizar el dato sin repintarla deja la tasa vieja en pantalla, que
  // es peor que no actualizar: parece fresca y no lo es.
  const resumen = await page.evaluate(() => ({
    hook: typeof beRefreshIfVisible === 'function',
    desdeTC: /beRefreshIfVisible/.test(a3500Repropagar.toString()),
    desdeFuturos: /beRefreshIfVisible/.test(maeAplicarFuturos.toString()),
    graficaSint: /SINT_BONDS/.test(beRenderChartTF.toString()),
  }));
  check(resumen.hook, 'existe el refresco del Resumen');
  check(resumen.graficaSint, 'el Resumen grafica los sintéticos');
  check(resumen.desdeTC, 'un cambio de tipo de cambio repinta el Resumen');
  check(resumen.desdeFuturos, 'un cambio de futuros repinta el Resumen');

  // Dos regresiones que aparecieron usando la app, no en el test:
  //  · dlkFetchPrices llamaba a dlkResetA3500, que estampaba la fecha del último
  //    cierre en la etiqueta. El valor mostrado era el del MAE, pero al lado
  //    decía "09/09/2026", y eso se lee como dato viejo.
  //  · SINT_BONDS sólo se cargaba al abrir la solapa, así que el volcado de la
  //    curva no encontraba nada que actualizar.
  const etiq = await page.evaluate(() => {
    const bkLive = A3500_LIVE, bkOver = dlkTCOverride;
    try {
      dlkTCOverride = null;
      A3500_LIVE = { valor: 1234.5, hora: '11:22' };
      const esperada = dlkTCFuente().etiqueta;
      dlkResetA3500();
      return {
        esperada,
        trasReset: (document.getElementById('usd-a3500-label') || {}).textContent,
        // Los dos caminos de refresco: el de la solapa DLK y el global, que es
        // el que se usa todo el día.
        refrescoNoResetea: !/dlkResetA3500/.test(dlkFetchPrices.toString())
                        && !/dlkResetA3500/.test(fetchAllPrices.toString()),
        sintVuelca: /maeAplicarFuturos/.test(sintInit.toString()),
        volcadoCargaBonos: /sintCargarEstado/.test(maeAplicarFuturos.toString()),
      };
    } finally { A3500_LIVE = bkLive; dlkTCOverride = bkOver; a3500Pintar(); }
  });
  check(etiq.trasReset === etiq.esperada, 'el ↺ deja la etiqueta de la fuente vigente',
        `"${etiq.trasReset}" vs "${etiq.esperada}"`);
  check(etiq.refrescoNoResetea, 'refrescar precios no pisa el A3500 con el último cierre');
  check(etiq.sintVuelca, 'abrir Sintéticos vuelca la curva de futuros');
  check(etiq.volcadoCargaBonos, 'el volcado carga los sintéticos si no están en memoria');

  // ↻ Precios no pedía nada al MAE: el mayorista y los futuros quedaban como
  // estaban y había que ir hasta Sintéticos a apretar ↻ MAE. Y al arrancar, la
  // curva llegaba antes que las definiciones DLK, así que el volcado se iba sin
  // hacer nada y sólo se recuperaba al abrir esa solapa.
  const mae = await page.evaluate(async () => {
    const bkSpot = maeFetchSpot, bkFut = maeFetchFuturos, bkRueda = maeRuedaAbierta;
    let spots = 0, futs = 0;
    try {
      window.maeFetchSpot = async () => { spots++; return null; };
      window.maeFetchFuturos = async () => { futs++; return []; };
      window.maeRuedaAbierta = () => false;
      await maeRefrescar(false);
      const cerrado = spots + futs;
      await maeRefrescar(true);
      return {
        cerrado, forzado: spots + futs,
        enPrecios: /maeRefrescar/.test(fetchAllPrices.toString()),
        enCiclo: /fetchAllPrices\(true\)/.test(refrescoCiclo.toString()),
        trasSupabase: /maeAplicarFuturos/.test(supaLoadSharedData.toString()),
      };
    } finally {
      window.maeFetchSpot = bkSpot;
      window.maeFetchFuturos = bkFut;
      window.maeRuedaAbierta = bkRueda;
    }
  });
  check(mae.enPrecios, 'refrescar precios también pide el MAE');
  check(mae.enCiclo, 'el ciclo automático refresca por el mismo camino que el botón');
  check(mae.cerrado === 0, 'con la rueda cerrada el ciclo no pide nada al MAE',
        `${mae.cerrado} pedidos`);
  check(mae.forzado === 2, 'un pedido explícito trae el cierre igual',
        `${mae.forzado} pedidos`);
  check(mae.trasSupabase, 'al llegar las definiciones DLK se vuelca la curva pendiente');

  // La tasa de descuento de los sintéticos se leía sólo al abrir esa solapa,
  // pero el Resumen los grafica desde el arranque. Al recargar la página salían
  // calculados con descuento 0: el sintético más corto daba 41,49% de TNA en vez
  // de 15,05% y ese punto solo estiraba el eje del gráfico de 14-30 a 20-45.
  const sintTasa = await page.evaluate(() => {
    const bkTasa = SINT_TASA_DESC, bkLs = localStorage.getItem('bonosAR_sint_tasa_desc_v1');
    try {
      localStorage.setItem('bonosAR_sint_tasa_desc_v1', '30');
      _sintCargado = false; SINT_TASA_DESC = null;
      beRenderChartTF();               // el camino del Resumen, sin pasar por Sintéticos
      const trasChart = SINT_TASA_DESC;
      _sintCargado = false; SINT_TASA_DESC = null;
      beCPEnrich({ ticker: (SINT_BONDS[0] || {}).ticker || 'X', tipo: 'sint' });
      const trasTabla = SINT_TASA_DESC;   // el comparador del Resumen
      _sintCargado = false; SINT_TASA_DESC = null;
      maeAplicarFuturos([]);           // el camino del volcado del MAE
      return { trasChart, trasTabla, trasMae: SINT_TASA_DESC };
    } finally {
      SINT_TASA_DESC = bkTasa;
      if (bkLs == null) localStorage.removeItem('bonosAR_sint_tasa_desc_v1');
      else localStorage.setItem('bonosAR_sint_tasa_desc_v1', bkLs);
    }
  });
  check(sintTasa.trasChart === 30, 'graficar el Resumen carga la tasa de descuento de los sintéticos',
        String(sintTasa.trasChart));
  check(sintTasa.trasTabla === 30, 'la tabla del Resumen también la carga', String(sintTasa.trasTabla));
  check(sintTasa.trasMae === 30, 'el volcado del MAE también la carga', String(sintTasa.trasMae));

  // Caución: el tramo corto de la curva de pesos, que hasta ahora arrancaba en
  // la LECAP más corta. Sale de BYMA directo del navegador, sin pasar por el
  // Worker, porque manda la cabecera CORS con el origen que la pide.
  console.log('\nCaución en pesos');
  const cau = await page.evaluate(async () => {
    await caucionFetch(true);
    const bk = SINT_TASA_DESC;
    try {
      SINT_TASA_DESC = null;
      const auto = sintTasaDescEfectiva();
      SINT_TASA_DESC = 44.4;
      const manual = sintTasaDescEfectiva();
      SINT_TASA_DESC = null;
      return {
        n: CAUCION_ARS.length,
        corta: caucionCorta(),
        primera: CAUCION_ARS[0] || null,
        creciente: CAUCION_ARS.every((c, i) => i === 0 || c.dias > CAUCION_ARS[i - 1].dias),
        sinCeros: CAUCION_ARS.every(c => c.tna > 0 && c.dias > 0),
        auto, manual,
      };
    } finally { SINT_TASA_DESC = bk; sintPintarTasaDesc(); }
  });
  if (!cau.n) {
    omitir('caución en pesos', 'BYMA no devolvió la rueda de cauciones ahora');
  } else {
    check(cau.n >= 3, 'trae la curva de caución en pesos', cau.n + ' plazos');
    check(cau.creciente && cau.sinCeros, 'ordenada por plazo y sin tasas en cero',
          JSON.stringify(cau.primera));
    check(cau.corta > 0 && cau.corta < 200, 'la más corta es una tasa plausible',
          cau.corta + '% TNA a ' + cau.primera.dias + ' día(s)');
    check(cau.auto === cau.corta, 'sin tasa escrita, el sintético descuenta a la caución',
          cau.auto + ' vs ' + cau.corta);
    check(cau.manual === 44.4, 'con tasa escrita, manda la tuya', String(cau.manual));

    const capa = await page.evaluate(async () => {
      switchSection('pesos'); switchTab('breakeven');
      await new Promise(r => setTimeout(r, 2500));
      const dsCau = () => (beChartTF && beChartTF.data.datasets.find(x => /cauci/i.test(x.label))) || null;
      const bk = beChartCaucion;
      beChartCaucion = true; beRenderChartTF();
      await new Promise(r => setTimeout(r, 400));
      const d = dsCau();
      const pts = d ? d.data : [];
      const con = pts.length;
      beChartCaucion = false; beRenderChartTF();
      await new Promise(r => setTimeout(r, 400));
      const sin = dsCau() ? dsCau().data.length : 0;
      beChartCaucion = bk; beRenderChartTF();
      await new Promise(r => setTimeout(r, 400));
      const tf = ((beChartTF.data.datasets.find(x => x.label === 'tf')) || {}).data || [];
      return {
        con, sin,
        xCau: pts.length ? Math.min.apply(null, pts.map(p => p.x)) : null,
        xTf: tf.length ? Math.min.apply(null, tf.map(p => p.x)) : null,
        montos: pts.every(p => p.monto >= 1e9),
      };
    });
    check(capa.con > 0 && capa.sin === 0, 'la capa entra al gráfico y el botón la saca',
          capa.con + ' puntos con, ' + capa.sin + ' sin');
    check(capa.montos, 'sólo entran los plazos con monto operado');
    // La caución cubre el tramo corto SIEMPRE QUE las letras no lleguen ahí solas.
    // Los días previos a un vencimiento la letra más corta queda en dos o tres días,
    // debajo del plazo más corto que la rueda de cauciones opera con volumen, y la
    // comparación deja de decir algo: no es que la capa falle, es que ese día no
    // hay tramo que cerrar.
    if (capa.xTf == null) {
      omitir('la caución cierra el tramo corto', 'no hay LECAPs con precio ahora');
    } else if (capa.xCau >= capa.xTf) {
      omitir('la caución cierra el tramo que las letras no cubren',
             `hay una letra a ${capa.xTf} días, más corta que la caución más corta (${capa.xCau})`);
    } else {
      check(capa.xCau < capa.xTf, 'la caución cierra el tramo que las letras no cubren',
            'caución desde ' + capa.xCau + ' días, letras desde ' + capa.xTf);
    }
  }


  // IOL se eliminó por completo: no debe quedar ni el modal ni las credenciales.
  const iol = await page.evaluate(() => ({
    modal: !!document.getElementById('iol-creds-modal'),
    funcs: ['rofexFetch', 'iolGetToken', 'iolCredsOpen', 'iolAuth']
      .filter(f => typeof window[f] === 'function'),
    creds: !!localStorage.getItem('bonosAR_iol_creds_v1'),
    token: !!localStorage.getItem('bonosAR_iol_token_v1'),
    boton: (document.getElementById('sint-rofex-btn') || {}).textContent || '',
  }));
  check(!iol.modal, 'no queda el modal de credenciales de IOL');
  check(iol.funcs.length === 0, 'no quedan funciones de IOL', iol.funcs.join(', '));
  check(!iol.creds && !iol.token, 'las credenciales guardadas de IOL se borran');
  check(/MAE/.test(iol.boton), 'el botón de futuros apunta al MAE', iol.boton);

  // ── Senderos proyectados: REM, TAMAR y dólar ──────────────────────────────
  console.log('\nProyecciones — REM, TAMAR y dólar');

  const rem = await page.evaluate(async () => {
    await remFetch(true);
    if (!REM_DATA) return { falla: 'rem.json no se pudo leer' };
    const dias = Math.round((Date.now() - new Date(REM_DATA.relevamiento + 'T00:00:00Z')) / 86400000);
    return {
      relevamiento: REM_DATA.relevamiento, dias,
      ipc: REM_DATA.ipc.length, tamar: REM_DATA.tamar.length, tcn: REM_DATA.tcn.length,
      anclas: Object.keys(REM_DATA.anclas || {}).length,
      tcnEsNivel: REM_DATA.tcn.every(p => p.v > 100),
      tamarEsTNA: REM_DATA.tamar.every(p => p.v > 0 && p.v < 300),
    };
  });
  check(!rem.falla, 'rem.json se sirve y parsea', rem.falla || '');
  check(rem.ipc >= 5 && rem.tamar >= 5 && rem.tcn >= 5,
        'el REM trae las tres series mensuales', JSON.stringify(rem));
  // El REM sale una vez por mes. Más de 75 días sin renovarse significa que el
  // workflow dejó de andar y la app está proyectando con datos viejos.
  check(rem.dias != null && rem.dias <= 75,
        'el relevamiento del REM está al día', `${rem.relevamiento} (${rem.dias} días)`);
  check(rem.tcnEsNivel, 'el tipo de cambio del REM viene en niveles, no en variación');
  check(rem.tamarEsTNA, 'la TAMAR del REM viene como TNA en porcentaje');

  // La extensión por anclas tiene que aterrizar exactamente sobre el ancla.
  const anc = await page.evaluate(() => {
    const hasta = proyMesAdd(proyMesHoy(), 72);
    const out = {};
    const tcn = proyExtender(REM_DATA.tcn, REM_DATA.anclas.tcn, 'tcn', hasta);
    const tam = proyExtender(REM_DATA.tamar, REM_DATA.anclas.tamar, 'tamar', hasta);
    const ipc = proyExtender(REM_DATA.ipc, REM_DATA.anclas.ipc, 'ipc', hasta);
    for (const [k, path, anclas] of [['tcn', tcn, REM_DATA.anclas.tcn],
                                      ['tamar', tam, REM_DATA.anclas.tamar]]) {
      const mes = Object.keys(anclas).sort().pop();
      const p = path.find(x => x.mes === mes);
      out[k] = { mes, esperado: anclas[mes], obtenido: p ? p.v : null };
    }
    // El acumulado del año calendario tiene que reproducir el ancla interanual.
    const mesIpc = Object.keys(REM_DATA.anclas.ipc).sort().pop();
    const anio = mesIpc.substring(0, 4);
    const delAnio = ipc.filter(x => x.mes.startsWith(anio + '-'));
    let acc = 1; delAnio.forEach(x => acc *= 1 + x.v / 100);
    out.ipc = { anio, meses: delAnio.length, esperado: REM_DATA.anclas.ipc[mesIpc],
                obtenido: (acc - 1) * 100 };
    out.largo = tcn.length;
    out.creciente = tcn.every((p, i) => i === 0 || p.v >= tcn[i - 1].v - 1e-9);
    return out;
  });
  check(anc.tcn.obtenido != null && Math.abs(anc.tcn.obtenido - anc.tcn.esperado) < 0.01,
        'el sendero del dólar aterriza en el ancla anual del REM', JSON.stringify(anc.tcn));
  check(anc.tamar.obtenido != null && Math.abs(anc.tamar.obtenido - anc.tamar.esperado) < 0.01,
        'el sendero de TAMAR aterriza en el ancla anual del REM', JSON.stringify(anc.tamar));
  check(anc.ipc.meses === 12 && Math.abs(anc.ipc.obtenido - anc.ipc.esperado) < 0.01,
        'la inflación acumulada del año reproduce el ancla interanual', JSON.stringify(anc.ipc));
  check(anc.largo >= 60, 'el sendero cubre el horizonte completo', 'meses: ' + anc.largo);
  check(anc.creciente, 'el sendero del dólar es monótono');

  // El método de 5 días tiene que reproducirse exactamente: es el caso
  // degenerado del sendero nuevo, no un camino de código aparte.
  const tam5 = await page.evaluate(() => {
    const b = [...TAMAR_BONDS].filter(x => x.precio != null && x.vcto)
      .sort((a, c) => c.vcto.localeCompare(a.vcto))[0];
    if (!b) return { sinBonos: true };
    const prev = PROJ_FUENTE.tamar;
    PROJ_FUENTE.tamar = '5dias'; proyInvalidar();
    const e = tamarEnrich(b);
    PROJ_FUENTE.tamar = prev; proyInvalidar();
    return { t: b.ticker,
      identico: e.tna === e.tnaProy && e.tir === e.tirProy &&
                e.tem === e.temProy && e.margenTNA === e.margenTNAProy };
  });
  check(tam5.sinBonos || tam5.identico,
        'con fuente 5 días la proyección reproduce el cálculo de siempre', JSON.stringify(tam5));

  // La que protege el histórico: cambiar la fuente NO puede mover los campos
  // que _curvasSnapshotTodayImpl guarda en Supabase.
  const congelado = await page.evaluate(() => {
    const out = { tamar: [], dlk: [], movio: [] };
    const prevT = PROJ_FUENTE.tamar, prevD = PROJ_FUENTE.tcn, prevM = PROJ_FUENTE.dlkModo;
    for (const b of TAMAR_BONDS.filter(x => x.precio != null && x.vcto).slice(0, 6)) {
      PROJ_FUENTE.tamar = '5dias'; proyInvalidar();
      const a = tamarEnrich(b);
      PROJ_FUENTE.tamar = 'rem'; proyInvalidar();
      const c = tamarEnrich(b);
      if (a.margenTNA !== c.margenTNA) out.movio.push('TAMAR ' + b.ticker);
      out.tamar.push(b.ticker);
    }
    for (const b of DLK_BONDS.filter(x => x.precio != null && x.vcto).slice(0, 6)) {
      PROJ_FUENTE.tcn = 'futuros'; PROJ_FUENTE.dlkModo = 'usd'; proyInvalidar();
      const a = dlkEnrich(b);
      PROJ_FUENTE.tcn = 'rem'; PROJ_FUENTE.dlkModo = 'pesos'; proyInvalidar();
      const c = dlkEnrich(b);
      if (a.tna !== c.tna || a.tir !== c.tir) out.movio.push('DLK ' + b.ticker);
      out.dlk.push(b.ticker);
    }
    PROJ_FUENTE.tamar = prevT; PROJ_FUENTE.tcn = prevD; PROJ_FUENTE.dlkModo = prevM;
    proyInvalidar();
    return out;
  });
  check(congelado.movio.length === 0,
        'el selector no mueve los campos que guarda el snapshot de curvas',
        congelado.movio.join(', '));
  check(congelado.tamar.length > 0 && congelado.dlk.length > 0,
        'la prueba anterior corrió sobre bonos reales',
        `TAMAR ${congelado.tamar.length} · DLK ${congelado.dlk.length}`);

  // dlkTCProy: coincide con el contrato en su fin de mes e interpola adentro.
  const tcproy = await page.evaluate(() => {
    const guardado = (typeof MAE_FUTUROS !== 'undefined' ? MAE_FUTUROS : []).slice();
    const prev = PROJ_FUENTE.tcn;
    const spot = dlkTCHoy();
    const hoyMes = proyMesHoy();
    MAE_FUTUROS = [];
    for (let k = 0; k < 12; k++) {
      const mes = proyMesAdd(hoyMes, k);
      const [y, m] = mes.split('-').map(Number);
      MAE_FUTUROS.push({ ticker: `DLR${String(m).padStart(2, '0')}${y}`, mes: m, anio: y,
                         precio: +(spot * Math.pow(1.02, k + 1)).toFixed(2), hora: '14:00' });
    }
    PROJ_FUENTE.tcn = 'futuros'; proyInvalidar();
    const c = MAE_FUTUROS[2];
    const mesC = `${c.anio}-${String(c.mes).padStart(2, '0')}`;
    const enFin = dlkTCProy(proyUltDiaMes(mesC));
    const medio = dlkTCProy(`${mesC}-15`);
    const anterior = MAE_FUTUROS[1].precio;
    const cola = dlkSendero().lista[14].origen;
    MAE_FUTUROS = guardado; PROJ_FUENTE.tcn = prev; proyInvalidar();
    return { coincide: Math.abs(enFin - c.precio) < 0.01,
             interpola: medio > anterior && medio < c.precio, cola,
             enFin: +enFin.toFixed(2), contrato: c.precio };
  });
  check(tcproy.coincide, 'el sendero devuelve el precio del contrato en su fin de mes',
        `${tcproy.enFin} vs ${tcproy.contrato}`);
  check(tcproy.interpola, 'interpola dentro del mes entre dos cierres');
  check(tcproy.cola === 'respaldo' || tcproy.cola === 'extrap',
        'pasado el último contrato el sendero sigue con el respaldo', tcproy.cola);

  // Sin contratos —rueda cerrada— el dólar no puede quedar plano.
  const sinRueda = await page.evaluate(() => {
    const guardado = (typeof MAE_FUTUROS !== 'undefined' ? MAE_FUTUROS : []).slice();
    const prev = PROJ_FUENTE.tcn;
    MAE_FUTUROS = [];
    PROJ_FUENTE.tcn = 'futuros'; proyInvalidar();
    const l = dlkSendero().lista;
    const spot = dlkTCHoy();
    MAE_FUTUROS = guardado; PROJ_FUENTE.tcn = prev; proyInvalidar();
    return { origen: l[3].origen, sube: l[11].v > spot * 1.02 };
  });
  check(sinRueda.sube && sinRueda.origen === 'respaldo',
        'sin contratos del MAE el sendero cae al REM, no a un dólar plano',
        JSON.stringify(sinRueda));

  // El Resumen: la columna proyectada de DLK, que antes salía vacía.
  const resumenProy = await page.evaluate(() => {
    const db = DLK_BONDS.find(b => b.precio != null && b.vcto);
    const d = db ? beCPEnrich({ ticker: db.ticker, tipo: 'dlk' }) : null;
    const sels = [...document.querySelectorAll('[data-proy-sel="tamar"] select')];
    return {
      selectores: sels.length,
      sincronizados: sels.every(s => s.value === PROJ_FUENTE.tamar),
      dlkLlena: !!(d && d.tir != null && d.tna != null && d.tirReal != null),
      dlkPesosMayor: !!(d && d.tir > d.tirReal),
      modos: document.querySelectorAll('[data-dlk-modo] select').length,
    };
  });
  check(resumenProy.selectores >= 3, 'el selector de TAMAR está en los tres lugares',
        'encontrados: ' + resumenProy.selectores);
  check(resumenProy.sincronizados, 'los selectores de TAMAR están sincronizados');
  check(resumenProy.dlkLlena, 'en el Resumen los DLK ya no tienen la columna proyectada vacía');

  // La TNA de TAMAR capitaliza mensual (12 × TEM), como la de CER: la simple
  // en un bono de años da casi el doble de la TIR. El panel dice lo mismo.
  const tnaTamar = await page.evaluate(() => {
    const out = { n: 0, errores: [], largo: null, panel: null };
    for (const b of TAMAR_BONDS.filter(x => x.precio != null && x.vcto)) {
      const e = tamarEnrich(b);
      if (isNaN(e.tir) || !(e.dias > 0)) continue;
      out.n++;
      const esperada = 12 * (Math.pow(1 + e.tir / 100, 1 / 12) - 1) * 100;
      if (Math.abs(e.tna - esperada) > 1e-9 || Math.abs(e.tna - 12 * e.tem) > 1e-9)
        out.errores.push(`${b.ticker}: ${e.tna} vs ${esperada}`);
      if (e.dias > 365 && (!out.largo || e.dias > out.largo.dias))
        out.largo = { ticker: b.ticker, dias: e.dias, tna: e.tna, tir: e.tir };
    }
    if (out.largo) {
      tamarOpenPanel(out.largo.ticker);
      const txt = (document.getElementById('tp-r-tna') || {}).textContent || '';
      const esperado = fmtPct(out.largo.tna);
      out.panel = { txt, esperado };
      tamarClosePanel();
    }
    return out;
  });
  if (!tnaTamar.n) {
    omitir('la TNA de TAMAR es 12 × TEM', 'no hay bonos TAMAR con precio');
  } else {
    check(tnaTamar.errores.length === 0, 'la TNA de TAMAR es 12 × TEM, igual que en CER',
          tnaTamar.errores.slice(0, 3).join(' · '));
    if (tnaTamar.largo) {
      check(tnaTamar.largo.tna < tnaTamar.largo.tir,
            'arriba de un año la TNA de TAMAR queda debajo de la TIR',
            JSON.stringify(tnaTamar.largo));
      check(tnaTamar.panel && tnaTamar.panel.txt === tnaTamar.panel.esperado,
            'el panel de la calculadora TAMAR muestra la misma TNA que la tabla',
            JSON.stringify(tnaTamar.panel));
    }
  }

  // La fuente de inflación se elige también desde la solapa CER y el Resumen, y
  // cambiarla ahí mueve la TIR c/proy de la tabla.
  const inflaSel = await page.evaluate(async () => {
    const prev = PROJ_FUENTE.infla;
    const otro = prev === 'rem' ? 'manual' : 'rem';
    const mapa = f => { const g = PROJ_FUENTE.infla; PROJ_FUENTE.infla = f; const m = JSON.stringify([...inflaFuenteMapa()]); PROJ_FUENTE.infla = g; return m; };
    const iguales = mapa(prev) === mapa(otro);
    switchSection('pesos'); switchTab('cer');
    await new Promise(r => setTimeout(r, 300));
    const liq = G_LIQ || addHabiles(TODAY, 1);
    const b = CER_BONDS.find(x => x.precio != null && x.vcto && diasACT(liq, parseDate(x.vcto)) > 90);
    const tirDe = () => { const e = b && (CER_DATA || []).find(r => r.ticker === b.ticker); return e ? e.tirProy : null; };
    const antes = tirDe();
    const sel = document.querySelector('#cer-left-pane [data-proy-sel="infla"] select');
    if (sel) { sel.value = otro; sel.dispatchEvent(new Event('change')); }
    const despues = tirDe();
    const sincronizados = [...document.querySelectorAll('[data-proy-sel="infla"] select')].every(s => s.value === otro);
    proySetFuente('infla', prev);
    const vuelta = tirDe();
    return {
      selectores: document.querySelectorAll('[data-proy-sel="infla"] select').length,
      enCer: !!sel, enResumen: !!document.querySelector('#be-col2 [data-proy-sel="infla"] select'),
      ticker: b && b.ticker, antes, despues, vuelta, sincronizados, iguales,
    };
  });
  check(inflaSel.enCer && inflaSel.enResumen && inflaSel.selectores >= 3,
        'el selector de inflación está en Proyecciones, en la solapa CER y en el Resumen',
        JSON.stringify({ n: inflaSel.selectores, cer: inflaSel.enCer, resumen: inflaSel.enResumen }));
  check(inflaSel.sincronizados, 'los selectores de inflación están sincronizados');
  if (inflaSel.iguales || inflaSel.antes == null) {
    omitir('cambiar la inflación desde la solapa CER mueve la TIR c/proy',
           inflaSel.iguales ? 'el sendero manual es igual al REM' : 'no hay un CER con precio');
  } else {
    check(Math.abs(inflaSel.despues - inflaSel.antes) > 1e-6 && Math.abs(inflaSel.vuelta - inflaSel.antes) < 1e-9,
          'cambiar la inflación desde la solapa CER mueve la TIR c/proy, y volver la deja igual',
          `${inflaSel.ticker}: ${inflaSel.antes} → ${inflaSel.despues} → ${inflaSel.vuelta}`);
  }
  check(resumenProy.dlkPesosMayor, 'la tasa en pesos de un DLK supera a la de dólares');
  check(resumenProy.modos >= 1, 'la solapa DLK tiene el selector dólares/pesos');

  // Las sub-solapas de Proyecciones.
  const subs = await page.evaluate(async () => {
    switchSection('pesos'); switchTab('proyecciones');
    await new Promise(r => setTimeout(r, 600));
    const out = {};
    for (const s of ['tamar', 'tcn', 'infla']) {
      proySubtabGo(s);
      await new Promise(r => setTimeout(r, 500));
      const pane = document.getElementById('proy-pane-' + s);
      out[s] = {
        visible: pane && pane.style.display !== 'none',
        filas: s === 'infla' ? document.querySelectorAll('#proj-tbody tr').length
                             : document.querySelectorAll(`#proy-${s}-tbody tr`).length,
      };
    }
    return out;
  });
  for (const s of ['tamar', 'tcn', 'infla']) {
    check(subs[s].visible && subs[s].filas > 0,
          `la sub-solapa ${s} de Proyecciones se dibuja`, JSON.stringify(subs[s]));
  }

  // Meses ya cerrados: el valor tiene que ser el dato real, no una proyección.
  const cerrados = await page.evaluate(() => {
    const h = proyHistoriaLista('tamar');
    const hd = proyHistoriaLista('tcn');
    if (!h.length || !hd.length) return { vacio: true, tamar: h.length, tcn: hd.length };
    const u = h[h.length - 1];
    const ruedas = TAMAR_INDEX.filter(t => t.fecha.substring(0, 7) === u.mes);
    const prom = ruedas.reduce((s, t) => s + t.valor, 0) / ruedas.length;
    const ud = hd[hd.length - 1];
    const fixes = DLK_INDEX.filter(t => t.fecha.substring(0, 7) === ud.mes)
      .sort((a, b) => a.fecha.localeCompare(b.fecha));
    return {
      tamarEsPromedio: Math.abs(u.v - prom) < 1e-9, ruedas: ruedas.length, mes: u.mes,
      tcnEsUltimoFix: Math.abs(ud.v - fixes[fixes.length - 1].valor) < 1e-9,
      todosReales: h.every(p => p.origen === 'real') && hd.every(p => p.origen === 'real'),
      anteriores: h.every(p => p.mes < proyMesHoy()),
    };
  });
  check(!cerrados.vacio && cerrados.tamarEsPromedio,
        'un mes cerrado de TAMAR es el promedio de sus ruedas',
        JSON.stringify(cerrados));
  check(!cerrados.vacio && cerrados.tcnEsUltimoFix,
        'un mes cerrado del dólar es el último fix del mes');
  check(!cerrados.vacio && cerrados.todosReales && cerrados.anteriores,
        'el tramo realizado va marcado y queda antes del mes en curso');

  // Rango por defecto: 12 meses, 4 de datos y 8 de proyección.
  const rango = await page.evaluate(async () => {
    const out = {};
    for (const s of ['tamar', 'tcn']) {
      proySubtabGo(s);
      await new Promise(r => setTimeout(r, 500));
      proyRangoDefault(s);
      await new Promise(r => setTimeout(r, 400));
      const v = proyVentana(s);
      const ch = s === 'tamar' ? projTamarChart : projTcnChart;
      // Los dos van por fecha: se comparan los extremos del eje con los de la
      // ventana elegida.
      let dibuja = false;
      if (ch) {
        const x = ch.options.scales.x;
        dibuja = x.min === parseDate(v[0].mes + '-01').getTime() &&
                 x.max === parseDate(proyUltDiaMes(v[v.length - 1].mes)).getTime();
      }
      out[s] = {
        total: v.length,
        reales: v.filter(p => p.origen === 'real').length,
        dibuja,
        selectores: !!document.getElementById(`proy-${s}-desde`) &&
                    !!document.getElementById(`proy-${s}-hasta`),
      };
    }
    return out;
  });
  for (const s of ['tamar', 'tcn']) {
    check(rango[s].selectores, `${s}: hay selectores de mes inicial y final`);
    check(rango[s].total === 12 && rango[s].reales === 4,
          `${s}: por defecto 12 meses, 4 de datos y 8 de proyección`, JSON.stringify(rango[s]));
    check(rango[s].dibuja, `${s}: el gráfico dibuja la ventana elegida`,
          JSON.stringify(rango[s]));
  }

  // TAMAR real: ida y vuelta exacta, y entra al gráfico.
  const real = await page.evaluate(async () => {
    proySubtabGo('tamar');
    await new Promise(r => setTimeout(r, 500));
    const mes = proyMesHoy();
    // El deflactor es la inflación DE ESE MES anualizada, no la de los últimos
    // doce. Se compara contra el sendero crudo para que no haya dos fórmulas.
    const teaI = proyInflTEA(mes);
    const fila = projCalcAcum().find(r => r.mes === mes);
    const teaEsperada = fila ? (Math.pow(1 + fila.inflaEfectiva / 100, 12) - 1) * 100 : null;
    // Y si la TEA de la TAMAR iguala a la de la inflación del mes, la real es 0.
    const tnaNeutra = tamarRealAtna(mes, 0);
    const teaNeutra = tnaNeutra != null ? tamarTEAde(tnaNeutra) : null;
    const errores = [];
    for (const tna of [12, 24.01, 35, 55, 80]) {
      const r = tamarRealDe(mes, tna);
      if (r == null) { errores.push(`sin real para ${tna}`); continue; }
      const vuelta = tamarRealAtna(mes, r);
      if (vuelta == null || Math.abs(vuelta - tna) > 1e-6) errores.push(`${tna} → ${vuelta}`);
    }
    // Una TNA igual a la inflación de 12 meses en efectiva anual da real ≈ 0
    const antes = projTamarChart ? projTamarChart.data.datasets.length : 0;
    document.getElementById('proy-tamar-cb-real').checked = true;
    proyRenderChart('tamar');
    await new Promise(r => setTimeout(r, 400));
    const ds = projTamarChart.data.datasets;
    const linea = ds.find(d => /real/i.test(d.label));
    const esc = projTamarChart.options.scales;
    // Las dos tasas van sobre la misma regla, con el cero a la vista.
    const mismoEje = ds.every(d => d.yAxisID === 'y') && !esc.yReal;
    const conReal = { min: esc.y.min,
      valores: ds.flatMap(d => d.data).map(p => p && p.y).filter(v => v != null) };
    document.getElementById('proy-tamar-cb-real').checked = false;
    proyRenderChart('tamar');
    const soloTNA = projTamarChart.options.scales.y.min;
    return { teaI, teaEsperada, teaNeutra, errores, antes, despues: ds.length,
             tieneLinea: !!linea, mismoEje,
             minConReal: conReal.min, minValor: Math.min(...conReal.valores),
             minSoloTNA: soloTNA,
             conDatos: linea ? linea.data.filter(v => v != null).length : 0 };
  });
  check(real.teaI != null, 'hay inflación proyectada para el mes en curso', String(real.teaI));
  check(real.teaEsperada != null && Math.abs(real.teaI - real.teaEsperada) < 1e-9,
        'el deflactor es la inflación del mes anualizada',
        `${real.teaI} vs ${real.teaEsperada}`);
  check(real.teaNeutra != null && Math.abs(real.teaNeutra - real.teaI) < 1e-6,
        'TAMAR real cero es TEA de TAMAR igual a TEA de inflación',
        `${real.teaNeutra} vs ${real.teaI}`);
  check(real.errores.length === 0, 'la TAMAR real y la TNA son inversas exactas',
        real.errores.join(' | '));
  check(real.tieneLinea && real.despues === real.antes + 1 && real.conDatos > 0,
        'la TAMAR real se puede sumar al gráfico', JSON.stringify(real));
  check(real.mismoEje, 'nominal y real comparten la misma regla');
  check(real.minSoloTNA === 0,
        'el gráfico de TAMAR arranca en cero', `min: ${real.minSoloTNA}`);
  check(real.minConReal <= 0 && real.minConReal <= real.minValor,
        'con tasa real negativa el eje baja de cero sin recortar la serie',
        `min eje ${real.minConReal} · mínimo de la serie ${real.minValor}`);

  // Escribir la tasa real despeja la TNA y queda guardada como TNA.
  const inverso = await page.evaluate(async () => {
    const prev = JSON.parse(JSON.stringify(PROJ_TAMAR));
    const mes = proyMesAdd(proyMesHoy(), 3);
    proySetTamarReal(mes, '5');
    await new Promise(r => setTimeout(r, 400));
    const g = PROJ_TAMAR.find(o => o.mes === mes);
    const leido = g ? tamarRealDe(mes, g.v) : null;
    const p = tamarSendero().mapa.get(mes);
    PROJ_TAMAR = prev; proySaveLs(); proyInvalidar();
    return { guardadaTNA: g ? +g.v.toFixed(4) : null,
             vuelve: leido != null ? +leido.toFixed(4) : null,
             esManual: p ? p.origen === 'manual' : false };
  });
  check(inverso.guardadaTNA != null && Math.abs(inverso.vuelve - 5) < 1e-3,
        'escribir la tasa real despeja la TNA que la produce', JSON.stringify(inverso));
  check(inverso.esManual, 'la TNA despejada entra al sendero como override manual');

  // Las fuentes tienen que convivir. Antes el sendero manual se aplicaba pasara
  // lo que pasara, así que en cuanto tocabas una celda el selector dejaba de
  // tener efecto y no había forma de volver al REM sin borrar tu escenario.
  // Y en inflación el selector directamente no lo leía nadie.
  const fuentes = await page.evaluate(async () => {
    const espera = () => new Promise(r => setTimeout(r, 250));
    const bk = { infla: PROJ_FUENTE.infla, tamar: PROJ_FUENTE.tamar,
                 man: JSON.parse(JSON.stringify(PROJ_INFLA_MANUAL)),
                 tam: JSON.parse(JSON.stringify(PROJ_TAMAR)) };
    const mes = proyMesAdd(proyMesHoy(), 4), sig = proyMesAdd(mes, 1);
    const infla = m => (PROJ_INFLACION.find(r => r.mes === m) || {}).infla;
    try {
      proySubtabGo('infla');
      PROJ_FUENTE.infla = 'manual';
      inflaSetManual(mes, 9.99); projRecalc(); await espera();
      const manual1 = infla(mes);
      proySetFuente('infla', 'rem'); await espera();
      const rem = infla(mes), remSig = infla(sig);
      proySetFuente('infla', 'manual'); await espera();
      const manual2 = infla(mes);
      // Editar con el REM activo bifurca: copia el REM al almacén manual y el
      // cambio se aplica ahí, así que el resto de los meses sigue siendo el REM.
      proySetFuente('infla', 'rem'); await espera();
      projSetInfla(mes, '7.77'); await espera();
      const fork = { fuente: PROJ_FUENTE.infla, valor: infla(mes), sig: infla(sig) };
      proySetFuente('infla', 'rem'); await espera();
      const remIntacto = infla(mes);
      // TAMAR: el sendero manual no puede ganarle a la fuente elegida.
      PROJ_TAMAR = [{ mes, v: 44.4 }]; PROJ_FUENTE.tamar = 'manual';
      proySaveLs(); proyInvalidar(); await espera();
      const tManual = tamarSendero().mapa.get(mes).v;
      proySetFuente('tamar', '5dias'); await espera();
      const t5 = tamarSendero().mapa.get(mes).v;
      proySetFuente('tamar', 'manual'); await espera();
      return { manual1, rem, remSig, manual2, fork, remIntacto,
               tManual, t5, prom5: +tamarProm5().toFixed(4),
               tVuelve: tamarSendero().mapa.get(mes).v, mes };
    } finally {
      PROJ_INFLA_MANUAL = bk.man; PROJ_TAMAR = bk.tam;
      PROJ_FUENTE.infla = bk.infla; PROJ_FUENTE.tamar = bk.tamar;
      proySaveLs(); proyInvalidar(); projRecalc();
    }
  });
  check(fuentes.rem != null, 'la fuente REM llena el sendero de inflación', String(fuentes.rem));
  check(fuentes.manual1 === 9.99 && fuentes.manual2 === 9.99 && fuentes.rem !== 9.99,
        'el selector de inflación cambia el sendero y vuelve', JSON.stringify(fuentes));
  check(fuentes.fork.fuente === 'manual' && fuentes.fork.valor === 7.77
        && fuentes.fork.sig === fuentes.remSig,
        'editar con el REM activo bifurca y conserva el resto del REM',
        JSON.stringify(fuentes.fork));
  check(fuentes.remIntacto === fuentes.rem, 'el REM queda intacto después de editar',
        `${fuentes.remIntacto} vs ${fuentes.rem}`);
  check(fuentes.tManual === 44.4 && fuentes.t5 === fuentes.prom5 && fuentes.tVuelve === 44.4,
        'el sendero manual de TAMAR sólo se aplica con la fuente manual',
        JSON.stringify(fuentes));

  // Pasado y proyección tienen que distinguirse solos en el gráfico. El escalón
  // mensual es una sola serie que cruza el corte, así que el punteado se decide
  // por tramo: el de un mes cerrado va entero, el de un mes proyectado no.
  const corte = await page.evaluate(async () => {
    proySubtabGo('tamar');
    await new Promise(r => setTimeout(r, 500));
    const ch = projTamarChart;
    const prom = ch.data.datasets.find(d => /promedio/i.test(d.label));
    const iProy = prom ? prom.data.findIndex(p => p.proy) : -1;
    const seg = prom && prom.segment && typeof prom.segment.borderDash === 'function';
    return {
      plugin: (ch.config.plugins || []).some(p => p.id === 'proyFuturo'),
      hayEscalon: !!prom && prom.stepped === 'after',
      punteaFuturo: !!seg && !!prom.segment.borderDash({ p0DataIndex: iProy }),
      punteaPasado: !!seg && !!prom.segment.borderDash({ p0DataIndex: Math.max(0, iProy - 1) }),
      iProy,
    };
  });
  check(corte.plugin, 'el gráfico sombrea el tramo proyectado');
  check(corte.hayEscalon, 'el promedio mensual se dibuja como escalón por mes');
  check(corte.punteaFuturo && !corte.punteaPasado,
        'el escalón va punteado desde el primer mes proyectado', JSON.stringify(corte));

  // El detalle diario y el promedio del mes son dos cosas distintas y las dos
  // tienen que estar. El nivel del escalón de un mes cerrado es tamarPromMes de
  // ese mes: si se separan, el gráfico dejó de decir contra qué se compara.
  const dia = await page.evaluate(async () => {
    proySubtabGo('tamar');
    await new Promise(r => setTimeout(r, 400));
    const ch = projTamarChart;
    const diaria = ch.data.datasets.find(d => /diaria/i.test(d.label));
    const prom = ch.data.datasets.find(d => /promedio/i.test(d.label));
    const lista = proyVentana('tamar');
    const cerrado = lista.find(p => p.origen === 'real' && p.v != null);
    const punto = cerrado && prom ? prom.data.find(p => p.mes === cerrado.mes) : null;
    const hoyTs = parseDate(fmtDate(TODAY)).getTime();
    return {
      ruedas: diaria ? diaria.data.length : 0,
      meses: lista.length,
      noPasaHoy: diaria ? diaria.data.every(p => p.x <= hoyTs) : null,
      nivel: punto ? +punto.y.toFixed(4) : null,
      promedio: cerrado ? +tamarPromMes(cerrado.mes).toFixed(4) : null,
    };
  });
  if (!dia.ruedas) {
    omitir('detalle diario de la TAMAR', 'el índice TAMAR no cargó ahora');
  } else {
    check(dia.ruedas > dia.meses, 'el gráfico muestra la TAMAR rueda por rueda',
          `${dia.ruedas} ruedas en ${dia.meses} meses`);
    check(dia.noPasaHoy === true, 'la serie diaria no se mete en el futuro');
    check(dia.nivel != null && dia.nivel === dia.promedio,
          'el escalón de un mes cerrado es su promedio', `${dia.nivel} vs ${dia.promedio}`);
  }

  // Tablas: años enteros con corte anual.
  const anios = await page.evaluate(async () => {
    const out = {};
    for (const s of ['tamar', 'tcn']) {
      proySubtabGo(s);
      await new Promise(r => setTimeout(r, 500));
      const v = proyVentana(s), t = proyVentanaTabla(s);
      const filas = [...document.querySelectorAll(`#proy-${s}-tbody tr`)];
      const cortes = filas.filter(tr => tr.querySelectorAll('td').length === 1);
      out[s] = {
        anioIni: v[0].mes.substring(0, 4), anioFin: v[v.length - 1].mes.substring(0, 4),
        mesesTabla: t.length, arranca: t[0].mes, termina: t[t.length - 1].mes,
        cortes: cortes.length, conResumen: cortes.every(tr => /%|sin datos/.test(tr.textContent)),
      };
    }
    return out;
  });
  for (const s of ['tamar', 'tcn']) {
    const a = anios[s];
    const esperado = (+a.anioFin - +a.anioIni + 1) * 12;
    check(a.arranca === a.anioIni + '-01' && a.termina === a.anioFin + '-12' && a.mesesTabla === esperado,
          `${s}: la tabla muestra años enteros`, JSON.stringify(a));
    check(a.cortes === +a.anioFin - +a.anioIni + 1 && a.conResumen,
          `${s}: un corte por año, con su resumen`, JSON.stringify(a));
  }

  // El gráfico del dólar: diario en el pasado, mensual hacia adelante.
  const tcnChart = await page.evaluate(async () => {
    proySubtabGo('tcn');
    await new Promise(r => setTimeout(r, 700));
    const ch = projTcnChart;
    const diario = ch.data.datasets.find(d => /diario/.test(d.label));
    const proy = ch.data.datasets.find(d => /proyectado/.test(d.label));
    // parseDate y new Date('YYYY-MM-DD') no dan lo mismo: el segundo interpreta
    // UTC. Hay que comparar con el mismo parser que usa el gráfico.
    const hoy = parseDate(fmtDate(TODAY)).getTime();
    return {
      xTipo: ch.options.scales.x.type,
      diarios: diario ? diario.data.length : 0,
      proyectados: proy ? proy.data.length : 0,
      diarioTodoPasado: diario ? diario.data.every(p => p.x <= hoy) : false,
      proyTodoFuturo: proy ? proy.data.slice(1).every(p => p.x > hoy) : false,
      seEnganchan: !!(diario && proy) &&
        Math.abs(diario.data[diario.data.length - 1].y - proy.data[0].y) < 1e-6,
      tablaMensual: document.querySelectorAll('#proy-tcn-tbody tr').length,
    };
  });
  check(tcnChart.xTipo === 'linear',
        'el gráfico del dólar usa eje de fechas, no de meses', tcnChart.xTipo);
  check(tcnChart.diarios > 30 && tcnChart.diarioTodoPasado,
        'el pasado del dólar son los fixes diarios', JSON.stringify(tcnChart));
  check(tcnChart.proyectados > 1 && tcnChart.proyTodoFuturo,
        'hacia adelante va un punto por cierre de mes');
  check(tcnChart.seEnganchan, 'la proyección arranca pegada al último dato');

  // Bandas cambiarias: serie del BCRA y proyección con la regla del régimen.
  const bandas = await page.evaluate(async () => {
    const ok = await bandaFetchIndex(false);
    if (!ok || !BANDA_INDEX.length) return { falla: true };
    const u = BANDA_INDEX[BANDA_INDEX.length - 1];
    const p = bandaProyectar(proyUltDiaMes(proyMesAdd(proyMesHoy(), 8)));
    const m1 = proyMesAdd(u.fecha.substring(0, 7), 1);
    const delMes = p.filter(r => r.fecha.substring(0, 7) === m1);
    let ritmo = null;
    if (delMes.length > 20) {
      const a = delMes[0], b = delMes[delMes.length - 1];
      const dias = (new Date(b.fecha) - new Date(a.fecha)) / 86400000;
      ritmo = ((b.sup / a.sup) ** (30 / dias) - 1) * 100;
    }
    const infl = new Map(projCalcAcum().map(r => [r.mes, r.inflaEfectiva]));
    const esperada = infl.get(proyMesAdd(m1, -2));
    document.getElementById('proy-tcn-cb-bandas').checked = true;
    await proyBandasToggle();
    const lineas = projTcnChart.data.datasets.filter(d => /Banda/.test(d.label));
    document.getElementById('proy-tcn-cb-bandas').checked = false;
    proyRenderChart('tcn');
    return {
      puntos: BANDA_INDEX.length, hasta: u.fecha,
      pisoDebajo: u.inf < u.sup, spotDentro: dlkTCHoy() > u.inf && dlkTCHoy() < u.sup,
      ritmo, esperada, lineas: lineas.length,
      // el techo sube y el piso baja al mismo ritmo
      techoSube: p.length > 1 && p[p.length - 1].sup > p[0].sup,
      pisoBaja: p.length > 1 && p[p.length - 1].inf < p[0].inf,
    };
  });
  check(!bandas.falla && bandas.puntos > 300,
        'se baja la serie de bandas del BCRA', JSON.stringify(bandas));
  check(!bandas.falla && bandas.pisoDebajo && bandas.spotDentro,
        'el mayorista está dentro de la banda publicada');
  // La regla: el ritmo del mes M es la inflación de M−2. Verificada contra los
  // siete meses de 2026 ya cerrados antes de programarla.
  check(!bandas.falla && bandas.ritmo != null && bandas.esperada != null &&
        Math.abs(bandas.ritmo - bandas.esperada) < 0.02,
        'la banda proyectada se desliza a la inflación de dos meses antes',
        `ritmo ${bandas.ritmo} vs IPC ${bandas.esperada}`);
  check(!bandas.falla && bandas.techoSube && bandas.pisoBaja,
        'el techo sube y el piso baja');
  check(!bandas.falla && bandas.lineas === 2, 'las dos bandas entran al gráfico');

  // Dólar breakeven de las LECAPs: vender dólares hoy, comprar tasa fija y
  // recomprarlos al vencimiento. BE = spot × VF / precio.
  const lecaps = await page.evaluate(async () => {
    const desde = proyMesHoy() + '-01';
    const hasta = proyUltDiaMes(proyMesAdd(proyMesHoy(), 12));
    const pts = proyLecapPuntos(desde, hasta);
    const spot = dlkTCHoy();
    document.getElementById('proy-tcn-cb-lecaps').checked = true;
    proyRenderChart('tcn');
    await new Promise(r => setTimeout(r, 500));
    const ds = projTcnChart.data.datasets.find(d => /BE/.test(d.label));
    document.getElementById('proy-tcn-cb-lecaps').checked = false;
    proyRenderChart('tcn');
    // Recalcular el breakeven a mano, sin pasar por proyLecapPuntos
    const aMano = pts.map(p => {
      const b = LECAPS.find(x => x.ticker === p.ticker);
      const c = calcLecap(b);
      return { t: p.ticker, esperado: spot * c.vf / b.precio, obtenido: p.y,
               enFecha: parseDate(b.vcto).getTime() === p.x };
    });
    return {
      puntos: pts.length, spot,
      conPrecio: LECAPS.some(b => b.precio != null && b.vcto >= desde && b.vcto <= hasta),
      cierraLaCuenta: aMano.every(r => Math.abs(r.esperado - r.obtenido) < 0.01),
      enFechaDeVto: aMano.every(r => r.enFecha),
      // el BE tiene que estar por encima del spot: la tasa fija es positiva
      porEncimaDelSpot: pts.every(p => p.y > spot),
      creceConElPlazo: pts.every((p, i) => i === 0 || p.y >= pts[i - 1].y - 1e-9),
      conContexto: pts.every(p => p.dev != null && p.proy != null && p.vs != null),
      dataset: !!ds, tipo: ds ? ds.type : null, eje: ds ? ds.yAxisID : null,
      muestra: aMano.slice(0, 2),
    };
  });
  if (!lecaps.conPrecio) {
    // Sin precios no hay puntos que dibujar: la función filtra los bonos sin
    // precio a propósito. Verificar acá sólo diría que el mercado está cerrado.
    omitir('dólar breakeven de las LECAPs', 'ninguna LECAP tiene precio ahora');
  } else {
    check(lecaps.puntos > 0 && lecaps.dataset && lecaps.tipo === 'scatter',
          'el dólar breakeven de las LECAPs entra al gráfico', JSON.stringify(lecaps));
    check(lecaps.cierraLaCuenta,
          'el breakeven es el spot por VF sobre precio', JSON.stringify(lecaps.muestra));
    check(lecaps.enFechaDeVto, 'cada LECAP va en su fecha de vencimiento');
    check(lecaps.eje === 'y',
          'el breakeven va en el eje de pesos, junto al sendero y las bandas', lecaps.eje);
    check(lecaps.porEncimaDelSpot && lecaps.creceConElPlazo,
          'el breakeven supera al spot y crece con el plazo', JSON.stringify(lecaps));
    check(lecaps.conContexto,
          'cada punto trae la devaluación implícita y el sendero para comparar');
  }

  // La opción de barras de devaluación se sacó: no aportaba nada.
  const sinBarras = await page.evaluate(() => ({
    checkbox: !!document.getElementById('proy-tcn-cb-dev'),
    eje: !!(projTcnChart && projTcnChart.options.scales.yPct),
  }));
  check(!sinBarras.checkbox && !sinBarras.eje,
        'ya no está la opción de barras de devaluación', JSON.stringify(sinBarras));

  // El histórico de inflación llega hasta donde llega el CER del BCRA.
  const hist = await page.evaluate(() => {
    const ini = projHistStart();
    const primeroCer = CER_INDEX.length ? CER_INDEX[0].fecha : null;
    return {
      ini, primeroCer, cer: CER_INDEX.length,
      primerMes: PROJ_INFLACION.length ? PROJ_INFLACION[0].mes : null,
      meses: PROJ_INFLACION.length,
      publicados: PROJ_INFLACION.filter(r => r.tipo === 'publicado').length,
      // el mes de arranque tiene que ser derivable y el anterior no
      derivable: projInflaRealDeMes(ini),
      anteriorNoDerivable: projInflaRealDeMes(proyMesAdd(ini, -1)) == null,
    };
  });
  check(hist.cer > 0 && hist.ini < '2005-01',
        'el histórico de inflación arranca donde arranca el CER del BCRA',
        JSON.stringify({ ini: hist.ini, primeroCer: hist.primeroCer }));
  check(hist.primerMes === hist.ini,
        'el sendero se rellena desde ese mes', JSON.stringify(hist));
  check(hist.derivable != null && hist.anteriorNoDerivable,
        'el mes de arranque es el primero que el CER permite derivar', JSON.stringify(hist));
  check(hist.publicados > 200,
        'quedan cientos de meses publicados, no sólo los de 2025',
        String(hist.publicados));

  // Las ruedas pegadas al vencimiento no entran al histórico: anualizar un
  // plazo que tiende a cero convierte medio punto de precio en decenas de
  // puntos de tasa, y eso ensuciaba el eje de todas las curvas.
  const cortevto = await page.evaluate(() => {
    const liq = G_LIQ || addHabiles(TODAY, 1);
    const mas = fmtDate(addHabiles(liq, 30));
    // En días CORRIDOS, que es como mide curvasMuyCerca. Con addHabiles esto
    // fallaba solo los jueves y viernes: dos hábiles cruzando el fin de semana
    // son cuatro corridos, o sea justo el corte. Nada que ver con el bono.
    const enTres = fmtDate(new Date(liq.getTime() + 2 * 86400000));
    return {
      existe: typeof curvasMuyCerca === 'function' && typeof CURVAS_DIAS_MIN === 'number',
      cortevto: typeof CURVAS_DIAS_MIN === 'number' ? CURVAS_DIAS_MIN : null,
      cercaEsCerca: curvasMuyCerca(enTres, liq),
      lejosNoEsCerca: !curvasMuyCerca(mas, liq),
      sinVtoNoRompe: curvasMuyCerca(null, liq) === false,
      dias: curvasDiasHasta(mas, liq),
    };
  });
  check(cortevto.existe, 'existe la regla de corte por vencimiento');
  check(cortevto.cortevto === 4, 'el corte deja afuera los últimos 3 días', String(cortevto.cortevto));
  check(cortevto.cercaEsCerca && cortevto.lejosNoEsCerca,
        'la regla distingue un bono por vencer de uno lejano', JSON.stringify(cortevto));
  check(cortevto.sinVtoNoRompe, 'un bono sin vencimiento cargado no se descarta por esto');

  // ── Gráficos interactivos ─────────────────────────────────────────────────
  console.log('\nGráficos: zoom y desplazamiento');

  const zoomPlugin = await page.evaluate(() => ({
    zoom: !!(Chart.registry && Chart.registry.plugins.get('zoom')),
    chip: !!(Chart.registry && Chart.registry.plugins.get('zoomChipReset')),
  }));
  check(zoomPlugin.zoom, 'el plugin de zoom se carga desde el CDN');
  check(zoomPlugin.chip, 'está registrado el chip de restablecer');

  // Arrastra dentro del área de dibujo de un gráfico.
  const arrastrar = async (canvasId) => {
    const caja = await page.evaluate(id => {
      const ch = Chart.getChart(document.getElementById(id));
      if (!ch || !ch.chartArea) return null;
      const r = ch.canvas.getBoundingClientRect();
      const a = ch.chartArea;
      const esc = ch.canvas.width / (r.width * (window.devicePixelRatio || 1));
      return { rx: r.x, ry: r.y, l: a.left / esc, r2: a.right / esc,
               t: a.top / esc, b: a.bottom / esc };
    }, canvasId);
    if (!caja) return false;
    const x1 = caja.rx + caja.l + (caja.r2 - caja.l) * 0.30;
    const x2 = caja.rx + caja.l + (caja.r2 - caja.l) * 0.65;
    const y1 = caja.ry + caja.t + (caja.b - caja.t) * 0.25;
    const y2 = caja.ry + caja.t + (caja.b - caja.t) * 0.75;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 6 });
    await page.mouse.move(x2, y2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    return true;
  };
  const ejes = id => page.evaluate(i => {
    const ch = Chart.getChart(document.getElementById(i));
    if (!ch) return null;
    return { x: ch.scales.x ? ch.scales.x.max - ch.scales.x.min : null,
             y: ch.scales.y ? ch.scales.y.max - ch.scales.y.min : null,
             zoom: typeof ch.isZoomedOrPanned === 'function' ? ch.isZoomedOrPanned() : null,
             chip: !!ch.$chipZoom };
  }, id);

  // Un gráfico de cada solapa que el usuario pidió: proyecciones, resumen,
  // curvas y series.
  const paneles = [
    ['proyecciones', () => { switchSection('pesos'); switchTab('proyecciones'); proySubtabGo('tcn'); }, 'proy-tcn-chart'],
    ['resumen', () => { switchSection('pesos'); switchTab('breakeven'); }, 'be-chart-tf'],
    ['curvas', () => { switchSection('pesos'); switchTab('curvas-ars'); }, 'curvas-ars-chart'],
    ['series', () => { switchSection('pesos'); switchTab('series-ars'); }, 'series-ars-chart'],
  ];
  for (const [nombre, ir, id] of paneles) {
    await page.evaluate(ir);
    let hay = true;
    try {
      await page.waitForFunction(
        i => { const c = Chart.getChart(document.getElementById(i)); return !!(c && c.chartArea); },
        id, { timeout: 25000 });
    } catch (e) { hay = false; }
    if (!hay) { omitir(`zoom en ${nombre}`, 'el gráfico no tiene datos ahora'); continue; }
    await page.waitForTimeout(400);

    const cfg = await page.evaluate(i => {
      const z = Chart.getChart(document.getElementById(i)).options.plugins.zoom;
      return { drag: !!(z && z.zoom.drag.enabled), rueda: !!(z && z.zoom.wheel.enabled),
               mod: z && z.zoom.wheel.modifierKey, pan: !!(z && z.pan.enabled) };
    }, id);
    check(cfg.drag && cfg.rueda && cfg.pan, `${nombre}: el gráfico acepta zoom y desplazamiento`,
          JSON.stringify(cfg));
    // La rueda pide Ctrl a propósito: si no, la página no se podría scrollear
    // con el puntero encima de un gráfico.
    check(cfg.mod === 'ctrl', `${nombre}: la rueda pide Ctrl`, String(cfg.mod));

    const antesZ = await ejes(id);
    await arrastrar(id);
    const despues = await ejes(id);
    const achico = antesZ && despues &&
      ((antesZ.x != null && despues.x != null && despues.x < antesZ.x - 1e-9) ||
       (antesZ.y != null && despues.y != null && despues.y < antesZ.y - 1e-9));
    check(achico && despues.zoom === true, `${nombre}: arrastrar recorta el rango`,
          JSON.stringify({ antes: antesZ, despues }));
    check(despues.chip === true, `${nombre}: aparece el chip de restablecer`);

    await page.dblclick(`#${id}`, { position: { x: 180, y: 80 } }).catch(() => {});
    await page.waitForTimeout(350);
    const reset = await ejes(id);
    check(reset && reset.zoom === false, `${nombre}: el doble clic restablece`,
          JSON.stringify(reset));
  }

  // El zoom sobrevive a un redibujo con los mismos datos y se suelta cuando la
  // forma cambia. Sin lo primero, el refresco de precios del Resumen lo borraba
  // cada cinco minutos.
  await page.evaluate(() => { switchSection('pesos'); switchTab('proyecciones'); proySubtabGo('tamar'); });
  await page.waitForTimeout(1200);
  await arrastrar('proy-tamar-chart');
  const persiste = await page.evaluate(async () => {
    const leer = () => { const c = Chart.getChart(document.getElementById('proy-tamar-chart'));
                         return [+c.scales.x.min.toFixed(4), +c.scales.x.max.toFixed(4)]; };
    const antes = leer();
    proyRenderChart('tamar');
    await new Promise(r => setTimeout(r, 400));
    const igual = leer();
    document.getElementById('proy-tamar-cb-real').checked = true;
    proyRenderChart('tamar');
    await new Promise(r => setTimeout(r, 400));
    const distinto = leer();
    document.getElementById('proy-tamar-cb-real').checked = false;
    proyRenderChart('tamar');
    return { antes, igual, distinto,
             sobrevive: igual[0] === antes[0] && igual[1] === antes[1],
             seSuelta: !(distinto[0] === antes[0] && distinto[1] === antes[1]) };
  });
  check(persiste.sobrevive, 'el zoom sobrevive a un redibujo con los mismos datos',
        JSON.stringify(persiste));
  check(persiste.seSuelta, 'el zoom se suelta cuando cambia la forma de los datos',
        JSON.stringify(persiste));

  const ayudaZoom = await page.evaluate(() =>
    (document.getElementById('proy-tamar-chart') || {}).title || '');
  check(/arrastr/i.test(ayudaZoom) && /ctrl/i.test(ayudaZoom),
        'el canvas explica los gestos al pasar el mouse', ayudaZoom.slice(0, 50));

  console.log('\nResto de pestañas (no deben lanzar)');
  const antes = errores.length;
  await page.evaluate(() => switchSection('usd'));
  for (const t of ['usd-resumen', 'usd-forwards', 'usd-equiv', 'usd-curvas']) {
    await page.evaluate(x => switchUsdTab(x), t);
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => switchSection('pesos'));
  for (const t of ['breakeven', 'forwards', 'sintetico', 'calendario', 'proyecciones', 'curvas-ars']) {
    await page.evaluate(x => switchTab(x), t);
    await page.waitForTimeout(700);
  }
  check(errores.length === antes, 'ninguna pestaña lanzó errores',
        errores.slice(antes).slice(0, 3).join(' | '));

  // Los ajustes manuales tienen que sobrevivir a una recarga. Va último porque
  // recarga la página de verdad y resetea el estado de todo lo anterior.
  //
  // Dos cosas los perdían. Los senderos manuales eran claves compartidas, y
  // escribir en shared_data exige ser admin: para cualquier otra persona el
  // ajuste quedaba sólo en localStorage y la hidratación siguiente lo pisaba
  // con la copia compartida. Y aun cuando sobrevivía, nadie recalculaba después
  // de la hidratación: el valor estaba guardado y no se veía.
  console.log('\nBarra USD: la brecha contra el oficial');
  const br = await page.evaluate(() => {
    const leer = id => (document.getElementById(id) || {}).textContent || '';
    const num = t => parseFloat(String(t).replace('%', ''));
    const of = dlkTCHoy();
    const mepBid = parseFloat(leer('usd-mep-bid'));
    const antes = leer('usd-brecha-bid');
    // Editar el oficial a mano tiene que recalcularla: es el único camino que no
    // pasa por a3500Pintar, y sería el que dejara el valor viejo en pantalla.
    dlkOnA3500Change('1000');
    const conManual = leer('usd-brecha-bid');
    dlkResetA3500();
    return { of, mepBid, antes, conManual, vuelta: leer('usd-brecha-bid'),
      esperado: of > 0 && mepBid > 0 ? (mepBid / of - 1) * 100 : null,
      esperadoManual: mepBid > 0 ? (mepBid / 1000 - 1) * 100 : null,
      antesNum: num(antes), manualNum: num(conManual) };
  });
  if (!(br.esperado != null && br.mepBid > 0)) {
    omitir('la brecha se pinta en la barra', 'sin MEP en vivo');
  } else {
    check(Math.abs(br.antesNum - br.esperado) < 0.01,
          'la brecha es MEP / A3500 − 1', `${br.antes} vs ${br.esperado.toFixed(2)}%`);
    check(Math.abs(br.manualNum - br.esperadoManual) < 0.01,
          'editar el oficial a mano la recalcula', `${br.conManual} vs ${br.esperadoManual.toFixed(2)}%`);
    check(br.vuelta === br.antes, 'el ↺ la devuelve al automático',
          `${br.vuelta} vs ${br.antes}`);
  }

  console.log('\nFicha de mercado');
  // Las convenciones de tasa no dependen de la red ni del mercado: si esto se
  // rompe, el breakeven de la ficha miente y no falla nada.
  const tasas = await page.evaluate(() => ({
    cer:  fichaTirEfectiva('CER', 12.34, 400),
    glo:  fichaTirEfectiva('GLO', 11.2, null),
    tf:   [fichaTirEfectiva('TF', 30, 180), calcTIR(30, 180)],
    tamar: fichaTirEfectiva('TAMAR', 5, 400),
    // Ida y vuelta por la funcion de la app. dlkCalcTNA usa base semestral
    // arriba de 180 dias, asi que calcTIR NO es su inversa: estas dos
    // aserciones son las que atrapan a quien 'simplifique' fichaTirEfectiva.
    dlkLargo: fichaTirEfectiva('DLK', dlkCalcTNA(22.3, 1200), 1200),
    dlkCorto: fichaTirEfectiva('DLK', dlkCalcTNA(7.5, 90), 90),
    atajo:    calcTIR(dlkCalcTNA(22.3, 1200), 1200),
  }));
  check(tasas.cer === 12.34 && tasas.glo === 11.2, 'CER y los dolares pasan derecho');
  check(tasas.tf[0] === tasas.tf[1], 'tasa fija se invierte con calcTIR');
  check(tasas.tamar === null, 'el margen TAMAR no devuelve una TIR');
  check(Math.abs(tasas.dlkLargo - 22.3) < 1e-9,
        'DLK largo cierra ida y vuelta', String(tasas.dlkLargo));
  check(Math.abs(tasas.dlkCorto - 7.5) < 1e-9,
        'DLK corto cierra ida y vuelta', String(tasas.dlkCorto));
  check(Math.abs(tasas.atajo - 22.3) > 3,
        'el atajo con calcTIR erraria por cientos de bps',
        `calcTIR daba ${tasas.atajo.toFixed(2)}% donde van 22,30%`);

  const aj = await page.evaluate(() => {
    const pts = [5, 30, 90, 200, 400, 700].map(x => ({ x, y: 3 + 2 * Math.log(x) }));
    const a = fichaAjuste(pts);
    const ruido = fichaAjuste([{x:10,y:5},{x:20,y:40},{x:30,y:2},{x:40,y:38}]);
    return { a: a.reg.a, b: a.reg.b, r2: a.r2, xMin: a.xMin, xMax: a.xMax,
      nivel: fichaNivel(a, 100), esperado: 3 + 2 * Math.log(100),
      r2Ruido: ruido.r2, unPunto: fichaAjuste([{x:1,y:1}]) };
  });
  check(Math.abs(aj.a - 3) < 1e-9 && Math.abs(aj.b - 2) < 1e-9 && Math.abs(aj.r2 - 1) < 1e-9,
        'el ajuste recupera a, b y R2 con datos perfectos');
  check(Math.abs(aj.nivel - aj.esperado) < 1e-9, 'fichaNivel evalua el ajuste');
  check(aj.r2Ruido < 0.5 && aj.unPunto === null,
        'R2 bajo con ruido, y con un punto no hay ajuste', String(aj.r2Ruido));

  const dual = await page.evaluate(() => {
    const g = fichaAgruparMontos([
      { snapshot_date: '2026-09-15', ticker: 'TXMJ0', sector: 'CER',   monto: 100 },
      { snapshot_date: '2026-09-15', ticker: 'TXMJ0', sector: 'TAMAR', monto: 100 },
      { snapshot_date: '2026-09-15', ticker: 'TX26',  sector: 'CER',   monto: 50 },
    ], false, false);
    return { total: g.total,
      cer: g.porSectorFecha.get('CER').get('2026-09-15'),
      tamar: g.porSectorFecha.get('TAMAR').get('2026-09-15') };
  });
  check(dual.total === 150 && dual.cer === 150 && dual.tamar === 100,
        'los duales cuentan una vez en el total y entero por sector',
        JSON.stringify(dual));

  const ruedas = await page.evaluate(async () => {
    const out = {};
    for (const p of ['dia', 'mes', 'anio']) {
      const r = await fichaRuedas(p, { soloArchivado: true });
      out[p] = r ? { ini: r.ini, fin: r.fin, dias: r.dias,
        hIni: esHabil(parseDate(r.ini)), hFin: esHabil(parseDate(r.fin)) } : null;
    }
    return out;
  });
  if (!ruedas.dia) omitir('las dos ruedas del dia', 'sin historia archivada');
  else check(ruedas.dia.ini < ruedas.dia.fin && ruedas.dia.hIni && ruedas.dia.hFin,
             'el dia toma dos ruedas habiles y distintas',
             `${ruedas.dia.ini} -> ${ruedas.dia.fin}`);
  if (!ruedas.anio) omitir('el ano retrocede', 'sin un ano de historia');
  else check(ruedas.anio.dias > 300, 'el ano retrocede de verdad',
             `${ruedas.anio.dias} dias`);
  if (ruedas.dia && ruedas.mes)
    check(ruedas.mes.dias > ruedas.dia.dias, 'el mes es mas largo que el dia',
          `${ruedas.mes.dias} vs ${ruedas.dia.dias}`);

  const fd = await page.evaluate(async () => {
    const f = await fichaConstruir('dia', { soloArchivado: true });
    if (!f) return null;
    return {
      n: f.bloques.length,
      pares: f.bloques.map(b => ({ s: b.sector, tenor: b.tenor,
        nIni: b._aj.ini ? b._aj.ini.n : null, nFin: b._aj.fin ? b._aj.fin.n : null,
        xMin: b._aj.fin ? b._aj.fin.xMin : null, xMax: b._aj.fin ? b._aj.fin.xMax : null })),
      fx: Object.keys(f.fx || {}).length,
      texto: fichaTexto(f),
    };
  });
  if (!fd) omitir('la ficha del dia', 'sin historia archivada');
  else {
    check(fd.n > 3, 'la ficha cubre la curva', `${fd.n} sectores`);
    check(fd.pares.every(x => x.nIni === x.nFin),
          'los dos ajustes van sobre los mismos bonos',
          fd.pares.map(x => `${x.s} ${x.nIni}/${x.nFin}`).join(' '));
    check(fd.pares.every(x => x.tenor == null || (x.tenor >= x.xMin && x.tenor <= x.xMax)),
          'el tenor nunca extrapola el ajuste');
    // En el año los bonos envejecen entre una rueda y otra, y ahí es donde la
    // mediana se salía del tramo común: los Bopreales daban un nivel de 62%.
    const anio = await page.evaluate(async () => {
      const f = await fichaConstruir('anio', { soloArchivado: true, sinFX: true, sinExternos: true });
      if (!f) return null;
      return f.bloques.map(b => ({ s: b.sector, n: b.n, sin: b.sinComparacion,
        tenor: b.tenor, rango: b.rangoComun, nivel: b.nivelFin, tramos: b.tramos.length }));
    });
    if (!anio) omitir('el año lee el nivel dentro del tramo común', 'sin un año de historia');
    else {
      const conNivel = anio.filter(x => x.nivel != null);
      check(conNivel.every(x => x.rango && x.tenor >= x.rango[0] - 1e-9 && x.tenor <= x.rango[1] + 1e-9),
            'en el año el nivel se lee dentro del tramo que comparten las dos ruedas',
            JSON.stringify(conNivel.map(x => [x.s, x.tenor, x.rango])));
      check(anio.every(x => x.n >= 3 || (x.nivel == null && x.tramos === 0)),
            'con menos de tres bonos comunes no hay nivel ni tramos',
            JSON.stringify(anio.map(x => [x.s, x.n, x.nivel, x.tramos])));
    }
    // El movimiento se mide desde el cierre de la rueda inicial: lo que se operó
    // ese día no es del período. Con la rueda adentro, el volumen "del día"
    // sumaba dos ruedas, y así llegó a publicarse.
    const volDia = await page.evaluate(async () => {
      const f = await fichaConstruir('dia', { soloArchivado: true, sinFX: true, sinExternos: true });
      return f ? { ruedas: f.volumen.ruedas, habiles: f.habiles } : null;
    });
    if (!volDia) omitir('el volumen del día es de una rueda', 'sin historia');
    else check(volDia.ruedas <= 1 && volDia.habiles === 1,
               'el volumen del día es el de una sola rueda', JSON.stringify(volDia));
    if (fd.fx < 3) omitir('la ficha trae el movimiento del dolar', 'sin precios en vivo');
    else check(fd.fx >= 3, 'la ficha trae el movimiento del dolar', String(fd.fx));
    check(!/undefined|NaN/.test(fd.texto) && fd.texto.length > 400,
          'fichaTexto sale limpio', `${fd.texto.length} chars`);
  }

  const pag = await page.evaluate(async () => {
    if (!await curvasSoportaLibro()) return { omitir: 'la tabla no tiene monto' };
    const r = await fichaRuedas('anio', { soloArchivado: true });
    if (!r) return { omitir: 'sin un ano de historia' };
    const m = await fichaFetchMontos(r.ini, r.fin);
    return { ruedas: m.fechas.length, total: m.total };
  });
  if (pag.omitir) omitir('la paginacion del volumen', pag.omitir);
  else check(pag.ruedas > 0 && pag.ruedas !== 1000,
             'el volumen del ano no se corta en el tope de PostgREST',
             `${pag.ruedas} ruedas con dato`);

  console.log('\nComentario: el panel');
  const com404 = await page.evaluate(async () => {
    try { await comFetch(true); return { ok: true }; }
    catch (e) { return { ok: false, err: e.message }; }
  });
  check(com404.ok, 'comFetch tolera que comentario.json no exista', com404.err || '');

  await page.evaluate(() => { switchSection('pesos'); switchTab('comentario'); });
  await page.waitForFunction(() => {
    const el = document.getElementById('com-ars-cuerpo');
    return el && !/Midiendo/.test(el.textContent);
  }, null, { timeout: 90000 }).catch(() => {});
  const pars = await page.evaluate(() => {
    const c = document.getElementById('com-ars-cuerpo');
    return { disp: document.getElementById('page-comentario').style.display,
      len: c ? c.innerHTML.length : 0,
      tiles: document.querySelectorAll('#com-ars-cuerpo [style*="minmax(285px"] > div').length,
      medido: c ? /Medido/.test(c.textContent) : false,
      pie: c ? /No es recomendación de inversión/.test(c.textContent) : false,
      rango: (document.getElementById('com-ars-rango') || {}).textContent || '' };
  });
  check(pars.disp === 'block' && pars.len > 1000, 'la entrada de pesos abre el panel',
        `${pars.len} chars`);
  check(pars.tiles >= 4, 'hay un tile por sector', `${pars.tiles}`);
  check(pars.medido && pars.pie, 'estan el bloque medido y el pie de responsabilidad');

  const antesRango = pars.rango;
  await page.evaluate(() => comSetPeriodo('ars', 'mes'));
  await page.waitForFunction(prev => {
    const r = document.getElementById('com-ars-rango');
    return r && r.textContent && r.textContent !== prev;
  }, antesRango, { timeout: 90000 }).catch(() => {});
  const trasPer = await page.evaluate(() => ({
    per: comEstado.ars.periodo,
    rango: (document.getElementById('com-ars-rango') || {}).textContent || '',
  }));
  check(trasPer.per === 'mes' && trasPer.rango !== antesRango,
        'el selector de periodo recarga la ficha', `${trasPer.rango.slice(0, 40)}`);

  await page.evaluate(() => { switchSection('usd'); switchUsdTab('usd-comentario'); });
  await page.waitForFunction(() => {
    const el = document.getElementById('com-usd-cuerpo');
    return el && !/Midiendo/.test(el.textContent);
  }, null, { timeout: 90000 }).catch(() => {});
  const usdp = await page.evaluate(() => {
    const c = document.getElementById('com-usd-cuerpo');
    return { disp: document.getElementById('page-usd-comentario').style.display,
      len: c ? c.innerHTML.length : 0,
      primero: (c && c.querySelector('[style*="minmax(285px"] > div span') || {}).textContent || '' };
  });
  check(usdp.disp === 'block' && usdp.len > 1000, 'la entrada de dolares abre el mismo panel',
        `${usdp.len} chars`);
  check(['Bopreales', 'Bonares', 'Globales'].includes(usdp.primero),
        'en la entrada de dolares los sectores USD van primero', usdp.primero);

  const copia = await page.evaluate(async () => {
    const f = await fichaCacheada('dia', false);
    if (!f) return null;
    const ficha = comTextoCompleto(f, COM_DATA, false);
    const prompt = comTextoCompleto(f, COM_DATA, true);
    return { medido: ficha.includes('MEDIDO'),
      pie: ficha.includes('No es recomendación de inversión'),
      preambulo: prompt.startsWith('Sos un operador'),
      sucio: /undefined|NaN/.test(ficha), largo: ficha.length };
  });
  if (!copia) omitir('el texto que se copia', 'sin ficha');
  else check(copia.medido && copia.pie && copia.preambulo && !copia.sucio && copia.largo > 1000,
             'el texto copiado lleva encabezados, pie y preambulo', JSON.stringify(copia));
  await page.evaluate(() => switchSection('pesos'));

  console.log('\nComentario: Treasuries, riesgo país, gráficos y Twitter');
  // Lo que no depende de la red: el parseo del Tesoro, la interpolación, la base
  // de tasa, la duration, el conteo de Twitter y el criterio de gráfico.
  const ext = await page.evaluate(() => {
    const csv = 'Date,"1 Mo","1.5 Month","2 Yr","5 Yr","10 Yr"\n09/15/2026,3.93,4.00,4.67,4.83,5.00\n09/14/2026,3.94,4.00,4.65,4.80,4.97';
    const m = ustParsearCSV(csv);
    const pts = m.get('2026-09-15');
    const plana = [{ plazo: 1 / 12, y: 5 }, { plazo: 30, y: 5 }];
    return {
      fechas: [...m.keys()].sort(),
      plazos: pts.map(p => +p.plazo.toFixed(4)),
      en2: ustEnPlazo(pts, 2), en7: ustEnPlazo(pts, 7.5), en40: ustEnPlazo(pts, 40),
      efe: ustEfectiva(5),
      // Un bono par a 5 años al 5% tiene esta duration; de vuelta tiene que dar 5.
      plazo5: ustPlazoPorMD(plana, (1 - Math.pow(1.025, -10)) / 0.05),
      rp: rpEn(new Map([['2026-09-11', 494], ['2026-09-14', 490], ['2026-09-15', 506]]), '2026-09-13'),
      tw: { ascii: twLargo('a'.repeat(280)), flecha: twLargo('→'),
            url: twLargo('ver https://example.com/una/ruta/muy/larga'), acento: twLargo('inflación') },
      graf: {
        dia15: fichaGraficoMotivo({ dNivelBps: 15, puntos: [1, 2, 3] }, 'dia'),
        dia5: fichaGraficoMotivo({ dNivelBps: 5, puntos: [1, 2, 3], r2ok: true, forma: 'sin cambio de forma' }, 'dia'),
        mes20: fichaGraficoMotivo({ dNivelBps: 20, puntos: [1, 2, 3], r2ok: false }, 'mes'),
        forma: fichaGraficoMotivo({ dNivelBps: 2, puntos: [1, 2, 3], r2ok: true, forma: 'empinó' }, 'dia'),
        sinR2: fichaGraficoMotivo({ dNivelBps: 2, puntos: [1, 2, 3], r2ok: false, forma: null }, 'dia'),
      },
    };
  });
  check(ext.fechas.join(',') === '2026-09-14,2026-09-15', 'el CSV del Tesoro se lee con sus fechas', ext.fechas.join(','));
  check(JSON.stringify(ext.plazos) === JSON.stringify([0.0833, 0.125, 2, 5, 10]),
        'los plazos salen de la cabecera, incluido el de 1,5 meses', JSON.stringify(ext.plazos));
  check(ext.en2 === 4.67 && Math.abs(ext.en7 - 4.915) < 1e-9 && ext.en40 === 5,
        'el Treasury se interpola por plazo y no extrapola', `${ext.en2} · ${ext.en7} · ${ext.en40}`);
  check(Math.abs(ext.efe - 5.0625) < 1e-9, 'la tasa par semestral se pasa a efectiva anual', String(ext.efe));
  check(Math.abs(ext.plazo5 - 5) < 1e-6, 'la duration de un par a 5 años devuelve 5 años', String(ext.plazo5));
  check(ext.rp && ext.rp.fecha === '2026-09-11' && ext.rp.valor === 494,
        'el riesgo país toma el último dato en o antes de la fecha', JSON.stringify(ext.rp));
  check(ext.tw.ascii === 280 && ext.tw.flecha === 2 && ext.tw.url === 27 && ext.tw.acento === 9,
        'los caracteres se cuentan como los cuenta Twitter', JSON.stringify(ext.tw));
  check(!!ext.graf.dia15 && !ext.graf.dia5 && !ext.graf.mes20 && !!ext.graf.forma && !ext.graf.sinR2,
        'el gráfico entra por nivel o por forma, con umbral por período', JSON.stringify(ext.graf));

  // Contra el Tesoro y ArgentinaDatos de verdad, sobre una rueda ya cerrada: la
  // última archivada puede ser una foto de media rueda sin Treasuries publicados.
  const dec = await page.evaluate(async () => {
    const r = await fichaRuedas('dia', { soloArchivado: true });
    if (!r) return { omitir: 'sin historia archivada' };
    const f = await fichaConstruir('dia', { soloArchivado: true, hasta: r.ini, sinFX: true });
    if (!f) return { omitir: 'sin ficha para la rueda anterior' };
    if (!f.ust) return { omitir: 'el Tesoro no respondió' };
    const usd = f.bloques.filter(b => b.ejeX === 'md' && b.ust);
    return {
      desfasado: f.ust.desfasado,
      suma: usd.map(b => ({ s: b.sector,
        ok: Math.round(b.dNivelBps) === b.ust.dBps + b.ust.dSpreadBps
            && b.ust.spreadFin - b.ust.spreadIni === b.ust.dSpreadBps })),
      plazos: usd.map(b => ({ s: b.sector, md: +b.tenor.toFixed(2), t: +b.ust.plazo.toFixed(2) })),
      rp: !!f.riesgoPais, texto: fichaTexto(f),
    };
  });
  if (dec.omitir) omitir('la descomposición contra Treasuries', dec.omitir);
  else {
    check(!dec.desfasado, 'una rueda cerrada tiene los Treasuries publicados');
    check(dec.suma.length > 0 && dec.suma.every(x => x.ok),
          'Treasuries más spread suman exactamente el movimiento del nivel', JSON.stringify(dec.suma));
    check(dec.plazos.every(x => x.t > x.md), 'el plazo equivalente es mayor que la duration', JSON.stringify(dec.plazos));
    check(/TREASURIES/.test(dec.texto) && /descomposición: de los/.test(dec.texto),
          'la ficha trae los Treasuries y la descomposición');
    if (dec.rp) check(/RIESGO PAÍS/.test(dec.texto), 'la ficha trae el riesgo país');
    else omitir('el riesgo país en la ficha', 'ArgentinaDatos no respondió');
  }

  // Con el cierre del Tesoro sin publicar, el Treasury no "se movió cero": no hay
  // dato. Ni la variación ni la descomposición pueden aparecer.
  const desf = await page.evaluate(async () => {
    const u = await ustCurvaEn(hoyAR());
    if (!u) return { omitir: 'el Tesoro no respondió' };
    const mas = n => { const d = parseDate(u.fecha); d.setDate(d.getDate() + n); return fmtDate(d); };
    const b = { ejeX: 'md', tenor: 4, dNivelBps: 12, nivelIni: 9, nivelFin: 9.12 };
    const out = await fichaDolares([b], mas(1), mas(2));
    return { desfasado: !!(out.ust && out.ust.desfasado), sinDescomposicion: !b.ust,
             refsNulas: !!(out.ust && out.ust.refs.every(r => r.dBps === null)),
             rpNulo: !out.riesgoPais || out.riesgoPais.dBps === null };
  });
  if (desf.omitir) omitir('los Treasuries desfasados', desf.omitir);
  else check(desf.desfasado && desf.sinDescomposicion && desf.refsNulas && desf.rpNulo,
             'sin cierre publicado no hay variación ni descomposición, en vez de un cero', JSON.stringify(desf));

  // El panel con la forma nueva, con un comentario armado a mano sobre la ficha real.
  const pan = await page.evaluate(async () => {
    const f = await fichaCacheada('dia', false);
    if (!f) return { omitir: 'sin ficha' };
    const guardado = COM_DATA;
    const graf = f.bloques.filter(b => b.grafico && b.puntos).map(b => b.sector);
    const p = { ini: f.ini, fin: f.fin, titular: 'Titular de prueba',
      pesos: { resumen: 'Resumen de pesos.', TF: 'Parrafo TF.', CER: 'Parrafo CER.', TAMAR: 'Parrafo TAMAR.', DLK: 'Parrafo DLK.' },
      dolares: { resumen: 'Parrafo de dolares.' }, contexto: 'Contexto.',
      twitter: [{ texto: '1/3 uno', graficos: graf.slice(0, 1) }, { texto: '2/3 dos' }, { texto: '3/3 tres' }],
      ficha: f };
    COM_DATA = { generado: new Date().toISOString(), ruedaFin: f.fin, fuentes: [], periodos: { dia: p } };
    comEstado.ars.periodo = 'dia'; comEstado.usd.periodo = 'dia';
    comRender('ars', f, COM_DATA);
    const c = document.getElementById('com-ars-cuerpo');
    const ta = c.textContent;
    const out = {
      pesosPrimero: ta.indexOf('Pesos') >= 0 && ta.indexOf('Pesos') < ta.indexOf('Dólares'),
      curvas: ['Parrafo TF.', 'Parrafo CER.', 'Parrafo TAMAR.', 'Parrafo DLK.'].every(t => ta.includes(t)),
      canvasLectura: c.querySelectorAll('canvas[data-graf-origen="lectura"]').length,
      canvasMedido: c.querySelectorAll('canvas[data-graf-origen="medido"]').length,
      charts: _comGraficos.ars.length, graf,
      twitter: ta.includes('1/3 uno') && /\/280/.test(ta),
      hilo: comHiloTexto(p),
    };
    const cu = document.getElementById('com-usd-cuerpo');
    if (cu) { comRender('usd', f, COM_DATA); const tu = cu.textContent; out.dolaresPrimero = tu.indexOf('Dólares') >= 0 && tu.indexOf('Dólares') < tu.indexOf('Pesos'); }
    const b = f.bloques.find(x => x.puntos && x.puntos.length >= 3);
    const png = b ? comGraficoPNG(b, f) : null;
    out.png = png ? { tipo: png.slice(0, 22), largo: png.length } : null;
    // Sin comentario, los gráficos van con lo medido.
    COM_DATA = null;
    comRender('ars', f, null);
    out.sinComentarioMedido = c.querySelectorAll('canvas[data-graf-origen="medido"]').length;
    // Un comentario de la forma vieja sigue mostrándose.
    COM_DATA = { generado: 'x', ruedaFin: f.fin, periodos: { dia: { ini: f.ini, fin: f.fin, titular: 'Viejo', movimiento: 'Texto viejo.', contexto: 'c' } } };
    comRender('ars', f, COM_DATA);
    out.viejo = c.textContent.includes('Texto viejo.');
    COM_DATA = guardado;
    comRender('ars', f, COM_DATA);
    return out;
  });
  if (pan.omitir) omitir('el panel con la forma nueva', pan.omitir);
  else {
    check(pan.pesosPrimero && pan.dolaresPrimero !== false, 'pesos y dólares van por separado, cada entrada con lo suyo primero',
          `ars pesos primero: ${pan.pesosPrimero} · usd dólares primero: ${pan.dolaresPrimero}`);
    check(pan.curvas, 'un párrafo por cada curva de pesos');
    check(pan.canvasLectura === pan.graf.length && pan.charts === pan.graf.length && pan.canvasMedido === 0,
          'un gráfico por curva que se movió, al lado de su párrafo y sin repetirse abajo',
          `${pan.canvasLectura} en lectura · ${pan.canvasMedido} en medido · ${pan.charts} dibujados · marcados ${pan.graf.join(',')}`);
    check(pan.sinComentarioMedido === pan.graf.length, 'sin comentario, los gráficos van con lo medido', String(pan.sinComentarioMedido));
    check(pan.twitter, 'el hilo se muestra con su conteo de caracteres');
    check(pan.hilo.includes('1/3 uno') && pan.hilo.includes('3/3 tres'), 'el hilo se copia entero');
    check(pan.png && pan.png.tipo === 'data:image/png;base64,' && pan.png.largo > 20000,
          'la imagen para compartir se genera', JSON.stringify(pan.png));
    check(pan.viejo, 'un comentario de la forma vieja se sigue mostrando');
  }

  // El comentario se publica en dos archivos por su cadencia: el diario con día y
  // semana, y el del mes con mes, trimestre y año. El panel tiene que pedir el
  // segundo sólo cuando hace falta y no tratar su fecha como si fuera vieja.
  console.log('\nComentario: la cadencia y sus dos archivos');
  const cad = await page.evaluate(() => {
    const out = { largos: [...COM_LARGOS] };
    const guardadoD = COM_DATA, guardadoL = COM_LARGOS_DATA, guardadoP = comEstado.ars.periodo;
    COM_DATA = { ruedaFin: '2026-09-17', archivoLargos: 'comentarios/2026-09.json', periodos: { dia: { titular: 'd' } } };
    COM_LARGOS_DATA = { ruta: 'comentarios/2026-09.json', data: { ruedaFin: '2026-09-30', periodos: { mes: { titular: 'm' } } } };
    comEstado.ars.periodo = 'dia';
    out.fuenteDia = comFuente('ars') === COM_DATA;
    comEstado.ars.periodo = 'mes';
    out.fuenteMes = comFuente('ars') === COM_LARGOS_DATA.data;
    out.periodoMes = (comPeriodoActual('ars') || {}).titular;
    comEstado.ars.periodo = guardadoP;
    // Sin comentario publicado, el mensaje depende del período.
    const vacio = p => comBloqueLectura('ars', null, false, null, { periodo: p, fin: '2026-09-17' }, null);
    out.vacioMes = /cierre del mes/i.test(vacio('mes'));
    out.vacioSemana = /los jueves/i.test(vacio('semana'));
    out.vacioDia = /Prompt/.test(vacio('dia'));
    // Con fecha anterior a la ficha: en el día es un aviso; en la semana y en los
    // largos es la cadencia, y se dice el tramo que cubre el comentario.
    const p = { titular: 't', pesos: { resumen: 'r' }, dolares: { resumen: 'd' },
                ini: '2026-08-31', fin: '2026-09-30' };
    const com = { ruedaFin: '2026-09-30', generado: '2026-09-30T20:00:00Z' };
    const f = { periodo: 'mes', fin: '2026-10-09', bloques: [] };
    out.avisoMes = comBloqueLectura('ars', p, true, com, f, f);
    out.avisoSemana = comBloqueLectura('ars', p, true, com, { ...f, periodo: 'semana' }, f);
    out.avisoDia = comBloqueLectura('ars', p, true, com, { ...f, periodo: 'dia' }, f);
    // Sin ruta no se pide nada.
    out.sinRuta = null;
    COM_DATA = guardadoD; COM_LARGOS_DATA = guardadoL;
    return out;
  });
  // La vista del cierre: para semana, mes, trimestre y año el panel muestra el
  // tramo del comentario que existe —a mitad de octubre, el de septiembre— y de
  // ahí salen también los tiles. El link cambia a la ventana móvil.
  const vista = await page.evaluate(() => {
    const out = {};
    const guardado = comEstado.ars.periodo;
    const f = { periodo: 'mes', ini: '2026-08-31', fin: '2026-09-30', dias: 30, enVivo: false,
                bloques: [], fx: {}, ust: null, riesgoPais: null,
                implicitasIni: [], implicitasFin: [], volumen: {} };
    const com = { ruedaFin: '2026-09-30', generado: '2026-09-30T20:00:00Z',
                  periodos: { mes: { ini: f.ini, fin: f.fin, titular: 'cierre de septiembre',
                                     pesos: { resumen: 'r' }, dolares: { resumen: 'd' } } } };
    comEstado.ars.periodo = 'mes';
    comRender('ars', f, com, { cierre: true, hayCierre: true });
    const rango = () => document.getElementById('com-ars-rango').innerHTML;
    const cuerpo = () => document.getElementById('com-ars-cuerpo').textContent.replace(/\s+/g, ' ');
    out.cierre = { rango: rango().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                   guardado: /guardado con el comentario del cierre del 30\/09\/2026/.test(cuerpo()),
                   link: /medir el tramo actual/.test(rango()) };
    comRender('ars', f, com, { cierre: false, hayCierre: true });
    out.vivo = { tramoActual: /tramo actual/.test(rango()), link: /ver el cierre/.test(rango()),
                 calculado: /calculado en tu navegador/.test(cuerpo()) };
    // Los dos sentidos del cambio de vista quedan anotados por período.
    comEstado.ars.medirAhora.delete('mes');
    comEstado.ars.medirAhora.add('mes');
    out.trasMedir = comEstado.ars.medirAhora.has('mes');
    comEstado.ars.medirAhora.delete('mes');
    out.trasVolver = !comEstado.ars.medirAhora.has('mes');
    comEstado.ars.periodo = guardado;
    return out;
  });
  check(/31\/08\/2026 → 30\/09\/2026/.test(vista.cierre.rango) && /cierre del 30\/09\/2026/.test(vista.cierre.rango)
        && vista.cierre.guardado && vista.cierre.link,
        'el cierre manda: el título trae su tramo y los tiles son los guardados con el comentario',
        vista.cierre.rango);
  check(vista.vivo.tramoActual && vista.vivo.link && vista.vivo.calculado,
        'con el tramo actual el título lo dice y ofrece volver al cierre');
  check(vista.trasMedir && vista.trasVolver, 'el cambio de vista se recuerda por período');

  const sinRuta = await page.evaluate(async () => (await comFetchLargos(null, false)) === null);
  check(cad.largos.join(',') === 'mes,trimestre,anio' && cad.fuenteDia && cad.fuenteMes && cad.periodoMes === 'm',
        'cada período lee su archivo: el diario o el del mes',
        `largos: ${cad.largos.join(', ')}`);
  check(cad.vacioMes && cad.vacioSemana && cad.vacioDia,
        'sin comentario, cada período dice cuándo se publica y sólo el día ofrece el prompt');
  check(!/⚠/.test(cad.avisoMes) && !/⚠/.test(cad.avisoSemana) && /⚠/.test(cad.avisoDia),
        'una fecha anterior es aviso sólo en el día: en la semana y el mes es la cadencia');
  check(/tramo 31\/08\/2026 → 30\/09\/2026/.test(cad.avisoMes)
        && /cierre del 30\/09\/2026/.test(cad.avisoMes),
        'el comentario en cadencia muestra su cierre y el tramo que cubre');
  check(sinRuta, 'sin archivo de períodos largos no se pide nada y no se rompe');

  // El dato solo dice poco: la ficha trae contra qué compararlo. Volumen contra las
  // ruedas previas y las implícitas contra el REM, medidos y no buscados, para que
  // el comentario les dé contexto con números que el verificador puede chequear.
  console.log('\nComentario: referencias de volumen y REM');
  const ref = await page.evaluate(async () => {
    const out = {};
    // REM inventado: 2% mensual tres meses, dólar de 1000 a 1100 en tres meses y
    // un ancla en marzo. Los números cierran a mano.
    const rem = {
      relevamiento: '2026-08-31',
      ipc: [{ mes: '2026-09', v: 2 }, { mes: '2026-10', v: 2 }, { mes: '2026-11', v: 2 }],
      tcn: [{ mes: '2026-09', v: 1000 }, { mes: '2026-10', v: 1030 }, { mes: '2026-11', v: 1060 }, { mes: '2026-12', v: 1100 }],
      tamar: [{ mes: '2026-09', v: 24 }, { mes: '2026-10', v: 23.5 }, { mes: '2026-11', v: 23 }, { mes: '2026-12', v: 22 }],
      anclas: { tcn: { '2027-03': 1200 } },
    };
    const imp = [{ tenor: 90, inflaMensual: 1.8, deval: 30 }, { tenor: 180, inflaMensual: 1.7, deval: 40 }, { tenor: 270 }];
    const r = fichaRemCalc(rem, '2026-09-16', { fecha: '2026-09-15', v: 23.6 }, imp);
    out.sint = {
      infla90: r.tenores[0].infla && r.tenores[0].infla.mensual,
      difInfla90: r.tenores[0].difInflaMensualPp,
      deval90: r.tenores[0].deval && r.tenores[0].deval.anual,
      infla180: r.tenores[1].infla,
      deval180: r.tenores[1].deval && r.tenores[1].deval.anual,
      ancla180: r.tenores[1].deval && r.tenores[1].deval.conAncla,
      tamar: r.tamar.esperada.map(p => p.mes + '=' + p.v).join(' '),
    };
    const f = await fichaConstruir('dia', { soloArchivado: true, sinFX: true, sinExternos: true });
    if (!f) return { ...out, sinFicha: true };
    out.volRef = f.volumen.ref;
    out.vsRefOk = f.bloques.filter(b => b.volumen.vsRef != null)
      .every(b => Math.abs(b.volumen.vsRef - b.volumen.prom / b.volumen.ref) < 1e-9);
    out.conVsRef = f.bloques.filter(b => b.volumen.vsRef != null).length;
    // La app archiva fotos durante la rueda: en la primera hora, la última
    // rueda guardada es la de hoy y todavía no tiene monto.
    out.finHoy = f.fin === hoyAR();
    out.rem = !!(f.rem && f.rem.tenores[0].infla && isFinite(f.rem.tenores[0].infla.mensual));
    const t = fichaTexto(f);
    out.textoRem = t.includes('REFERENCIAS DEL REM');
    out.textoVol = t.includes('veces el promedio de las');
    out.limpio = !/undefined|NaN|null/.test(t);
    return out;
  });
  const s = ref.sint;
  check(Math.abs(s.infla90 - 2) < 1e-9 && Math.abs(s.difInfla90 + 0.2) < 1e-9,
        'REM: la inflación esperada es el promedio de los meses del plazo, y la diferencia contra la curva sale en pp',
        `${s.infla90} · dif ${s.difInfla90}`);
  check(Math.abs(s.deval90 - (Math.pow(1.1, 4) - 1) * 100) < 1e-9,
        'REM: la devaluación es el ritmo del propio REM, no contra el spot', String(s.deval90));
  check(s.infla180 === null && Math.abs(s.deval180 - 44) < 1e-9 && s.ancla180 === true,
        'REM: sin meses no se inventa, y con el ancla anual se completa y se marca',
        `infla180 ${s.infla180} · deval180 ${s.deval180} · ancla ${s.ancla180}`);
  check(s.tamar === '2026-09=24 2026-12=22', 'REM: el sendero de TAMAR corta donde el REM deja de cubrir', s.tamar);
  if (ref.sinFicha) omitir('referencias en la ficha real', 'no hay dos ruedas archivadas');
  else {
    if (!(ref.volRef > 0)) omitir('volumen contra las ruedas previas', 'no hay 20 ruedas previas con monto');
    else if (!ref.conVsRef && ref.finHoy) omitir('volumen contra las ruedas previas', 'la rueda de hoy recién empieza y todavía no tiene monto');
    else check(ref.vsRefOk && ref.conVsRef > 0 && ref.textoVol,
               'el volumen de cada curva se compara con su promedio de las ruedas previas', `${ref.conVsRef} curvas`);
    if (!ref.rem) omitir('implícitas contra el REM', 'rem.json no cargó');
    else check(ref.textoRem, 'la ficha trae las referencias del REM');
    check(ref.limpio, 'la ficha con referencias no tiene undefined, NaN ni null');
  }

  // TAMAR contra tasa fija. El núcleo, fijado con el TMF27 contra la T30A7 del
  // 01/10/2026; la LECAP par, interpolada entre las dos que rodean el vencimiento
  // o elegida a mano; la extrapolación, sólo cerca de la última LECAP; el precio
  // en dólares normalizado con el TC inicial, y los avisos.
  console.log('\nTAMAR contra tasa fija');
  const betf = await page.evaluate(() => {
    const out = {};
    const tirTF = (Math.pow(157.341 / 135.1, 365 / 210) - 1) * 100;
    const base = { precio: 123.9, tirTF, dias: 147, dias360: 373, transc: 161, proy: 88, temTransc: 0.026279, margen: 6.5 };
    const n = beTamarNucleo(base);
    out.fijo = { be: n.tamar_be_tna, vf: n.valor_final, vfViejo: 123.9 * Math.pow(157.341 / 135.1, 147 / 210) };
    // Más precio del TAMAR, más valor final: el breakeven sube.
    out.subeConPrecio = beTamarNucleo({ ...base, precio: 124 }).tamar_be_tna > n.tamar_be_tna;
    const guardado = JSON.parse(JSON.stringify(BETF_TF || {}));
    BETF_TF = {};
    TAMAR_DATA = TAMAR_BONDS.map(tamarEnrich);
    const liq = G_LIQ || addHabiles(TODAY, 1);
    const vivos = TAMAR_BONDS.filter(b => b.precio > 0 && b.vcto && diasACT(liq, parseDate(b.vcto)) > 0);
    const letras = beTamarLetras();
    const ultima = letras[letras.length - 1];
    const maxDias = ultima ? ultima.dias : 0;
    out.conPar = 0; out.interpolados = 0; out.errores = []; out.sensibles = 0;
    out.extrap = 0; out.extrapBien = true; out.lejos = 0; out.lejosBien = true;
    for (const b of vivos) {
      const res = beTamarCalcular(b.ticker);
      const dT = tamarEnrich(b).dias;
      if (dT > maxDias + BE_TAMAR_EXTRAP_MAX) { out.lejos++; if (!res.error) out.lejosBien = false; continue; }
      if (dT > maxDias) {
        out.extrap++;
        if (res.error || !res.extrapola || res.tfTicker !== ultima.ticker) out.extrapBien = false;
      }
      if (res.error) { out.errores.push(`${b.ticker}: ${res.error}`); continue; }
      out.conPar++;
      if (res.sensible) out.sensibles++;
      if (res.tfTickers.length === 2) {
        out.interpolados++;
        const [a, c] = res.tfTickers.map(t => letras.find(r => r.ticker === t));
        const lo = Math.min(a.tir, c.tir), hi = Math.max(a.tir, c.tir);
        if (!(a.dias < dT && dT <= c.dias)) out.errores.push(`${b.ticker}: ${a.ticker}/${c.ticker} no rodean ${dT} días`);
        if (!(res.tirTF >= lo - 1e-9 && res.tirTF <= hi + 1e-9)) out.errores.push(`${b.ticker}: TIR ${res.tirTF} fuera de [${lo}, ${hi}]`);
        // Elegir a mano el mismo par da lo mismo: la ponderación por cercanía es
        // la interpolación lineal.
        BETF_TF = { [b.ticker]: [...res.tfTickers] };
        const man = beTamarCalcular(b.ticker);
        BETF_TF = {};
        if (!(man.tfManual && Math.abs(man.tamar_be_tna - res.tamar_be_tna) < 1e-9))
          out.errores.push(`${b.ticker}: a mano con el mismo par da ${man.tamar_be_tna} contra ${res.tamar_be_tna}`);
      }
      // La sensibilidad es la del núcleo con un 0,1% más de precio.
      if (!(res.sens > 0) || res.sensible !== (Math.abs(res.sens) > BE_TAMAR_SENS_MAX))
        out.errores.push(`${b.ticker}: sensibilidad ${res.sens}`);
    }
    // A mano, un bono lejos se compara con cualquier LECAP, avisando la
    // extrapolación, y el detalle se abre desde la tabla.
    const lejano = vivos.map(b => ({ b, dT: tamarEnrich(b).dias }))
      .filter(x => x.dT > maxDias + BE_TAMAR_EXTRAP_MAX).pop();
    if (lejano && ultima) {
      BETF_TF = { [lejano.b.ticker]: [ultima.ticker] };
      const r = beTamarCalcular(lejano.b.ticker);
      out.aMano = { ticker: lejano.b.ticker,
        ok: !r.error && r.tfManual && r.extrapola && Math.abs(r.tirTF - ultima.tir) < 1e-9 };
      beTamarRecalc();
      betfAbrir(lejano.b.ticker);
      const det = document.getElementById('betf-m-detalle');
      out.modal = { detalle: !!(det && /valor final/.test(det.textContent) && /menos el margen/.test(det.textContent)),
        chips: document.querySelectorAll('#betf-m-chips button').length, letras: letras.length };
      betfCerrar();
      BETF_TF = {};
    }
    // El TC inicial: el mismo bono cotizado por lámina en dólares da lo mismo.
    const ref = vivos.find(b => (!b.tcInicial || b.tcInicial === 1) && !beTamarCalcular(b.ticker).error);
    if (ref) {
      const r0 = beTamarCalcular(ref.ticker);
      TAMAR_BONDS.push({ ...ref, ticker: 'ZZTC1', precio: ref.precio * 1500, tcInicial: 1500 });
      const r1 = beTamarCalcular('ZZTC1');
      TAMAR_BONDS = TAMAR_BONDS.filter(b => b.ticker !== 'ZZTC1');
      out.tc = { base: r0.tamar_be_tna, dolares: r1.tamar_be_tna };
    }
    // La tabla: un ⚠ por cada bono sensible, y un botón para elegir donde no hay número.
    beTamarRecalc();
    const tb = document.getElementById('be-tamar-tbody');
    const html = tb ? tb.innerHTML : '';
    out.avisos = (html.match(/⚠/g) || []).length;
    out.avisosBetr = (html.match(/despeje amplifica/g) || []).length;
    out.botonesElegir = (html.match(/elegir TF/g) || []).length;
    // fmtP2 ya trae el %: sumarle otro en el texto lo duplicaba.
    out.textoLimpio = !/%%|% puntos/.test(html);
    out.sync = SUPA_USER_KEYS.includes(BETF_LS);
    BETF_TF = guardado; betfSaveLs(); beTamarRecalc();
    return out;
  });
  // cerca() se declara más abajo; acá todavía no existe.
  const cercaTF = (a, b, tol) => Math.abs(a - b) < (tol || 1e-6);
  check(cercaTF(betf.fijo.be, 24.62642179) && cercaTF(betf.fijo.vf, betf.fijo.vfViejo, 1e-9),
        'el núcleo contra tasa fija reproduce el TMF27 contra la T30A7, y una sola LECAP da lo mismo que antes',
        `${betf.fijo.be.toFixed(8)}%`);
  check(betf.subeConPrecio, 'con más precio del TAMAR el breakeven contra tasa fija sube');
  if (!betf.conPar) {
    omitir('la LECAP par se interpola entre las dos vecinas', 'ningún TAMAR tiene LECAP de su plazo');
  } else {
    check(betf.errores.length === 0,
          'la LECAP par se interpola entre las dos que rodean el vencimiento, a mano da lo mismo, y la sensibilidad es la del núcleo',
          `${betf.conPar} con par, ${betf.interpolados} interpolados · ` + betf.errores.slice(0, 3).join(' · '));
    check(betf.avisos - betf.avisosBetr === betf.sensibles,
          'la tabla avisa en cada bono muy sensible al precio',
          `${betf.avisos - betf.avisosBetr} avisos, ${betf.sensibles} sensibles`);
  }
  if (!betf.extrap) omitir('poco después de la última LECAP', 'ningún TAMAR vence en ese tramo');
  else check(betf.extrapBien, 'si vence poco después de la última LECAP, se usa esa plana y se avisa',
             `${betf.extrap} bono(s)`);
  if (!betf.lejos) omitir('lejos de la última LECAP', 'ningún TAMAR vence tan lejos');
  else check(betf.lejosBien && betf.botonesElegir >= betf.lejos,
             'más lejos no se extrapola solo: la tabla ofrece elegir la tasa fija',
             `${betf.lejos} lejos, ${betf.botonesElegir} botones`);
  if (!betf.aMano) omitir('la tasa fija elegida a mano', 'no hay un TAMAR lejos de la última LECAP');
  else {
    check(betf.aMano.ok, 'elegida a mano sirve cualquier LECAP, avisando la extrapolación', betf.aMano.ticker);
    check(betf.modal.detalle && betf.modal.chips === betf.modal.letras,
          'el detalle paso a paso se abre desde la tabla, con una opción por LECAP',
          JSON.stringify(betf.modal));
  }
  check(betf.sync, 'la elección de tasa fija viaja por usuario');
  check(betf.textoLimpio, 'los carteles de la tabla no repiten el %');
  if (!betf.tc) omitir('el TAMAR en dólares se normaliza con el TC inicial', 'no hay TAMAR con par de tasa fija');
  else check(cercaTF(betf.tc.base, betf.tc.dolares, 1e-9),
             'el TAMAR cotizado en dólares se normaliza con el TC inicial', JSON.stringify(betf.tc));

  // TAMAR real contra CER. Los dos casos están fijados con los números que se
  // verificaron a mano contra planilla, con los precios de esa rueda: si alguien
  // toca la fórmula, esto se cae.
  console.log('\nTAMAR real contra CER');
  const betr = await page.evaluate(() => {
    const out = {};
    // TTD26 contra TZXD6, 16/09/2026. Margen 0, así que la corrección por
    // inflación no cambia nada y la resta del margen es exacta por definición.
    const ttd = betrNucleo({
      cers: [{ ticker: 'TZXD6', vcto: '2026-12-15', vpv: 307.6960369012062, precio: 305.15, dias: 88, peso: 1 }],
      diasTamar: 88, precioTamar: 170.338, margen: 0,
      varCerTecnico: 1.5993417547087379, varCerTranscurrida: 1.6111796147340527,
      dias360Transc: 600, dias360Bono: 676, diasProy: 51, diasTransc: 402,
      temTranscurrida: 0.027420999203538576, inflaMensual: null,
    });
    out.ttd = { tem7: ttd.tem7 * 100, tna: ttd.tnaAprox * 100, tea: ttd.tea * 100, v5: ttd.valorSobreCer };
    // TML27 contra TZXM7 y TZXS7, mismos precios, con los pesos por cercanía de
    // vencimiento (34% y 66%) y 201 días a proyectar, ya con los feriados 2027.
    const base = {
      cers: [
        { ticker: 'TZXM7', vcto: '2027-03-31', vpv: 230.82257228520533, precio: 226.15, dias: 194, peso: 0.3387978142076503 },
        { ticker: 'TZXS7', vcto: '2027-09-30', vpv: 115.3434858477226, precio: 108.85, dias: 377, peso: 0.6612021857923497 },
      ],
      diasTamar: 315, precioTamar: 108.75, margen: 5.4,
      varCerTecnico: 1.0537124888307963, varCerTranscurrida: 1.0615117605705482,
      dias360Transc: 89, dias360Bono: 390, diasProy: 201, diasTransc: 63,
      temTranscurrida: 0.02391478917002976,
    };
    const iguales = betrNucleo({ ...base, cers: base.cers.map(c => ({ ...c, peso: 1 })), diasProy: 211, inflaMensual: null });
    out.tmlSimple = { tna: iguales.tnaAprox * 100 };
    const pond = betrNucleo({ ...base, diasProy: 211, inflaMensual: null });
    out.tmlPonderado = { tna: pond.tnaAprox * 100 };
    // Los feriados 2027 bajan los días a proyectar de 211 a 201.
    const con201 = betrNucleo({ ...base, cers: base.cers.map(c => ({ ...c, peso: 1 })), inflaMensual: null });
    out.tml201 = { tna: con201.tnaAprox * 100 };
    const conRem = betrNucleo({ ...base, inflaMensual: 0.017 });
    out.tmlRem = { tnaAprox: conRem.tnaAprox * 100, tnaReal: conRem.tnaReal * 100, exacta: conRem.exacta };
    // Pesos: con dos bonos, la inversa de la distancia es la interpolación lineal.
    const pesos = betrPesos([{ vcto: '2027-03-31' }, { vcto: '2027-09-30' }], '2027-07-30');
    const tot = pesos.reduce((s, c) => s + c.peso, 0);
    out.pesos = pesos.map(c => c.peso / tot);
    const exacto = betrPesos([{ vcto: '2027-07-30' }, { vcto: '2027-09-30' }], '2027-07-30');
    out.pesoExacto = exacto.map(c => c.peso);
    // Feriados 2027: sin ellos, cualquier cuenta de 2027 contaba días hábiles de más.
    out.feriados2027 = ['2027-01-01', '2027-02-08', '2027-03-25', '2027-06-21', '2027-07-09', '2027-10-11']
      .every(f => !esHabil(parseDate(f)));
    // Sin CER elegidos no hay número, y sin días a proyectar tampoco.
    out.sinCer = (betrNucleo({ ...base, cers: [] }) || {}).error;
    return out;
  });
  const cerca = (a, b, tol) => Math.abs(a - b) < (tol || 1e-6);
  check(cerca(betr.ttd.tem7, 0.28712983) && cerca(betr.ttd.tna, 3.44581521) && cerca(betr.ttd.tea, 3.50049485),
        'TTD26 contra TZXD6 reproduce los números verificados',
        `TEM ${betr.ttd.tem7.toFixed(8)}% · TNA ${betr.ttd.tna.toFixed(8)}% · TEA ${betr.ttd.tea.toFixed(8)}%`);
  check(cerca(betr.tmlSimple.tna, 2.04460118) && cerca(betr.tmlPonderado.tna, 2.34006046),
        'TML27: pesos iguales y pesos por plazo dan lo verificado',
        `iguales ${betr.tmlSimple.tna.toFixed(8)}% · ponderado ${betr.tmlPonderado.tna.toFixed(8)}%`);
  check(cerca(betr.tml201.tna, 2.08151923),
        'con los feriados de 2027 quedan 201 días a proyectar y TML27 da lo verificado',
        `${betr.tml201.tna.toFixed(8)}%`);
  check(betr.tmlRem.exacta && betr.tmlRem.tnaReal - betr.tmlRem.tnaAprox > 0.05
        && betr.tmlRem.tnaReal - betr.tmlRem.tnaAprox < 0.2,
        'la corrección por inflación saca el sesgo del margen, unos 0,1 puntos',
        `aprox ${betr.tmlRem.tnaAprox.toFixed(8)}% → exacta ${betr.tmlRem.tnaReal.toFixed(8)}%`);
  check(cerca(betr.pesos[0], 0.3387978142076503) && cerca(betr.pesos[1], 0.6612021857923497),
        'los pesos por cercanía son la interpolación lineal entre los dos CER',
        betr.pesos.map(p => p.toFixed(4)).join(' · '));
  check(betr.pesoExacto[0] === 1 && betr.pesoExacto[1] === 0,
        'con un CER del mismo vencimiento, ese se lleva todo');
  check(betr.feriados2027, 'el calendario tiene los feriados de 2027');
  check(/CER/.test(betr.sinCer || ''), 'sin bonos CER no se inventa un número', betr.sinCer);

  // Breakeven de inflación: la tasa fija al plazo del CER sale de interpolar las
  // dos LECAP que rodean su vencimiento, no de la primera que vence después.
  console.log('\nBreakeven de inflación: tasa fija interpolada');
  const beTF = await page.evaluate(() => {
    const out = {};
    const L = [{ ticker: 'A', dias: 50, tir: 25 }, { ticker: 'B', dias: 100, tir: 28 }, { ticker: 'C', dias: 200, tir: 30 }];
    const r = d => beTirTFAlPlazo(L, d);
    out.medio = r(75);        // a mitad entre A y B
    out.exacta = r(100);      // la misma B
    out.antes = r(20);        // antes de la primera: esa sola
    out.despues = r(250);     // después de la última: no hay par
    // Con una LECAP del mismo vencimiento, el núcleo da lo mismo que el método
    // anterior —estirar el rendimiento directo en forma lineal—, porque los días
    // coinciden. Números del TZXD6 contra la T15E7 del 08/10/2026.
    const dir = 161.1037734246615 / 151.04 - 1, dias = 98;
    const nuevo = beNucleo({ psCER: 310.35, tirTF: Math.pow(1 + dir, 365 / dias) - 1, diasCER: dias,
      cerIni: 271.04755550913, cerConocido: 854.45861540882, diasRestantes: 74 });
    const viejo = 310.35 * (1 + dir * dias / dias);
    out.mismoPar = nuevo ? Math.abs(nuevo.pfBE - viejo) : null;
    // En vivo: cada breakeven interpolado queda entre las dos LECAP vecinas.
    const letras = beTamarLetras();
    out.vivos = 0; out.interpolados = 0; out.errores = [];
    for (const c of beCandidatos()) {
      const res = beCalcular(c.ticker);
      if (!res || res.error) continue;
      out.vivos++;
      if (res.tfTickers.length === 2) {
        out.interpolados++;
        const [a, b] = res.tfTickers.map(t => letras.find(l => l.ticker === t));
        const lo = Math.min(a.tir, b.tir), hi = Math.max(a.tir, b.tir);
        if (!(a.dias < res.diasCER && res.diasCER <= b.dias)) out.errores.push(`${c.ticker}: ${a.ticker}/${b.ticker} no rodean ${res.diasCER}d`);
        if (!(res.tirTF >= lo - 1e-9 && res.tirTF <= hi + 1e-9)) out.errores.push(`${c.ticker}: TIR ${res.tirTF} fuera de [${lo}, ${hi}]`);
      }
    }
    return out;
  });
  check(Math.abs(beTF.medio.tir - 26.5) < 1e-9 && beTF.medio.tickers.join() === 'A,B',
        'la tasa fija al plazo del CER se interpola en días entre las dos LECAP vecinas', JSON.stringify(beTF.medio));
  check(beTF.exacta.tir === 28 && beTF.exacta.tickers.join() === 'B' && beTF.antes.tickers.join() === 'A' && beTF.despues === null,
        'con una LECAP del mismo plazo va esa; antes de la primera, la primera; después de la última, nada');
  check(beTF.mismoPar != null && beTF.mismoPar < 1e-9,
        'con una LECAP del mismo vencimiento el breakeven no cambia', String(beTF.mismoPar));
  if (!beTF.vivos) omitir('breakeven interpolado en vivo', 'ningún CER con LECAP de su plazo');
  else check(beTF.errores.length === 0, 'en vivo, cada breakeven interpolado queda entre sus dos LECAP',
             `${beTF.vivos} con par, ${beTF.interpolados} interpolados · ` + beTF.errores.slice(0, 3).join(' · '));

  // La referencia contra el REM se mide sobre la misma ventana que el breakeven:
  // los días de cada mes de IPC entre el último CER publicado y el fixing.
  console.log('\nBreakeven de inflación: la ventana contra el REM');
  const beVen = await page.evaluate(() => {
    const out = {};
    // El TZXD6 del 08/10/2026: del 15/10 al 27/11 son 30 días de septiembre y 13
    // de octubre. El TZXA7, que fija el 16/04, tiene 2 días de marzo; el TZXY7,
    // que fija el 14/05, 30.
    const j = m => m.map(x => x.mes + ':' + x.dias).join(' ');
    out.d6 = j(beMesesVentana('2026-10-15', '2026-11-27'));
    out.a7 = beMesesVentana('2026-10-15', '2027-04-16').slice(-1)[0];
    out.y7 = beMesesVentana('2026-10-15', '2027-05-14').slice(-1)[0];
    // Un sendero plano proyecta el mismo CER que la app: con el IPC de septiembre
    // en 2% y los 31 días de octubre, 30 días dan 1,02^(30/31).
    out.plano = beInflaVentana([{ mes: '2026-09', dias: 30 }], 30, () => 2);
    out.planoEsperado = (Math.pow(Math.pow(1.02, 30 / 31), 30.4 / 30) - 1) * 100;
    // En vivo: con el REM como fuente, el REM de la ventana es el CER proyectado
    // por la app hasta el fixing —la misma cuenta por dos caminos—.
    if (!REM_DATA || !REM_DATA.ipc || !CER_INDEX.length) return { ...out, sinRem: true };
    const prev = PROJ_FUENTE.infla;
    PROJ_FUENTE.infla = 'rem'; projRecalc();
    out.vivos = 0; out.errores = [];
    for (const c of beCandidatos()) {
      const r = beCalcular(c.ticker);
      if (!r || r.error || !r.rem) continue;
      out.vivos++;
      if (Math.abs(r.rem.mensual - r.promInfla) > 1e-9) out.errores.push(`${c.ticker}: REM ${r.rem.mensual} vs CER proyectado ${r.promInfla}`);
      if (r.ventana.meses.reduce((t, m) => t + m.dias, 0) !== r.diasRestantes) out.errores.push(`${c.ticker}: los días de la ventana no suman ${r.diasRestantes}`);
    }
    PROJ_FUENTE.infla = prev; projRecalc();
    // El detalle muestra la ventana.
    const r0 = beCandidatos().map(c => beCalcular(c.ticker)).find(r => r && !r.error);
    out.texto = r0 ? beVentanaTexto(r0) : '';
    return out;
  });
  check(beVen.d6 === '2026-09:30 2026-10:13', 'la ventana cuenta los días de cada mes de IPC entre el último CER y el fixing', beVen.d6);
  check(beVen.a7.mes === '2027-03' && beVen.a7.dias === 2 && beVen.y7.mes === '2027-03' && beVen.y7.dias === 30,
        'un fixing del 16 tiene 2 días del último mes y uno del 14 tiene 30: ya no son el mismo "hasta marzo"',
        JSON.stringify({ a7: beVen.a7, y7: beVen.y7 }));
  check(Math.abs(beVen.plano - beVen.planoEsperado) < 1e-12, 'el REM de la ventana está en la misma unidad que el breakeven',
        `${beVen.plano} vs ${beVen.planoEsperado}`);
  if (beVen.sinRem) omitir('REM de la ventana en vivo', 'rem.json no cargó');
  else if (!beVen.vivos) omitir('REM de la ventana en vivo', 'ningún CER con breakeven');
  else {
    check(beVen.errores.length === 0, 'el REM de la ventana es el CER que proyecta la app con el REM, hasta el fixing',
          `${beVen.vivos} bonos · ` + beVen.errores.slice(0, 3).join(' · '));
    check(/→ .* días/.test(beVen.texto), 'el detalle muestra la ventana con los días de cada mes', beVen.texto);
  }

  // El forward entre bonos: el cociente de los dos CER de breakeven entre sus
  // fixings, sin contar meses, con el REM del mismo tramo.
  console.log('\nBreakeven de inflación: forward entre fixings');
  const beFw = await page.evaluate(() => {
    const out = {};
    // Sintético: el anterior fija el 16/04 con CER de breakeven 1000 y éste el
    // 14/05 con 1015; son 28 días.
    const mk = (t, hasta, cer, rem, dR) => ({ ticker: t, res: { ventana: { hasta }, cerFinalBE: cer, rem: { mensual: rem }, diasRestantes: dR } });
    const a = mk('A', '2027-04-16', 1000, 1.6, 183), b = mk('B', '2027-05-14', 1015, 1.6, 211);
    const f = beForward(b, [a]);
    out.sint = f && { valor: f.valor, esperado: (Math.pow(1.015, 30.4 / 28) - 1) * 100, dias: f.dias,
      meses: f.meses.map(m => m.mes + ':' + m.dias).join(' '), rem: f.rem, corto: f.corto };
    // Mismo fixing: no hay forward; el primero tampoco.
    out.mismo = beForward(mk('C', '2027-04-16', 1001, 1.6, 183), [a]);
    out.primero = beForward(a, []);
    // En vivo, con todos los CER que tienen breakeven: la tabla trae la columna
    // y cada bono con un anterior de fixing distinto tiene forward.
    const guardado = BE_BONOS;
    BE_BONOS = beCandidatos().map(c => c.ticker);
    beRecalc();
    const res = BE_BONOS.map(t => ({ ticker: t, res: beCalcular(t) }))
      .sort((x, y) => String((CER_BONDS.find(b => b.ticker === x.ticker) || {}).vcto).localeCompare(String((CER_BONDS.find(b => b.ticker === y.ticker) || {}).vcto)));
    out.vivos = 0; out.faltan = [];
    res.forEach((it, i) => {
      if (!it.res || it.res.error) return;
      const hayPrev = res.slice(0, i).some(x => x.res && !x.res.error && x.res.ventana.hasta < it.res.ventana.hasta);
      if (!hayPrev) return;
      out.vivos++;
      if (!beForward(it, res.slice(0, i))) out.faltan.push(it.ticker);
    });
    const th = document.querySelector('#be-col1 table thead');
    out.columna = th ? /Fwd/.test(th.textContent) : false;
    out.celdas = [...document.querySelectorAll('#be-tbody tr')].filter(tr => tr.children.length === 5).length;
    BE_BONOS = guardado; beRecalc();
    return out;
  });
  check(beFw.sint && Math.abs(beFw.sint.valor - beFw.sint.esperado) < 1e-9 && beFw.sint.dias === 28
        && beFw.sint.meses === '2027-03:28',
        'el forward es el cociente de los dos CER de breakeven, mensualizado por los días entre fixings', JSON.stringify(beFw.sint));
  check(Math.abs(beFw.sint.rem - 1.6) < 1e-9 && !beFw.sint.corto,
        'con un REM parejo, el REM del tramo es ese mismo valor');
  check(beFw.mismo === null && beFw.primero === null, 'sin un fixing anterior distinto no hay forward');
  if (!beFw.vivos) omitir('forward en vivo', 'menos de dos CER con breakeven');
  else {
    check(beFw.faltan.length === 0, 'en vivo, cada bono con un fixing anterior tiene forward', beFw.faltan.join(', '));
    check(beFw.columna && beFw.celdas > 0, 'la tabla de breakeven muestra la columna del forward', `${beFw.celdas} filas`);
  }

  // Breakeven de devaluación de los dollar linked y el tablero del Resumen.
  console.log('\nBreakeven de devaluación y tablero del Resumen');
  const beDv = await page.evaluate(async () => {
    const out = {};
    // Si el precio es exactamente el A3500 de hoy descontado a la tasa fija, el
    // breakeven es cero; si la tasa fija sube, sube.
    const spot = 1500, d = 60, tir = 0.25;
    const precio = 100 * spot / Math.pow(1 + tir, d / 365);
    out.cero = beDevalNucleo({ precio, cf: 100, diasPago: d, tirTF: tir, spot, diasTC: d }).devalBE;
    out.sube = beDevalNucleo({ precio, cf: 100, diasPago: d, tirTF: 0.30, spot, diasTC: d }).devalBE > 0;
    // El REM interpola sus cierres de mes: en un cierre da ese nivel.
    if (REM_DATA && REM_DATA.tcn && REM_DATA.tcn.length > 1) {
      const p1 = REM_DATA.tcn[1];
      out.remCierre = { mes: p1.mes, nivel: p1.v, interp: remTCAl(proyUltDiaMes(p1.mes)) };
    }
    // En vivo: cada dollar linked con LECAP de su plazo tiene breakeven, y el
    // REM se compara con su propio ritmo, no desde el A3500 de hoy.
    out.filas = 0; out.conBE = 0; out.errores = [];
    for (const b of beDevalBonos()) {
      out.filas++;
      const r = beDevalCalcular(b);
      if (r.error) continue;
      out.conBE++;
      if (!isFinite(r.devalBE)) out.errores.push(`${b.ticker}: breakeven ${r.devalBE}`);
      if (r.rem != null) {
        const ritmo = (Math.pow(r.tcRem / r.tcRemHoy, 30.4 / r.diasTC) - 1) * 100;
        if (Math.abs(r.rem - ritmo) > 1e-9) out.errores.push(`${b.ticker}: REM ${r.rem} vs ritmo propio ${ritmo}`);
      }
    }
    out.duales = beDevalBonos().filter(b => TAMAR_BONDS.some(t => t.ticker === b.ticker)).length;
    // El tablero: cinco tarjetas, y las medianas son las de las tablas.
    switchSection('pesos'); switchTab('breakeven');
    await new Promise(r => setTimeout(r, 1500));
    beRefreshIfVisible();
    const tb = document.getElementById('be-tablero');
    out.tarjetas = tb ? tb.children.length : 0;
    const dat = beTableroDatos();
    const med = a => { const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); const m = Math.floor(v.length / 2); return v.length ? (v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) : null; };
    const dv = beDevalBonos().map(beDevalCalcular).filter(r => !r.error);
    out.medianaDeval = dat.deval.be == null || Math.abs(dat.deval.be - med(dv.map(r => r.devalBE))) < 1e-12;
    const letras = (DATA.length ? DATA : LECAPS.map(enrich)).filter(r => r.precio > 0 && r.dias > 0 && isFinite(r.tna));
    out.puntas = !dat.corta || (dat.corta.dias === Math.min(...letras.map(r => r.dias)) && dat.larga.dias === Math.max(...letras.map(r => r.dias)));
    out.tablaDeval = (document.getElementById('be-deval-tbody') || {}).children ? document.getElementById('be-deval-tbody').children.length : 0;
    return out;
  });
  check(Math.abs(beDv.cero) < 1e-9 && beDv.sube, 'el breakeven de devaluación es cero si el precio es el A3500 de hoy a la tasa fija, y sube con la tasa',
        String(beDv.cero));
  if (beDv.remCierre) check(Math.abs(beDv.remCierre.interp - beDv.remCierre.nivel) < 1e-9,
                            'el A3500 del REM en un cierre de mes es el nivel de ese mes', JSON.stringify(beDv.remCierre));
  if (!beDv.filas) omitir('breakeven de devaluación en vivo', 'sin dollar linked con precio');
  else {
    check(beDv.errores.length === 0 && beDv.duales === 0,
          'los dollar linked con LECAP de su plazo tienen breakeven, sin duales, y el REM va con su propio ritmo',
          `${beDv.conBE}/${beDv.filas} con breakeven · ` + beDv.errores.slice(0, 3).join(' · '));
    check(beDv.tablaDeval === beDv.filas, 'la tabla BE · Devaluación del Resumen tiene una fila por dollar linked', `${beDv.tablaDeval} filas`);
  }
  check(beDv.tarjetas === 5 && beDv.medianaDeval && beDv.puntas,
        'el tablero del Resumen tiene sus cinco tarjetas, con las puntas de la curva y las medianas de las tablas',
        JSON.stringify({ tarjetas: beDv.tarjetas, mediana: beDv.medianaDeval, puntas: beDv.puntas }));

  // Modelos de curva: cada uno recupera su propia forma, el mejor ajuste elige
  // el verdadero, la banda es de ±1σ y el selector repinta los gráficos.
  console.log('\nModelos de curva');
  const cur = await page.evaluate(async () => {
    const out = {};
    const xs = [10, 25, 50, 90, 140, 200, 280, 400];
    const de = f => xs.map(x => ({ x, y: f(x) }));
    const lo = 10, hi = 400, tau = lo * Math.pow(hi / lo, 20 / 40);
    const g1 = x => (1 - Math.exp(-x / tau)) / (x / tau), g2 = x => g1(x) - Math.exp(-x / tau);
    const formas = {
      log: x => 3 + 2 * Math.log(x),
      raiz: x => 1 + 0.5 * Math.sqrt(x),
      lineal: x => 2 + 0.01 * x,
      cuad: x => 1 + 0.5 * Math.log(x) + 0.1 * Math.log(x) ** 2,
      ns: x => 5 - 2 * g1(x) + g2(x),
    };
    out.recupera = {}; out.auto = {};
    for (const [m, f] of Object.entries(formas)) {
      const aj = curvaAjustar(de(f), m);
      out.recupera[m] = aj ? aj.sse < 1e-9 && Math.abs(aj.f(120) - f(120)) < 1e-6 : false;
      const au = curvaAjustar(de(f), 'auto');
      out.auto[m] = au ? au.modelo : null;
    }
    // La banda: ±σ de los residuos, sólo si se pide.
    const ruido = xs.map((x, i) => ({ x, y: formas.log(x) + (i % 2 ? 0.1 : -0.1) }));
    const aj = curvaAjustar(ruido, 'log');
    const prev = { ...CURVA_PREF };
    CURVA_PREF.banda = true;
    const con = curvaDatasets(aj, xs, { color: '#fff' });
    CURVA_PREF.banda = false;
    const sin = curvaDatasets(aj, xs, { color: '#fff' });
    CURVA_PREF.banda = prev.banda;
    out.banda = { con: con.lista.length, sin: sin.lista.length, relleno: con.banda[1] && con.banda[1].fill,
      ancho: con.banda.length ? con.banda[0].data[5].y - con.lista[0].data[5].y : null, sigma: aj.sigma };
    out.vacia = curvaDatasets(null, xs, {}).lista.length === 1;
    // El selector: repetido en cada gráfico, sincronizado, y repinta.
    switchSection('pesos'); switchTab('lecap');
    await new Promise(r => setTimeout(r, 1500));
    curvaSetModelo('lineal');
    const sels = [...document.querySelectorAll('[data-curva-sel] select')];
    out.selectores = sels.length;
    out.sincronizados = sels.every(x => x.value === 'lineal');
    const tr = typeof curveChart !== 'undefined' && curveChart ? curveChart.data.datasets.find(d => d.curvaInfo) : null;
    if (tr && tr.data.length > 3) {
      const d = tr.data;
      const pend = (d[2].y - d[1].y) / (d[2].x - d[1].x), pend2 = (d[d.length - 1].y - d[d.length - 2].y) / (d[d.length - 1].x - d[d.length - 2].x);
      out.recta = Math.abs(pend - pend2) < 1e-3;
      out.info = (document.querySelector('[data-curva-sel="tf"] .curva-info') || {}).textContent || '';
    }
    curvaSetModelo(prev.modelo || 'log');
    out.sync = SUPA_USER_KEYS.includes(CURVA_LS);
    return out;
  });
  check(Object.values(cur.recupera).every(Boolean), 'cada modelo de curva recupera su propia forma', JSON.stringify(cur.recupera));
  check(Object.entries(cur.auto).every(([m, a]) => a === m), 'el mejor ajuste elige el modelo que generó los puntos', JSON.stringify(cur.auto));
  check(cur.banda.con === 3 && cur.banda.sin === 1 && cur.banda.relleno === '-1' && Math.abs(cur.banda.ancho - cur.banda.sigma) < 1e-3 && cur.vacia,
        'la banda es de ±1σ de los residuos y se puede sacar', JSON.stringify(cur.banda));
  check(cur.selectores >= 8 && cur.sincronizados, 'el selector de curva está en cada gráfico y sincronizado', `${cur.selectores} selectores`);
  if (cur.recta == null) omitir('el selector repinta la curva de tasa fija', 'sin LECAP con precio');
  else check(cur.recta && /Lineal/.test(cur.info), 'el selector repinta la curva de tasa fija con el modelo elegido', cur.info);
  check(cur.sync, 'la preferencia de curva viaja por usuario');

  // La solapa DUAL: cada pata al vencimiento con los senderos elegidos, quién
  // gana, y la indiferencia, que tiene que devolver exactamente la otra pata.
  console.log('\nDuales');
  const dua = await page.evaluate(async () => {
    const out = {};
    // La rama fija del TTD26 sale de la resolución del canje: 2,14% TEM, 30/360.
    out.tipoTTD26 = dualTipo({ ticker: 'TTD26' });
    out.fijaTTD26 = calcVF(dualTemFija({ ticker: 'TTD26' }), parseDate('2025-01-29'), parseDate('2026-12-15'));
    out.tipos = { conTem: dualTipo({ ticker: 'XXX99', temFija: 2 }), sinNada: dualTipo({ ticker: 'XXX99' }) };
    // La TNA de TAMAR que devuelve una tasa mensual es la inversa de la de tamarEnrich.
    const mensualDe = (tna, mg) => Math.pow(Math.pow(1 + (tna + mg) / 100 * 32 / 365, 365 / 32), 1 / 12) - 1;
    out.inversa = dualTnaDeMensual(mensualDe(30, 3), 3);

    switchSection('pesos'); switchTab('dual');
    await new Promise(r => setTimeout(r, 1500));
    out.filas = DUAL_DATA.length;
    out.dom = document.querySelectorAll('#dual-tbody tr').length;
    out.cols = document.querySelectorAll('#dual-thead th').length;
    out.boton = !!document.getElementById('nav-dual');
    out.selectores = ['infla', 'tamar', 'tcn'].every(k => document.querySelector(`#page-dual [data-proy-sel="${k}"] select`));
    out.curvaSel = !!document.querySelector('#page-dual [data-curva-sel="dual"] select');
    // Todos los TAMAR cargados también en CER o DLK, sin vencer, están.
    const liq = G_LIQ || addHabiles(TODAY, 1);
    const esperados = TAMAR_BONDS.filter(t => t.vcto && t.emision && diasACT(liq, parseDate(t.vcto)) > 0
      && (CER_BONDS.some(b => b.ticker === t.ticker) || DLK_BONDS.some(b => b.ticker === t.ticker) || dualTemFija(t)));
    out.completos = esperados.length === DUAL_DATA.length;

    out.errores = []; out.vivos = 0; out.indifs = 0;
    const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
    for (const r of DUAL_DATA) {
      if (r.error) continue;
      const t = r.bono;
      const vpv = tamarEnrich({ ...t, precio: t.precio > 0 ? t.precio : 100 * (t.tcInicial || 1) }).vpvProy * (t.tcInicial || 1);
      if (rel(r.ramaB, vpv) > 1e-12) out.errores.push(`${r.ticker}: rama B ${r.ramaB} vs tamarEnrich ${vpv}`);
      if (!(r.ramaA > 0)) continue;
      out.vivos++;
      if (r.precio > 0 && r.dias > 0) {
        const tea = (Math.pow(Math.max(r.ramaA, r.ramaB) / r.precio, 365 / r.dias) - 1) * 100;
        if (Math.abs(r.tea - tea) > 1e-9) out.errores.push(`${r.ticker}: TEA ${r.tea} vs ${tea}`);
      }
      const i = r.indif;
      if (!i || i.fijado || i.ganada || !isFinite(i.valor)) continue;
      out.indifs++;
      // Con la indiferencia, la rama A paga exactamente lo de la B.
      let conIndif;
      if (r.tipo === 'cer') {
        const ult = projGetLastCerReal();
        conIndif = 100 * ult.valor * Math.pow(1 + i.valor / 100, i.ventana.dias / 30.4) / r.cer.em;
      } else if (r.tipo === 'dlk') {
        conIndif = r.dlk.cf * r.dlk.spot * Math.pow(1 + i.valor / 100, i.dias / 30.4);
      } else {
        const ta = r.tamar;
        const nmc = (ta.transc * ta.temTransc + ta.proy * mensualDe(i.valor, r.margen)) / (ta.transc + ta.proy);
        conIndif = 100 * Math.pow(1 + nmc, ta.d360 / 360 * 12) * r.tcInicial;
      }
      const otra = r.tipo === 'tf' ? r.ramaA : r.ramaB;
      if (rel(conIndif, otra) > 1e-9) out.errores.push(`${r.ticker}: con la indiferencia ${conIndif} vs ${otra}`);
      // El escenario arriba de la indiferencia es el que hace ganar a la rama A
      // (a la TAMAR, en la tasa fija).
      if (i.esc != null && Math.abs(i.esc - i.valor) > 1e-6) {
        const ganaA = r.tipo === 'tf' ? i.esc < i.valor : i.esc > i.valor;
        if (ganaA !== (r.gana === 'A')) out.errores.push(`${r.ticker}: escenario ${i.esc} vs indiferencia ${i.valor} y gana ${r.gana}`);
      }
    }
    // El gráfico: un punto por dual con margen, y la métrica y el plazo lo cambian.
    const puntos = () => dualChart ? dualChart.data.datasets.filter(d => d.esPunto).reduce((a, d) => a + d.data.length, 0) : 0;
    const prev = { ...DUAL_PREF };
    out.puntos = puntos();
    out.conMargen = DUAL_DATA.filter(r => !r.error && r.dias > 0 && r.margenTNA != null && isFinite(r.margenTNA)).length;
    dualSetPref('metrica', 'tea');
    out.tituloTea = document.getElementById('dual-chart-titulo').textContent;
    dualSetPref('metrica', 'margen');
    dualSetPref('plazoMax', 365);
    out.puntosAnio = puntos();
    out.conMargenAnio = DUAL_DATA.filter(r => !r.error && r.dias > 0 && r.dias <= 365 && r.margenTNA != null && isFinite(r.margenTNA)).length;
    DUAL_PREF = prev; dualSaveLs(); dualRender();
    // Cambiar el sendero de TAMAR repinta la solapa sola.
    const fuente = PROJ_FUENTE.tamar;
    const otra = fuente === '5dias' ? 'rem' : '5dias';
    proySetFuente('tamar', otra);
    out.repinta = DUAL_DATA.length ? DUAL_DATA.every(r => r.error || r.fuenteTamar === otra) : null;
    proySetFuente('tamar', fuente);
    out.sync = SUPA_USER_KEYS.includes(DUAL_LS);
    out.modal = !!document.getElementById('tamar-m-temfija');
    return out;
  });
  check(dua.tipoTTD26 === 'tf' && Math.abs(dua.fijaTTD26 - 100 * Math.pow(1.0214, 676 / 30)) < 1e-9 && Math.abs(dua.fijaTTD26 - 161.14) < 0.01,
        'la rama fija del TTD26 es 2,14% TEM capitalizable 30/360 desde la emisión', String(dua.fijaTTD26));
  check(dua.tipos.conTem === 'tf' && dua.tipos.sinNada === null, 'un bono TAMAR es dual tasa fija sólo si tiene TEM fija', JSON.stringify(dua.tipos));
  check(Math.abs(dua.inversa - 30) < 1e-9, 'la TNA de TAMAR que devuelve una tasa mensual es la inversa de la de tamarEnrich', String(dua.inversa));
  check(dua.boton && dua.selectores && dua.curvaSel && dua.cols === 12 && dua.sync && dua.modal,
        'la solapa DUAL tiene su botón, los tres senderos, el selector de curva y doce columnas',
        JSON.stringify({ boton: dua.boton, selectores: dua.selectores, curva: dua.curvaSel, cols: dua.cols, sync: dua.sync, modal: dua.modal }));
  if (!dua.filas) omitir('duales en vivo', 'sin duales sin vencer');
  else {
    check(dua.completos && dua.dom === dua.filas, 'la tabla tiene una fila por cada dual sin vencer', `${dua.dom} filas, ${dua.filas} duales`);
    check(dua.errores.length === 0 && dua.vivos > 0,
          'las dos ramas, la TEA y la indiferencia cierran: con la indiferencia, las dos patas pagan lo mismo',
          `${dua.vivos} con las dos ramas, ${dua.indifs} con indiferencia · ` + dua.errores.slice(0, 3).join(' · '));
    check(dua.puntos === dua.conMargen && dua.tituloTea === 'TEA en el escenario' && dua.puntosAnio === dua.conMargenAnio,
          'el gráfico tiene un punto por dual, y la métrica y el plazo máximo lo cambian',
          JSON.stringify({ puntos: dua.puntos, conMargen: dua.conMargen, anio: dua.puntosAnio, esperadosAnio: dua.conMargenAnio, titulo: dua.tituloTea }));
    check(dua.repinta === true, 'cambiar el sendero de TAMAR repinta la solapa DUAL sola');
  }

  // El color de la tabla del Resumen: sólo la TIR, por percentil y centrado en
  // la mediana. La lista de la tabla es por usuario, así que se arma una.
  console.log('\nColores de la tabla del Resumen');
  const cpc = await page.evaluate(async () => {
    const out = {};
    const p = beCPPercentiles([5, 1, 3, 2, 4]);
    const e = beCPPercentiles([1, 1, 3]);
    out.percentiles = p.get(1) === 0 && p.get(3) === 0.5 && p.get(5) === 1 && e.get(1) === 0.25 && e.get(3) === 1;
    out.escala = beCPHeat(0.5) === '' && beCPHeat(0.55) === '' && /74,222,128/.test(beCPHeat(1)) && /248,113,113/.test(beCPHeat(0));
    const prev = CP_BONDS;
    const liq = G_LIQ || addHabiles(TODAY, 1);
    CP_BONDS = LECAPS.filter(b => b.precio > 0 && b.vcto && diasACT(liq, parseDate(b.vcto)) > 0).slice(0, 8).map(b => ({ ticker: b.ticker, tipo: 'tf' }));
    switchSection('pesos'); switchTab('breakeven');
    await new Promise(r => setTimeout(r, 800));
    beCPRecalc();
    const filas = [...document.querySelectorAll('#be-cp-tbody tr')].filter(tr => tr.children.length >= 7);
    out.filas = filas.length;
    const tir = tr => parseFloat(tr.children[5].textContent);
    const bg = td => td.style.background || td.style.backgroundColor || '';
    out.sinColorTnaTem = filas.every(tr => !bg(tr.children[4]) && !bg(tr.children[6]));
    if (filas.length >= 2) {
      const ord = [...filas].sort((a, b) => tir(a) - tir(b));
      out.extremos = /74, 222, 128|74,222,128/.test(bg(ord[ord.length - 1].children[5])) && /248, 113, 113|248,113,113/.test(bg(ord[0].children[5]));
    }
    CP_BONDS = prev;
    beCPRecalc();
    return out;
  });
  check(cpc.percentiles && cpc.escala, 'el percentil reparte los empates y el medio de la escala va sin color', JSON.stringify(cpc));
  if (cpc.filas < 2) omitir('colores de la tabla del Resumen en vivo', 'menos de dos LECAP con precio');
  else check(cpc.sinColorTnaTem && cpc.extremos, 'en la tabla del Resumen sólo la TIR lleva color: la más alta verde, la más baja roja',
             JSON.stringify(cpc));

  // Cada fetcher de pesos repinta el Resumen al terminar. La tabla BE ·
  // Devaluación quedaba vacía al abrir la app porque dlkFetchPrices no lo hacía.
  console.log('\nLos precios de cada sector repintan el Resumen');
  const rep = await page.evaluate(async () => {
    try { await fetchData912('arg_bonds'); } catch (e) { return { sinRed: e.message }; }
    switchSection('pesos'); switchTab('breakeven');
    await new Promise(r => setTimeout(r, 800));
    const out = {};
    for (const [nombre, fn] of [['tasa fija', fetchPrices], ['CER', cerFetchPrices], ['TAMAR', tamarFetchPrices], ['DLK', dlkFetchPrices]]) {
      const tb = document.getElementById('be-deval-tbody');
      tb.innerHTML = '<tr><td>CENTINELA</td></tr>';
      await fn();
      out[nombre] = !tb.textContent.includes('CENTINELA');
    }
    return out;
  });
  if (rep.sinRed) omitir('los precios repintan el Resumen', 'data912 no responde: ' + rep.sinRed);
  else check(Object.values(rep).every(Boolean), 'traer los precios de tasa fija, CER, TAMAR y DLK repinta el Resumen', JSON.stringify(rep));

  // Retornos: TIR de salida, escenarios y camino de precio, en dólares y en
  // pesos (tasa fija y CER real). Un solo motor, así que se prueba igual.
  console.log('\nRetornos');
  const ret = await page.evaluate(async () => {
    const out = {};
    // Sintético: un bono que vence antes del corte paga lo mismo salga a la TIR
    // que salga.
    const fl = [{ fecha: '2027-01-04', cupon: 5, amortAmt: 100, flujo: 105 }];
    const v = retNucleo({ precio: 100, flujos: fl, liq: '2026-10-09', corte: '2027-06-01', tasa: 4, reinvertir: false });
    out.vence = v.vence && Math.abs(v.retorno(5) - 0.05) < 1e-12 && Math.abs(v.retorno(25) - 0.05) < 1e-12 && v.be0 === null;
    const probar = async (sec, abrir, fam) => {
      const o = { errores: [] };
      if (fam) { const P = retPref(sec); P.familias = [fam]; }
      abrir();
      await new Promise(r => setTimeout(r, 2500));
      const E = RET_ESTADO[sec], liq = retLiq(), corte = retCorte(sec);
      const ok = E.data.filter(r => !r.error);
      o.filas = ok.length;
      o.dom = document.querySelectorAll(`#${RET_SEC[sec].p}-tbody tr`).length;
      // Ordenados por duration modificada.
      const mds = E.data.map(r => r.md != null && isFinite(r.md) ? r.md : Infinity);
      if (mds.some((m, i) => i && m < mds[i - 1])) o.errores.push('no está ordenada por duration: ' + mds.join(' '));
      for (const r of ok) {
        // Reinvirtiendo a la TIR de hoy y saliendo a esa misma TIR, el retorno
        // es el valor futuro de los mismos flujos.
        const n = retNucleo({ precio: r.precio, flujos: r.flujos, liq, corte, tasa: r.tir, reinvertir: true });
        const fv = Math.pow(1 + r.tir / 100, n.dias / 365) - 1;
        if (Math.abs(n.retorno(r.tir) - fv) > 1e-4) o.errores.push(`${r.ticker}: TIR constante ${n.retorno(r.tir)} vs ${fv}`);
        if (r.be0 != null && Math.abs(r.n.retorno(r.be0)) > 1e-8) o.errores.push(`${r.ticker}: BE 0`);
        if (r.beReinv != null && Math.abs(r.n.retorno(r.beReinv) - r.n.objetivo) > 1e-8) o.errores.push(`${r.ticker}: BE reinv`);
        for (let i = 1; i < r.grilla.length; i++) if (r.grilla[i] > r.grilla[i - 1] + 1e-12) o.errores.push(`${r.ticker}: sube con la TIR de salida`);
        if (r.resto < RET_RESTO_MIN && r.be0 != null) o.errores.push(`${r.ticker}: vence ${r.resto} días después del corte y muestra breakeven`);
        // El precio de hoy es el valor presente de sus flujos a su TIR.
        const pv = retLimpio(r, liq, r.tir) + (r.fam.corrido ? r.fam.corrido(r, liq) : 0);
        if (Math.abs(pv / r.precio - 1) > 1e-4) o.errores.push(`${r.ticker}: valor presente ${pv} vs precio ${r.precio}`);
        // Sin picos: entre la fecha nominal de un cupón y su pago, lo corrido no
        // se pone en cero mientras el cupón sigue en el precio.
        if (r.fam.corrido) for (const f of r.flujos) {
          if (!f.fechaNominal || f.fechaNominal >= f.fecha || f.fecha <= liq || f.amortAmt > 0) continue;
          const ant = fmtDate(new Date(parseDate(f.fechaNominal).getTime() - 86400000));
          const salto = retLimpio(r, f.fechaNominal, r.tir) - retLimpio(r, ant, r.tir);
          if (Math.abs(salto) > 0.2) o.errores.push(`${r.ticker}: salto de ${salto.toFixed(3)} el ${f.fechaNominal}`);
        }
      }
      const sh = retShocks(E.data, liq);
      if (sh.length > 1) {
        const ord = [...sh].sort((a, b) => a.r.md - b.r.md);
        o.puntas = Math.abs(ord[0].dSteep + RET_PENDIENTE) < 1e-9 && Math.abs(ord[ord.length - 1].dSteep - RET_PENDIENTE) < 1e-9;
        o.paralelos = sh.every(f => f.paralelos[0] > f.paralelos[2] && f.paralelos[2] > 0 && f.paralelos[3] < 0 && f.paralelos[3] > f.paralelos[5]);
      }
      o.esc = document.querySelectorAll(`#${RET_SEC[sec].p}-esc-tbody tr`).length;
      // El camino de precio se dibuja cuando llega la historia.
      for (let i = 0; i < 20 && !E.chart; i++) await new Promise(r => setTimeout(r, 300));
      o.chart = E.chart ? E.chart.data.datasets.length : 0;
      o.salidas = retSalidas(sec).vals.length;
      o.sync = SUPA_USER_KEYS.includes(RET_SEC[sec].ls);
      return o;
    };
    out.usd = await probar('usd', () => { switchSection('usd'); switchUsdTab('usd-retornos'); });
    out.tf = await probar('ars', () => { switchSection('pesos'); switchTab('retornos'); }, 'tf');
    out.cer = await probar('ars', () => { retRender('ars'); }, 'cer');
    out.botones = !!document.getElementById('nav-usd-retornos') && !!document.getElementById('nav-retornos');
    // La grilla de TIR de salida: la elegida, la de por defecto si no sirve, y
    // un tope de columnas.
    switchSection('usd'); switchUsdTab('usd-retornos');
    await new Promise(r => setTimeout(r, 1200));
    const cols = () => [...document.querySelectorAll('#ret-thead th')].map(t => t.textContent).filter(t => /^-?[\d.]+%$/.test(t));
    const nota = () => document.getElementById('ret-g-nota').textContent;
    const prev = JSON.parse(JSON.stringify(retPref('usd').grilla || {}));
    retSetGrilla('usd', null);
    const def = cols();
    retSetGrilla('usd', 'min', 4); retSetGrilla('usd', 'max', 10); retSetGrilla('usd', 'paso', 2);
    const propia = cols();
    retSetGrilla('usd', 'paso', 0);
    const invalida = { cols: cols().length, nota: nota() };
    retSetGrilla('usd', 'min', 0); retSetGrilla('usd', 'max', 100); retSetGrilla('usd', 'paso', 1);
    const larga = { cols: cols().length, nota: nota() };
    retSetGrilla('usd', null);
    const vuelta = cols();
    const P = retPref('usd'); P.grilla = prev; retSetPref('usd', 'grilla', prev);
    out.grilla = { def: def.length, propia, invalida, larga, vuelta: vuelta.length };
    return out;
  });
  check(ret.vence, 'un bono que vence antes del corte rinde lo mismo con cualquier TIR de salida y no tiene breakeven');
  { const g = ret.grilla;
    check(g.def === 9 && g.propia.join(' ') === '4% 6% 8% 10%' && g.invalida.cols === 9 && /paso/.test(g.invalida.nota)
          && g.larga.cols === 25 && /25 de 101/.test(g.larga.nota) && g.vuelta === 9,
          'la grilla de TIR de salida se elige con desde, hasta y paso, vuelve a la de defecto si no sirve y corta en 25 columnas', JSON.stringify(g)); }
  check(ret.botones && ret.usd.sync && ret.tf.sync, 'Retornos está en pesos y en dólares, con preferencias por usuario');
  for (const [k, nombre] of [['usd', 'dólares'], ['tf', 'tasa fija'], ['cer', 'CER real']]) {
    const o = ret[k];
    if (!o.filas) { omitir(`retornos en ${nombre}`, 'sin bonos con precio'); continue; }
    check(o.errores.length === 0 && o.dom === o.filas,
          `retornos en ${nombre}: TIR constante = valor futuro, breakevens que empatan, retorno que baja con la TIR de salida y precio = valor presente`,
          `${o.filas} bonos · ` + o.errores.slice(0, 3).join(' · '));
    if (o.filas > 1) check(o.puntas && o.paralelos && o.esc === o.filas,
          `escenarios en ${nombre}: shocks paralelos ordenados y ±75 pb en las puntas del steepener`, JSON.stringify({ puntas: o.puntas, paralelos: o.paralelos, esc: o.esc }));
    check(o.chart === 3 + o.salidas, `camino de precio en ${nombre}: TIR simulada, cotización, TIR de mercado y abanico`, String(o.chart));
  }

  // El spread de legislación en TIR, contra su historia.
  console.log('\nSpread de legislación con historia');
  const sl = await page.evaluate(async () => {
    const out = {};
    const st = slegStats([1, 2, 3, 4, 5], 5);
    out.stats = Math.abs(st.media - 3) < 1e-12 && Math.abs(st.sd - Math.sqrt(2.5)) < 1e-12 && Math.abs(st.z - 2 / Math.sqrt(2.5)) < 1e-12 && st.pct === 100;
    switchSection('usd'); switchUsdTab('usd-spreadleg');
    for (let i = 0; i < 30 && !document.querySelector('#sleg-c-tbody tr'); i++) await new Promise(r => setTimeout(r, 300));
    await new Promise(r => setTimeout(r, 500));
    const pares = slegParesVivos();
    out.pares = pares.length;
    out.vivos = pares.filter(p => p.spread != null).length;
    out.cards = document.querySelectorAll('#sleg-cards > div').length;
    out.filas = document.querySelectorAll('#sleg-c-tbody tr').length;
    out.errores = [];
    const liq = bopFmtDate(G_LIQ || addHabiles(TODAY, 1));
    for (const p of pares.filter(x => x.spread != null)) {
      const b = BON_BONDS.find(x => x.ticker === p.bon), g = GLO_BONDS.find(x => x.ticker === p.glo);
      const sp = (bopTIR(b, liq, b.lastPrecio) - bopTIR(g, liq, g.lastPrecio)) * 100;
      if (Math.abs(sp - p.spread) > 1e-6) out.errores.push(`${p.label}: ${p.spread} vs ${sp}`);
    }
    // La historia del rango por defecto tiene ruedas para cada par.
    const { desde, hasta } = slegRango();
    try {
      const h = await slegTraerHistoria(desde, hasta);
      out.historia = [...h.values()].map(m => m.size);
    } catch (e) { out.historia = 'error: ' + e.message; }
    return out;
  });
  check(sl.stats, 'media, desvío, z y percentil del spread son los de la muestra');
  if (!sl.vivos) omitir('spread de legislación en vivo', 'sin precios de Bonares y Globales');
  else {
    check(sl.errores.length === 0 && sl.cards === sl.pares && sl.filas === sl.pares,
          'el spread de hoy es TIR del Bonar menos TIR del Global, con una tarjeta y una fila de canje por par',
          `${sl.vivos}/${sl.pares} pares · ` + sl.errores.slice(0, 2).join(' · '));
    check(Array.isArray(sl.historia) && sl.historia.every(n => n >= 20), 'cada par tiene historia en el rango por defecto', JSON.stringify(sl.historia));
  }

  // Desvío histórico contra la curva, en pesos y en dólares.
  console.log('\nDesvío histórico contra la curva');
  const dv = await page.evaluate(async () => {
    const out = {};
    // Sintético: puntos sobre y = 3 + 2·ln(x) salvo uno, 50 pb arriba.
    const filas = [5, 20, 60, 120, 250, 400].map((x, i) => ({ ticker: 'B' + i, dias: x, tir: 3 + 2 * Math.log(x) + (i === 3 ? 0.5 : 0) }));
    const m = desvDeRueda(filas, 'dias', 'log');
    out.sintetico = m && m.size === 6 && m.get('B3').d > 30 && [...m.values()].reduce((s, v) => s + v.d, 0) < 1e-6;
    const probar = async (sec, abrir, sector) => {
      abrir();
      await new Promise(r => setTimeout(r, 1200));
      desvSet(sec, 'modo', 'desvio');
      (sec === 'ars' ? curvasArsSetSector : curvasUsdSetSector)(sector);
      const res = await desvCalcular(sec, sector, '6M');
      await new Promise(r => setTimeout(r, 1500));
      const o = { filas: res.filas.length, ruedas: res.ruedas,
        dom: document.querySelectorAll(`#${desvCfg(sec).p}-dv-tabla tr`).length,
        chart: !!desvCharts[sec], errores: [] };
      for (const f of res.filas) if (f.st && Math.abs(f.st.z - (f.actual - f.st.media) / f.st.sd) > 1e-9) o.errores.push(f.ticker);
      // La curva de cada rueda deja los desvíos centrados: suman casi cero.
      const s = res.filas.reduce((a, f) => a + f.actual, 0);
      o.centrado = Math.abs(s) < 1e-6 * Math.max(1, res.filas.length);
      desvSet(sec, 'modo', 'curvas');
      return o;
    };
    out.ars = await probar('ars', () => { switchSection('pesos'); switchTab('curvas-ars'); }, 'CER');
    out.usd = await probar('usd', () => { switchSection('usd'); switchUsdTab('usd-curvas'); }, 'GLO');
    out.sync = SUPA_USER_KEYS.includes(DESV_LS);
    return out;
  });
  check(dv.sintetico, 'el desvío es la distancia a la curva de la rueda: centrado en cero y positivo para el que rinde de más');
  check(dv.sync, 'el modo y el rango del desvío viajan por usuario');
  for (const [k, nombre] of [['ars', 'pesos (CER)'], ['usd', 'dólares (Globales)']]) {
    const o = dv[k];
    if (!o.filas) { omitir(`desvío histórico en ${nombre}`, 'sin curva para hoy'); continue; }
    check(o.dom === o.filas && o.chart && o.ruedas > 20 && o.errores.length === 0,
          `desvío histórico en ${nombre}: una fila por bono, historia de la curva y z bien calculado`, JSON.stringify(o));
  }

  // A/B en Series: retorno total con lo cobrado, y el relativo.
  console.log('\nComparación A/B');
  const ab = await page.evaluate(async () => {
    const out = {};
    // Sintético: cobra 5 el segundo día y vence el tercero (precio cero).
    const precio = new Map([['2026-01-01', 100], ['2026-01-02', 98]]);
    const r = abRetornos(precio, [{ fecha: '2026-01-02', monto: 5 }, { fecha: '2026-01-03', monto: 100 }], ['2026-01-01', '2026-01-02', '2026-01-04']);
    out.sintetico = Math.abs(r[0]) < 1e-12 && Math.abs(r[1] - 0.03) < 1e-12 && Math.abs(r[2] - 0.05) < 1e-12;
    // Un CER cero cupón paga una vez: 100 por el coeficiente de su vencimiento.
    const lecer = CER_BONDS.find(b => b.tipo === 'lecer' && b.emision && b.vcto && b.vcto < hoyAR());
    if (lecer) {
      const f = abCerFlujos(lecer);
      const fac = cerGetValorCer(parseDate(lecer.vcto)) / cerGetValorCer(parseDate(lecer.emision));
      out.lecer = f.length === 1 && Math.abs(f[0].monto - 100 * fac) < 1e-9;
    }
    const probar = async (sec, abrir, a, b) => {
      abrir();
      await new Promise(r => setTimeout(r, 2000));
      const P = abPrefs()[sec]; P.a = a; P.b = b; P.vista = 'retorno';
      seriesSetModo(sec, 'ab');
      for (let i = 0; i < 30 && !(seriesEstado[sec].chart && seriesEstado[sec].chart.data.datasets.length === 3); i++) await new Promise(r => setTimeout(r, 300));
      const ch = seriesEstado[sec].chart;
      const o = { datasets: ch ? ch.data.datasets.length : 0, resumen: document.getElementById(`series-${sec}-ab-res`).textContent };
      if (ch && o.datasets === 3) {
        // En la última rueda con los dos: durante la rueda la foto de hoy puede
        // haber llegado para uno solo.
        const ds = ch.data.datasets, rel = ds[2].data[ds[2].data.length - 1];
        const ra = rel && ds[0].data.find(q => q.x === rel.x), rb = rel && ds[1].data.find(q => q.x === rel.x);
        o.relativo = ra && rb ? Math.abs(rel.y - 100 * (1 + ra.y / 100) / (1 + rb.y / 100)) < 1e-3 : null;
      }
      o.sectoresOcultos = document.getElementById(`series-${sec}-sectores`).style.display === 'none';
      seriesSetModo(sec, 'tasas');
      o.vuelve = document.getElementById(`series-${sec}-sectores`).style.display !== 'none' && document.getElementById(`series-${sec}-abbar`).style.display === 'none';
      return o;
    };
    const tf = LECAPS.find(x => x.precio > 0), cer = CER_BONDS.find(x => x.precio > 0 && !TAMAR_BONDS.some(t => t.ticker === x.ticker));
    out.ars = tf && cer ? await probar('ars', () => { switchSection('pesos'); switchTab('series-ars'); }, 'TF|' + tf.ticker, 'CER|' + cer.ticker) : null;
    const al = BON_BONDS.find(x => x.ticker === 'AL30'), gd = GLO_BONDS.find(x => x.ticker === 'GD30');
    out.usd = al && gd ? await probar('usd', () => { switchSection('usd'); switchUsdTab('usd-series'); }, 'BON|AL30', 'GLO|GD30') : null;
    out.sync = SUPA_USER_KEYS.includes(AB_LS);
    return out;
  });
  check(ab.sintetico, 'el retorno total suma lo cobrado y, después del último pago, queda en lo cobrado');
  if (ab.lecer != null) check(ab.lecer, 'un CER cero cupón paga 100 por el coeficiente de su vencimiento');
  check(ab.sync, 'la elección A/B viaja por usuario');
  for (const [k, nombre] of [['ars', 'pesos'], ['usd', 'dólares']]) {
    const o = ab[k];
    if (!o) { omitir(`A/B en ${nombre}`, 'sin instrumentos'); continue; }
    check(o.datasets === 3 && o.relativo === true && /rindió más/.test(o.resumen) && o.sectoresOcultos && o.vuelve,
          `A/B en ${nombre}: dos retornos totales y el relativo, y al salir vuelven los sectores`, JSON.stringify(o));
  }

  // Las matrices de forwards en pesos: sin "%%" ni infinitos.
  console.log('\nForwards en pesos');
  const fw = await page.evaluate(async () => {
    switchSection('pesos'); switchTab('forwards');
    await new Promise(r => setTimeout(r, 2000));
    const t = ['fwd-tf-wrap', 'fwd-cer-wrap', 'fwd-tamar-wrap'].map(id => (document.getElementById(id) || {}).innerText || '').join(' ');
    return { celdas: (t.match(/%/g) || []).length, dobles: (t.match(/%%/g) || []).length, infinitos: (t.match(/Infinity|NaN/g) || []).length };
  });
  if (!fw.celdas) omitir('matrices de forwards', 'sin tasas');
  else check(fw.dobles === 0 && fw.infinitos === 0, 'las matrices de forwards en pesos no muestran "%%" ni infinitos', JSON.stringify(fw));

  // Cartera: valores, DV01, escenarios y VaR, y que se vea igual desde las dos
  // secciones.
  console.log('\nCartera');
  const ca = await page.evaluate(async () => {
    const out = {};
    // Sintéticos: el retorno diario suma lo pagado, y el percentil interpola.
    const rd = cartRetornosDiarios(new Map([['2026-01-01', 100], ['2026-01-02', 101]]), [{ fecha: '2026-01-02', monto: 1 }]);
    out.retorno = Math.abs(rd.get('2026-01-02') - 0.02) < 1e-12;
    out.percentil = cartPercentil([1, 2, 3, 4, 5], 0.25) === 2 && cartPercentil([0, 10], 0.05) === 0.5;
    const previo = JSON.stringify(cartLeer());
    switchSection('pesos'); switchTab('cartera');
    await new Promise(r => setTimeout(r, 800));
    cartNueva();
    const c = cartActiva();
    const liq = bopFmtDate(G_LIQ || addHabiles(TODAY, 1));
    const tf = LECAPS.find(b => b.precio > 0 && parseDate(b.vcto) > parseDate(liq));
    const usd = BON_BONDS.find(b => b.lastPrecio > 0);
    if (!tf || !usd) { out.sinPrecios = true; CART = JSON.parse(previo); cartGuardar(); return out; }
    // Una posición en monto: los nominales salen del precio.
    document.getElementById('cart-inst').value = 'TF|' + tf.ticker;
    document.getElementById('cart-cant').value = '1000000';
    document.getElementById('cart-modo').value = 'monto';
    cartAgregar('ars');
    out.monto = Math.abs(c.pos[0].vn - 1000000 / tf.precio * 100) < 1e-6;
    c.pos.push({ inst: 'BON|' + usd.ticker, vn: 10000 });
    cartGuardar();
    await new Promise(r => setTimeout(r, 1500));
    const mep = _cartMep;
    out.mep = mep > 0;
    for (const vista of ['ARS', 'USD']) {
      const res = cartCalcular(c, vista, mep, liq);
      const suma = res.ok.reduce((s, p) => s + p.valorVista, 0);
      const dv01 = res.ok.reduce((s, p) => s + p.valorVista * p.md * 1e-4, 0);
      out[vista] = { total: Math.abs(res.total - suma) < 1e-6, dv01: Math.abs(res.dv01 - dv01) < 1e-6 };
    }
    // El escenario a una fecha, con la tasa fija sola: en cero devenga a su TIR,
    // y la palanca de referencia la descuenta a TIR + palanca.
    // Una letra que venza después del corte de tres meses.
    const tfL = LECAPS.filter(b => b.precio > 0 && parseDate(b.vcto) > new Date(parseDate(liq).getTime() + 120 * 86400000)).pop() || tf;
    const tfSola = { pos: [{ inst: 'TF|' + tfL.ticker, vn: 1000000 }], esc: { corte: null, reinvertir: false } };
    const resTF = cartCalcular(tfSola, 'ARS', mep, liq);
    const evTF = resTF.ok[0], ctx = cartEscContexto(resTF, tfSola);
    const pago = fmtDate(siguienteHabil(parseDate(tfL.vcto)));
    if (evTF && pago > ctx.corte) {
      const cero = { ref: 0, cer: 0, tamar: 0, fx: 0, usd: 0 };
      const base = cartEscValuar(resTF, ctx, cero, false).r;
      const conRef = cartEscValuar(resTF, ctx, { ...cero, ref: 100 }, false).r;
      const vf = evTF.flujos[0].flujo, t = diasACT(parseDate(ctx.corte), parseDate(pago)) / 365;
      out.escTF = Math.abs(base - (Math.pow(1 + evTF.y / 100, ctx.dias / 365) - 1)) < 1e-9
        && Math.abs(conRef - (vf / Math.pow(1 + (evTF.y + 1) / 100, t) / evTF.precio - 1)) < 1e-9;
      tfSola.esc.ref = 100;
      const esc = cartEscCalcular(resTF, tfSola);
      out.unaPalanca = Math.abs(esc.interaccion) < 1e-12;
    }
    // Con dólares solos vistos en pesos, la devaluación multiplica el valor al corte.
    const usdSola = { pos: [{ inst: 'BON|' + usd.ticker, vn: 10000 }], esc: { reinvertir: true } };
    const resU = cartCalcular(usdSola, 'ARS', mep, liq), ctxU = cartEscContexto(resU, usdSola);
    const v0 = cartEscValuar(resU, ctxU, { ref: 0, cer: 0, tamar: 0, fx: 0, usd: 0 }, true).corte;
    const v10 = cartEscValuar(resU, ctxU, { ref: 0, cer: 0, tamar: 0, fx: 10, usd: 0 }, true).corte;
    out.fxEsc = Math.abs(v10 / v0 - 1.1) < 1e-9;
    // TAMAR y CER: cada palanca mueve su familia para el lado que corresponde.
    const tam = TAMAR_BONDS.find(b => b.precio > 0 && !dualTipo(b) && parseDate(b.vcto) > parseDate(liq));
    const cer = CER_BONDS.find(b => b.precio > 0 && !TAMAR_BONDS.some(t => t.ticker === b.ticker) && parseDate(b.vcto) > new Date(parseDate(liq).getTime() + 200 * 86400000));
    if (tam && cer) {
      const cc = { pos: [{ inst: 'TAMAR|' + tam.ticker, vn: 1e6 }, { inst: 'CER|' + cer.ticker, vn: 1e6 }], esc: { reinvertir: true } };
      const rc = cartCalcular(cc, 'ARS', mep, liq), cx = cartEscContexto(rc, cc);
      const L0 = { ref: 0, cer: 0, tamar: 0, fx: 0, usd: 0 };
      const val = L => { const v = cartEscValuar(rc, cx, L, true).pos; return v.map(x => x.corte); };
      const b0 = val(L0), tUp = val({ ...L0, tamar: 500 }), cUp = val({ ...L0, cer: 100 });
      out.palancas = tUp[0] > b0[0] && Math.abs(tUp[1] - b0[1]) < 1e-9 && cUp[1] < b0[1] && Math.abs(cUp[0] - b0[0]) < 1e-9;
    }
    // La pantalla: cinco palancas con su curva, y la descomposición.
    switchSection('pesos'); switchTab('cartera');
    await new Promise(r => setTimeout(r, 1500));
    out.palancasDom = document.querySelectorAll('#cart-e-palancas input[type=range]').length === 5
      && document.querySelectorAll('#cart-e-palancas canvas').length === 5
      && document.querySelectorAll('#cart-e-desc tr').length === 8;
    // La misma cartera desde dólares.
    switchSection('usd'); switchUsdTab('usd-cartera');
    await new Promise(r => setTimeout(r, 1500));
    out.desdeUsd = document.querySelectorAll('#ucart-tbody tr').length === c.pos.length && document.getElementById('ucart-sel').value === c.id;
    out.botones = !!document.getElementById('nav-cartera') && !!document.getElementById('nav-usd-cartera');
    out.sync = SUPA_USER_KEYS.includes(CART_LS);
    CART = JSON.parse(previo); cartGuardar();
    return out;
  });
  check(ca.retorno && ca.percentil, 'el retorno diario de la cartera suma lo cobrado y el percentil del VaR interpola');
  if (ca.sinPrecios) omitir('cartera en vivo', 'sin precios de tasa fija o de Bonares');
  else {
    check(ca.monto, 'una posición cargada en monto se pasa a nominales con el precio');
    check(ca.mep && ['ARS', 'USD'].every(v => ca[v].total && ca[v].dv01),
          'en pesos y en dólares: el total suma las posiciones y el DV01 es valor × MD', JSON.stringify({ ARS: ca.ARS, USD: ca.USD }));
    if (ca.escTF == null) omitir('escenario de tasa fija al corte', 'la letra vence antes del corte');
    else check(ca.escTF && ca.unaPalanca, 'escenario al corte: en cero la tasa fija devenga a su TIR, la palanca de referencia la descuenta a TIR + palanca, y con una sola palanca no hay interacción');
    check(ca.fxEsc, 'escenario al corte: con dólares vistos en pesos, la devaluación multiplica el valor');
    if (ca.palancas == null) omitir('palancas de TAMAR y CER', 'sin TAMAR o CER con precio');
    else check(ca.palancas, 'escenario al corte: la palanca de TAMAR sube el TAMAR y no toca el CER; la de CER real baja el CER y no toca el TAMAR');
    check(ca.palancasDom, 'el escenario muestra las cinco palancas con su curva y la descomposición');
    check(ca.desdeUsd && ca.botones && ca.sync, 'la misma cartera se ve desde las dos secciones y viaja por usuario', JSON.stringify(ca));
  }

  // Serie histórica del BE de inflación, reconstruida rueda por rueda. Lo que hay
  // que cuidar es no usar CER que ese día no estaba publicado.
  console.log('\nSerie histórica del BE de inflación');
  const serieBE = await page.evaluate(async () => {
    const out = {};
    // El horizonte del CER: hasta el 15 del mes siguiente si la rueda es del 15
    // en adelante, y hasta el 15 del propio mes si es antes.
    out.horizontes = ['2026-09-17', '2026-09-05', '2026-03-31', '2026-03-01']
      .map(f => beHorizonteCer(f));
    // Y en ninguna fecha pasada se usa un CER posterior a su horizonte.
    out.sinFuturo = ['2026-01-20', '2026-05-06', '2026-08-31'].every(f => {
      const c = beCerConocidoAl(f);
      return c && c.fecha <= beHorizonteCer(f);
    });
    const guardado = [...(BE_BONOS || [])];
    const liq = G_LIQ || addHabiles(TODAY, 1);
    // Dos CER cero cupón con LECAP de su plazo. Con menos de tres meses por
    // delante el fixing puede haber pasado ya y no hay número con el que comparar.
    const cands = CER_BONDS.filter(b => b.tipo !== 'cupon' && b.vcto && b.precio > 0 && b.emision &&
      diasACT(liq, parseDate(b.vcto)) > 90 && beFindTF(b.vcto))
      .sort((a, b) => a.vcto.localeCompare(b.vcto)).map(b => b.ticker).slice(0, 2);
    if (!cands.length) return { ...out, sinBonos: true };
    BE_BONOS = cands;
    const hasta = fmtDate(TODAY);
    const d = parseDate(hasta); d.setMonth(d.getMonth() - 4);
    let serie = null, error = null;
    try { serie = await seriesTraerBEInfla(fmtDate(d), hasta); } catch (e) { error = e.message; }
    BE_BONOS = guardado; beSaveLs();
    if (!serie) return { ...out, error };
    const ipc = serie.porBono.get('IPC publicado');
    // Las líneas van por vencimiento, no por el orden en que se eligieron, y la
    // referencia al final. Se eligen al revés a propósito.
    BE_BONOS = [...cands].reverse();
    let inv = null;
    try { inv = await seriesTraerBEInfla(fmtDate(d), hasta); } catch (e) {}
    BE_BONOS = guardado; beSaveLs();
    out.orden = inv ? inv.orden.map(t => {
      const b = CER_BONDS.find(x => x.ticker === t);
      return b ? b.vcto : 'zzz';
    }) : null;
    const ult = t => { const m = serie.porBono.get(t); if (!m) return null;
      const k = [...m.keys()].sort(); return m.get(k[k.length - 1]); };
    // El último punto de cada bono contra la tabla de hoy: el precio de la rueda
    // archivada no es el de la pantalla, así que se compara con tolerancia.
    out.contraPanel = cands.map(t => {
      const p = beCalcular(t);
      return { t, serie: ult(t), panel: p && p.inflaBE };
    });
    // El IPC publicado tiene que coincidir con el último mes que el sendero marca
    // como publicado, que se detecta por otro camino.
    const pub = [...PROJ_INFLACION].filter(r => r.tipo === 'publicado').pop();
    out.ipc = { serie: ult('IPC publicado'), sendero: pub && pub.infla };
    out.series = [...serie.porBono.keys()];
    out.ruedas = serie.fechas.length;
    out.conIpc = !!ipc;
    out.nota = serie.nota;
    return out;
  });
  check(serieBE.horizontes[0] === '2026-10-15' && serieBE.horizontes[1] === '2026-09-15'
        && serieBE.horizontes[2] === '2026-04-15' && serieBE.horizontes[3] === '2026-03-15',
        'el horizonte del CER de cada rueda sigue la convención del 15',
        (serieBE.horizontes || []).join(' · '));
  check(serieBE.sinFuturo, 'ninguna rueda pasada usa un CER que todavía no estaba publicado');
  if (serieBE.sinBonos) omitir('la serie del BE de inflación', 'ningún CER cero cupón con LECAP de su plazo');
  else if (serieBE.error) omitir('la serie del BE de inflación', serieBE.error);
  else {
    check(serieBE.ruedas > 20 && serieBE.conIpc && /CER publicado/.test(serieBE.nota || ''),
          'la serie trae varias ruedas y el IPC publicado al lado',
          `${serieBE.ruedas} ruedas · ${serieBE.series.join(', ')}`);
    // La tabla usa el precio de pantalla y la serie el de la rueda archivada, así
    // que se comparan con tolerancia. Alcanza con que un bono se pueda comparar:
    // el otro puede no tener número hoy (sin LECAP del plazo, fixing pasado).
    const comparables = serieBE.contraPanel.filter(x => x.serie > 0 && x.panel > 0);
    const fmt = x => `${x.t} serie ${x.serie.toFixed(2)}% vs tabla ${x.panel.toFixed(2)}%`;
    if (!comparables.length) omitir('la serie contra la tabla', 'ningún bono con número en las dos');
    else check(comparables.every(x => x.serie > 0.3 && x.serie < 6 && Math.abs(x.serie - x.panel) < 0.5),
               'el último punto de la serie coincide con la tabla del Resumen',
               comparables.map(fmt).join(' · '));
    check(serieBE.ipc.sendero == null || Math.abs(serieBE.ipc.serie - serieBE.ipc.sendero) < 0.06,
          'el IPC publicado de la serie es el último mes publicado',
          `serie ${serieBE.ipc.serie} · sendero ${serieBE.ipc.sendero}`);
    check(serieBE.orden && serieBE.orden.length > 1
          && serieBE.orden.every((v, i) => i === 0 || serieBE.orden[i - 1] <= v),
          'las líneas van por vencimiento aunque los bonos se elijan al revés',
          (serieBE.orden || []).join(' → '));
  }

  // Serie histórica de la TAMAR real, con el mismo núcleo que la tabla.
  console.log('\nSerie histórica de la TAMAR real');
  const serieTR = await page.evaluate(async () => {
    const out = {};
    const liq = G_LIQ || addHabiles(TODAY, 1);
    // La ventana de TAMAR sin corte tiene que dar lo mismo que la solapa TAMAR.
    const bono = TAMAR_BONDS.find(b => b.vcto && b.emision && b.precio > 0 &&
      diasACT(liq, parseDate(b.vcto)) > 60 && tamarEnrich(b)._debug);
    if (!bono) return { sinBono: true };
    const d = tamarEnrich(bono)._debug;
    const v = betrVentanaTamar(bono, null);
    out.ventana = { ticker: bono.ticker, igualP: v.P === d.DIAS_TAMAR_PROYECTAR,
      igualT: v.T === d.DIAS_TAMAR_TRANSCURRIDOS,
      igualTem: Math.abs(v.tem * 100 - d.TAMAR_MARGEN_DIAS_TRANSCURRIDOS) < 1e-9,
      P: v.P, T: v.T };
    // Con un corte hacia atrás, queda menos devengado y más por proyectar.
    const atras = fmtDate(new Date(TODAY.getTime() - 60 * 86400000));
    const c = betrVentanaTamar(bono, atras);
    out.corte = c ? { P: c.P, T: c.T, ult: c.ult.fecha, respeta: c.ult.fecha <= atras,
      masProy: c.P > v.P, menosTransc: c.T < v.T } : null;
    // La serie, con un CER elegido para ese bono.
    const cerCand = CER_BONDS.filter(b => b.tipo !== 'cupon' && b.vcto && b.precio > 0 && b.emision &&
      diasACT(liq, parseDate(b.vcto)) > 60).sort((a, b) =>
        Math.abs(diasACT(parseDate(bono.vcto), parseDate(a.vcto))) - Math.abs(diasACT(parseDate(bono.vcto), parseDate(b.vcto))));
    if (!cerCand.length) return { ...out, sinCer: true };
    const guardado = JSON.parse(JSON.stringify(BETR_CER || {}));
    BETR_CER = { [bono.ticker]: [cerCand[0].ticker] };
    const hasta = fmtDate(TODAY);
    const dd = parseDate(hasta); dd.setMonth(dd.getMonth() - 4);
    let serie = null, error = null;
    try { serie = await seriesTraerTamarReal(fmtDate(dd), hasta); } catch (e) { error = e.message; }
    const panel = betrDe(bono.ticker, [cerCand[0].ticker]);
    BETR_CER = guardado; betrSaveLs();
    if (!serie) return { ...out, error };
    const m = serie.porBono.get(bono.ticker);
    const k = m ? [...m.keys()].sort() : [];
    out.serie = { ruedas: serie.fechas.length, series: [...serie.porBono.keys()],
      conObservada: serie.porBono.has('TAMAR real observada'), nota: serie.nota,
      ultimo: k.length ? m.get(k[k.length - 1]) : null,
      panel: panel && !panel.error ? panel.tnaAprox * 100 : null,
      finitos: k.every(f => isFinite(m.get(f))) };
    return out;
  });
  if (serieTR.sinBono) omitir('la serie de la TAMAR real', 'ningún bono TAMAR con datos');
  else {
    check(serieTR.ventana.igualP && serieTR.ventana.igualT && serieTR.ventana.igualTem,
          'la ventana de TAMAR sin corte da lo mismo que la solapa TAMAR',
          `${serieTR.ventana.ticker}: ${serieTR.ventana.T} devengados · ${serieTR.ventana.P} a proyectar`);
    check(serieTR.corte && serieTR.corte.respeta && serieTR.corte.masProy && serieTR.corte.menosTransc,
          'cortada a una fecha pasada, no usa TAMAR posterior y queda más por proyectar',
          serieTR.corte ? `hasta ${serieTR.corte.ult}: ${serieTR.corte.T} y ${serieTR.corte.P}` : '—');
    if (serieTR.sinCer) omitir('la serie de la TAMAR real', 'ningún CER con plazo para comparar');
    else if (serieTR.error) omitir('la serie de la TAMAR real', serieTR.error);
    else {
      check(serieTR.serie.ruedas > 20 && serieTR.serie.finitos && serieTR.serie.conObservada
            && /sin corrección/.test(serieTR.serie.nota || ''),
            'la serie trae varias ruedas, la TAMAR real observada y avisa por el margen',
            `${serieTR.serie.ruedas} ruedas · ${serieTR.serie.series.join(', ')}`);
      // El despeje amplifica el precio por (devengados + a proyectar) / a proyectar,
      // así que contra la tabla se compara con tolerancia ancha: la serie usa el
      // precio de la rueda archivada y la tabla el de pantalla.
      check(serieTR.serie.panel == null ||
            Math.abs(serieTR.serie.ultimo - serieTR.serie.panel) < 1.5,
            'el último punto de la serie acompaña a la tabla del Resumen',
            `serie ${serieTR.serie.ultimo.toFixed(2)}% vs tabla ${serieTR.serie.panel && serieTR.serie.panel.toFixed(2)}%`);
    }
  }

  // Paginado: sin él, un rango largo se cortaba en las primeras 1000 filas.
  const pagSeries = await page.evaluate(async () => {
    const hasta = fmtDate(TODAY);
    const d = parseDate(hasta); d.setMonth(d.getMonth() - 8);
    const s = await seriesTraerSector('CER', fmtDate(d), hasta);
    let filas = 0; for (const m of s.porBono.values()) filas += m.size;
    return { fechas: s.fechas.length, bonos: s.porBono.size, filas };
  });
  check(pagSeries.filas > 1000 && pagSeries.fechas > 100,
        'un rango largo trae todas las ruedas y no las primeras mil filas',
        `${pagSeries.fechas} ruedas · ${pagSeries.bonos} bonos · ${pagSeries.filas} puntos`);

  // Los dos selectores del Resumen son chips ordenados por vencimiento, y los
  // bonos vencidos no se ofrecen.
  console.log('\nResumen: chips para elegir bonos');
  const chips = await page.evaluate(() => {
    const liq = G_LIQ || addHabiles(TODAY, 1);
    const vencidos = lista => lista.filter(b => b.vcto && diasACT(liq, parseDate(b.vcto)) <= 0).map(b => b.ticker);
    beRenderChips(); beTamarRenderChips();
    const leer = id => [...document.querySelectorAll('#' + id + ' button')].map(b => b.textContent.trim());
    const cer = leer('be-chips'), tamar = leer('be-tamar-chips');
    const ordenado = (ch, lista) => {
      const v = ch.map(t => (lista.find(b => b.ticker === t) || {}).vcto || '');
      return v.length > 1 && v.every((x, i) => i === 0 || v[i - 1] <= x);
    };
    // Un clic agrega y otro saca.
    const antes = [...BE_BONOS];
    const tk = cer[0];
    beToggleBono(tk); const alta = BE_BONOS.includes(tk);
    beToggleBono(tk); const baja = !BE_BONOS.includes(tk);
    BE_BONOS = antes; beSaveLs(); beRecalc();
    return { cer, tamar, ordenCer: ordenado(cer, CER_BONDS), ordenTamar: ordenado(tamar, TAMAR_BONDS),
      vencidosOfrecidos: [...vencidos(CER_BONDS).filter(t => cer.includes(t)),
                          ...vencidos(TAMAR_BONDS).filter(t => tamar.includes(t))],
      nVencidos: vencidos(CER_BONDS).length + vencidos(TAMAR_BONDS).length,
      alta, baja, modalViejo: !!document.getElementById('be-modal') };
  });
  check(chips.cer.length > 0 && chips.ordenCer && chips.tamar.length > 0 && chips.ordenTamar,
        'los chips de CER y de TAMAR van ordenados por vencimiento',
        `${chips.cer.length} CER · ${chips.tamar.length} TAMAR`);
  if (!chips.nVencidos) omitir('los vencidos no se ofrecen', 'no hay bonos vencidos cargados');
  else check(!chips.vencidosOfrecidos.length, 'ningún bono vencido aparece como opción',
             `${chips.nVencidos} vencidos, ninguno ofrecido`);
  check(chips.alta && chips.baja, 'un clic en el chip agrega y otro saca');
  check(!chips.modalViejo, 'el modal viejo de BE · Inflación ya no existe');

  // BE · Inflación contra el REM: el breakeven solo no dice si el mercado pide
  // más o menos inflación que los analistas.
  console.log('\nBE · Inflación contra el REM');
  const beRem = await page.evaluate(() => {
    const out = {};
    // Con un REM inventado de 2% por mes, el promedio tiene que dar 2%, y si el
    // REM no cubre los meses pedidos no se compara.
    const guardado = REM_DATA;
    REM_DATA = { relevamiento: '2026-08-31', anclas: {},
      ipc: [{ mes: '2026-09', v: 2 }, { mes: '2026-10', v: 2 }, { mes: '2026-11', v: 2 }] };
    const tres = betrRemMensual('2026-09', '2026-11');
    out.promedio = tres && tres.mensual;
    out.meses = tres && tres.meses;
    out.fuera = betrRemMensual('2026-09', '2027-06');
    REM_DATA = guardado;
    // Y con el REM real, sobre los bonos CER que tengan LECAP de su plazo.
    const liq = G_LIQ || addHabiles(TODAY, 1);
    const candidatos = CER_BONDS.filter(b => b.tipo !== 'cupon' && b.vcto && b.precio > 0 &&
      diasACT(liq, parseDate(b.vcto)) > 0).map(b => b.ticker);
    const guardadoBonos = BE_BONOS;
    BE_BONOS = candidatos.slice(0, 4);
    beRecalc();
    out.filas = [...document.querySelectorAll('#be-tbody tr')].length;
    out.cuentas = BE_BONOS.map(t => beCalcular(t)).filter(x => x && !x.error && x.rem)
      .map(x => ({ ok: Math.abs(x.difRem - (x.inflaBE - x.rem.mensual)) < 1e-9,
                   cubre: !!(x.ventana && x.ventana.meses.length
                     && x.ventana.meses.reduce((t, m) => t + m.dias, 0) === x.diasRestantes) }));
    BE_BONOS = guardadoBonos;
    beRecalc();
    // La primera tabla de la columna es la de BE · Inflación.
    const thead = document.querySelector('#be-col1 table thead');
    out.encabezado = thead ? thead.textContent.replace(/\s+/g, ' ').trim() : '';
    // El color de la diferencia: ámbar arriba del REM, azul abajo, gris cuando
    // es chica, y sin REM no hay número.
    const rem = { mensual: 1.8, meses: 3, desde: '2026-09', hasta: '2026-11', conAncla: false, relevamiento: '2026-08-31' };
    const color = t => (t.match(/color:(var\(--[a-z0-9]+\))/) || [])[1];
    out.colores = {
      arriba: color(beCeldaRem({ difRem: 0.2, inflaBE: 2, rem })),
      abajo: color(beCeldaRem({ difRem: -0.2, inflaBE: 1.6, rem })),
      chica: color(beCeldaRem({ difRem: 0.01, inflaBE: 1.81, rem })),
      sinRem: beCeldaRem({ difRem: null }).includes('—'),
    };
    return out;
  });
  check(Math.abs(beRem.promedio - 2) < 1e-9 && beRem.meses === 3 && beRem.fuera === null,
        'el promedio del REM son los meses del período, y sin cobertura no se compara',
        `${beRem.promedio} en ${beRem.meses} meses`);
  check(/vs REM/i.test(beRem.encabezado || ''), 'la tabla BE trae la columna contra el REM', beRem.encabezado);
  check(beRem.colores.arriba === 'var(--warn)' && beRem.colores.abajo === 'var(--info)'
        && beRem.colores.chica === 'var(--text3)' && beRem.colores.sinRem,
        'el color de la diferencia separa arriba, abajo y diferencia chica',
        `+0,20 ${beRem.colores.arriba} · −0,20 ${beRem.colores.abajo} · +0,01 ${beRem.colores.chica}`);
  if (!beRem.cuentas.length) omitir('la diferencia contra el REM', 'ningún bono CER con LECAP de su plazo y REM que cubra');
  else check(beRem.cuentas.every(c => c.ok && c.cubre),
             'la diferencia es el breakeven menos el REM de la misma ventana',
             `${beRem.cuentas.length} bono(s)`);

  // El precio al lado de la tasa, en el globo de cada gráfico de tasa. Mostrarlo
  // es fácil; lo que hay que sostener es que salga de la misma fila que la tasa
  // —un precio de otra rueda junto a la tasa de hoy no se nota mirando— y que
  // lleve el símbolo de su moneda: los sectores USD guardan el precio MEP.
  console.log('\nPrecio junto a la tasa');
  const pxFmt = await page.evaluate(() => ({
    chico: fmtPrecio(72.35),
    medio: fmtPrecio(980.25),
    centavos: fmtPrecio(0.0958, 'US$'),
    grande: fmtPrecio(132480.17),
    vacio: fmtPrecio(null),
    usd: fmtPrecio(72.35, 'US$'),
    tip: curvasPxTip({ precio: 980.25 }, '$'),
    tipUsd: curvasPxTip({ precio: 72.35 }, 'US$'),
    tipSin: curvasPxTip({}, '$'),
  }));
  check(pxFmt.chico === '$72,35' && pxFmt.medio === '$980,25' && pxFmt.grande === '$132.480'
        && pxFmt.vacio === '—' && pxFmt.usd === 'US$72,35' && pxFmt.centavos === 'US$0,0958',
        'el precio se escribe como en las tablas, con más decimales abajo de un peso',
        JSON.stringify(pxFmt));
  check(/\$980,25$/.test(pxFmt.tip) && /US\$72,35$/.test(pxFmt.tipUsd) && pxFmt.tipSin === '',
        'las curvas lo agregan con el símbolo de su moneda, y un punto sin precio no agrega nada',
        JSON.stringify([pxFmt.tip, pxFmt.tipUsd, pxFmt.tipSin]));

  const pxScatter = await page.evaluate(() => {
    switchSection('pesos'); switchTab('cer');
    cerRenderTabChart();
    if (!cerTabChart) return { sinChart: true };
    const lab = cerTabChart.options.plugins.tooltip.callbacks.label;
    const con = lab({ raw: { x: 512, y: 9.84, precio: 1284.5 } });
    const sin = lab({ raw: { x: 512, y: 9.84, precio: null } });
    // El punto tiene que traer el precio de SU bono, no el de otro.
    const pts = cerTabChart.data.datasets[1].data;
    const p = pts[0] || {};
    const bono = CER_BONDS.find(b => b.ticker === p.ticker);
    return { con, sin, n: pts.length, ticker: p.ticker,
             precio: p.precio, delBono: bono ? bono.precio : null };
  });
  if (pxScatter.sinChart) omitir('el globo de los scatter de tasa', 'sin índice CER: no se dibujó la curva');
  else {
    check(Array.isArray(pxScatter.con) && pxScatter.con.length === 2 && /^Precio \$1\.285$/.test(pxScatter.con[1]),
          'el globo de la curva CER suma una línea con el precio', JSON.stringify(pxScatter.con));
    check(Array.isArray(pxScatter.sin) && pxScatter.sin.length === 1,
          'sin precio queda sólo la tasa: la caución y los sintéticos no tienen precio',
          JSON.stringify(pxScatter.sin));
    check(pxScatter.precio != null && pxScatter.precio === pxScatter.delBono,
          'el punto lleva el precio de ese bono',
          `${pxScatter.ticker}: ${pxScatter.precio} vs ${pxScatter.delBono}`);
  }

  const pxUsd = await page.evaluate(() => {
    switchSection('usd'); switchUsdTab('usd-bonares');
    usdFamChartRender(USD_FAM.bon);
    const out = { moneda: usdCurrency, simbolo: usdSimbolo() };
    const ch = USD_FAM.bon.chart;
    if (ch && ch.data.datasets[0].data.length) {
      const p = ch.data.datasets[0].data[0];
      const b = BON_BONDS.find(x => x.ticker === p.ticker);
      out.fam = ch.options.plugins.tooltip.callbacks.label({ datasetIndex: 0, dataIndex: 0 });
      out.famPrecio = p.precio;
      out.famDelBono = b ? (b.lastPrecioDisplay ?? b.lastPrecio) : null;
    }
    // Resumen: el globo es HTML propio, así que se lee el nodo que escribe. El
    // gráfico dibuja los bonos que el usuario haya elegido; si no eligió
    // ninguno se le prestan tres y se le devuelve la selección.
    switchUsdTab('usd-resumen');
    const elegidos = [...usdResState.chartBonds];
    if (!BON_BONDS.length) bonLoad();
    if (!elegidos.length) usdResState.chartBonds = BON_BONDS.slice(0, 3).map(b => b.ticker);
    usdResChartRenderIndep();
    if (usdResChart) {
      const ds = usdResChart.data.datasets.findIndex(d => d.showLine === false);
      if (ds >= 0 && usdResChart.data.datasets[ds].data.length) {
        usdResChart.options.plugins.tooltip.external({
          chart: usdResChart,
          tooltip: { opacity: 1, caretX: 0, caretY: 0,
                     dataPoints: [{ datasetIndex: ds, dataIndex: 0, raw: usdResChart.data.datasets[ds].data[0] }] },
        });
        const el = document.getElementById('ures-chart-tooltip');
        out.res = el ? el.textContent : '';
      }
    }
    usdResState.chartBonds = elegidos;
    usdResChartRenderIndep();
    return out;
  });
  if (pxUsd.famDelBono == null) omitir('el globo de los Bonares', 'sin precios en vivo');
  else {
    check(/TIR .*% · MD .*· (US\$|\$)[\d.,]+$/.test(pxUsd.fam || ''),
          'el globo de los Bonares cierra con el precio', pxUsd.fam);
    check(pxUsd.famPrecio === pxUsd.famDelBono,
          'y es el precio que muestra la tabla, en la moneda del selector',
          `${pxUsd.famPrecio} vs ${pxUsd.famDelBono} (${pxUsd.moneda})`);
  }
  if (!pxUsd.res) omitir('el globo del Resumen USD', 'sin precios en vivo');
  else check(/MD .*TIR .*% · (US\$|\$)[\d.,]+$/.test(pxUsd.res),
             'el globo del Resumen USD cierra con el precio', pxUsd.res);

  // En Series el precio no sale del bono en memoria sino del snapshot de esa
  // rueda: es el único lugar donde la tasa y el precio podrían terminar siendo
  // de días distintos.
  for (const [sec, tab, ir, sector, simb] of [
    ['ars', 'series-ars', 'switchTab', 'CER', '$'],
    ['usd', 'usd-series', 'switchUsdTab', 'BON', 'US$'],
  ]) {
    const r = await page.evaluate(async ([s, t, fn, sector, simb]) => {
      if (fn === 'switchTab') { switchSection('pesos'); switchTab(t); }
      else { switchSection('usd'); switchUsdTab(t); }
      seriesSetSector(s, sector);
      await new Promise(r => setTimeout(r, 4000));
      const st = seriesEstado[s];
      if (!st.chart || !st.cache.precios || !st.cache.precios.size) return { sinDatos: true };
      const tk = [...st.cache.precios.keys()][0];
      const serie = st.cache.precios.get(tk);
      const idx = st.cache.fechas.findIndex(f => serie.has(f));
      if (idx < 0) return { sinDatos: true };
      const lab = st.chart.options.plugins.tooltip.callbacks.label;
      const out = lab({ parsed: { y: 12.34 }, raw: 12.34, dataset: { label: tk }, dataIndex: idx });
      // Una serie sin precio guardado no puede inventar uno.
      const vacio = lab({ parsed: { y: 12.34 }, raw: 12.34, dataset: { label: '__no_existe__' }, dataIndex: idx });
      const fecha = st.cache.fechas[idx];
      return { tk, fecha, out, vacio, esperado: `Precio ${fmtPrecio(serie.get(fecha), simb)}` };
    }, [sec, tab, ir, sector, simb]);
    if (r.sinDatos) { omitir(`${sec}: el globo de la serie trae el precio`, 'sin ruedas con precio guardado'); continue; }
    check(Array.isArray(r.out) && r.out.length === 2 && r.out[1] === r.esperado,
          `${sec}: el globo de la serie trae el precio de esa rueda`,
          `${r.tk} ${r.fecha} → ${JSON.stringify(r.out)}`);
    check(typeof r.vacio === 'string',
          `${sec}: una serie sin precio guardado muestra sólo la tasa`, JSON.stringify(r.vacio));
  }

  console.log('\nEscenarios');
  const esc = await page.evaluate(() => {
    switchSection('pesos'); switchTab('escenarios');
    const mk = () => escNormalizar({ horizonte: 12 });
    const con = (k, v, modo) => { const e = mk(); e.palancas[k].tramos[0].v = v; if (modo) e.palancas[k].modo = modo; return e; };

    // El invariante que hace seguro todo el panel: un escenario no puede dejar
    // rastro en los senderos que usa el resto de la app.
    const foto = () => JSON.stringify([PROJ_INFLACION, PROJ_TAMAR, PROJ_TCN, PROJ_FUENTE,
      CER_PROJ.size, [...CER_PROJ.values()].slice(0, 5)]);
    const antes = foto();
    const base = escCalcular(mk());
    escCalcular(con('infl', 90));
    escCalcular(con('tamar', 70));
    escCalcular(con('tcn', 85));
    const despues = foto();

    // Cada palanca mueve lo suyo y nada más.
    const tea = (r, t) => { const i = r && r.items.find(x => x.ticker === t); return i ? i.tea : null; };
    const unTf = (LECAPS.find(b => b.precio > 0) || {}).ticker;
    const inflAlta = escCalcular(con('infl', 90));
    const rollAlto = escCalcular(con('tamar', 60)).roll;
    const rollBajo = escCalcular(con('tamar', 10)).roll;

    // TAMAR real: poner la nominal que implica tiene que dar el mismo real.
    const eR = con('tamar', 5, 'real'); eR.palancas.infl.tramos[0].v = 25;
    const real = escCalcular(eR);
    const eN = escNormalizar(JSON.parse(JSON.stringify(eR)));
    eN.palancas.tamar.modo = 'nominal'; eN.palancas.tamar.tramos[0].v = real.tnaH;
    const nominal = escCalcular(eN);

    // Un tramo es el caso degenerado de N tramos.
    const uno = mk(); uno.palancas.tamar.tramos = [{ hasta: null, v: 30 }];
    const dos = mk(); dos.palancas.tamar.tramos = [{ hasta: 6, v: 30 }, { hasta: null, v: 30 }];
    const baja = mk(); baja.palancas.tamar.tramos = [{ hasta: 6, v: 30 }, { hasta: null, v: 15 }];

    // Guardar con nombre y recuperarlo.
    ESCENARIOS = []; ESC = escNuevo('');
    ESC.palancas.tamar.tramos[0].v = 33; ESC.palancas.tamar.modo = 'real'; ESC.horizonte = 18;
    document.getElementById('esc-nombre').value = 'Smoke';
    escGuardar();
    const id = ESC.id;
    escCargar(''); const vacio = ESC.palancas.tamar.tramos[0].v;
    escCargar(id);

    return {
      nBonos: base ? base.items.length : 0,
      filas: document.querySelectorAll('#esc-tbody tr').length,
      intacto: antes === despues,
      roll: base ? base.roll : null,
      inflSube: base && inflAlta && inflAlta.infl > base.infl,
      rollAlto, rollBajo,
      tfIgual: unTf && base ? Math.abs(tea(inflAlta, unTf) - tea(base, unTf)) < 1e-6 : null,
      realLeido: real.tamarRealH, realIdaVuelta: nominal.tamarRealH,
      unoRoll: escCalcular(uno).roll, dosRoll: escCalcular(dos).roll, bajaRoll: escCalcular(baja).roll,
      guardados: ESCENARIOS.length, nombre: (ESCENARIOS[0] || {}).nombre,
      vacio, vuelto: ESC.palancas.tamar.tramos[0].v, modo: ESC.palancas.tamar.modo, hor: ESC.horizonte,
      tiles: (document.getElementById('esc-tiles') || {}).textContent || '',
      grafico: !!escChart,
    };
  });
  const escSinPrecios = esc.nBonos === 0;
  if (escSinPrecios) omitir('valúa la curva al horizonte', 'sin precios en vivo');
  else check(esc.nBonos > 3 && esc.filas > 3, 'valúa la curva al horizonte',
             `${esc.nBonos} bonos · ${esc.filas} filas`);
  check(esc.intacto, 'un escenario no deja rastro en los senderos de la app');
  check(esc.roll > 0, 'la referencia de renovar a TAMAR sale', String(esc.roll));
  check(esc.rollAlto > esc.rollBajo, 'la palanca de TAMAR mueve la reinversión',
        `${esc.rollAlto} vs ${esc.rollBajo}`);
  check(esc.inflSube === true, 'la palanca de inflación mueve el acumulado');
  if (escSinPrecios || esc.tfIgual === null)
    omitir('una tasa fija no se mueve con la inflación', 'sin precios en vivo');
  else check(esc.tfIgual === true, 'una tasa fija no se mueve con la inflación');
  check(Math.abs(esc.realLeido - 5) < 0.02, 'TAMAR real 5% se lee como 5% real', String(esc.realLeido));
  check(Math.abs(esc.realIdaVuelta - esc.realLeido) < 0.02,
        'real → nominal → real cierra', `${esc.realIdaVuelta} vs ${esc.realLeido}`);
  check(Math.abs(esc.unoRoll - esc.dosRoll) < 1e-9, 'un tramo es el caso degenerado de dos iguales');
  check(esc.bajaRoll < esc.unoRoll, 'el segundo tramo cambia el resultado',
        `${esc.bajaRoll} vs ${esc.unoRoll}`);
  check(esc.guardados === 1 && esc.nombre === 'Smoke' && esc.vacio === null,
        'el escenario se guarda con nombre', JSON.stringify([esc.guardados, esc.nombre, esc.vacio]));
  check(esc.vuelto === 33 && esc.modo === 'real' && esc.hor === 18,
        'volver a cargarlo recupera palancas, modo y horizonte',
        JSON.stringify([esc.vuelto, esc.modo, esc.hor]));
  if (escSinPrecios) omitir('se pintan los tiles y el gráfico', 'sin precios en vivo');
  else check(esc.tiles.includes('Renovar a TAMAR') && esc.grafico,
             'se pintan los tiles y el gráfico');

  console.log('\nSolapas en desarrollo: sólo para admins');
  const dev = await page.evaluate(() => {
    const vis = id => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
    const ids = ['nav-escenarios', 'nav-comentario', 'nav-usd-comentario'];
    const sinSesion = ids.map(vis);
    // Admin simulado, sincrónico y restaurado en la misma llamada: nada escribe
    // localStorage en el medio, así que la sincronización con Supabase no se entera.
    const antes = SUPA_USER;
    SUPA_USER = { email: ADMIN_EMAIL };
    authUpdateAdminUI();
    const conAdmin = ids.map(vis);
    SUPA_USER = antes;
    authUpdateAdminUI();
    const restaurado = ids.map(vis);
    // Un no-admin parado en una solapa en desarrollo vuelve al Resumen.
    switchSection('pesos'); switchTab('escenarios');
    devSacarSiNoAdmin();
    const trasPesos = currentTab;
    switchSection('usd'); switchUsdTab('usd-comentario');
    devSacarSiNoAdmin();
    const trasUsd = currentUsdTab;
    switchSection('pesos');
    const otros = ['nav-breakeven', 'nav-proyecciones', 'nav-series-ars', 'nav-usd-series'].map(vis);
    return { sinSesion, conAdmin, restaurado, trasPesos, trasUsd, otros, admin: !!isAdmin() };
  });
  check(dev.sinSesion.every(v => !v), 'sin sesión no se ven Escenarios ni Comentario', JSON.stringify(dev.sinSesion));
  check(dev.conAdmin.every(v => v), 'el admin sí las ve', JSON.stringify(dev.conAdmin));
  check(dev.restaurado.every(v => !v) && !dev.admin, 'al dejar de ser admin se vuelven a ocultar', JSON.stringify(dev.restaurado));
  check(dev.trasPesos === 'breakeven' && dev.trasUsd === 'usd-resumen',
        'un no-admin parado en una solapa en desarrollo vuelve al Resumen', `${dev.trasPesos} · ${dev.trasUsd}`);
  check(dev.otros.every(v => v), 'el resto de la navegación sigue a la vista', JSON.stringify(dev.otros));

  console.log('\nProyecciones: los ajustes manuales sobreviven a la recarga');
  const puesto = await page.evaluate(async () => {
    const mes = proyMesAdd(proyMesHoy(), 3);
    switchSection('pesos'); switchTab('proyecciones');
    proySubtabGo('tamar'); proySetValor('tamar', mes, '77.7');
    proySubtabGo('infla'); projSetInfla(mes, '8.88');
    await new Promise(r => setTimeout(r, 800));
    return { mes,
      tamar: (PROJ_TAMAR.find(o => o.mes === mes) || {}).v,
      infla: (PROJ_INFLA_MANUAL.find(o => o.mes === mes) || {}).v };
  });
  check(puesto.tamar === 77.7 && puesto.infla === 8.88,
        'el ajuste manual entra en su almacén', JSON.stringify(puesto));

  // La recarga se hace como la de un usuario: con precios en caché y una lista
  // guardada en la tabla del Resumen, que beInit pinta durante la carga. Con la
  // tabla vacía, una const del módulo leída antes de su declaración pasaba sin
  // verse y en producción cortaba el script entero (08/10/2026).
  const cpGuardada = await page.evaluate(() => {
    const liq = G_LIQ || addHabiles(TODAY, 1);
    const vivo = b => b.precio > 0 && b.vcto && diasACT(liq, parseDate(b.vcto)) > 0;
    const cp = [...LECAPS.filter(vivo).slice(0, 3).map(b => ({ ticker: b.ticker, tipo: 'tf' })),
                ...CER_BONDS.filter(vivo).slice(0, 2).map(b => ({ ticker: b.ticker, tipo: 'cer' })),
                ...TAMAR_BONDS.filter(vivo).slice(0, 2).map(b => ({ ticker: b.ticker, tipo: 'tamar' })),
                ...DLK_BONDS.filter(vivo).slice(0, 2).map(b => ({ ticker: b.ticker, tipo: 'dlk' }))];
    localStorage.setItem(LS_CP, JSON.stringify(cp));
    return cp.length;
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof proySetValor === 'function', null, { timeout: 60000 });
  await page.waitForTimeout(16000);
  const tras = await page.evaluate(mes => ({
    tamar: (PROJ_TAMAR.find(o => o.mes === mes) || {}).v,
    infla: (PROJ_INFLA_MANUAL.find(o => o.mes === mes) || {}).v,
    // Guardado no alcanza: tiene que estar aplicado en el sendero que se usa.
    senderoTamar: (tamarSendero().mapa.get(mes) || {}).v,
    senderoInfla: (PROJ_INFLACION.find(r => r.mes === mes) || {}).infla,
    fuentes: { infla: PROJ_FUENTE.infla, tamar: PROJ_FUENTE.tamar },
  }), puesto.mes);
  check(tras.tamar === 77.7 && tras.infla === 8.88,
        'el ajuste manual sigue guardado tras recargar', JSON.stringify(tras));
  check(tras.senderoTamar === 77.7 && tras.senderoInfla === 8.88,
        'y queda aplicado en el sendero, no sólo guardado', JSON.stringify(tras));
  check(tras.fuentes.infla === 'manual' && tras.fuentes.tamar === 'manual',
        'la fuente elegida también sobrevive', JSON.stringify(tras.fuentes));
  // El script cargó entero: lo declarado al final existe y la tabla tiene filas.
  const entero = await page.evaluate(() => {
    const def = n => { try { return eval(`typeof ${n}`) !== 'undefined' && eval(n) != null; } catch (e) { return false; } };
    return { finales: ['DLK_BONDS', 'ALTO_COMPLETO', 'DUAL_TIPOS', 'CURVA_MODELOS'].filter(n => !def(n)),
             filas: document.querySelectorAll('#be-cp-tbody tr').length };
  });
  check(cpGuardada > 0 && entero.finales.length === 0 && entero.filas > 0,
        'con una lista guardada en el Resumen la app carga entera',
        `${cpGuardada} guardados, ${entero.filas} filas · sin definir: ${entero.finales.join(', ')}`);
  await page.evaluate(() => { CP_BONDS = []; beCPSaveLs(); });

  console.log('\nHigiene');
  const undef = req400.filter(r => r.includes('/undefined'));
  check(undef.length === 0, 'sin peticiones a /undefined', undef.join(', '));
  const graves = errores.filter(e =>
    /is not defined|is not a function|before initialization|Cannot read/.test(e));
  check(graves.length === 0, 'sin ReferenceError/TypeError', graves.slice(0, 3).join(' | '));

  if (req400.length) {
    console.log('\n  peticiones con status >= 400:');
    for (const r of [...new Set(req400)].slice(0, 8)) console.log('    ' + r);
  }

  console.log(`\n${ok} OK · ${bad} fallas\n`);
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('\n✗', e.message, '\n'); process.exit(1); });
