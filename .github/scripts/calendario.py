#!/usr/bin/env python3
"""Calendario: las fechas oficiales de publicación que importan para los bonos.

Escribe calendario.json en la raíz del repo, que la solapa Calendario lee junto
con lo que la app ya sabe por sí sola (el cronograma de licitaciones, los
vencimientos y pagos de los bonos, los feriados).

Fuentes, ninguna con CORS, por eso las baja este script:
  · INDEC, su calendario de difusión, mes por mes: el IPC nacional con su hora
    y unos pocos informes más que mueven los bonos en pesos (EMAE, PBI,
    salarios, comercio exterior, precios mayoristas, pobreza, balanza de
    pagos).
  · El Instituto de Estadística de la Ciudad: el IPC CABA (IPCBA).
  · La Reserva Federal: las reuniones del FOMC; el día de la decisión es el
    segundo de cada reunión, y las marcadas con asterisco traen proyecciones.

Lo que una fuente ya no muestra —un mes pasado del INDEC, por ejemplo— queda
de la corrida anterior.

Uso:
  python .github/scripts/calendario.py

Sólo biblioteca estándar: el workflow no instala nada.
"""
import datetime as dt
import html
import io
import json
import os
import re
import sys
import time
import urllib.request

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SALIDA = os.path.join(RAIZ, 'calendario.json')

INDEC = 'https://www.indec.gob.ar/Calendario/FiltrosCalendario/mes/%s-%d/0'
CABA = 'https://www.estadisticaciudad.gob.ar/eyc/calendario-listado/'
FED = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'

MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto',
         'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
CORTO = {m.lower(): m[:3].lower() for m in MESES}
MESES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
            'September', 'October', 'November', 'December']
GUARDAR_DIAS = 400   # lo anterior a esto se descarta

# Los informes del INDEC que van: patrón del título → (tipo, etiqueta corta).
# {m} es el mes de referencia abreviado; {t} el trimestre o semestre.
INDEC_INFORMES = [
    (r'^[IÍ]ndice de precios al consumidor \(IPC\)\. Cobertura nacional', 'ipc_nacion', 'IPC {m}'),
    (r'^Estimador mensual de actividad econ[oó]mica', 'indec', 'EMAE {m}'),
    (r'^Informe de avance del nivel de actividad', 'indec', 'PBI {t}'),
    (r'^[IÍ]ndice de salarios', 'indec', 'Salarios {m}'),
    (r'^Intercambio comercial argentino', 'indec', 'Comercio exterior {m}'),
    (r'^Sistema de [ií]ndices de precios mayoristas', 'indec', 'Mayoristas {m}'),
    (r'pobreza', 'indec', 'Pobreza {t}'),
    (r'^Balanza de pagos', 'indec', 'Balanza de pagos {t}'),
]


def log(*a):
    print(*a, file=sys.stderr)


def get(url, intentos=3):
    for i in range(intentos):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (bonos-ar)', 'Accept': 'text/html,*/*'})
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
            try:
                return b.decode('utf-8')
            except UnicodeDecodeError:
                return b.decode('cp1252', 'replace')
        except Exception as e:
            if i == intentos - 1:
                raise
            log('  reintento', url, e)
            time.sleep(3 * (i + 1))


def texto(s):
    t = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' | ', s)))
    return re.sub(r'(\| )+', '| ', t)


def ref_mes(titulo):
    m = re.search(r'\b(' + '|'.join(MESES) + r') de (\d{4})', titulo, re.I)
    return CORTO.get(m.group(1).lower(), '') if m else ''


def ref_periodo(titulo):
    m = re.search(r'(primer|segundo|tercer|cuarto)\w*\s+(trimestre|semestre)\s+de\s+(\d{4})', titulo, re.I)
    if not m:
        return ''
    n = {'primer': '1', 'segundo': '2', 'tercer': '3', 'cuarto': '4'}[m.group(1).lower()]
    return ('%sT%s' if m.group(2).lower() == 'trimestre' else '%sS%s') % (n, m.group(3)[2:])


def indec(anio, mes):
    """Los informes que van del mes, como [fecha, hora, tipo, corto, título, fuente]."""
    t = texto(get(INDEC % (MESES[mes - 1], anio)))
    out, dia = [], None
    # El listado es: día | DÍA DE LA SEMANA | título | hora | título | hora | día | …
    partes = [p.strip() for p in t.split('|')]
    for k, p in enumerate(partes):
        if re.fullmatch(r'\d{1,2}', p) and k + 1 < len(partes) and re.fullmatch(r'[A-ZÁÉÍÓÚ]+', partes[k + 1] or ''):
            dia = int(p)
            continue
        if not dia or k + 1 >= len(partes) or not re.fullmatch(r'\d{1,2}:\d{2}hs', partes[k + 1] or ''):
            continue
        for pat, tipo, corto in INDEC_INFORMES:
            if re.search(pat, p, re.I):
                out.append(['%d-%02d-%02d' % (anio, mes, dia), partes[k + 1][:5], tipo,
                            corto.format(m=ref_mes(p), t=ref_periodo(p)).strip(), p.rstrip('. '), 'INDEC'])
                break
    return out


def caba():
    t = texto(get(CABA))
    out = []
    for f, h, tit in re.findall(r'(\d{2}/\d{2}/\d{4}) (\d{1,2}:\d{2} [ap]m) \| ([^|]{5,200})', t):
        if not tit.strip().startswith('IPCBA'):
            continue
        d, m, a = f.split('/')
        hh, mm = h[:-3].split(':')
        hh = int(hh) % 12 + (12 if h.endswith('pm') else 0)
        out.append(['%s-%s-%s' % (a, m, d), '%02d:%s' % (hh, mm), 'ipc_caba', 'IPC CABA ' + ref_mes(tit), tit.strip().rstrip('. '), 'Ciudad'])
    return out


def fomc():
    s = get(FED)
    out = []
    for bloque in re.findall(r'(\d{4}) FOMC Meetings(.*?)(?=\d{4} FOMC Meetings|$)', s, re.S):
        anio, cuerpo = int(bloque[0]), bloque[1]
        for mes_txt, dias in re.findall(r'fomc-meeting__month[^>]*>\s*<strong>([^<]+)</strong>.*?fomc-meeting__date[^>]*>([^<]+)<', cuerpo, re.S):
            meses = [m.strip() for m in mes_txt.split('/')]
            proy = '*' in dias
            d = re.findall(r'\d{1,2}', dias)
            if not d or meses[-1] not in MESES_EN:
                continue
            # La decisión sale el último día de la reunión, en el último mes nombrado.
            mes = MESES_EN.index(meses[-1]) + 1
            fecha = '%d-%02d-%02d' % (anio, mes, int(d[-1]))
            out.append([fecha, '15:00', 'fomc', 'FOMC' + (' + proyecc.' if proy else ''),
                        'Fed: decisión de tasa del FOMC' + (', con proyecciones económicas' if proy else ''), 'Fed'])
    return out


def volcar(datos):
    j = lambda o: json.dumps(o, ensure_ascii=False, separators=(', ', ': '))
    ev = datos['eventos']
    out = ['{']
    for k, v in datos.items():
        if k != 'eventos':
            out.append(' %s: %s,' % (json.dumps(k), j(v)))
    out.append(' "eventos": [')
    out += ['  ' + j(e) + (',' if n < len(ev) - 1 else '') for n, e in enumerate(ev)]
    out += [' ]', '}']
    return '\n'.join(out) + '\n'


def leer_actual():
    try:
        with io.open(SALIDA, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    previo = leer_actual()
    hoy = dt.date.today()
    nuevos, fuentes_ok = [], set()
    # INDEC: el mes pasado y los doce que vienen (los que todavía no publicó
    # vuelven vacíos).
    for k in range(-1, 13):
        y, m = hoy.year + (hoy.month - 1 + k) // 12, (hoy.month - 1 + k) % 12 + 1
        try:
            ev = indec(y, m)
            nuevos += ev
            fuentes_ok.add(('INDEC', '%d-%02d' % (y, m)))
            log('INDEC', y, m, len(ev))
        except Exception as e:
            log('INDEC', y, m, e)
        time.sleep(0.5)
    for nombre, fn in (('Ciudad', caba), ('Fed', fomc)):
        try:
            ev = fn()
            nuevos += ev
            fuentes_ok.add((nombre, '*'))
            log(nombre, len(ev))
        except Exception as e:
            log(nombre, e)
    # Lo de la corrida anterior queda si su fuente no contestó, o si es de un
    # mes del INDEC que ya no se pidió.
    def cubierto(e):
        return (e[5], e[0][:7]) in fuentes_ok or (e[5], '*') in fuentes_ok
    corte = (hoy - dt.timedelta(days=GUARDAR_DIAS)).isoformat()
    previos = [e for e in previo.get('eventos', []) if e[0] >= corte and not cubierto(e)]
    vistos, eventos = set(), []
    for e in sorted(previos + [e for e in nuevos if e[0] >= corte], key=lambda e: (e[0], e[1], e[2], e[4])):
        k = (e[0], e[2], e[4])
        if k in vistos:
            continue
        vistos.add(k)
        eventos.append(e)
    datos = {'fuente': 'INDEC (calendario de difusión), Instituto de Estadística de la Ciudad (IPCBA) y Reserva Federal (FOMC)',
             'columnas': ['fecha', 'hora', 'tipo', 'corto', 'titulo', 'fuente'],
             'eventos': eventos}
    sin_sello = lambda d: {k: v for k, v in d.items() if k != 'generado'}
    if sin_sello(previo) == datos:
        log('Sin cambios.')
        return
    datos = {'generado': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), **datos}
    texto_json = volcar(datos)
    json.loads(texto_json)
    with io.open(SALIDA, 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(texto_json)
    log('Escrito', SALIDA, ':', len(eventos), 'eventos')


if __name__ == '__main__':
    main()
