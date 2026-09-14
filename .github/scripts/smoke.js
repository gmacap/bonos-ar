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
const APP = process.env.APP_URL || 'https://santosechezarreta5.github.io/bonos-ar/';

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
    const estable = tickers.filter(t => Math.abs(mep[t] / cable[t] - 1) < 0.001).length;
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
        series: st.chart ? st.chart.data.datasets.length : -1,
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
      const antes = st.chart.data.datasets.length;
      seriesToggle(s, t);
      return { t, antes, despues: st.chart ? st.chart.data.datasets.length : -1 };
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
      const serie = st.cache.porBono.get(c + '\u2192' + l);
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
    check(add.label === `${add.c}\u2192${add.l}`, `${sec}: la serie se llama por el par`, add.label);
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
      const [c, l] = [...st.cache.porBono.keys()][0].split('\u2192');
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
        volcadoCargaBonos: /sintLoadBonds/.test(maeAplicarFuturos.toString()),
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
      // El de TAMAR va por mes, así que se cuentan etiquetas. El del dólar va
      // por fecha: se comparan los extremos del eje con los de la ventana.
      let dibuja = false;
      if (s === 'tamar') dibuja = !!ch && ch.data.labels.length === v.length;
      else if (ch) {
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
    const i12 = proyInfl12Mapa().get(mes);
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
    const conReal = { min: esc.y.min, valores: ds.flatMap(d => d.data).filter(v => v != null) };
    document.getElementById('proy-tamar-cb-real').checked = false;
    proyRenderChart('tamar');
    const soloTNA = projTamarChart.options.scales.y.min;
    return { i12, errores, antes, despues: ds.length,
             tieneLinea: !!linea, mismoEje,
             minConReal: conReal.min, minValor: Math.min(...conReal.valores),
             minSoloTNA: soloTNA,
             conDatos: linea ? linea.data.filter(v => v != null).length : 0 };
  });
  check(real.i12 != null, 'hay inflación de 12 meses para el mes en curso',
        String(real.i12));
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

  // Pasado y proyección tienen que distinguirse solos en el gráfico.
  const corte = await page.evaluate(async () => {
    proySubtabGo('tamar');
    await new Promise(r => setTimeout(r, 500));
    const ch = projTamarChart;
    const ds = ch.data.datasets[0];
    const lista = proyVentana('tamar');
    const iProy = lista.findIndex(p => p.origen !== 'real');
    const seg = ds.segment && typeof ds.segment.borderDash === 'function';
    return {
      plugin: (ch.config.plugins || []).some(p => p.id === 'proyFuturo'),
      punteaFuturo: seg && !!ds.segment.borderDash({ p1DataIndex: iProy }),
      punteaPasado: seg && !!ds.segment.borderDash({ p1DataIndex: Math.max(0, iProy - 1) }),
      iProy,
    };
  });
  check(corte.plugin, 'el gráfico sombrea el tramo proyectado');
  check(corte.punteaFuturo && !corte.punteaPasado,
        'la línea va punteada desde el primer mes proyectado', JSON.stringify(corte));

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
    const enTres = fmtDate(addHabiles(liq, 2));
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
