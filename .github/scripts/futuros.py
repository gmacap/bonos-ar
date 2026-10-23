#!/usr/bin/env python3
"""Futuros de dólar y de caución de A3 Mercados: los cierres de cada rueda.

Escribe futuros.json en la raíz del repo, que la solapa Futuros lee como lee
licitaciones.json.

Fuente: la API pública de estadísticas de A3 (apicem.matbarofex.com.ar), la que
usa su sitio para los precios de cierre. Por contrato y por rueda trae ajuste,
apertura, mínimo, máximo, último, el ajuste anterior, volumen, interés abierto
y su variación, y la tasa implícita que publica A3. No manda CORS, así que la
app no la puede pedir directo: la baja este script.

El spot no viene en la respuesta y sale de la tasa implícita. A3 la calcula
como (ajuste / spot − 1) × 365 / días, con los días de la rueda al último día
hábil del mes, así que spot = ajuste / (1 + tasa × días / 365). Es el mismo
para todos los contratos de la rueda: con la mediana alcanza aunque un feriado
corra algún vencimiento. Después, los días de cada contrato se despejan de su
propia tasa, y son los de A3 sin necesidad de un calendario de feriados.

Qué guarda:
  · curvas: las últimas RUEDAS ruedas, contrato por contrato, de dólar y de
    caución. Alcanza para la rueda anterior y para la de hace un mes.
  · historia: desde 2020, por rueda, el spot y la tasa a 90 días, interpolada
    entre los contratos de 30 días o más.

Uso:
  python .github/scripts/futuros.py                      # al día
  python .github/scripts/futuros.py --desde 2020-01-01   # rearma la historia

Sólo biblioteca estándar: el workflow no instala nada.
"""
import argparse
import calendar
import datetime as dt
import io
import json
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SALIDA = os.path.join(RAIZ, 'futuros.json')

API = 'https://apicem.matbarofex.com.ar/api/v2/closing-prices'
PAGINA = 5000
RUEDAS = 30            # curvas completas que se guardan
VENTANA = 50           # días corridos que se piden en cada pasada diaria
DESDE_HIST = '2020-01-02'
MESES = {'ENE': 1, 'FEB': 2, 'MAR': 3, 'ABR': 4, 'MAY': 5, 'JUN': 6,
         'JUL': 7, 'AGO': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DIC': 12}


def log(*a):
    print(*a, file=sys.stderr)


def pedir(params, intentos=3):
    url = API + '?' + urllib.parse.urlencode(params)
    for i in range(intentos):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (bonos-ar)', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            if i == intentos - 1:
                raise
            log('  reintento', e)
            time.sleep(5 * (i + 1))


def bajar(desde, hasta, producto=None):
    """Todas las filas de futuros del segmento Monedas entre dos fechas, página
    por página. Con producto, sólo ese (DLR)."""
    filas, pag = [], 1
    while True:
        q = {'segment': 'Monedas', 'type': 'FUT', 'excludeEmptyVol': 'false', 'from': desde, 'to': hasta,
             'page': pag, 'pageSize': PAGINA, 'sortDir': 'ASC', 'market': 'ROFX'}
        if producto:
            q['product'] = producto
        d = pedir(q)
        filas += d.get('data') or []
        if pag * PAGINA >= (d.get('totalEntries') or 0):
            return filas
        pag += 1
        time.sleep(1)


def num(v):
    return None if v is None else float(v)


def precio(v):
    """A3 pone 0 en apertura, mínimo, máximo y último cuando el contrato no operó."""
    v = num(v)
    return v if v else None


def ultimo_habil(anio, mes):
    d = dt.date(anio, mes, calendar.monthrange(anio, mes)[1])
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d


def curva_dolar(rueda, filas):
    """Los contratos de dólar de una rueda, con el spot de A3 y los días de cada
    uno. Devuelve (spot, contratos)."""
    t = dt.date.fromisoformat(rueda)
    base = []
    for f in filas:
        s = f['symbol']
        if not (s.startswith('DLR') and len(s) == 9 and s[3:].isdigit()):
            continue
        aj = num(f.get('settlement'))
        if not aj:
            continue
        est = (ultimo_habil(int(s[5:]), int(s[3:5])) - t).days
        if est < 0:
            continue
        base.append((s, aj, num(f.get('impliedRate')), est, f))
    base.sort(key=lambda x: (x[0][5:], x[0][3:5]))
    spots = [aj / (1 + r / 100 * est / 365) for s, aj, r, est, f in base if r is not None and est >= 5]
    if not spots:
        return None, []
    spot = statistics.median(spots)
    out = []
    for s, aj, r, est, f in base:
        dias = est
        if r is not None and abs(r) > 0.5 and est >= 5:
            d2 = round((aj / spot - 1) * 365 / (r / 100))
            if abs(d2 - est) <= 4:
                dias = d2
        if dias <= 0:
            continue
        tna = r if r is not None else (aj / spot - 1) * 365 / dias * 100
        vence = (t + dt.timedelta(days=dias)).isoformat()
        out.append([s, vence, dias, aj, precio(f.get('open')), precio(f.get('low')), precio(f.get('high')),
                    precio(f.get('close')), precio(f.get('previousClose')), int(f.get('volume') or 0),
                    int(num(f.get('openInterest')) or 0), int(num(f.get('openInterestChange')) or 0), round(tna, 4)])
    return round(spot, 4), out


def curva_caucion(filas):
    out = []
    for f in filas:
        s = f['symbol']
        if not s.startswith('CAUC/') or s[5:8] not in MESES:
            continue
        aj = num(f.get('settlement'))
        if not aj:
            continue
        out.append([s, aj, precio(f.get('open')), precio(f.get('low')), precio(f.get('high')),
                    precio(f.get('close')), precio(f.get('previousClose')), int(f.get('volume') or 0),
                    int(num(f.get('openInterest')) or 0), int(num(f.get('openInterestChange')) or 0)])
    out.sort(key=lambda r: (r[0][8:], MESES[r[0][5:8]]))
    return out


def tasa90(contratos):
    """La TNA a 90 días, interpolada entre los contratos de 30 días o más. Si el
    primero ya pasa los 90, la suya."""
    g = [(c[2], c[12]) for c in contratos if c[2] >= 30 and c[12] is not None]
    for (d0, t0), (d1, t1) in zip(g, g[1:]):
        if d0 <= 90 <= d1:
            return round(t0 + (t1 - t0) * (90 - d0) / (d1 - d0), 3)
    if g and g[0][0] > 90:
        return round(g[0][1], 3)
    return None


def por_rueda(filas):
    r = {}
    for f in filas:
        r.setdefault(f['dateTime'][:10], []).append(f)
    return r


def volcar(datos):
    """JSON con una línea por rueda: el workflow commitea este archivo y así el
    diff de cada día se lee."""
    j = lambda o: json.dumps(o, ensure_ascii=False, separators=(',', ':'))
    out = ['{']
    for k in ('generado', 'fuente', 'rueda', 'campos'):
        out.append(' %s: %s,' % (json.dumps(k), j(datos[k])))
    fechas = sorted(datos['curvas'])
    out.append(' "curvas": {')
    out += ['  %s: %s%s' % (json.dumps(f), j(datos['curvas'][f]), ',' if n < len(fechas) - 1 else '') for n, f in enumerate(fechas)]
    out.append(' },')
    h = datos['historia']
    out.append(' "historia": [')
    out += ['  %s%s' % (j(x), ',' if n < len(h) - 1 else '') for n, x in enumerate(h)]
    out.append(' ]')
    return '\n'.join(out + ['}']) + '\n'


def leer_actual():
    try:
        with io.open(SALIDA, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--desde', help='YYYY-MM-DD: rearma la historia desde esa fecha')
    a = ap.parse_args()
    previo = leer_actual()
    hoy = dt.date.today()
    reciente = (hoy - dt.timedelta(days=VENTANA)).isoformat()

    hist = {x[0]: x for x in previo.get('historia', [])}
    if a.desde:
        hist = {f: x for f, x in hist.items() if f < a.desde}
        # De a un año: con varios juntos A3 contesta 424.
        for anio in range(int(a.desde[:4]), hoy.year + 1):
            ini, fin = max(a.desde, '%d-01-01' % anio), min(hoy.isoformat(), '%d-12-31' % anio)
            for rueda, fs in sorted(por_rueda(bajar(ini, fin, 'DLR')).items()):
                spot, c = curva_dolar(rueda, fs)
                if spot:
                    hist[rueda] = [rueda, spot, tasa90(c)]
            log('historia', anio, ':', len(hist), 'ruedas')
            time.sleep(1)

    curvas = dict(previo.get('curvas', {}))
    for rueda, fs in sorted(por_rueda(bajar(reciente, hoy.isoformat())).items()):
        spot, c = curva_dolar(rueda, fs)
        if not spot:
            continue
        curvas[rueda] = {'spot': spot, 'dlr': c, 'cau': curva_caucion(fs)}
        hist[rueda] = [rueda, spot, tasa90(c)]
    if not curvas:
        log('A3 no devolvió ninguna rueda')
        sys.exit(1)
    curvas = {f: curvas[f] for f in sorted(curvas)[-RUEDAS:]}

    datos = {
        'generado': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        'fuente': 'A3 Mercados',
        'rueda': max(curvas),
        'campos': {
            'dlr': ['contrato', 'vence', 'dias', 'ajuste', 'apertura', 'minimo', 'maximo', 'ultimo', 'anterior',
                    'volumen', 'ia', 'varIa', 'tna'],
            'cau': ['contrato', 'ajuste', 'apertura', 'minimo', 'maximo', 'ultimo', 'anterior', 'volumen', 'ia', 'varIa'],
            'historia': ['fecha', 'spot', 'tna90'],
        },
        'curvas': curvas,
        'historia': [hist[f] for f in sorted(hist)],
    }
    sin_sello = lambda d: {k: v for k, v in d.items() if k != 'generado'}
    if previo and sin_sello(previo) == json.loads(json.dumps(sin_sello(datos))):
        log('Sin cambios.')
        return
    with io.open(SALIDA, 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(volcar(datos))
    c = curvas[datos['rueda']]
    log('rueda', datos['rueda'], '· spot', c['spot'], '·', len(c['dlr']), 'contratos de dólar,', len(c['cau']), 'de caución ·',
        len(datos['historia']), 'ruedas de historia')


if __name__ == '__main__':
    main()
