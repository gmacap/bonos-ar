// Dónde vive la app publicada.
//
// Estaba repetida en siete scripts. Mudarla —a una organización, a un dominio
// propio— era editar siete líneas, que es exactamente la cantidad con la que uno
// se olvida de una y después no entiende por qué el backfill sigue leyendo la
// versión vieja. Acá es una sola.
//
// La variable de entorno APP_URL la pisa: así los scripts corren contra
// localhost o contra un deploy de prueba sin tocar este archivo. El CI la usa
// para probar el código del commit antes de que llegue a Pages.
const PUBLICADA = 'https://gmacap.github.io/bonos-ar/';

module.exports = {
  PUBLICADA,
  appUrl: () => process.env.APP_URL || PUBLICADA,
};
