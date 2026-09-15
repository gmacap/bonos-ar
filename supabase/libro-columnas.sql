-- bonos-ar · Spread y monto operado en el histórico de curvas
--
-- Corré esto en el editor SQL de Supabase. Es aditivo: no toca ninguna fila
-- existente, no cambia policies y no reescribe nada. Las dos columnas quedan
-- en null para las 19.701 filas que ya están, que es lo correcto: de esas
-- ruedas no guardamos el libro y no hay forma de reconstruirlo desde el
-- precio.
--
-- Por qué dos columnas y no una:
--
--   monto   lo que se operó ese día, en pesos. Es el que decide si una señal
--           se puede ejecutar. Los cortes del semáforo de la app están en
--           pesos, así que los tickers en dólares ya vienen convertidos por
--           el MEP de esa rueda.
--
--   spread  punta a punta en % del medio, tal como se vio al cerrar. Va
--           aparte del monto porque miden cosas distintas: el monto dice si
--           hay contraparte, el spread dice qué te cobra.
--
-- numeric sin precisión fija, igual que price/tir/md. El monto llega a los
-- doce dígitos en los bonos más operados y no entra en un real sin perder
-- centavos.

alter table public.bond_price_snapshots
  add column if not exists monto  numeric,
  add column if not exists spread numeric;

comment on column public.bond_price_snapshots.monto  is
  'Monto operado de la rueda, en pesos. Nominales x precio / 100, y por el MEP si el ticker cotiza en dolares.';
comment on column public.bond_price_snapshots.spread is
  'Spread punta a punta en % del medio: (ask - bid) / ((ask + bid) / 2) * 100.';

-- Verificación: las dos columnas existen y las filas viejas quedaron intactas.
select
  count(*)                              as filas,
  count(price)                          as con_precio,
  count(monto)                          as con_monto,
  count(spread)                         as con_spread
from public.bond_price_snapshots;
