---
name: comentario
description: "Escribe el comentario diario del movimiento de la curva de bonos argentinos para bonos-ar: mide la curva con la ficha, busca el contexto de noticias, redacta los cinco periodos y commitea comentario.json. Usar cuando el usuario pida el comentario de mercado, el comentario del dia, o /comentario."
---

# Comentario de mercado — bonos-ar

Escribís el comentario diario del movimiento de la curva. Va a clientes, así que
el estándar es el de una nota que alguien manda con su nombre: nada inventado,
nada de relleno.

**No calculás nada.** Los números salen de `fichaConstruir()`, que es la misma
función que dibuja el panel de la app. Tu trabajo es leer esa ficha y escribirla
en castellano, más el contexto de noticias que la ficha no puede tener.

## El procedimiento

### 1. Medir

```
node .github/scripts/ficha.js --salida <scratchpad>/ficha.json
```

Tarda un minuto: abre la app publicada con Playwright y le pide los cinco
períodos. Con `--local` va contra `http://localhost:8000/index.html`, que sirve
para probar cambios sin publicarlos. Con `--envivo` toma los precios del momento
en vez de la última rueda cerrada — usalo sólo si el usuario pide expresamente el
comentario durante la rueda, porque lo que se commitea deja de ser reproducible.

Leé el archivo. Trae, por período: `ficha` (el objeto con todo) y `texto` (la
ficha formateada, que es lo que tenés que respetar al pie de la letra). Trae
también `preambulo`, que son las reglas de redacción tal como las define la app:
**leelas de ahí, no de acá.** Si algún día cambian en `index.html`, cambian solas
para vos también, y no hay dos juegos de reglas.

Antes de seguir, mirá `ruedaFin`. Si no es la última rueda hábil, decíselo al
usuario: puede que el snapshot del día todavía no haya corrido.

### 2. Buscar el contexto

Con `WebSearch`, buscá qué pasó entre `ini` y `fin` del período **día** que le
importe a un operador de renta fija argentina. Entre tres y seis búsquedas
alcanzan. Cubrí las dos puntas:

- **Local**: licitaciones del Tesoro, medidas del BCRA, reservas, dato de
  inflación, política, riesgo país.
- **Internacional**: tasas largas de Estados Unidos, la Fed, emergentes, materias
  primas que muevan la cuenta externa argentina.

Quedate con cinco a ocho hechos, cada uno con su fecha y su fuente. Si en el día
no pasó nada relevante, **eso también es el dato**: se dice que fue una rueda sin
novedades y se sigue. Inventar una noticia para llenar el campo es peor que
dejarlo corto.

Para los períodos largos no busques de nuevo: usá los mismos hechos y sumá lo
estructural del trimestre o del año si lo sabés, marcando la fecha.

### 3. Redactar

Cinco períodos: `dia`, `semana`, `mes`, `trimestre`, `anio`. Cada uno con tres
campos.

- **`titular`** — una línea, sin ningún número. Es lo que se lee primero.
- **`movimiento`** — qué se movió, cuánto, en qué tramo, con qué volumen. Uno o
  dos párrafos. **Sólo la ficha.** Ninguna noticia, ninguna causa.
- **`contexto`** — el marco. Un párrafo. **Sólo lo que buscaste.** Ningún precio
  de bono.

Las reglas de redacción están en `preambulo`. Las que más se violan sin querer:

- Todo número tiene que estar **literal en la ficha de ese período**. No
  calcules una variación que la ficha no trae, no promedies, no redondees hacia
  un número más lindo. Si querés decir algo que no está medido, no lo digas.
- En `movimiento` no puede aparecer **"porque", "debido a", "impulsado por",
  "tras conocerse", "a raíz de"** ni ninguna otra forma de atribuir un
  movimiento a un hecho. Hay un verificador que los busca.
- Si la ficha dice que el volumen está **parcial**, no hables de volumen de ese
  período. El monto operado sólo existe desde mediados de 2026, así que
  trimestre y año lo tienen truncado.
- Si un sector dice **"pendiente no reportada"**, no digas que empinó ni que
  aplanó. Quiere decir que el ajuste logarítmico no representa esa curva y
  cualquier adjetivo sobre su forma sería inventado.
- Las **implícitas de curva** no son el breakeven de la solapa Resumen. Si las
  mencionás, llamalas por su nombre.

Sobre el tono: castellano rioplatense, de operador a cliente. Frases cortas.
Nada de "cabe destacar", "en un contexto de", "se observó". Los duales aparecen
dos veces, una por pata: si los nombrás, aclaralo o no los nombres.

### 4. Escribir el archivo

`comentario.json` en la raíz del repo, al lado de `rem.json`:

```json
{
  "generado": "<ISO 8601 de ahora>",
  "modelo": "claude-opus-5",
  "ruedaFin": "<el ruedaFin de la ficha>",
  "fuentes": [{"titulo": "...", "url": "...", "fecha": "YYYY-MM-DD"}],
  "periodos": {
    "dia": {
      "ini": "...", "fin": "...", "ruedas": 1,
      "titular": "...", "movimiento": "...", "contexto": "...",
      "ficha": { }
    }
  }
}
```

`ini` y `fin` se copian de la ficha del período. En `ficha` va el objeto
`periodos.<p>.ficha` de `ficha.json` tal cual: **el comentario tiene que viajar
con los números que lo respaldan.** Si alguien abre la app el miércoles, el
comentario del martes tiene que verse junto a los números del martes, no junto a
los que el navegador recalcule en ese momento.

El archivo va en **CRLF**, como todo el repo.

### 5. Verificar

```
node .github/scripts/comentario-verificar.js comentario.json <scratchpad>/ficha.json
```

Chequea la forma, que todo número del movimiento esté en la ficha, y que no haya
conectores causales. **Si sale en rojo, corregí el texto y volvé a correrlo. No
commitees con errores** — el punto de esto es que una cifra inventada no llegue a
un cliente.

Los avisos (`!`) son para mirar, no para bloquear.

### 6. Mostrar y commitear

Mostrale al usuario el `titular` y el `movimiento` del día antes de commitear.
Es lo que va a mandar: que lo lea primero.

Con el visto bueno:

```
git add comentario.json
git commit -m "data(comentario): cierre del <fecha>"
git push
```

Va a `main` si el usuario lo pide, o a `dev` si estás en medio de otra cosa.
GitHub Pages lo publica y el panel lo levanta solo: `comFetch()` tiene un TTL de
tres horas y sirve la caché vencida si no hay red.

## Qué NO hacer

- **No edites `index.html`.** La ficha es lo que la app calcula; si un número te
  parece mal, decíselo al usuario en vez de maquillar el texto.
- **No inventes un número que la ficha no trae**, ni siquiera uno que parezca
  obvio de despejar.
- **No expliques un movimiento con una noticia.** Es la regla que existe porque
  es la más fácil de romper: la correlación de un día no es una causa, y firmarla
  frente a un cliente es otra cosa que sugerirla en una charla.
- **No commitees sin que el verificador pase.**
