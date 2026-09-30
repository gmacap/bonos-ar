---
name: referencias
description: "Procesa los documentos nuevos de la carpeta privada de referencias del comentario —reportes, papers, notas de prensa, textos modelo de estilo—: los lee una sola vez, escribe una nota por fuente, actualiza el índice y propone qué sumar a los marcos de lectura y a la guía de estilo. Usar cuando el usuario diga que dejó material nuevo para el comentario, pida procesar referencias, o escriba /referencias."
---

# Referencias del comentario

La carpeta de referencias es donde el usuario deja reportes, papers y textos que
le parecen buenos, para que el comentario tenga mejor contexto y mejor forma. Es
**privada**: vive en su OneDrive, fuera del repo, porque bonos-ar es público y
buena parte de ese material es pago o interno. Esta skill es sólo el
procedimiento; el contenido nunca entra al repo.

La idea central: **cada documento se lee una sola vez**. El comentario diario no
relee PDFs; lee tres archivos cortos —el índice, los marcos y la guía de estilo—
y abre una nota sólo cuando el tema del día la pide. Por eso la calidad de las
notas es todo: si una nota es mala, el documento no existe para el comentario.

## Dónde está

`../../Referencias comentario`, relativo a la raíz del repo (queda en
`Documentos\Santos\Referencias comentario`). Si no existe, decíselo al usuario y
no la crees en otro lado.

```
fuentes\            lo que deja el usuario, tal cual
  estilo\           textos que él marcó como modelo de estilo
    evitar\         textos que marcó como ejemplo de lo que no hay que hacer
  links.md          links, uno por línea, con una nota opcional
notas\              una por fuente, la escribís vos
INDICE.md           el registro: una fila por fuente procesada
marcos.md           formas de leer el mercado que aportan las fuentes
estilo.md           la guía de estilo
LEEME.md            instrucciones para el usuario
```

## El procedimiento

### 1. Ver qué hay de nuevo

Es nuevo todo archivo de `fuentes\` (con sus subcarpetas) y toda línea de
`fuentes\links.md` que empiece con http y no figure en `INDICE.md`. El índice es
el único registro: no hay otro.

Si no hay nada nuevo, decilo y terminá.

### 2. Leer cada fuente entera, una sola vez

- **PDF**: con Read, de a 20 páginas (`pages`). Los escaneados se leen como imagen.
- **Word y Excel**: con las skills `docx` y `xlsx`.
- **Link**: con WebFetch. Si está detrás de un paywall, pedile al usuario el PDF.
- **Imagen o captura**: con Read.

Si una fuente no se puede leer, va igual al índice, con `pendiente — <motivo>` en
la columna de la nota, y se lo decís al usuario. No la saltees en silencio: la
próxima corrida la volvería a intentar sin que nadie sepa por qué falla.

### 3. Escribir la nota

`notas\AAAA-MM-DD-<tema-corto>.md`, con la fecha del documento, no la de hoy:

```markdown
---
titulo:
emisor:
fecha: AAAA-MM-DD
archivo: fuentes/...        (o url: ..., si es un link)
tipo: reporte | paper | informe-oficial | prensa | hilo | otro
citable: sí | no
temas: [...]
vigencia: estructural | hasta AAAA-MM-DD
estilo: no | candidato | modelo | evitar
---

## Qué dice
## Cómo sirve para el comentario
## Estilo        (sólo si estilo no es "no")
```

- **Con tus palabras.** La nota resume ideas, no copia párrafos. Y es corta: lo que
  no entra en veinte líneas no es un resumen.
- **"Cómo sirve para el comentario" es lo más importante.** No repite el
  documento: dice qué lectura de la curva, qué pregunta o qué contexto aporta, y
  en qué situación de mercado se usaría.
- **Temas**, de esta lista, para que el comentario los encuentre: `tasa-fija`,
  `cer`, `tamar`, `dlk`, `bonares`, `globales`, `bopreales`, `curva`,
  `breakeven`, `fx`, `bcra`, `licitaciones`, `inflacion`, `actividad`, `fiscal`,
  `fed`, `treasuries`, `emergentes`, `politica`, `estructura`.
- **Citable: sí**, sólo si es público y se puede linkear: BCRA, INDEC, el Tesoro,
  el FMI, un paper publicado, una nota de prensa. Reportes de bancos o de brokers,
  material pago o interno: **no**. Ante la duda, no.
- **Vigencia.** Un reporte sobre la licitación de la semana vence con la
  licitación; un paper sobre cómo se forma la prima por plazo es estructural. Lo
  que venció no se borra, pero el comentario no lo usa.
- **Los números de la fuente** van en la nota tal como los dice ella y con su
  fecha. Son la opinión o la proyección de quien los escribió, no datos de
  mercado: nunca van a la ficha ni a pesos, dólares o Twitter.

### 4. Evaluar el estilo

- Lo que está en `fuentes\estilo\` ya viene marcado por el usuario como modelo, y
  lo que está en `fuentes\estilo\evitar\`, como ejemplo de lo que no hay que hacer.
- Lo demás lo evaluás vos, con los criterios que ya pidió para el comentario:
  ¿cada dato va con su lectura? ¿arranca por lo que más importa? ¿frases cortas,
  sin relleno y sin explicar lo obvio? ¿separa lo medido de lo interpretado? ¿los
  titulares informan sin números? Si un texto se destaca, lo proponés como
  candidato, con el recurso puntual que tomarías de él. En la nota queda
  `estilo: candidato` hasta que el usuario decida: con su OK pasa a `modelo`;
  si lo descarta, a `no`.
- Si un texto suena bien pero rompe una regla del comentario —explica el
  movimiento con una noticia, afirma en vez de sugerir—, se anota como `evitar`.

### 5. Actualizar el índice

Una fila por fuente, la más nueva arriba:

| fecha | título | emisor | citable | temas | vigencia | estilo | nota |

### 6. Proponer marcos y estilo, nunca aplicarlos solo

`marcos.md` y `estilo.md` cambian qué se les dice a los clientes y cómo, así que
**nada entra sin el OK del usuario**. Juntá las propuestas de toda la corrida y
mostralas juntas:

- **Marco**: una forma de leer que el preámbulo de la ficha no tenga ya. Una o dos
  líneas: qué mirar, qué puede significar, cuándo aplica y de qué nota sale.
- **Estilo**: un recurso concreto, con un fragmento corto de ejemplo, el formato
  (comentario o hilo) y de dónde sale. Nunca "escribí como X": un recurso se
  puede aplicar y controlar; una imitación, no.

Con el OK, los agregás. Si `estilo.md` pasa de una página o `marcos.md` de dos,
proponé qué sacar: una guía que no se puede aplicar entera no sirve.

### 7. Contarle al usuario

Qué se leyó; qué nota salió de cada fuente, en una línea; qué quedó pendiente y
por qué; y las propuestas de marcos y estilo que esperan su OK.

## Qué NO hacer

- **Nada de esta carpeta entra al repo**: ni fuentes, ni notas, ni resúmenes.
  bonos-ar es público.
- **No copies párrafos** de las fuentes en las notas, en los marcos ni en la guía.
- **No marques como citable** algo que no se pueda linkear públicamente.
- **No cambies `marcos.md` ni `estilo.md` sin el OK del usuario.**
