#!/usr/bin/env python3
"""Números de mercado para el Morning Brief de bonos-ar.

La tarea en la nube de las 9:30 corre esto antes de escribir: así las cifras
del brief salen de una descarga y no de lo que diga una nota. Trae:

- FRED (Fed de St. Louis): Treasuries 2, 5, 10 y 30 años, 2s10s, 10 años real,
  los OAS de ICE BofA (HY, IG, CCC) y el rendimiento efectivo del HY, el rango
  de la Fed y la tasa efectiva. Con 1D, 1W y YTD en pb.
- Yahoo Finance: futuros de Wall Street y del T-Note, índices, VIX, MOVE,
  monedas, materias primas, Bitcoin y ADRs argentinos (con la operatoria previa
  a la apertura si la hay).
- Futuros de Fed Funds del CME (vía Yahoo) más las reuniones del FOMC de
  calendario.json: lo que descuenta el mercado para la próxima reunión y a doce
  meses, con el método de CME FedWatch.
- Riesgo país (EMBI) de argentinadatos, la misma serie que usa la app.

Imprime tablas en markdown, listas para el brief (coma decimal, signo −, pb), y
con --json guarda todo en crudo. Sólo biblioteca estándar.

    python3 tools/brief_datos.py --json /tmp/brief_datos.json > /tmp/brief_datos.md

Lo que no tiene fuente abierta (CDX, iTraxx, Bund diario) sale en la lista de
faltantes, igual que cualquier descarga que falle: nunca se completa a ojo.
"""

import argparse
import calendar
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = 'bonos-ar-brief/1.0 (+https://gmacap.github.io/bonos-ar/)'
ART = dt.timezone(dt.timedelta(hours=-3))
AHORA = dt.datetime.now(dt.timezone.utc)
HOY = AHORA.astimezone(ART).date()
MESES = 'FGHJKMNQUVXZ'   # códigos de vencimiento de los futuros

# ── descargas ────────────────────────────────────────────────────────────────

def bajar(url, intentos=3, espera=2.0, timeout=40):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
    ultimo = None
    for i in range(intentos):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            ultimo = e
            if e.code not in (429, 500, 502, 503, 504):
                break
        except Exception as e:  # red, timeout
            ultimo = e
        time.sleep(espera * (i + 1))
    raise RuntimeError(f'{url}: {ultimo}')


def fred(serie, desde):
    """[(fecha, valor)] de FRED, sin los días vacíos."""
    url = ('https://fred.stlouisfed.org/graph/fredgraph.csv?id='
           f'{serie}&cosd={desde.isoformat()}')
    txt = bajar(url).decode('utf-8', 'replace')
    filas = list(csv.reader(io.StringIO(txt)))
    if not filas or len(filas[0]) < 2:
        raise RuntimeError(f'FRED {serie}: respuesta inesperada')
    out = []
    for f in filas[1:]:
        if len(f) < 2 or f[1] in ('', '.'):
            continue
        try:
            out.append((dt.date.fromisoformat(f[0]), float(f[1])))
        except ValueError:
            continue
    if not out:
        raise RuntimeError(f'FRED {serie}: sin datos')
    return out


def yahoo(simbolo, rango='1y', intervalo='1d', prepost=False):
    q = urllib.parse.quote(simbolo, safe='')
    extra = '&includePrePost=true' if prepost else ''
    error = None
    for host in ('query1', 'query2'):
        url = (f'https://{host}.finance.yahoo.com/v8/finance/chart/{q}'
               f'?range={rango}&interval={intervalo}{extra}')
        try:
            d = json.loads(bajar(url, intentos=2))
            r = (d.get('chart') or {}).get('result') or []
            if r and r[0].get('meta', {}).get('regularMarketPrice') is not None:
                return r[0]
            error = (d.get('chart') or {}).get('error') or 'sin resultado'
        except Exception as e:
            error = e
    raise RuntimeError(f'Yahoo {simbolo}: {error}')


# ── formato ──────────────────────────────────────────────────────────────────

MENOS = '−'


def num(x, dec=2):
    if x is None:
        return 'N/D'
    s = f'{abs(x):,.{dec}f}'.replace(',', '_').replace('.', ',').replace('_', '.')
    return (MENOS if x < 0 and round(abs(x), dec) != 0 else '') + s


def signo(x, dec, sufijo):
    if x is None:
        return 'N/D'
    r = round(x, dec)
    if r == 0:
        return f'{num(0, dec)}{sufijo}'
    return ('+' if r > 0 else MENOS) + num(abs(x), dec) + sufijo


def pb(x, dec=0):
    return signo(x, dec, ' pb')


def pct(x, dec=2):
    return signo(x, dec, '%')


def pts(x, dec=2):
    return signo(x, dec, ' pts')


def dm(d):
    return d.strftime('%d/%m')


def hora_art(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone(ART)


# ── series y variaciones ─────────────────────────────────────────────────────

def ref_hasta(serie, limite):
    """Último (fecha, valor) con fecha <= limite."""
    previo = None
    for f, v in serie:
        if f > limite:
            break
        previo = (f, v)
    return previo


def fin_anio_previo(d):
    return dt.date(d.year - 1, 12, 31)


def variaciones(serie, ultimo_f, ultimo_v, previo):
    """1D contra `previo`, 1W contra la última de hace 7 días o más, YTD contra
    el último dato del año anterior."""
    w = ref_hasta(serie, ultimo_f - dt.timedelta(days=7))
    a = ref_hasta(serie, fin_anio_previo(ultimo_f))
    return {
        'previo': previo,
        'semana': w,
        'anio': a,
    }


def fred_fila(serie):
    f, v = serie[-1]
    previo = serie[-2] if len(serie) > 1 else None
    r = variaciones(serie, f, v, previo)
    d = lambda ref: None if ref is None else (v - ref[1])
    return {
        'fecha': f.isoformat(), 'valor': v,
        'previo': r['previo'] and {'fecha': r['previo'][0].isoformat(), 'valor': r['previo'][1]},
        'd1': d(r['previo']), 'd1w': d(r['semana']), 'ytd': d(r['anio']),
        'ref_1w': r['semana'] and r['semana'][0].isoformat(),
        'ref_ytd': r['anio'] and r['anio'][0].isoformat(),
    }


def yahoo_fila(res, tipo_var):
    """Último precio, cierre anterior y variaciones de una serie diaria de Yahoo.

    El cierre anterior es el de la rueda previa a la del último precio: para un
    índice cerrado, la variación es la de su última rueda; para un futuro que
    opera, la de la sesión en curso."""
    m = res['meta']
    off = m.get('gmtoffset') or 0
    ts = res.get('timestamp') or []
    cl = ((res.get('indicators') or {}).get('quote') or [{}])[0].get('close') or []
    dia = lambda t: (dt.datetime.fromtimestamp(t + off, dt.timezone.utc)).date()
    serie = [(dia(t), c) for t, c in zip(ts, cl) if c is not None]
    # Una fila por día: si Yahoo repite, queda la última.
    porDia = {}
    for f, c in serie:
        porDia[f] = c
    serie = sorted(porDia.items())
    lt = m.get('regularMarketTime')
    last = m.get('regularMarketPrice')
    dlt = dia(lt) if lt else (serie[-1][0] if serie else None)
    previo = ref_hasta(serie, dlt - dt.timedelta(days=1)) if dlt else None
    w = ref_hasta(serie, dlt - dt.timedelta(days=7)) if dlt else None
    a = ref_hasta(serie, fin_anio_previo(dlt)) if dlt else None

    def var(ref):
        if ref is None or last is None or not ref[1]:
            return None
        if tipo_var == 'pb':
            return (last - ref[1]) * 100
        if tipo_var == 'pts':
            return last - ref[1]
        return (last / ref[1] - 1) * 100

    tipo = m.get('instrumentType') or ''
    if tipo == 'FUTURE':
        # El continuo de Yahoo (BZ=F, CL=F…) cambia de contrato al vencer, y la
        # barra diaria no es el ajuste: el 26/11/2026 el Brent pasó de enero a
        # febrero y contra la barra de ayer daba −3,46% cuando el contrato subía
        # 0,77%. La variación del día va la de Yahoo, contra el ajuste anterior
        # del mismo contrato; 1W y YTD no se calculan porque cruzan vencimientos.
        rmcp = m.get('regularMarketChangePercent')
        if rmcp is not None and last:
            previo = (previo[0] if previo else dlt, last / (1 + rmcp / 100))
        w = a = None

    t_art = hora_art(lt) if lt else None
    fresco = lt is not None and (AHORA.timestamp() - lt) <= 20 * 60
    if tipo == 'FUTURE':
        clase = 'futuro'
    elif fresco:
        clase = 'intradiario'
    elif tipo in ('INDEX', 'EQUITY', 'ETF'):
        clase = 'cierre'
    else:
        clase = 'último'
    return {
        'simbolo': m.get('symbol'), 'nombre': m.get('shortName') or m.get('longName'),
        'tipo': tipo, 'clase': clase, 'moneda': m.get('currency'),
        'ultimo': last, 'hora_art': t_art and t_art.strftime('%Y-%m-%d %H:%M'),
        'dia_rueda': dlt and dlt.isoformat(),
        'previo': previo and {'fecha': previo[0].isoformat(), 'valor': previo[1]},
        'd1': var(previo), 'd1w': var(w), 'ytd': var(a),
        'ref_1w': w and w[0].isoformat(), 'ref_ytd': a and a[0].isoformat(),
    }


def extendida(res):
    """Pre-apertura de un ADR: el último precio de 5 minutos de un día posterior
    al de la última operación de la rueda regular. El post-cierre de la víspera
    no se muestra: a las 9:30 es viejo, y Yahoo informa esas barras sin volumen."""
    m = res['meta']
    ts = res.get('timestamp') or []
    q = ((res.get('indicators') or {}).get('quote') or [{}])[0]
    cl = q.get('close') or []
    reg_t = m.get('regularMarketTime') or 0
    reg_p = m.get('regularMarketPrice')
    off = m.get('gmtoffset') or 0
    dia = lambda t: dt.datetime.fromtimestamp(t + off, dt.timezone.utc).date()
    pares = [(t, c) for t, c in zip(ts, cl)
             if c is not None and t > reg_t + 60 and dia(t) > dia(reg_t)]
    if not pares or not reg_p:
        return None
    t, c = pares[-1]
    return {
        'precio': c, 'hora_art': hora_art(t).strftime('%Y-%m-%d %H:%M'),
        'sesion': 'pre-apertura', 'var_vs_cierre': (c / reg_p - 1) * 100, 'cierre': reg_p,
    }


# ── qué se pide ──────────────────────────────────────────────────────────────

FRED_SERIES = {
    'DGS2': 'UST 2Y', 'DGS5': 'UST 5Y', 'DGS10': 'UST 10Y', 'DGS30': 'UST 30Y',
    'T10Y2Y': 'Spread 2s10s', 'DFII10': 'UST 10Y real (TIPS)',
    'BAMLH0A0HYM2': 'US High Yield OAS', 'BAMLC0A0CM': 'US Investment Grade OAS',
    'BAMLH0A3HYC': 'US CCC & Lower OAS', 'BAMLH0A0HYM2EY': 'US High Yield Effective Yield',
    'DFEDTARL': 'Fed: rango, piso', 'DFEDTARU': 'Fed: rango, techo', 'EFFR': 'Fed Funds efectiva (EFFR)',
}

# (símbolo, nombre, variación en: pct | pb | pts, decimales del nivel)
YAHOO = {
    # apertura
    'ES=F': ('Futuro S&P 500', 'pct', 2), 'NQ=F': ('Futuro Nasdaq 100', 'pct', 2),
    'YM=F': ('Futuro Dow Jones', 'pct', 0), 'RTY=F': ('Futuro Russell 2000', 'pct', 2),
    'ZT=F': ('Futuro T-Note 2Y (precio)', 'pct', 3), 'ZN=F': ('Futuro T-Note 10Y (precio)', 'pct', 3),
    # índices
    '^GSPC': ('S&P 500', 'pct', 2), '^NDX': ('Nasdaq 100', 'pct', 2), '^DJI': ('Dow Jones', 'pct', 2),
    '^RUT': ('Russell 2000', 'pct', 2), '^VIX': ('VIX', 'pts', 2), '^MOVE': ('MOVE', 'pts', 2),
    '^STOXX50E': ('Euro Stoxx 50', 'pct', 2), '^GDAXI': ('DAX', 'pct', 2),
    '^N225': ('Nikkei 225', 'pct', 2), '^HSI': ('Hang Seng', 'pct', 2),
    # tasas del CBOE (rendimiento en %, variación en pb)
    '^FVX': ('UST 5Y (CBOE)', 'pb', 3), '^TNX': ('UST 10Y (CBOE)', 'pb', 3), '^TYX': ('UST 30Y (CBOE)', 'pb', 3),
    # monedas
    'DX-Y.NYB': ('DXY', 'pct', 2), 'EURUSD=X': ('EUR/USD', 'pct', 4),
    'JPY=X': ('USD/JPY', 'pct', 2), 'BRL=X': ('USD/BRL', 'pct', 4),
    # materias primas y cripto
    'CL=F': ('WTI', 'pct', 2), 'BZ=F': ('Brent', 'pct', 2), 'GC=F': ('Oro', 'pct', 2),
    'BTC-USD': ('Bitcoin', 'pct', 0),
}
ADRS = ['YPF', 'GGAL', 'BMA', 'PAM', 'VIST', 'CEPU', 'TGS', 'SUPV']
for s in ADRS:
    YAHOO[s] = (f'{s} (ADR)', 'pct', 2)

APERTURA = ['ES=F', 'NQ=F', 'YM=F', '^STOXX50E', '^GDAXI', '^N225', '^HSI',
            'ZT=F', 'ZN=F', '^TNX', 'DX-Y.NYB', 'CL=F', 'BZ=F', 'GC=F']
CIERRES = ['^GSPC', '^NDX', '^DJI', '^RUT', '^VIX', '^STOXX50E', '^N225', '^HSI',
           'DX-Y.NYB', 'EURUSD=X', 'JPY=X', 'BRL=X', 'CL=F', 'BZ=F', 'GC=F', 'BTC-USD']

FALTAN_SIEMPRE = [
    'CDX NA HY 5Y, CDX NA IG 5Y y CDX EM 5Y (Markit/S&P, de pago)',
    'iTraxx Main e iTraxx Crossover 5Y (de pago)',
    'Bund alemán 10Y diario (FRED sólo lo tiene mensual)',
    'Treasuries antes de la apertura: el CBOE recién calcula ^TNX con la rueda; la dirección la dan los futuros del T-Note',
    'Bonos argentinos en dólares en el exterior antes de las 11',
]


def zq(y, m):
    return f'ZQ{MESES[m - 1]}{y % 100:02d}.CBT'


def suma_meses(y, m, k):
    t = y * 12 + (m - 1) + k
    return t // 12, t % 12 + 1


def reuniones_fomc(repo):
    try:
        with open(os.path.join(repo, 'calendario.json'), encoding='utf-8') as f:
            cal = json.load(f)
        return sorted({dt.date.fromisoformat(e[0]) for e in cal.get('eventos', [])
                       if len(e) > 2 and e[2] == 'fomc'})
    except Exception:
        return []


def fed_descuento(efectiva, contratos, reuniones):
    """Camino implícito de la tasa con el método de CME FedWatch.

    El promedio del mes del contrato es d/N días a la tasa previa a la reunión y
    el resto a la posterior (la decisión rige desde el día siguiente). Si la
    reunión cae en la última semana del mes y el mes siguiente no tiene reunión,
    la tasa posterior es la de ese contrato, que es más estable."""
    meses_con = {(r.year, r.month) for r in reuniones}
    tope = HOY + dt.timedelta(days=366)
    camino, pre = [], efectiva
    for r in [x for x in reuniones if HOY <= x <= tope]:
        ym = (r.year, r.month)
        if ym not in contratos:
            break
        n = calendar.monthrange(*ym)[1]
        d = r.day
        sig = suma_meses(r.year, r.month, 1)
        if n - d < 7 and sig in contratos and sig not in meses_con:
            post = contratos[sig]
        else:
            post = (contratos[ym] - pre * d / n) / ((n - d) / n)
        camino.append({'reunion': r.isoformat(), 'pre': pre, 'post': post,
                       'cambio_pb': (post - pre) * 100, 'acumulado_pb': (post - efectiva) * 100})
        pre = post
    prob = None
    if camino:
        c = camino[0]['cambio_pb']
        pasos = abs(c) / 25
        n = int(pasos)
        frac = pasos - n
        dir_ = 'suba' if c > 0 else 'baja'
        nombre = lambda k: 'mantener' if k == 0 else f'{dir_} de {k * 25} pb'
        prob = [{'escenario': nombre(n), 'prob': (1 - frac) * 100},
                {'escenario': nombre(n + 1), 'prob': frac * 100}]
        prob = [p for p in prob if round(p['prob']) > 0]
    return camino, prob


# ── armado ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--json', help='guardar los datos en crudo en este archivo')
    ap.add_argument('--repo', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    help='raíz del repo (para calendario.json)')
    args = ap.parse_args()

    desde = dt.date(HOY.year - 1, 12, 1)
    reuniones = reuniones_fomc(args.repo)
    contratos_sim = {}
    for k in range(0, 14):
        y, m = suma_meses(HOY.year, HOY.month, k)
        contratos_sim[(y, m)] = zq(y, m)

    tareas = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for s in FRED_SERIES:
            tareas[('fred', s)] = ex.submit(fred, s, desde)
        for s in YAHOO:
            tareas[('yahoo', s)] = ex.submit(yahoo, s)
        for s in ADRS:
            tareas[('ext', s)] = ex.submit(yahoo, s, '2d', '5m', True)
        for ym, s in contratos_sim.items():
            tareas[('zq', ym)] = ex.submit(yahoo, s, '5d', '1d')
        tareas[('rp', '')] = ex.submit(lambda: json.loads(bajar(
            'https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais')))

    errores, F, Y, EXT, ZQ = [], {}, {}, {}, {}
    rp = None
    for (fuente, s), fut in tareas.items():
        try:
            res = fut.result()
        except Exception as e:
            if fuente != 'zq':   # un vencimiento lejano que no cotiza no es error
                errores.append(f'{fuente} {s}: {e}')
            continue
        try:
            if fuente == 'fred':
                F[s] = fred_fila(res)
            elif fuente == 'yahoo':
                Y[s] = yahoo_fila(res, YAHOO[s][1])
            elif fuente == 'ext':
                EXT[s] = res
            elif fuente == 'zq':
                ZQ[s] = {'simbolo': res['meta']['symbol'], 'precio': res['meta']['regularMarketPrice'],
                         'implicita': 100 - res['meta']['regularMarketPrice'],
                         'hora_art': hora_art(res['meta']['regularMarketTime']).strftime('%Y-%m-%d %H:%M')}
            elif fuente == 'rp':
                rp = sorted(((dt.date.fromisoformat(x['fecha']), float(x['valor'])) for x in res
                             if x.get('fecha') and x.get('valor') is not None))
        except Exception as e:
            errores.append(f'{fuente} {s}: {e}')

    for s, res in EXT.items():
        if s in Y:
            try:
                Y[s]['extendida'] = extendida(res)
            except Exception as e:
                errores.append(f'ext {s}: {e}')

    # Fed
    fed = {}
    if 'DFEDTARL' in F and 'DFEDTARU' in F:
        fed['rango'] = [F['DFEDTARL']['valor'], F['DFEDTARU']['valor']]
        fed['rango_fecha'] = F['DFEDTARU']['fecha']
    if 'EFFR' in F:
        fed['efectiva'] = F['EFFR']['valor']
        fed['efectiva_fecha'] = F['EFFR']['fecha']
        contratos = {ym: z['implicita'] for ym, z in ZQ.items()}
        fed['contratos'] = {f'{ym[0]}-{ym[1]:02d}': z for ym, z in sorted(ZQ.items())}
        if reuniones and contratos:
            fed['camino'], fed['proxima_prob'] = fed_descuento(F['EFFR']['valor'], contratos, reuniones)
        elif not reuniones:
            errores.append('fed: no encontré reuniones del FOMC en calendario.json')

    # Riesgo país
    RP = None
    if rp:
        f, v = rp[-1]
        RP = fred_fila(rp)

    # ── markdown ────────────────────────────────────────────────────────────
    L = []
    p = L.append
    ahora_art = AHORA.astimezone(ART)
    p(f'DATOS DE MERCADO PARA EL BRIEF · bajados el {ahora_art:%d/%m/%Y %H:%M} ART')
    p('')
    p('Copiar estos números tal cual, con su fecha u hora. Variaciones de tasas y spreads en pb; '
      'de precios en %; VIX y MOVE en puntos. "cierre" = última rueda cerrada; "futuro" = contrato '
      'que opera ahora; "intradiario" = dato de los últimos 20 minutos; "último" = última cotización disponible.')

    def yrow(s, cols):
        y = Y.get(s)
        nombre, tv, dec = YAHOO[s]
        if not y:
            return f'| {nombre} | N/D | | | |'
        h = y['hora_art']
        cuando = (f'{y["clase"]} {h[8:10]}/{h[5:7]} {h[11:]}' if h else y['clase'])
        if y['clase'] == 'cierre' and y.get('dia_rueda'):
            cuando = f'cierre {y["dia_rueda"][8:10]}/{y["dia_rueda"][5:7]}'
        fmt = {'pct': pct, 'pb': lambda x: pb(x, 1), 'pts': pts}[tv]
        nivel = num(y['ultimo'], dec) + ('%' if tv == 'pb' else '')
        prev = y['previo']
        prev_s = (f'{num(prev["valor"], dec)}{"%" if tv == "pb" else ""} ({dm(dt.date.fromisoformat(prev["fecha"]))})'
                  if prev else 'N/D')
        if cols == 'apertura':
            return f'| {nombre} | {prev_s} | {nivel} | {cuando} | {fmt(y["d1"])} |'
        if cols == 'diaria':
            return f'| {nombre} | {nivel} | {cuando} | {fmt(y["d1"])} |'
        return f'| {nombre} | {nivel} | {cuando} | {fmt(y["d1"])} | {fmt(y["d1w"])} | {fmt(y["ytd"])} |'

    p('')
    p('## Apertura de hoy (sección 1)')
    p('')
    p('| Instrumento | Cierre previo | Último | Dato | Var. |')
    p('|---|---:|---:|---|---:|')
    for s in APERTURA:
        p(yrow(s, 'apertura'))
    p('')
    p('Los futuros del T-Note son precios: si suben, bajan las tasas. ^TNX es el 10 años del CBOE, '
      'que se calcula durante la rueda: antes de la apertura muestra el cierre anterior.')

    p('')
    p('## ADRs argentinos (sección 1, Argentina antes de las 11)')
    p('')
    p('| ADR | Cierre | Var. de esa rueda | Pre-apertura | Var. vs cierre |')
    p('|---|---:|---:|---|---:|')
    for s in ADRS:
        y = Y.get(s)
        if not y:
            p(f'| {s} | N/D | | | |')
            continue
        e = y.get('extendida')
        fuera = vfuera = '—'
        if e:
            h = e['hora_art']
            fuera = f'{num(e["precio"], 2)} ({h[11:]} ART)'
            vfuera = pct(e['var_vs_cierre'])
        rueda = y.get('dia_rueda') or ''
        p(f'| {s} | {num(y["ultimo"], 2)} ({rueda[8:10]}/{rueda[5:7]}) | {pct(y["d1"])} | {fuera} | {vfuera} |')
    p('')
    p('"—" en pre-apertura: todavía no operó hoy. En la pre-apertura hay pocas operaciones: '
      'el precio es una referencia, no un cierre.')

    def frow(s, unidad):
        f = F.get(s)
        nombre = FRED_SERIES[s]
        if not f:
            return f'| {nombre} | N/D | | | | |'
        fecha = dm(dt.date.fromisoformat(f['fecha']))
        if unidad == 'pb_nivel':      # el nivel ya es un spread en %: se muestra en pb
            nivel = f'{num(f["valor"] * 100, 0)} pb'
        else:
            nivel = f'{num(f["valor"], 2)}%'
        c = lambda x: pb(None if x is None else x * 100)
        return f'| {nombre} | {nivel} | {fecha} | {c(f["d1"])} | {c(f["d1w"])} | {c(f["ytd"])} |'

    p('')
    p('## Rates (sección 4) · FRED, cierres')
    p('')
    p('| Instrumento | Nivel | Fecha | 1D | 1W | YTD |')
    p('|---|---:|---|---:|---:|---:|')
    for s in ('DGS2', 'DGS5', 'DGS10', 'DGS30'):
        p(frow(s, '%'))
    p(frow('T10Y2Y', 'pb_nivel'))
    p(frow('DFII10', '%'))
    p('| Bund alemán 10Y | N/D | | | | |')
    m = Y.get('^MOVE')
    if m:
        h = m['dia_rueda'] or ''
        p(f'| MOVE (Yahoo) | {num(m["ultimo"], 2)} | {h[8:10]}/{h[5:7]} | {pts(m["d1"])} | {pts(m["d1w"])} | {pts(m["ytd"])} |')
    else:
        p('| MOVE | N/D | | | | |')
    p('')
    p('FRED publica con un día hábil de atraso: la fecha es la del dato. 1W contra el último dato de '
      'hace siete días o más; YTD contra el último del año anterior. MOVE en puntos.')
    p('')
    p('Referencia del CBOE (Yahoo), con su hora:')
    p('')
    p('| Instrumento | Nivel | Dato | 1D | 1W | YTD |')
    p('|---|---:|---|---:|---:|---:|')
    for s in ('^FVX', '^TNX', '^TYX'):
        p(yrow(s, 'tabla'))

    p('')
    p('## US Macro & Fed (sección 3)')
    p('')
    if fed.get('rango'):
        lo, hi = fed['rango']
        p(f'- Rango objetivo de los Fed Funds: {num(lo, 2)}%–{num(hi, 2)}% '
          f'(FRED DFEDTARL/DFEDTARU, {dm(dt.date.fromisoformat(fed["rango_fecha"]))}).')
    else:
        p('- Rango objetivo: N/D.')
    if 'efectiva' in fed:
        p(f'- Tasa efectiva (EFFR): {num(fed["efectiva"], 2)}% (FRED, {dm(dt.date.fromisoformat(fed["efectiva_fecha"]))}).')
    cam = fed.get('camino') or []
    if cam:
        r0 = cam[0]
        probs = ' · '.join(f'{x["escenario"]} {num(x["prob"], 0)}%' for x in fed['proxima_prob'])
        p(f'- Próxima reunión, {dm(dt.date.fromisoformat(r0["reunion"]))}: el mercado descuenta '
          f'{pb(r0["cambio_pb"])} (tasa implícita posterior {num(r0["post"], 2)}%). Probabilidades: {probs}.')
        ult = cam[-1]
        p(f'- Acumulado descontado hasta la reunión del {dm(dt.date.fromisoformat(ult["reunion"]))}/'
          f'{ult["reunion"][:4]} (doce meses): {pb(ult["acumulado_pb"])} contra la EFFR.')
        p('')
        p('| Reunión | Tasa implícita después | Cambio en la reunión | Acumulado vs EFFR |')
        p('|---|---:|---:|---:|')
        for x in cam:
            p(f'| {dm(dt.date.fromisoformat(x["reunion"]))}/{x["reunion"][2:4]} | {num(x["post"], 2)}% | '
              f'{pb(x["cambio_pb"])} | {pb(x["acumulado_pb"])} |')
        p('')
        zs = sorted(fed['contratos'].values(), key=lambda z: z['simbolo'])
        hz = max((z['hora_art'] for z in zs), default='')
        p(f'Calculado con los futuros de Fed Funds a 30 días del CME (Yahoo, último {hz[8:10]}/{hz[5:7]} {hz[11:]}) '
          'y las reuniones del FOMC de calendario.json, con el método de CME FedWatch. Citarlo como '
          '"futuros de Fed Funds (CME)"; si FedWatch publica otra cifra, es por diferencias de precio y método.')
    else:
        p('- Probabilidades de la próxima reunión: N/D (faltan los futuros de Fed Funds o la EFFR).')

    p('')
    p('## Credit & High Yield (sección 5) · ICE BofA vía FRED')
    p('')
    p('| Indicador | Nivel | Fecha | 1D | 1W | YTD |')
    p('|---|---:|---|---:|---:|---:|')
    for s in ('BAMLH0A0HYM2', 'BAMLC0A0CM', 'BAMLH0A3HYC'):
        p(frow(s, 'pb_nivel'))
    p(frow('BAMLH0A0HYM2EY', '%'))
    p('')
    p('OAS en pb; el rendimiento efectivo en %, con sus variaciones en pb.')

    p('')
    p('## Equities, FX & Commodities (sección 6)')
    p('')
    p('| Instrumento | Nivel | Dato | Var. 1D |')
    p('|---|---:|---|---:|')
    for s in CIERRES:
        p(yrow(s, 'diaria'))
    p('')
    p('VIX en puntos. Para un índice cerrado, la variación es la de su última rueda; para un futuro, '
      'contra el ajuste anterior del mismo contrato; para monedas y Bitcoin, contra la barra diaria anterior.')

    p('')
    p('## Argentina')
    p('')
    if RP:
        f = dt.date.fromisoformat(RP['fecha'])
        prev = RP['previo']
        p(f'- Riesgo país (EMBI, JP Morgan, vía argentinadatos): {num(RP["valor"], 0)} pb al {dm(f)}'
          + (f'; {pb(RP["d1"])} contra el {dm(dt.date.fromisoformat(prev["fecha"]))} ({num(prev["valor"], 0)} pb)' if prev else '')
          + f'; 1W {pb(RP["d1w"])}; YTD {pb(RP["ytd"])}.')
    else:
        p('- Riesgo país: N/D.')

    p('')
    p('## Sin fuente abierta: buscar con fecha o poner N/D')
    p('')
    for x in FALTAN_SIEMPRE:
        p(f'- {x}')
    if errores:
        p('')
        p('Descargas que fallaron en esta corrida (esos datos van como N/D o se buscan aparte):')
        for x in errores:
            p(f'- {x}')

    p('')
    p('## Fuentes para citar')
    p('')
    fuentes = [
        ('FRED, Federal Reserve Bank of St. Louis', 'https://fred.stlouisfed.org/'),
        ('ICE BofA US High Yield Index OAS (FRED)', 'https://fred.stlouisfed.org/series/BAMLH0A0HYM2'),
        ('Treasury 10Y (FRED DGS10)', 'https://fred.stlouisfed.org/series/DGS10'),
        ('Yahoo Finance', 'https://finance.yahoo.com/'),
        ('Futuros de Fed Funds a 30 días, CME', 'https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.html'),
        ('Riesgo país, argentinadatos', 'https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais'),
        ('Calendario de reuniones del FOMC', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'),
    ]
    for t, u in fuentes:
        p(f'- [{t}]({u})')

    salida = '\n'.join(L) + '\n'
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdout.write(salida)

    if args.json:
        datos = {
            'generado': AHORA.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'fred': F, 'yahoo': Y, 'fed': fed, 'riesgo_pais': RP,
            'faltan_siempre': FALTAN_SIEMPRE, 'errores': errores,
            'fuentes': [{'titulo': t, 'url': u} for t, u in fuentes],
        }
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(datos, f, ensure_ascii=False, indent=1, default=str)

    # Sale con error sólo si no llegó casi nada: la tarea tiene que enterarse.
    if len(F) < len(FRED_SERIES) // 2 or len(Y) < len(YAHOO) // 2:
        sys.stderr.write(f'Faltan demasiados datos: FRED {len(F)}/{len(FRED_SERIES)}, '
                         f'Yahoo {len(Y)}/{len(YAHOO)}\n')
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
