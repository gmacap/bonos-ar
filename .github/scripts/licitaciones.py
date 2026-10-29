#!/usr/bin/env python3
"""Licitaciones del Tesoro: cronograma, resultados y próximo llamado.

Escribe licitaciones.json en la raíz del repo, que la solapa Licitaciones lee
como lee rem.json.

Fuente: la Secretaría de Finanzas en argentina.gob.ar.
  · El cronograma oficial está embebido en la página del año como una lista de
    fechas (holidays2026 = [...]) con llamado, licitación y liquidación.
  · Cada resultado es una noticia con una tabla por tipo de instrumento: VNO
    ofertado y adjudicado, valor efectivo, precio de corte, TIREA y VNO en
    circulación, y una tabla de totales.
  · El llamado es otra noticia, con los instrumentos y las fechas.

Respaldo: el MAE, que publica las licitaciones de los últimos 30 días con
precio de corte y VNO adjudicado. Se usa sólo para una licitación que el MAE ya
tiene y Finanzas todavía no publicó, y para el llamado si la noticia no está.

Lo que no se puede reconstruir de los comunicados no se inventa: el rollover
oficial aparece sólo cuando el texto lo dice. Aparte, y marcado como tal, va un
rollover estimado sobre el total de vencimientos (ver "Rollover estimado"), con
el libro de circulación en circulacion.json.

Uso:
  python .github/scripts/licitaciones.py                 # al día
  python .github/scripts/licitaciones.py --desde 2025-01-01   # historial
  python .github/scripts/licitaciones.py --libro-desde 2024-01-01   # rearma el libro

Sólo biblioteca estándar: el workflow no instala nada.
"""
import argparse
import datetime as dt
import html
import io
import json
import os
import re
import ssl
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from html.parser import HTMLParser

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SALIDA = os.path.join(RAIZ, 'licitaciones.json')

BASE = 'https://www.argentina.gob.ar'
LISTADO = [BASE + '/economia/finanzas/noticias'] + [BASE + '/node/77983/noticias?page=%d' % p for p in range(1, 60)]
CRONOGRAMA = BASE + '/economia/finanzas/licitaciones-de-letras-y-bonos-del-tesoro/cronograma-%d'
MAE = 'https://api.marketdata.mae.com.ar/api/mercado/licitacionesporestado/Todos?oTitulo='

MESES = {'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6, 'julio': 7,
         'agosto': 8, 'septiembre': 9, 'setiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12}
# "(S29E7 - reapertura)", "(TMVE8 – reapertura)", "(T30J6 - nuevo)" o, en un
# instrumento nuevo que todavía no tiene ticker, "(nuevo)" a secas.
TICKER = re.compile(r'\(\s*(?!NUEV|REAPERT)([A-Z][A-Z0-9]{2,5})\s*(?:[-–—]\s*(nuev[oa]s?|reapertura))?\s*\)', re.I)
# Sin ticker: "(nuevo)", o con el nombre comercial, "(BONAR 2027 - reapertura)".
SIN_TICKER = re.compile(r'\(\s*(?:[A-Z]+\s+\d{4}\s*[-–—]\s*)?(nuev[oa]s?|reapertura)\s*\)', re.I)
# Al revés, como en algunos comunicados de 2026: "(nuevo - S17L6)".
TICKER_INV = re.compile(r'\(\s*(nuev[oa]s?|reapertura)\s*[-–—]\s*([A-Z][A-Z0-9]{2,5})\s*\)', re.I)


def log(*a):
    print(*a, file=sys.stderr)


def get(url, intentos=3):
    for i in range(intentos):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (bonos-ar)', 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception as e:
            if i == intentos - 1:
                raise
            log('  reintento', url, e)
            time.sleep(3 * (i + 1))


def sin_tildes(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def norm(s):
    return re.sub(r'\s+', ' ', html.unescape(s or '')).strip()


def num(s, monto=False):
    """'$ 1.042.888 (**)' -> 1042888 · 'USD 946,46' -> 946.46 · '2,27% (1)' -> 2.27.
    Finanzas escribe los miles con punto y los decimales con coma, pero algunos
    comunicados salieron con el formato inglés ('USD 1,015.33', '5.12%',
    '$ 6,075,698'). Con los dos signos, el último es el decimal; con uno solo,
    un punto seguido de grupos de tres cifras es de miles, y una coma también
    si es un monto."""
    if s is None:
        return None
    s = re.sub(r'\(\s*\*+\s*\)|\(\s*\d+\s*\)', ' ', s).replace('−', '-').replace('–', '-')
    m = re.search(r'-?\s?\d[\d.,]*', s)
    if not m:
        return None
    t = m.group(0).replace(' ', '').rstrip('.,')
    if ',' in t and '.' in t:
        t = t.replace('.', '').replace(',', '.') if t.rfind(',') > t.rfind('.') else t.replace(',', '')
    elif ',' in t:
        t = t.replace(',', '') if monto and re.fullmatch(r'-?\d{1,3}(,\d{3})+', t) else t.replace(',', '.')
    elif re.fullmatch(r'-?\d{1,3}(\.\d{3})+', t):
        t = t.replace('.', '')
    try:
        return float(t)
    except ValueError:
        return None


def fecha_larga(s):
    """'14 de octubre de 2026' -> '2026-10-14'."""
    m = re.search(r'(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de\s+)?(\d{4})', sin_tildes(s), re.I)
    if not m or m.group(2).lower() not in MESES:
        return None
    return '%s-%02d-%02d' % (m.group(3), MESES[m.group(2).lower()], int(m.group(1)))


# ── El cuerpo de una noticia como párrafos y tablas, en orden ─────────────────
class Bloques(HTMLParser):
    BLOQUE = ('p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'ul', 'ol')

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.bloques, self.tabla, self.fila, self.celda, self.texto = [], None, None, None, []

    def _cerrar(self):
        t = norm(''.join(self.texto))
        self.texto = []
        if t:
            self.bloques.append(('texto', t))

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self._cerrar()
            self.tabla = []
        elif tag == 'tr' and self.tabla is not None:
            self.fila = []
        elif tag in ('td', 'th') and self.fila is not None:
            self.celda = []
        elif tag == 'br':
            if self.celda is not None:
                self.celda.append(' ')
            elif self.tabla is None:
                self._cerrar()
        elif tag in self.BLOQUE and self.tabla is None:
            self._cerrar()

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.celda is not None and self.fila is not None:
            self.fila.append(norm(' '.join(self.celda)))
            self.celda = None
        elif tag == 'tr' and self.fila is not None and self.tabla is not None:
            if any(self.fila):
                self.tabla.append(self.fila)
            self.fila = None
        elif tag == 'table' and self.tabla is not None:
            if self.tabla:
                self.bloques.append(('tabla', self.tabla))
            self.tabla = None
        elif tag in self.BLOQUE and self.tabla is None:
            self._cerrar()

    def handle_data(self, d):
        if self.celda is not None:
            self.celda.append(d)
        elif self.tabla is None:
            self.texto.append(d)


def cuerpo(pagina):
    m = re.search(r'<article\b.*?</article>', pagina, re.S) or re.search(r'<main\b.*?</main>', pagina, re.S)
    h = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', m.group(0) if m else pagina, flags=re.S)
    p = Bloques()
    p.feed(h)
    p._cerrar()
    return p.bloques


# ── Instrumentos ──────────────────────────────────────────────────────────────
def clase_de(nombre):
    u = sin_tildes(nombre).upper()
    if 'DUAL' in u or re.search(r'(CER|FIJA|LINKED)\s*/\s*TAMAR|TAMAR\s*/\s*(CER|DOLAR|FIJA)', u):
        return 'dual'
    if 'VINCULAD' in u or 'DOLAR LINKED' in u:
        return 'dl'
    if 'TAMAR' in u or 'BADLAR' in u:
        return 'tamar'
    if re.search(r'\bCER\b', u):
        return 'cer'
    if 'DOLARES ESTADOUNIDENSES' in u and 'PESOS' not in u:
        return 'usd'
    return 'fija'


def dual_de(nombre):
    u = sin_tildes(nombre).upper()
    if clase_de(nombre) != 'dual':
        return None
    if re.search(r'\bCER\b', u):
        return 'cer'
    if 'LINKED' in u or 'VINCULAD' in u:
        return 'dl'
    return 'fija'


def vencimiento_de(nombre):
    u = sin_tildes(nombre).upper()
    m = re.search(r'(?:VENCIMIENTO|VTO\.?)\s*(?:EL\s+)?(?:DEL?\s+)?(\d{1,2})\s+DE\s+([A-Z]+)\s+(?:DE\s+)?(\d{4})', u)
    if m and m.group(2).lower() in MESES:
        return '%s-%02d-%02d' % (m.group(3), MESES[m.group(2).lower()], int(m.group(1)))
    m = re.search(r'(?:VENCIMIENTO|VTO\.?)\s*(\d{1,2})/(\d{1,2})/(\d{4})', u)
    if m:
        return '%s-%02d-%02d' % (m.group(3), int(m.group(2)), int(m.group(1)))
    return None


def instrumento(nombre):
    m, mi = TICKER.search(nombre), TICKER_INV.search(nombre)
    if m:
        ticker, estado = m.group(1).upper(), (m.group(2) or '').lower()
    elif mi:
        ticker, estado = mi.group(2).upper(), mi.group(1).lower()
    elif SIN_TICKER.search(nombre) and 'TESORO' in sin_tildes(nombre).upper():
        # Sin ticker todavía: se completa después con el de otra licitación
        # del mismo bono, o con la lista de bonos de la app.
        ticker, estado = None, SIN_TICKER.search(nombre).group(1).lower()
    else:
        return None
    limpio = norm(SIN_TICKER.sub('', TICKER.sub('', TICKER_INV.sub('', nombre)))).rstrip(' ;,.y')
    limpio = re.sub(r'\s*\(\d+\)\s*$', '', limpio)
    return {'ticker': ticker, 'nombre': limpio, 'clase': clase_de(nombre), 'dual': dual_de(nombre),
            'estado': 'nuevo' if estado.startswith('nuev') else 'reapertura' if estado else None,
            'vencimiento': vencimiento_de(nombre)}


def columnas(enc):
    col = {}
    for i, h in enumerate(enc):
        if i == 0:
            continue
        u = sin_tildes(h).upper()
        if 'OFERTADO' in u:
            col.setdefault('vnoOfertado', i)
        elif 'ADJUDICADO' in u and 'VNO' in u:
            col.setdefault('vnoAdjudicado', i)
        elif 'EFECTIVO' in u or u.startswith('VE '):
            col.setdefault('veAdjudicado', i)
        elif 'CIRCULACION' in u:
            col.setdefault('circulacion', i)
        elif 'PRECIO' in u:
            col.setdefault('precio', i)
        elif 'MARGEN' in u:
            col.setdefault('margen', i)
        elif 'TIREA' in u:
            col.setdefault('tirea', i)
            pata = re.search(r'PATA\s+([A-Z]+)', u)
            if pata:
                col['tireaPata'] = pata.group(1)
        elif u.startswith('TNA') or u.startswith('YIELD'):
            col.setdefault('tna', i)
        elif u.startswith('TEM'):
            col.setdefault('tem', i)
    return col


def es_usd(celda):
    return bool(re.match(r'\s*(USD|U\$S|US\$)', celda or ''))


def filas_instrumentos(tabla, ronda):
    """Las filas de una tabla de resultados por instrumento."""
    if not tabla or len(tabla) < 2:
        return []
    col = columnas(tabla[0])
    if 'vnoAdjudicado' not in col:
        return []
    out = []
    for fila in tabla[1:]:
        ins = instrumento(fila[0])
        if not ins:
            continue
        c = lambda k: fila[col[k]] if k in col and col[k] < len(fila) else None
        x = dict(ins)
        x['ronda'] = ronda
        x['moneda'] = 'USD' if es_usd(c('vnoAdjudicado')) else 'ARS'
        for k in ('vnoOfertado', 'vnoAdjudicado', 'circulacion'):
            x[k] = num(c(k), monto=True)
        x['veAdjudicado'] = num(c('veAdjudicado'), monto=True)
        x['veMoneda'] = 'USD' if es_usd(c('veAdjudicado')) else 'ARS'
        p = c('precio')
        # Una LECAP nueva se licita por TEM a la par, y una letra TAMAR nueva
        # por margen: en la columna del precio viene la tasa, no un precio.
        if p and '%' in p and x['clase'] in ('tamar', 'dual'):
            x['precio'], x['margen'] = None, num(p)
        elif p and '%' in p:
            x['precio'], x['tem'] = None, num(p)
        else:
            x['precio'] = num(p)
            x['tem'] = num(c('tem')) if 'tem' in col else None
        x['tirea'] = num(c('tirea'))
        if col.get('tireaPata'):
            x['tireaPata'] = col['tireaPata']
        x['tna'] = num(c('tna'))
        # En los comunicados de 2025, la columna TNA de una LECAP reabierta
        # traía la TEM con una nota al pie. Una TNA de tasa fija por debajo de
        # 6% no existió en el período: es la TEM.
        if x['clase'] == 'fija' and x['tna'] is not None and x['tna'] < 6 and not x.get('tem'):
            x['tem'], x['tna'] = x['tna'], None
        x['margen'] = x.get('margen') if x.get('margen') is not None else num(c('margen'))
        # Lo que no puede ser un precio por cada VNO 1.000 o una tasa es una
        # columna corrida: se descarta antes que guardar un número falso.
        if x.get('precio') is not None and not (100 <= x['precio'] <= 20000):
            x['precio'] = None
        for k in ('tirea', 'tna', 'tem', 'margen'):
            if x.get(k) is not None and abs(x[k]) > 300:
                x[k] = None
        # Un instrumento desierto queda, para que se vea que se ofreció.
        if not x.get('vnoAdjudicado'):
            x['desierto'] = True
        out.append({k: v for k, v in x.items() if v is not None})
    return out


def totales(tabla):
    """Valor efectivo ofertado y adjudicado de una tabla de totales: la última
    columna, que es la del total. Si está en dólares, va aparte."""
    out = {}
    for fila in tabla:
        u = sin_tildes(fila[0]).upper()
        if not u.startswith('TOTAL') and not u.startswith('CANTIDAD'):
            continue
        # A veces las dos últimas columnas vienen en una sola celda.
        celdas = [p.strip() for c in fila[1:] for p in c.split('|')]
        ultima = next((c for c in reversed(celdas) if num(c, monto=True) is not None), None)
        if ultima is None:
            continue
        v = num(ultima, monto=True)
        suf = 'Usd' if es_usd(ultima) else ''
        if u.startswith('CANTIDAD'):
            out['ofertas'] = int(v)
        elif ('VE ' in u or 'EFECTIVO' in u) and 'OFERTADO' in u:
            out['ofertadoVE' + suf] = v
        elif ('VE ' in u or 'EFECTIVO' in u) and 'ADJUDICADO' in u:
            out['adjudicadoVE' + suf] = v
    return out


def es_conversion(texto):
    u = sin_tildes(texto).upper()
    return 'CONVERSION' in u and bool(re.match(r'^\s*([A-Z]|\d)\)\s', u) or 'LICITACION POR LA CONVERSION' in u
                                      or 'DETALLE NUEVOS' in u or u.startswith('CONVERSION'))


def parsear_resultado(pagina, ronda=1):
    bl = cuerpo(pagina)
    texto = ' '.join(t for k, t in bl if k == 'texto')
    lic = {'instrumentos': []}
    conv = False
    for k, b in bl:
        if k == 'texto':
            if es_conversion(b):
                conv = True
            continue
        if conv or (b and b[0] and 'CONVERSI' in sin_tildes(b[0][0]).upper()):
            continue
        t = totales(b)
        if t and not any(TICKER.search(f[0]) for f in b):
            for kk, v in t.items():
                lic[kk] = lic.get(kk, 0) + v
            continue
        lic['instrumentos'] += filas_instrumentos(b, ronda)
    m = re.search(r'Pesos\s*/\s*USD\s*([\d.,]+)', texto)
    if m:
        lic['a3500'] = num(m.group(1))
    m = re.search(r'roll-?over[”"\s]*(?:del|de)?\s*([\d.,]+)\s*%', texto, re.I)
    if m:
        lic['rollover'] = num(m.group(1))
    m = re.search(r'vencimientos\s*(?:de\s*|\(\s*)\$\s*([\d.,]+)\s*billones', texto)
    if m:
        lic['vencimientos'] = round(num(m.group(1)) * 1e6, 0)   # en millones, como el resto
    # Los totales en dólares de un instrumento integrado en dólares, pasados a
    # pesos con el A3500 del comunicado, para que el total sea uno solo.
    for kk in ('ofertadoVE', 'adjudicadoVE'):
        if lic.get(kk + 'Usd') and lic.get('a3500'):
            lic[kk] = round(lic.get(kk, 0) + lic[kk + 'Usd'] * lic['a3500'], 0)
    return lic


def parsear_llamado(pagina):
    bl = cuerpo(pagina)
    ins, vistos, conv = [], set(), False
    texto = ' '.join(t for k, t in bl if k == 'texto')
    for k, b in bl:
        if k != 'texto':
            continue
        if re.search(r'conversi[oó]n', b, re.I) and re.match(r'^\s*([A-Z]|\d)\)\s', b):
            conv = True
        if re.match(r'^\s*(?:[A-Z]|\d)\)\s', b) and not re.search(r'conversi[oó]n', b, re.I):
            conv = False
        if conv:
            continue
        for m in list(TICKER.finditer(b)) + list(TICKER_INV.finditer(b)) + list(SIN_TICKER.finditer(b)):
            pre = b[:m.end()]
            # El nombre del instrumento es lo que viene antes del ticker en esa línea.
            nombre = re.split(r'(?:^|\s)[a-z]\.\s', pre)[-1]
            x = instrumento(nombre)
            k = x and (x['ticker'] or (x['clase'], x['dual'], x['vencimiento']))
            if x and k not in vistos and (x['estado'] or 'TESORO' in sin_tildes(nombre).upper()):
                vistos.add(k)
                ins.append({kk: v for kk, v in x.items() if v is not None})
    out = {'instrumentos': ins}
    m = re.search(r'finalizar[aá][^.]*?d[ií]a\s+\w+\s+(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})', texto, re.I)
    if m:
        out['fecha'] = fecha_larga(m.group(1))
    m = re.search(r'liquidaci[oó]n[^.]*?se efectuar[aá][^.]*?d[ií]a\s+\w+\s+(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})', texto, re.I)
    if m:
        out['liquidacion'] = fecha_larga(m.group(1))
    return out


# ── El listado de noticias ────────────────────────────────────────────────────
def listado(desde):
    items = []
    for url in LISTADO:
        try:
            s = get(url)
        except Exception as e:
            log('listado:', url, e)
            break
        nuevos = 0
        for h, t in re.findall(r'<a[^>]+href="(/noticias/[^"]+)"[^>]*>(.*?)</a>', s, re.S):
            t = norm(re.sub(r'<[^>]+>', ' ', t))
            m = re.match(r'(\d{1,2} de \w+ de \d{4})\s+(.*)', t)
            if not m:
                continue
            items.append({'fecha': fecha_larga(m.group(1)), 'titulo': m.group(2), 'url': BASE + h})
            nuevos += 1
        if not nuevos or (items and items[-1]['fecha'] and items[-1]['fecha'] < desde):
            break
        time.sleep(1)
    return [x for x in items if x['fecha'] and x['fecha'] >= desde]


def tipo_noticia(titulo):
    u = sin_tildes(titulo).upper()
    if u.startswith('RESULTADO'):
        if 'SEGUNDA VUELTA' in u:
            return 'segunda'
        if re.match(r'RESULTADO DE LA LICITACION DEL DIA', u):
            return 'correccion'
        # Una conversión sola no es una licitación por efectivo. Si el título
        # dice "por efectivo y conversión", la parte de conversión se saltea
        # al parsear.
        if 'CONVERSION' in u and 'EFECTIVO' not in u and 'LECAP' not in u and 'BONCER' not in u and 'BONCAP' not in u:
            return None
        return 'resultado'
    if u.startswith('LLAMADO') or 'LLAMADO A LICITACION' in u:
        if 'CONVERSION' in u and 'EFECTIVO' not in u and 'INSTRUMENTOS' not in u and 'LECAP' not in u:
            return None
        return 'llamado'
    return None


# ── Cronograma ────────────────────────────────────────────────────────────────
def cronograma(anio):
    try:
        s = get(CRONOGRAMA % anio)
    except Exception as e:
        log('cronograma', anio, e)
        return None
    ev = re.findall(r'"date"\s*:\s*"(\d{2})/(\d{2})/(\d{4})"[^}]*?"type"\s*:\s*"(\w+)"', s)
    if not ev:
        return None
    ev = sorted(('%s-%s-%s' % (a, m, d), t) for d, m, a, t in ev)
    filas, actual = [], {}
    for f, t in ev:
        if t == 'llamado':
            actual = {'llamado': f}
        elif t == 'licitacion':
            actual['licitacion'] = f
        elif t == 'liquidacion' and actual.get('licitacion'):
            actual['liquidacion'] = f
            filas.append([actual.get('llamado'), actual['licitacion'], f])
            actual = {}
    return filas


# ── MAE ───────────────────────────────────────────────────────────────────────
def mae(estado):
    hoy = dt.date.today()
    q = json.dumps({'estado': estado, 'fechaDesde': (hoy - dt.timedelta(days=40)).isoformat(),
                    'fechaHasta': (hoy + dt.timedelta(days=40)).isoformat()}, separators=(',', ':'))
    try:
        d = json.loads(get(MAE + urllib.parse.quote(q)))
    except Exception as e:
        log('MAE', estado, e)
        return []
    return [x for x in d if 'ECONOMIA' in sin_tildes(x.get('emisor') or '').upper()]


def mae_instrumento(x):
    ins = instrumento(x.get('titulo') or '')
    if not ins:
        return None
    ins['vencimiento'] = ins.get('vencimiento') or (x.get('fechaVencimiento') or '')[:10] or None
    if not ins.get('estado'):
        ins['estado'] = 'reapertura' if 'REAPERTURA' in sin_tildes(x.get('titulo') or '').upper() else None
    return {k: v for k, v in ins.items() if v is not None}


def mae_fecha(x, campo):
    """El MAE manda medianoche de Buenos Aires en UTC: 03:00Z es el día."""
    v = x.get(campo) or ''
    try:
        t = dt.datetime.fromisoformat(v.replace('Z', '+00:00')) - dt.timedelta(hours=3)
        return t.date().isoformat()
    except ValueError:
        return v[:10] or None


def mae_precio(v):
    """El MAE escribe el corte a mano y sin un formato fijo: '$ 946.46',
    '$ 1.226', '$ 1.494,50', 'USD 992.80'. Un punto seguido de tres cifras y
    nada más es de miles."""
    s = re.sub(r'[^\d.,]', '', (v or '').split(':')[-1])
    if not s:
        return None
    if ',' in s:
        return num(s)
    if re.fullmatch(r'\d{1,3}(\.\d{3})+', s):
        return float(s.replace('.', ''))
    try:
        return float(s)
    except ValueError:
        return None


def mae_resultados():
    por = {}
    for x in mae('F'):
        if 'CONVERSI' in sin_tildes(x.get('titulo') or '').upper():
            continue
        ins = mae_instrumento(x)
        if not ins:
            continue
        f = mae_fecha(x, 'fechaFin')
        lic = por.setdefault(f, {'fecha': f, 'liquidacion': mae_fecha(x, 'fechaLiquidacion'), 'fuente': 'MAE',
                                 'instrumentos': []})
        usd = 'USD' in (x.get('moneda') or '').upper()
        ins.update({'ronda': 1, 'moneda': 'USD' if usd else 'ARS',
                    'vnoAdjudicado': round((x.get('monto_Adjudicado') or 0) / 1e6, 0),
                    'precio': mae_precio(x.get('valor_Corte'))})
        lic['instrumentos'].append(ins)
    return por


# ── Rollover estimado ─────────────────────────────────────────────────────────
# Finanzas casi nunca publica en el comunicado los vencimientos que refinancia
# cada licitación. Se estiman: el VNO en circulación de cada instrumento que
# vence entre la liquidación de la licitación anterior del cronograma y la de
# esta, por su valor de rescate.
#
# El VNO sale de un libro armado con los comunicados desde 2024: cada
# licitación por efectivo informa el VNO total en circulación de lo que reabre;
# cada conversión, el VNO rescatado del título que se convierte —a veces con el
# porcentaje de la circulación que era— y lo que se entrega del nuevo; el canje
# de enero de 2025, los títulos elegibles y la canasta. El valor de rescate es
# el último cierre de BYMA antes del vencimiento; una LETAMAR que no operó se
# capitaliza con la TAMAR del BCRA más su margen.
#
# Es el rollover sobre el total de vencimientos. Finanzas a veces lo informa
# sobre lo que está en manos privadas: cuando el BCRA o el FGS tienen mucho, el
# oficial da más alto (marzo de 2025: 91,61% oficial, 62,9% estimado). Lo que el
# libro no conoce —un título anterior a 2024 que no se reabrió ni se convirtió—
# no entra, y queda anotado en los que faltan.
CIRCULACION = os.path.join(RAIZ, 'circulacion.json')
HISTORIA_DESDE = '2025-01-01'     # lo que muestra la página
LIBRO_DESDE_DEFECTO = '2024-01-01'
BYMA_HIST = 'https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/chart/historical-series/history'
BCRA_TAMAR = 'https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias/44'
MES_TICKER = 'EFMAYJLGSOND'
NO_TICKER = {'OPCION', 'NUEVO', 'NUEVA', 'REAPERTURA', 'BONCER', 'LELINK', 'LECAP', 'BONCAP', 'LETAMAR',
             'DUAL', 'BONO', 'LETRA', 'TAMAR', 'BONTE', 'LECER', 'BONAR'}
ORDEN_OP = {'s': 0, '-': 1, '+': 2}


def tickers_en(s):
    u = sin_tildes(s or '').upper()
    return [t for t in re.findall(r'\b([A-Z][A-Z0-9]{3,5})\b', u)
            if any(c.isdigit() for c in t) and t not in NO_TICKER and not re.fullmatch(r'A\d+', t)]


def ticker_de(nombre):
    """El ticker de una fila de conversión, también con 'OPCIÓN 1 - TZXM8'."""
    ins = {'clase': clase_de(nombre), 'dual': dual_de(nombre), 'vencimiento': vencimiento_de(nombre)}
    m, mi = TICKER.search(nombre or ''), TICKER_INV.search(nombre or '')
    if m or mi:
        return (m.group(1) if m else mi.group(2)).upper(), ins
    for par in reversed(re.findall(r'\(([^()]*)\)?', nombre or '')):
        t = tickers_en(par)
        if t:
            return t[-1], ins
    return None, ins


def vto_de_ticker(t):
    m = re.fullmatch(r'[SDMXT](\d{2})([EFMAYJLGSOND])(\d)', t or '')
    if not m:
        return None
    try:
        return dt.date(2020 + int(m.group(3)), MES_TICKER.index(m.group(2)) + 1, int(m.group(1))).isoformat()
    except ValueError:
        return None


def _col(enc, *claves):
    for k, c in enumerate(enc):
        if all(x in sin_tildes(c).upper() for x in claves):
            return k
    return None


def eventos_de(pagina, efectivo):
    """Los movimientos del VNO en circulación que informa un comunicado, como
    [ticker, op, valor]: op 's' es el total en circulación, '-' lo rescatado y
    '+' lo entregado. Un instrumento nuevo sin ticker va como 'clase|vencimiento'."""
    ev, meta = [], {}

    def alta(t, ins=None, **kw):
        d = meta.setdefault(t, {})
        for k in ('clase', 'dual', 'vencimiento', 'margen', 'moneda', 'tem'):
            v = (ins or {}).get(k, kw.get(k))
            if v is not None and k not in d:
                d[k] = v

    if efectivo:
        for i in parsear_resultado(pagina)['instrumentos']:
            t = i.get('ticker') or '%s|%s' % (i.get('clase'), i.get('vencimiento'))
            alta(t, i)
            if i.get('circulacion'):
                ev.append([t, 's', i['circulacion']])
            elif i.get('desierto'):
                meta[t]['desierto'] = True
    bl = cuerpo(pagina)
    texto = ' '.join(b for k, b in bl if k == 'texto')
    pct = {}
    for m in re.finditer(r'representa (?:el )?([\d.,]+)\s*% del VNO en circulaci[oó]n([^.]{0,60})', texto):
        t = tickers_en(m.group(2))
        if t:
            pct[t[0]] = num(m.group(1))
    for m in re.finditer(r'VNO total a ser rescatado de([^.]{0,60}?) es (?:USD|\$)\s*([\d.,]+)', texto):
        t = tickers_en(m.group(1))
        if t:
            alta(t[-1])
            ev.append([t[-1], '-', num(m.group(2))])
    # El vencimiento de un título que sólo aparece como el que se convierte.
    for m in re.finditer(r'vencimiento (?:el |al )?(\d{1,2} de [a-záéíóú]+ de \d{4})\s*\(([A-Z][A-Z0-9]{3,5})\)', texto, re.I):
        if any(c.isdigit() for c in m.group(2)):
            alta(m.group(2).upper(), vencimiento=fecha_larga(m.group(1)))
    for k, b in bl:
        if k != 'tabla' or not b or len(b[0]) < 2:
            continue
        enc = b[0]
        e0, ult = sin_tildes(enc[0]).upper(), sin_tildes(enc[-1]).upper()
        # Canje: los títulos elegibles por ticker, y lo que se emite.
        if e0.startswith('TITULOS ELEGIBLES'):
            cn = _col(enc, 'NUEVO VNO EN CIRCULACION')
            ca = _col(enc, 'VNO', 'ADJUDICADO')
            for fila in b[1:]:
                t = (fila[0] or '').strip().upper()
                if not re.fullmatch(r'[A-Z][A-Z0-9]{3,5}', t):
                    continue
                alta(t)
                if cn is not None and num(fila[cn], monto=True):
                    ev.append([t, 's', num(fila[cn], monto=True)])
                elif ca is not None and num(fila[ca], monto=True):
                    ev.append([t, '-', num(fila[ca], monto=True)])
            continue
        if e0.startswith('NUEVOS INSTRUMENTOS') and _col(enc, 'VNO A EMITIR') is not None:
            ce = _col(enc, 'VNO A EMITIR')
            for fila in b[1:]:
                t, ins = ticker_de(fila[0])
                if t and num(fila[ce], monto=True):
                    alta(t, ins, moneda='ARS')
                    ev.append([t, '+', num(fila[ce], monto=True)])
            continue
        # Conversión: la última columna nombra el título que se rescata.
        if not any(w in ult for w in ('RESCAT', 'A ENTREGAR DE', 'A INTEGRAR')):
            continue
        fuente = (tickers_en(enc[-1]) or [None])[-1]
        cadj = _col(enc, 'VNO ADJUDICADO')
        total, suma = None, 0
        for fila in b[1:]:
            nom = fila[0] or ''
            if 'TOTAL' in sin_tildes(nom).upper():
                fuente = fuente or (tickers_en(nom) or [None])[-1]
                total = num(fila[-1], monto=True)
                continue
            t, ins = ticker_de(nom)
            v = num(fila[cadj], monto=True) if cadj is not None and cadj < len(fila) else None
            if t and v:
                alta(t, ins, moneda='USD' if es_usd(fila[cadj]) else 'ARS')
                ev.append([t, '+', v])
            if len(fila) == len(enc):
                suma += num(fila[-1], monto=True) or 0
        if fuente and (total or suma):
            alta(fuente)
            ev.append([fuente, '-', total or suma])
    # Lo que el texto declara desierto no se emitió.
    for frase in re.split(r'\.\s', texto):
        if re.search(r'declar[oóaá]\w*\s+desiert', frase, re.I):
            for t in tickers_en(frase):
                alta(t)
                if not any(tt == t and op == 's' for tt, op, _ in ev):
                    meta[t]['desierto'] = True
    # "Un porcentaje de participación del 38,25%": de la circulación del único
    # título que se convierte.
    m = re.search(r'porcentaje de participaci[oó]n del ([\d.,]+)\s*%', texto)
    fuentes = {t for t, op, _ in ev if op == '-'}
    if m and len(fuentes) == 1 and not pct:
        pct[fuentes.pop()] = num(m.group(1))
    # El porcentaje de la circulación que se rescata da la circulación previa.
    for t, x in pct.items():
        res = sum(v for tt, op, v in ev if tt == t and op == '-')
        if res and x:
            ev.insert(0, [t, 's', round(res / (x / 100), 0)])
    return ev, meta


def leer_libro():
    try:
        with io.open(CIRCULACION, encoding='utf-8') as f:
            d = json.load(f)
        return {'fuentes': d.get('fuentes') or {}, 'inst': d.get('inst') or {}}
    except Exception:
        return {'fuentes': {}, 'inst': {}}


def volcar_libro(libro):
    j = lambda o: json.dumps(o, ensure_ascii=False, separators=(', ', ': '))
    ins = sorted(libro['inst'].items())
    fu = sorted(libro['fuentes'].items(), key=lambda kv: (kv[1]['fecha'], kv[0]))
    out = ['{', ' "fuente": "Comunicados de la Secretaría de Finanzas desde 2024: VNO en circulación, rescatado y entregado, en millones",',
           ' "inst": {']
    out += ['  %s: %s%s' % (json.dumps(k), j(v), ',' if n < len(ins) - 1 else '') for n, (k, v) in enumerate(ins)]
    out += [' },', ' "fuentes": {']
    out += ['  %s: %s%s' % (json.dumps(k), j(v), ',' if n < len(fu) - 1 else '') for n, (k, v) in enumerate(fu)]
    return '\n'.join(out + [' }', '}']) + '\n'


def eventos_por_ticker(libro):
    """[fecha, op, valor] ordenados de cada ticker. Lo que entró sin ticker se
    suma al ticker del mismo tipo y vencimiento, si se conoce."""
    inst = libro['inst']
    real = {(d.get('clase'), d.get('vencimiento')): t for t, d in inst.items() if '|' not in t and d.get('vencimiento')}
    alias = {t: real.get((d.get('clase'), d.get('vencimiento'))) for t, d in inst.items() if '|' in t}
    evs = {}
    for f in libro['fuentes'].values():
        for t, op, v in f['ev']:
            t = alias.get(t) or t
            evs.setdefault(t, []).append([f['fecha'], op, v])
    for e in evs.values():
        e.sort(key=lambda x: (x[0], ORDEN_OP.get(x[1], 9)))
    return evs, {t for t, a in alias.items() if a}


def circulacion_al(evs, fecha):
    """El VNO en circulación antes de una fecha: el último total conocido más lo
    que entró y salió después. None si no hay de dónde partir."""
    v, base = None, False
    for f, op, x in evs:
        if f >= fecha:
            break
        if op == 's':
            v, base = x, True
        elif op == '+':
            v = (v or 0) + x
        elif op == '-':
            v = (v or 0) - x
    # Creado por un canje o una conversión dentro del libro: arranca en cero.
    if v is None or (not base and evs[0][1] != '+'):
        return None
    return max(v, 0)


_SIN_CERT = ssl.create_default_context()
_SIN_CERT.check_hostname = False
_SIN_CERT.verify_mode = ssl.CERT_NONE   # el certificado de BYMA no valida; el dato es público


def byma_cierre(simbolo, vto):
    """El último cierre antes del vencimiento, por cada 100 VN."""
    d = dt.date.fromisoformat(vto)
    q = {'symbol': simbolo + ' 24HS', 'resolution': 'D',
         'from': int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp()) - 25 * 86400,
         'to': int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp()) + 86400}
    try:
        req = urllib.request.Request(BYMA_HIST + '?' + urllib.parse.urlencode(q),
                                     headers={'User-Agent': 'Mozilla/5.0 (bonos-ar)', 'Accept': 'application/json'})
        with urllib.request.urlopen(req, context=_SIN_CERT, timeout=30) as r:
            j = json.loads(r.read())
    except Exception as e:
        log('BYMA', simbolo, e)
        return None
    if j.get('s') != 'ok':
        return None
    pares = [(dt.datetime.fromtimestamp(a, dt.timezone.utc).date().isoformat(), c)
             for a, c in zip(j.get('t') or [], j.get('c') or []) if c and c > 0]
    pares = [x for x in pares if x[0] < vto]
    return pares[-1] if pares else None


_TAMAR = {}


def pago_tamar(emision, vto, margen):
    """Una LETAMAR que no operó: capitaliza la TAMAR del BCRA más su margen, día
    a día, de la emisión al vencimiento. Por cada 1 VN."""
    if not _TAMAR:
        try:
            q = urllib.parse.urlencode({'Desde': LIBRO_DESDE_DEFECTO, 'Limit': 3000})
            with urllib.request.urlopen(urllib.request.Request(BCRA_TAMAR + '?' + q, headers={'User-Agent': 'Mozilla/5.0'}), timeout=40) as r:
                for x in json.loads(r.read())['results'][0]['detalle']:
                    _TAMAR[x['fecha']] = x['valor']
        except Exception as e:
            log('TAMAR', e)
            return None
    d, fin, f, ultima = dt.date.fromisoformat(emision), dt.date.fromisoformat(vto), 1.0, None
    while d < fin:
        ultima = _TAMAR.get(d.isoformat(), ultima)
        if ultima is None:
            return None
        f *= 1 + (ultima + margen) / 100 / 365
        d += dt.timedelta(days=1)
    return f


def simbolos(t, d):
    if '|' not in t:
        return [t]
    v = d.get('vencimiento') or ''
    if len(v) < 10:
        return []
    cod = v[8:10] + MES_TICKER[int(v[5:7]) - 1] + v[3]
    return [x + cod for x in {'fija': 'ST', 'cer': 'X', 'dl': 'D', 'tamar': 'M'}.get(d.get('clase'), '')]


def precio_rescate(t, d, vto, emision):
    """Por cada 1 VN, en pesos: el dollar linked ya cotiza en pesos."""
    sim = simbolos(t, d)
    for s in sim:
        c = byma_cierre(s, vto)
        time.sleep(0.3)
        if c:
            return c[1] / 100, 'BYMA ' + c[0], s
    if d.get('clase') == 'tamar' and d.get('margen') is not None and emision:
        f = pago_tamar(emision, vto, d['margen'])
        if f:
            return f, 'TAMAR + margen', (sim or [t])[0]
    return None, None, t


def habil(f):
    d = dt.date.fromisoformat(f)
    while d.weekday() >= 5:
        d += dt.timedelta(days=1)
    return d.isoformat()


def estimar_rollover(lics, crono, libro, recalcular_desde, previo):
    """Los vencimientos y el rollover estimados de cada licitación del
    cronograma. Las anteriores a recalcular_desde quedan como estaban."""
    evs, absorbidos = eventos_por_ticker(libro)
    liqs = sorted({c[2] for c in crono if c[2]})
    del_crono = {c[1] for c in crono}
    # Para la primera ventana, las licitaciones del libro anteriores al cronograma.
    efectivo = sorted({f['fecha'] for f in libro['fuentes'].values() if any(op == 's' for _, op, _ in f['ev'])})
    for l in lics:
        if l['fecha'] not in del_crono or l['fecha'] < HISTORIA_DESDE or l.get('fuente') != 'Finanzas':
            continue
        viejo = previo.get(l['fecha']) or {}
        if l['fecha'] < recalcular_desde and viejo.get('vencEst'):
            l['vencEst'], l['rolloverEst'] = viejo['vencEst'], viejo.get('rolloverEst')
            continue
        liq = l.get('liquidacion')
        if not liq:
            continue
        prev = max((x for x in liqs if x < liq), default=None)
        if not prev:
            ant = [f for f in efectivo if f < l['fecha']]
            if not ant:
                continue
            prev = habil((dt.date.fromisoformat(ant[-1]) + dt.timedelta(days=2)).isoformat())
        detalle, faltan = [], []
        # Si BYMA no contesta, el precio de la corrida anterior.
        antes = {x[0]: x for x in (viejo.get('vencEst') or {}).get('detalle', [])}
        for t, d in sorted(libro['inst'].items(), key=lambda kv: (kv[1].get('vencimiento') or '', kv[0])):
            v = d.get('vencimiento') or vto_de_ticker(t)
            if not v or t in absorbidos or d.get('clase') == 'usd' or not (prev < habil(v) <= liq):
                continue
            e = evs.get(t)
            if not e:
                if not d.get('desierto'):
                    faltan.append(t)
                continue
            vn = circulacion_al(e, v)
            if vn is None:
                faltan.append(t)
                continue
            if vn < 1:
                continue
            emision = next((f for f, op, _ in e if op in ('s', '+')), None)
            px, de, sim = precio_rescate(t, d, v, emision)
            if px is None and sim in antes:
                px, de = antes[sim][2] / 100, antes[sim][4]
            if px is None:
                faltan.append(sim)
                continue
            detalle.append([sim, round(vn), round(px * 100, 3), round(vn * px), de])
        total = sum(x[3] for x in detalle)
        r2 = sum(i.get('veAdjudicado', 0) for i in l.get('instrumentos', []) if i.get('ronda') == 2 and i.get('veMoneda') != 'USD')
        adj = (l.get('adjudicadoVE') or 0) + r2
        l['vencEst'] = {k: v for k, v in {'desde': prev, 'total': total, 'detalle': detalle, 'faltan': faltan or None}.items() if v is not None}
        l['rolloverEst'] = round(adj / total * 100, 2) if total and adj else None
        if l['rolloverEst'] is None:
            l.pop('rolloverEst')
        log('rollover estimado', l['fecha'], l.get('rolloverEst'), 'faltan' if faltan else '', ' '.join(faltan))


# ── Armado ────────────────────────────────────────────────────────────────────
def completar_tickers(lics, llamado):
    """Un bono nuevo sale en el resultado sin ticker; en la reapertura
    siguiente ya lo tiene. Se busca por tipo y vencimiento."""
    clave = lambda i: (i.get('clase'), i.get('dual'), i.get('vencimiento'))
    conocidos = {}
    for l in lics + ([llamado] if llamado else []):
        for i in l.get('instrumentos', []):
            if i.get('ticker') and i.get('vencimiento'):
                conocidos.setdefault(clave(i), i['ticker'])
    for l in lics + ([llamado] if llamado else []):
        for i in l.get('instrumentos', []):
            if not i.get('ticker') and clave(i) in conocidos:
                i['ticker'] = conocidos[clave(i)]
            if not i.get('ticker'):
                i.pop('ticker', None)


def volcar(datos):
    """JSON con una línea por licitación y una por instrumento: el workflow
    commitea este archivo y así el diff de cada día se lee."""
    j = lambda o: json.dumps(o, ensure_ascii=False, separators=(', ', ': '))
    sep = lambda n, total: ',' if n < total - 1 else ''

    def con_lista(cab, lista, sangria):
        base = {k: v for k, v in cab.items() if k != 'instrumentos'}
        filas = [sangria + j(base)[:-1] + ', "instrumentos": [']
        filas += [sangria + ' ' + j(i) + sep(q, len(lista)) for q, i in enumerate(lista)]
        return filas + [sangria + ']}']

    out, claves = ['{'], list(datos)
    for n, k in enumerate(claves):
        v, coma = datos[k], sep(n, len(claves))
        if k == 'cronograma':
            out += [' "cronograma": ['] + ['  ' + j(c) + sep(m, len(v)) for m, c in enumerate(v)] + [' ]' + coma]
        elif k == 'licitaciones':
            out.append(' "licitaciones": [')
            for m, l in enumerate(v):
                filas = con_lista(l, l.get('instrumentos', []), '  ')
                filas[-1] += sep(m, len(v))
                out += filas
            out.append(' ]' + coma)
        elif k == 'llamado' and v:
            filas = con_lista(v, v.get('instrumentos', []), ' ')
            filas[0] = ' "llamado": ' + filas[0].lstrip()
            filas[-1] += coma
            out += filas
        else:
            out.append(' ' + json.dumps(k) + ': ' + j(v) + coma)
    return '\n'.join(out + ['}']) + '\n'


def leer_actual():
    try:
        with io.open(SALIDA, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--desde', help='YYYY-MM-DD: rearma el historial desde esa fecha')
    ap.add_argument('--libro-desde', help='YYYY-MM-DD: rearma el libro de circulación desde esa fecha')
    a = ap.parse_args()
    previo = leer_actual()
    # Lo leído, aparte: las licitaciones viejas se completan en el lugar.
    leido = json.loads(json.dumps(previo))
    hoy = dt.date.today()
    por_fecha = {l['fecha']: l for l in previo.get('licitaciones', [])}
    desde = a.desde or (hoy - dt.timedelta(days=45)).isoformat()

    crono = []
    for anio in sorted({hoy.year - 1, hoy.year, hoy.year + 1, int(desde[:4])}):
        c = cronograma(anio)
        if c:
            crono += c
        time.sleep(1)
    if not crono:
        crono = previo.get('cronograma', [])
    liq_de = {c[1]: c[2] for c in crono}

    libro_desde = min(a.libro_desde or desde, desde)
    todas = sorted(listado(libro_desde), key=lambda x: x['fecha'])
    noticias = [n for n in todas if n['fecha'] >= max(desde, HISTORIA_DESDE)]
    log('noticias desde', desde, ':', len(noticias), '· para el libro desde', libro_desde, ':', len(todas))
    paginas = {}

    def pagina(u):
        if u not in paginas:
            paginas[u] = get(u)
            time.sleep(1)
        return paginas[u]

    ultimo_llamado, llamados = None, []
    for n in noticias:
        tipo = tipo_noticia(n['titulo'])
        if not tipo:
            continue
        if tipo == 'llamado':
            ultimo_llamado = n
            llamados.append(n)
            continue
        try:
            pag = pagina(n['url'])
        except Exception as e:
            log('no se pudo leer', n['url'], e)
            continue
        if tipo == 'resultado':
            r = parsear_resultado(pag)
            if not r['instrumentos']:
                log('sin instrumentos:', n['fecha'], n['titulo'][:80])
                continue
            r.update({'fecha': n['fecha'], 'url': n['url'], 'fuente': 'Finanzas'})
            r['liquidacion'] = liq_de.get(n['fecha']) or (por_fecha.get(n['fecha']) or {}).get('liquidacion')
            # Lo cargado a mano (el rollover, por ejemplo) no se pisa con un hueco.
            viejo = por_fecha.get(n['fecha']) or {}
            for k in ('rollover', 'vencimientos', 'manual', 'rolloverOficial'):
                if k in viejo and k not in r:
                    r[k] = viejo[k]
            por_fecha[n['fecha']] = {k: v for k, v in r.items() if v is not None}
            log('resultado', n['fecha'], len(r['instrumentos']), 'instrumentos')
        elif tipo == 'segunda':
            r = parsear_resultado(pag, ronda=2)
            base = max((f for f in por_fecha if f < n['fecha'] and f >= (dt.date.fromisoformat(n['fecha']) - dt.timedelta(days=6)).isoformat()), default=None)
            if not base or not r['instrumentos']:
                log('segunda vuelta sin licitación:', n['fecha'])
                continue
            lic = por_fecha[base]
            lic['instrumentos'] = [i for i in lic['instrumentos'] if i.get('ronda') != 2] + r['instrumentos']
            for i in r['instrumentos']:
                i['fechaRonda'] = n['fecha']
            log('segunda vuelta de', base, len(r['instrumentos']))
        elif tipo == 'correccion':
            f = fecha_larga(n['titulo'])
            r = parsear_resultado(pag)
            if f not in por_fecha or not r['instrumentos']:
                continue
            lic = por_fecha[f]
            # La última tabla de la corrección es la que vale.
            nuevos = {i['ticker']: i for i in r['instrumentos']}
            lic['instrumentos'] = [dict(i, **{k: v for k, v in nuevos[i['ticker']].items() if k not in ('ronda',)})
                                   if i['ticker'] in nuevos else i for i in lic['instrumentos']]
            m = re.search(r'total de valor efectivo adjudicado de \$\s*([\d.,]+)\s*billones', ' '.join(t for k, t in cuerpo(pag) if k == 'texto'))
            if m:
                lic['adjudicadoVE'] = round(num(m.group(1)) * 1e6, 0)
            if r.get('rollover'):
                lic['rollover'] = r['rollover']
            lic['correccion'] = n['url']
            log('corrección de', f)

    # Una licitación fuera del cronograma no tiene la liquidación ahí: la dice
    # su llamado.
    for f, lic in por_fecha.items():
        if lic.get('liquidacion') or lic.get('fuente') != 'Finanzas':
            continue
        cand = [n for n in llamados if n['fecha'] <= f and n['fecha'] >= (dt.date.fromisoformat(f) - dt.timedelta(days=10)).isoformat()]
        for n in reversed(cand):
            try:
                ll = parsear_llamado(get(n['url']))
                time.sleep(1)
            except Exception as e:
                log('llamado de', f, e)
                continue
            if ll.get('liquidacion') and (ll.get('fecha') in (f, None)):
                lic['liquidacion'] = ll['liquidacion']
                break

    # El MAE, para lo que Finanzas todavía no publicó.
    for f, lic in mae_resultados().items():
        if f and f not in por_fecha and f >= desde:
            lic['liquidacion'] = lic.get('liquidacion') or liq_de.get(f)
            por_fecha[f] = lic
            log('resultado del MAE', f)

    llamado = None
    ult_res = max(por_fecha) if por_fecha else ''
    if ultimo_llamado:
        try:
            ll = parsear_llamado(get(ultimo_llamado['url']))
            ll.update({'publicado': ultimo_llamado['fecha'], 'url': ultimo_llamado['url'], 'fuente': 'Finanzas'})
            if ll.get('fecha') and ll['fecha'] > ult_res and ll['instrumentos']:
                ll['liquidacion'] = ll.get('liquidacion') or liq_de.get(ll['fecha'])
                llamado = ll
        except Exception as e:
            log('llamado:', e)
    if not llamado:
        # El MAE programa las licitaciones del cronograma con un título
        # genérico; sirve recién cuando trae los instrumentos.
        prox = [x for x in mae('A') + mae('P') if (mae_fecha(x, 'fechaFin') or '') > ult_res
                and 'CONVERSI' not in sin_tildes(x.get('titulo') or '').upper()]
        if prox:
            f = min(mae_fecha(x, 'fechaFin') for x in prox)
            ins = [i for i in (mae_instrumento(x) for x in prox if mae_fecha(x, 'fechaFin') == f) if i]
            if ins:
                llamado = {'fecha': f, 'liquidacion': mae_fecha(prox[0], 'fechaLiquidacion') or liq_de.get(f),
                           'fuente': 'MAE', 'instrumentos': ins}

    lics = [por_fecha[f] for f in sorted(por_fecha)]
    completar_tickers(lics, llamado)

    # El libro de circulación: los comunicados de resultados que faltan, o
    # todos desde --libro-desde.
    libro = leer_libro()
    for n in todas:
        if not sin_tildes(n['titulo']).upper().startswith('RESULTADO'):
            continue
        if n['url'] in libro['fuentes'] and n['fecha'] < desde:
            continue
        try:
            ev, meta = eventos_de(pagina(n['url']), tipo_noticia(n['titulo']) in ('resultado', 'segunda', 'correccion'))
        except Exception as e:
            log('libro:', n['url'], e)
            continue
        libro['fuentes'][n['url']] = {'fecha': n['fecha'], 'ev': ev}
        for t, d in meta.items():
            viejo = libro['inst'].setdefault(t, {})
            for k, v in d.items():
                if k == 'desierto':
                    continue
                viejo.setdefault(k, v)
            # Desierto sólo si nunca tuvo circulación.
            if d.get('desierto') and not any(tt == t and op == 's' for tt, op, _ in ev):
                viejo.setdefault('desierto', True)
            elif any(tt == t and op == 's' for tt, op, _ in ev):
                viejo.pop('desierto', None)
    try:
        estimar_rollover(lics, crono, libro, a.libro_desde or desde, {l['fecha']: l for l in previo.get('licitaciones', [])})
    except Exception as e:
        log('rollover estimado:', e)
    texto_libro = volcar_libro(libro)
    viejo_libro = io.open(CIRCULACION, encoding='utf-8').read() if os.path.exists(CIRCULACION) else ''
    if texto_libro != viejo_libro:
        json.loads(texto_libro)
        with io.open(CIRCULACION, 'w', encoding='utf-8', newline='\r\n') as f:
            f.write(texto_libro)
        log('Escrito', CIRCULACION, ':', len(libro['fuentes']), 'comunicados')

    datos = {'fuente': 'Secretaría de Finanzas (argentina.gob.ar) · respaldo: MAE',
             'cronograma': crono, 'llamado': llamado, 'licitaciones': lics}
    sin_sello = lambda d: {k: v for k, v in d.items() if k != 'generado'}
    if sin_sello(leido) == datos:
        log('Sin cambios.')
        return
    datos = {'generado': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), **datos}
    texto = volcar(datos)
    json.loads(texto)   # que lo escrito se pueda leer
    with io.open(SALIDA, 'w', encoding='utf-8', newline='\r\n') as f:
        f.write(texto)
    log('Escrito', SALIDA, ':', len(lics), 'licitaciones', '· llamado' if llamado else '')


if __name__ == '__main__':
    main()
