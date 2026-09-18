---
name: comentario
description: "Escribe el comentario diario del movimiento de la curva de bonos argentinos para bonos-ar: mide la curva con la ficha, busca el contexto de noticias, redacta pesos por curva y dólares contra Treasuries y riesgo país, arma el hilo de Twitter con sus gráficos y commitea comentario.json. Usar cuando el usuario pida el comentario de mercado, el comentario del dia, el hilo para Twitter, o /comentario."
---

# Comentario de mercado — bonos-ar

Escribís el comentario diario del movimiento de la curva. Va a clientes y a
Twitter, así que el estándar es el de una nota que alguien firma: nada inventado,
nada de relleno.

**No calculás nada.** Los números salen de `fichaConstruir()`, la misma función
que dibuja el panel de la app, y eso incluye los Treasuries, el riesgo país y la
descomposición de los bonos en dólares. Tu trabajo es leer esa ficha y escribirla
en castellano, más el contexto de noticias que la ficha no puede tener.

## El procedimiento

### 1. Medir

```
node .github/scripts/ficha.js --salida <scratchpad>/ficha.json --imagenes salidas/comentario
```

Tarda un minuto. Abre la app publicada, le pide la ficha de los cinco períodos y
exporta un PNG de 1200×675 por cada curva que la ficha marca con gráfico, del
período `dia`. Las imágenes quedan en `salidas/comentario/<fecha>/`, que no se
commitea. Playwright está instalado en `%LOCALAPPDATA%\bonos-ar`, fuera del repo
porque el repo vive en OneDrive, y el script lo busca ahí solo. Si falta, el
script dice cómo instalarlo.

Opciones que vas a necesitar:

- `--hasta YYYY-MM-DD` fija la rueda que cierra el período. **La app archiva fotos
  durante la rueda, no sólo al cierre**, así que antes de las 17:30 la "última
  rueda archivada" es la de hoy a medio hacer. Si es de mañana o del mediodía,
  pedí la rueda cerrada anterior con `--hasta`.
- `--local` va contra `http://localhost:8000/index.html`, para probar cambios sin
  publicarlos.
- `--imagenes-periodos dia,semana` exporta gráficos de otros períodos.

Antes de escribir, mirá lo que imprime al final:

- **`ruedaFin`**: tiene que ser una rueda cerrada. Si es hoy y todavía no pasaron
  las 17:30, decíselo al usuario.
- **`Treasuries` y `Riesgo país`**: si alguno dice **DESFASADO**, el dato de afuera
  todavía no se publicó para esa rueda. Sin Treasuries del día no hay
  descomposición de los bonos en dólares. Preguntale al usuario si espera y lo
  corrés más tarde, o si escribís dólares diciendo que el dato está pendiente.

Leé `ficha.json`. Trae, por período, `ficha` (el objeto) y `texto` (la ficha
formateada, que es lo que tenés que respetar al pie de la letra), y trae
`preambulo`: la estructura y las reglas de redacción tal como las define la app.
**Leelas de ahí, no de acá.** Si cambian en `index.html` cambian solas para vos
también.

### 2. Buscar el contexto

Con `WebSearch`, buscá qué pasó entre `ini` y `fin` del período **día** que le
importe a un operador de renta fija argentina. Entre tres y seis búsquedas. Cubrí:

- **Local**: licitaciones del Tesoro, BCRA, reservas, dato de inflación, política.
- **Internacional**: la Fed y lo que se esperaba de ella, el movimiento de los
  Treasuries y por qué se habló de él, emergentes, materias primas.

Quedate con cinco a ocho hechos, cada uno con fecha y fuente. Si en el día no
pasó nada relevante, eso también es el dato: inventar una noticia para llenar el
campo es peor que dejarlo corto.

**Los números de mercado no salen de la búsqueda.** Si una nota dice que el 10
años "tocó 5,04%" y la ficha dice que cerró en 5,00%, en dólares va el 5,00% de la
ficha; el 5,04% sólo puede aparecer en el contexto, dicho como máximo del día.

Para los períodos largos no busques de nuevo: usá los mismos hechos y sumá lo
estructural que sepas, con fecha.

### 3. Redactar

**Qué se escribe depende del día.** Mes, trimestre y año no cambian de lectura de
una rueda a la otra, y arrastran una ficha de 25 KB cada una:

| Cuándo | Qué se escribe | Dónde va |
|---|---|---|
| Todos los cierres | `dia` | `comentario.json` |
| Jueves | `dia` y `semana` | `comentario.json` |
| Último cierre del mes | `dia`, `semana`, `mes`, `trimestre`, `anio` | el diario y `comentarios/AAAA-MM.json` |

Fuera de los jueves, **el bloque `semana` no se reescribe: se copia tal cual** del
`comentario.json` publicado, con su ficha y su hilo. Lo mismo con el archivo del
mes, que no se toca hasta el cierre siguiente. Si el usuario pide expresamente
uno fuera de fecha, se hace y se le avisa que va a quedar fechado en esa rueda.

La estructura de cada período está en `preambulo`; en concreto:

- **`titular`** — una línea, **sin ningún número**.
- **`pesos.resumen`** — un párrafo corto sobre la curva de pesos en conjunto.
- **`pesos.TF`, `pesos.CER`, `pesos.TAMAR`, `pesos.DLK`** — un párrafo breve por
  curva, dos o tres frases. **Siempre los cuatro**, aunque la curva haya estado
  quieta. Sólo puede faltar uno si la ficha no trae ese sector en el período.
- **`dolares.resumen`** — Bonares, Globales y Bopreales **relacionados con los
  Treasuries y con el riesgo país**. Usá la línea `descomposición` de cada curva:
  "de los 19 puntos básicos, 3 corresponden a los Treasuries y 16 al spread". Para
  citar un Treasury, la tasa par de la sección TREASURIES. El spread de la ficha
  **no es** el riesgo país: si mencionás los dos, que se note que son medidas
  distintas.
- **`contexto`** — el marco, separado de todo lo anterior.
- **`twitter`** — obligatorio en `dia`, opcional en los demás. Ver abajo.

Las reglas que más se violan sin querer:

- Todo número en pesos, dólares y Twitter tiene que **salir de la ficha de ese
  período**. Se puede redondear a entero o a un decimal ("25,3%", "447 mil
  millones"); no se puede aproximar ("casi 450", "unos 20") ni calcular uno nuevo.
- **Cada número con su unidad a la vista**: "bajó 20 puntos", "20 bps", "25,3%". En
  la ficha MM son miles de millones y B son billones: escribilos en palabras.
- Ningún **"porque", "debido a", "impulsado por", "a raíz de"** fuera del contexto.
  La descomposición contra Treasuries se escribe como resta ("corresponden a"),
  no como causa.
- Volumen **PARCIAL**: no se habla de volumen de ese período.
- **"pendiente no se reporta"**: no digas que la curva empinó ni que aplanó.
- **Spread negativo** (Bopreales): no lo presentes como riesgo crédito.
- Las **implícitas de curva** no son el breakeven de la solapa Resumen.
- Los **duales** aparecen en CER y en TAMAR: si los nombrás, aclaralo.

**A quién le escribís: clientes que saben de finanzas.** El detalle está en
`preambulo`; lo que pidió el usuario, en corto:

- **Nada obvio.** Ni "cuando la tasa baja, el precio sube" ni definiciones de tasa
  real, margen, spread o breakeven. Términos de mercado, tono cercano, primera
  persona del plural, frases cortas.
- **Cada dato con su contexto.** Un número suelto no agrega valor. El volumen va
  contra el promedio de las 20 ruedas previas ("1,9 veces el promedio"). Las
  implícitas van contra el REM (sección REFERENCIAS DEL REM). El margen TAMAR va
  contra la TAMAR de hoy y la que espera el REM. Todas esas referencias están en
  la ficha, así que el verificador las chequea como cualquier otro número.
- **Leé la curva.** Después del dato, qué puede estar descontando el mercado,
  como lectura posible ("puede leerse como", "es consistente con", "se lee
  como"). Sale de la curva y de las referencias, **nunca de una noticia**. Las
  claves por curva están en `preambulo`: leelas antes de interpretar. En TAMAR,
  por ejemplo, el margen se calcula con la TAMAR constante: si el mercado
  recalculara la TAMAR esperada se moverían más los largos.
- **Que la lectura cierre con los números.** Antes de escribir "el mercado
  descuenta X", fijate que los tramos, el volumen y las referencias lo sostengan.
  Si apuntan para lados distintos, decí eso en vez de forzar una lectura.
- **Elegí.** Uno o dos datos por curva, cada uno con su lectura.
- Empinó y aplanó se pueden usar, pero la pendiente sale del ajuste de toda la
  curva: en el trimestre al 16/09 tasa fija "aplanó" con las medianas subiendo más
  que las cortas. Si la palabra y los tramos no dicen lo mismo, contá los tramos.
- Nada de "cabe destacar", "se observó", "en un contexto de". Nada de
  recomendaciones.

Antes y después, con los mismos números (TAMAR, 16/09):

> ✗ En TAMAR el margen, lo que pagan por encima de la TAMAR, no se movió y sigue
> en 7%. Adentro sí hubo cambios: los dos bonos más cortos subieron 20 puntos y
> los medianos bajaron 9 puntos. El que más subió fue el TTD26, 42 puntos.
>
> ✓ TAMAR cerró con el margen sin cambios, en 7,02%, pero con rotación adentro:
> los dos más cortos ampliaron 20 bps (el TTD26, 42 bps) y el tramo medio
> comprimió 9 bps, con los largos planos. Si el mercado estuviera recalculando la
> TAMAR esperada se movería más el tramo largo, y no se movió: se lee como demanda
> puntual por los bonos de mediano plazo y algo de oferta en los que vencen antes.
> Volumen en su promedio, 1,0 veces.

### 4. El hilo de Twitter

Entre 3 y 5 tweets, **cada uno de hasta 280 caracteres contando la numeración**, y
la numeración `1/4` al principio. Twitter cuenta distinto que un editor: las
flechas y los emojis pesan dos y un link pesa 23, así que no uses "→" y evitá
emojis. El verificador cuenta con la regla de Twitter.

- **1/N**: el titular y los dos o tres números que más importan del día.
- **pesos**: lo central de la curva de pesos.
- **dólares**: Globales y Bonares contra Treasuries y riesgo país.
- **contexto**, si hace falta.

Cada tweet lleva `graficos`: los sectores cuya imagen se adjunta, **sólo entre los
que la ficha marca con "gráfico: sí"**, hasta 4 por tweet. Si ninguno se movió lo
suficiente, el hilo va sin imágenes y está bien.

### 5. Escribir los archivos

Dos archivos, por la cadencia y por el peso. El diario pesa 60 KB y lo baja toda
visita; los tres largos pesan 74 KB y se piden sólo cuando alguien los abre.

- **`comentario.json`** (raíz, al lado de `rem.json`): `dia` y `semana`, más
  `archivoLargos` con la ruta del archivo del mes. Sin ese campo el panel no sabe
  dónde buscar los períodos largos.
- **`comentarios/AAAA-MM.json`**: `mes`, `trimestre` y `anio`, con la misma
  cabecera (`generado`, `modelo`, `ruedaFin`, `fuentes`). Se escribe en el último
  cierre del mes y queda publicado: es el histórico de los períodos largos.

La forma de cada período no cambia:

```json
{
  "generado": "<ISO 8601 de ahora>",
  "modelo": "claude-opus-5 (Claude Code)",
  "ruedaFin": "<el ruedaFin de la ficha>",
  "archivoLargos": "comentarios/2026-09.json",
  "fuentes": [{"titulo": "...", "url": "...", "fecha": "YYYY-MM-DD"}],
  "periodos": {
    "dia": {
      "ini": "...", "fin": "...", "ruedas": 1,
      "titular": "...",
      "pesos": {"resumen": "...", "TF": "...", "CER": "...", "TAMAR": "...", "DLK": "..."},
      "dolares": {"resumen": "..."},
      "contexto": "...",
      "twitter": [{"texto": "1/4 ...", "graficos": ["TF", "GLO"]}],
      "ficha": { }
    }
  }
}
```

`ini` y `fin` se copian de la ficha del período. En `ficha` va el objeto
`periodos.<p>.ficha` de `ficha.json` tal cual: **el comentario viaja con los
números que lo respaldan**, y los gráficos del panel se dibujan desde ahí. Si
alguien abre la app el miércoles, el comentario del martes se ve con la curva del
martes.

El archivo va en **CRLF**, como todo el repo.

### 6. Verificar

```
node .github/scripts/comentario-verificar.js comentario.json comentarios/AAAA-MM.json <scratchpad>/ficha.json
```

Se le pasan **todos los archivos que acabás de escribir**: verifica los períodos
que estén, así que en un día común alcanza con el diario. Si volvés a medir
después de redactar, corré el verificador otra vez: un dato puede haberse movido
un punto básico entre las dos mediciones y el texto queda desfasado sin que se
note.

Chequea la forma, que dólares mencione Treasuries y riesgo país, que todo número
esté en la ficha, que no haya conectores causales, y el hilo: cantidad, largo,
numeración y que las imágenes existan. **Si sale en rojo, corregí el texto y volvé
a correrlo. No commitees con errores.** Los avisos (`!`) son para mirar.

### 7. Mostrar y commitear

Mostrale al usuario, antes de commitear:

- el titular, el resumen de pesos y la parte de dólares del día;
- el hilo, tweet por tweet, con qué imagen va en cada uno;
- la carpeta donde quedaron las imágenes.

Es lo que va a publicar: que lo lea primero. **La revisión es en el chat**, y
puede llevar varias vueltas: "el párrafo de CER más corto", "sacá el tweet 4",
"¿de dónde sale el 443?".

- Si pregunta de dónde sale un número, mostrale la línea de la ficha.
- Si pide un cambio, hacelo en `comentario.json`, **volvé a correr el
  verificador** y mostrale sólo lo que cambió. Un cambio de redacción puede
  meter un número mal redondeado o un "porque" sin que se note.
- Si lo que pide choca con una regla (un número que la ficha no trae, una
  causa en pesos o dólares), decíselo y proponé cómo decirlo dentro de la regla.
- **No publiques hasta un OK explícito** ("dale", "publicalo", "ok"). Un "está
  bien" sobre un párrafo suelto no es el OK del comentario entero.

Con el OK, **directo a `main`**, que es lo que sirve GitHub Pages; después se
trae a `dev`. Es un dato, como `rem.json`: no pasa por `dev` para no arrastrar a
producción código que todavía no se mergeó.

```
git checkout main && git pull --ff-only
git add comentario.json comentarios/
git commit -m "data(comentario): cierre del <fecha>"
git push origin main
git checkout dev && git merge --no-edit main && git push origin dev
```

Si `checkout` o `pull` se quejan (cambios sin commitear, ramas divergidas), frená
y decíselo al usuario: no resuelvas conflictos ni descartes cambios por tu cuenta.

Las imágenes **no** se commitean. GitHub Pages publica el JSON en uno o dos
minutos y el panel lo levanta con ↻; desde el panel también se bajan las imágenes
con el botón ⤓ PNG de cada curva.

## Qué NO hacer

- **No edites `index.html`.** Si un número de la ficha te parece mal, decíselo al
  usuario en vez de maquillar el texto.
- **No inventes un número que la ficha no trae**, aunque parezca obvio despejarlo.
- **No expliques un movimiento con una noticia.** La correlación de un día no es
  una causa, y firmarla frente a un cliente es otra cosa que sugerirla en una
  charla.
- **No tomes números de mercado de la búsqueda web** para pesos, dólares o Twitter.
- **No commitees sin que el verificador pase.**
