#!/usr/bin/env python3
"""Liquidez: el REPO en pesos del MAE, rueda por rueda, con y sin el BCRA.

Escribe liquidez.json en la raíz del repo, que la solapa Liquidez lee como lee
futuros.json.

Fuente: la API pública del MAE (api.marketdata.mae.com.ar), la que usa su
sitio para la pantalla de REPO. Por rueda trae el volumen operado en millones
de pesos, la tasa promedio ponderada de todo el REPO a un día y la misma sin
las operaciones del BCRA. No manda CORS, así que la app no la puede pedir
directo: la baja este script.

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
DESDE_HIST = '2026-01-01'   # desde acá el BCRA toma en el REPO a una tasa fija
VENTANA = 40                # días corridos que se piden en cada pasada diaria


def log(*a):
    print(*a, file=sys.stderr)


def pedir(desde, hasta, intentos=3):
    q = urllib.parse.quote(json.dumps({'fechaDesde': desde, 'fechaHasta': hasta, 'unit': 'USD'}))
    for i in range(intentos):
        try:
            req = urllib.request.Request(API + '?oTitulo=' + q, headers={'User-Agent': 'Mozilla/5.0 (bonos-ar)', 'Accept': 'application/json'})
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
    for x in pedir(desde, hasta) or []:
        d = x.get('details') or {}
        f = str(x.get('fecha') or d.get('fecha') or '')[:10]
        v, t, n = num(d.get('volumen', x.get('volumen'))), num(d.get('tPP')), num(d.get('tPPnBCRA'))
        if len(f) == 10 and v and v > 0 and t is not None:
            out[f] = [f, round(v, 3), round(t, 4), round(n, 4) if n is not None else None]
    return out


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
    por.update({f: r for f, r in nuevas.items() if f >= DESDE_HIST})
    datos = {'fuente': 'MAE · REPO en pesos a un día: volumen (millones de $) y tasa promedio ponderada, con y sin el BCRA',
             'columnas': ['fecha', 'volumen', 'tasa', 'tasaSinBCRA'],
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
