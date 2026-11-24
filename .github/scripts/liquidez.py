#!/usr/bin/env python3
"""Liquidez: el REPO en pesos del MAE, rueda por rueda, con y sin el BCRA, y la
caución en pesos a un día hábil.

Escribe liquidez.json en la raíz del repo, que la solapa Liquidez lee como lee
futuros.json.

Fuente: la API pública del MAE (api.marketdata.mae.com.ar), la que usa su
sitio para la pantalla de REPO. Por rueda trae el volumen operado en millones
de pesos, la tasa promedio ponderada de todo el REPO a un día y la misma sin
las operaciones del BCRA. No manda CORS, así que la app no la puede pedir
directo: la baja este script.

Del mismo MAE sale la caución en pesos (CAARS): por día, la tasa promedio
ponderada y el monto del plazo con más monto, que es el de un día hábil: tres
días corridos los viernes, y más antes de un feriado (el 05/11/2026 operó 2,88
billones a 6 días y 0,01 a uno). Va en las mismas filas, para comparar tasas.
Si el histórico de cauciones no responde —desde el 19/11/2026 da 400 con "Could
not find stored procedure"—, sale de las series de tasa y volumen de cada plazo
del mismo MAE, con la misma regla.

Lo que el MAE no publica es cuánto puso o tomó el BCRA. La app lo estima con
esas dos tasas: si el BCRA toma a una tasa fija, la tasa de todo el REPO es el
promedio ponderado de la del BCRA y la del resto, y su parte sale despejada.
Eso se hace en la app, no acá: este archivo guarda sólo lo publicado.

Uso:
  python .github/scripts/liquidez.py                      # al día
  python .github/scripts/liquidez.py --desde 2026-01-01   # rearma la historia

Sólo biblioteca estándar: el workflow no instala nada.
"""
import argparse
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SALIDA = os.path.join(RAIZ, 'liquidez.json')

API = 'https://api.marketdata.mae.com.ar/api/mercado/repo/titulosfecha'
API_CAU = 'https://api.marketdata.mae.com.ar/api/mercado/titulo/historicocauciones'
API_CAU_SERIE = 'https://api.marketdata.mae.com.ar/api/mercado/cauciones/valorescierre/volumentasas'
DESDE_HIST = '2026-01-01'   # desde acá el BCRA toma en el REPO a una tasa fija
VENTANA = 40                # días corridos que se piden en cada pasada diaria


def log(*a):
    print(*a, file=sys.stderr)


def pedir(url, o, intentos=3):
    q = urllib.parse.quote(json.dumps(o))
    for i in range(intentos):
        try:
            req = urllib.request.Request(url + '?oTitulo=' + q, headers={'User-Agent': 'Mozilla/5.0 (bonos-ar)', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            if i == intentos - 1:
                raise
            log('  reintento', e)
            time.sleep(3 * (i + 1))


def num(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def ruedas(desde, hasta):
    """[fecha, volumen en millones, tasa PP, tasa PP sin BCRA] por rueda."""
    out = {}
    for x in pedir(API, {'fechaDesde': desde, 'fechaHasta': hasta, 'unit': 'USD'}) or []:
        d = x.get('details') or {}
        f = str(x.get('fecha') or d.get('fecha') or '')[:10]
        v, t, n = num(d.get('volumen', x.get('volumen'))), num(d.get('tPP')), num(d.get('tPPnBCRA'))
        if len(f) == 10 and v and v > 0 and t is not None:
            out[f] = [f, round(v, 3), round(t, 4), round(n, 4) if n is not None else None]
    return out


def cauciones(desde, hasta):
    """{fecha: [tasa PP, monto en millones]} de la caución en pesos al plazo de
    un día hábil: el de más monto entre los de hasta diez días. Se pide de a un
    mes: el día trae todos los plazos."""
    out = {}
    d0, fin = dt.date.fromisoformat(desde), dt.date.fromisoformat(hasta)
    while d0 <= fin:
        d1 = min(fin, d0 + dt.timedelta(days=30))
        for d in pedir(API_CAU, {'fechaDesde': d0.isoformat(), 'fechaHasta': d1.isoformat()}) or []:
            f = str(d.get('fecha') or '')[:10]
            cand = [x for x in d.get('details') or []
                    if x.get('ticker') == 'CAARS' and x.get('moneda') == '$'
                    and (num(x.get('tasaPP')) or 0) > 0 and (num(x.get('montoConcertado')) or 0) > 0
                    and str(x.get('plazo') or '').isdigit() and int(x['plazo']) <= 10]
            if len(f) == 10 and cand:
                x = max(cand, key=lambda x: num(x['montoConcertado']))
                out[f] = [round(num(x['tasaPP']), 4), round(num(x['montoConcertado']) / 1e6, 3)]
        d0 = d1 + dt.timedelta(days=1)
    return out


def cauciones_por_plazo(desde, hasta):
    """Lo mismo que cauciones(), desde las series de tasa y volumen de cada
    plazo de uno a diez días: por día, el plazo con más volumen. La tasa es la
    del histórico al decimal; el monto es el volumen de la serie, que difiere
    del montoConcertado del histórico en torno al 0,1%."""
    cand = {}
    for pl in range(1, 11):
        try:
            d = pedir(API_CAU_SERIE, {'codTitulo': 'CAARS', 'plazo': '%03d' % pl,
                                      'fechaDesde': desde, 'fechaHasta': hasta}) or {}
        except Exception as e:
            log('  caución a %d días:' % pl, e)
            continue
        vol = {x.get('time'): num(x.get('value')) for x in d.get('volumen') or []}
        for x in d.get('tasa') or []:
            tasa, v = num(x.get('value')), vol.get(x.get('time'))
            if not (tasa and tasa > 0 and v and v > 0):
                continue
            # time: segundos UTC, a la medianoche del día de la rueda.
            f = dt.datetime.fromtimestamp(x['time'], tz=dt.timezone.utc).date().isoformat()
            if f not in cand or v > cand[f][1]:
                cand[f] = [tasa, v]
    return {f: [round(tasa, 4), round(v / 1e6, 3)] for f, (tasa, v) in cand.items()}


def volcar(datos):
    """Una línea por rueda: el diff de cada día se lee."""
    j = lambda o: json.dumps(o, ensure_ascii=False, separators=(', ', ': '))
    filas = datos['ruedas']
    out = ['{']
    for k, v in datos.items():
        if k != 'ruedas':
            out.append(' %s: %s,' % (json.dumps(k), j(v)))
    out.append(' "ruedas": [')
    out += ['  ' + j(r) + (',' if n < len(filas) - 1 else '') for n, r in enumerate(filas)]
    out += [' ]', '}']
    return '\n'.join(out) + '\n'


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
    desde = a.desde or (hoy - dt.timedelta(days=VENTANA)).isoformat()
    por = {r[0]: r for r in previo.get('ruedas', []) if r and r[0] >= DESDE_HIST}
    nuevas = ruedas(desde, hoy.isoformat())
    log('ruedas del MAE desde', desde, ':', len(nuevas))
    # La caución va en la misma fila; las ruedas que no se volvieron a pedir
    # conservan la suya.
    try:
        cau = cauciones(desde, hoy.isoformat())
    except Exception as e:
        log('  sin el histórico de cauciones:', e)
        cau = {}
    log('cauciones del MAE desde', desde, ':', len(cau))
    # Lo que el histórico no trajo, de las series por plazo. Una rueda que ya
    # tenía caución la conserva —no se reescribe la historia por la diferencia
    # de monto entre las dos fuentes—, salvo las de los últimos días, por si
    # alguna pasada las tomó con la rueda a medio hacer.
    serie = {}
    if any(f not in cau for f in nuevas):
        serie = cauciones_por_plazo(desde, hoy.isoformat())
        log('cauciones de las series por plazo:', len(serie))
    reciente = (hoy - dt.timedelta(days=4)).isoformat()
    for f, r in nuevas.items():
        viejo = por.get(f) or []
        previa = viejo[4:6] if len(viejo) >= 6 and viejo[4] is not None else None
        r += (cau.get(f) or (serie.get(f) if f >= reciente else None)
              or previa or serie.get(f) or [None, None])
    por.update({f: r for f, r in nuevas.items() if f >= DESDE_HIST})
    por = {f: (r + [None] * 6)[:6] for f, r in por.items()}
    datos = {'fuente': 'MAE · REPO en pesos a un día: volumen (millones de $) y tasa promedio ponderada, con y sin el BCRA; caución en pesos a un día hábil: tasa promedio ponderada y monto (millones de $)',
             'columnas': ['fecha', 'volumen', 'tasa', 'tasaSinBCRA', 'caucion', 'montoCaucion'],
             'ruedas': [por[f] for f in sorted(por)]}
    sin_sello = lambda d: {k: v for k, v in d.items() if k != 'generado'}
    if sin_sello(previo) == datos:
        log('Sin cambios.')
        return
    datos = {'generado': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), **datos}
    texto = volcar(datos)
    json.loads(texto)
    with io.open(SALIDA, 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(texto)
    log('Escrito', SALIDA, ':', len(datos['ruedas']), 'ruedas, la última', datos['ruedas'][-1][0] if datos['ruedas'] else '—')


if __name__ == '__main__':
    main()
