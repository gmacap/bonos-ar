-- ═══════════════════════════════════════════════════════════════════════════
-- bonos-ar · Morning Brief privado del equipo
--
-- El brief que escribe la tarea en la nube de las 9:30 se guarda en la tabla
-- briefs, y sólo lo leen el admin y los mails de brief_lectores. La lista la
-- edita el admin desde la solapa Comentario de la app.
--
-- Escribe sólo el Worker (POST /brief), con la service_role, que saltea RLS:
-- desde la app nadie escribe briefs.
--
-- CÓMO EJECUTARLO
--   Supabase Dashboard → SQL Editor → New query → pegar todo → Run.
--   Es idempotente: se puede correr varias veces sin romper nada.
--   Requiere public.es_admin(), de supabase/policies.sql.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 0. Diagnóstico ─────────────────────────────────────────────────────────
do $diag$
begin
  if to_regprocedure('public.es_admin()') is null then
    raise exception 'Falta public.es_admin(): corré antes supabase/policies.sql (¿el SQL Editor está en el proyecto hxkxyawsstivjsxmafge?)';
  end if;
end
$diag$;


-- ── 1. Tablas ──────────────────────────────────────────────────────────────

-- Quiénes leen el brief, además del admin. En minúscula, como llega el mail
-- de Google.
create table if not exists public.brief_lectores (
  email      text primary key check (email = lower(email) and email like '%_@_%._%'),
  created_at timestamptz not null default now()
);
alter table public.brief_lectores enable row level security;

-- Un brief por día: una corrida repetida reemplaza la anterior.
create table if not exists public.briefs (
  fecha       date primary key,
  generado    timestamptz not null,
  actualizado text,
  palabras    integer,
  markdown    text not null,
  fuentes     jsonb not null default '[]'::jsonb,
  modelo      text,
  subido      timestamptz not null default now()
);
alter table public.briefs enable row level security;


-- ── 2. Quién es del equipo ─────────────────────────────────────────────────
-- SECURITY DEFINER para leer brief_lectores sin que RLS la bloquee. La app la
-- consulta al iniciar sesión para mostrar o no la solapa.

create or replace function public.es_lector_brief()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.es_admin() or exists (
    select 1 from public.brief_lectores
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.es_lector_brief() from public;
grant execute on function public.es_lector_brief() to anon, authenticated;


-- ── 3. Políticas ───────────────────────────────────────────────────────────

drop policy if exists "brief_lectores · admin" on public.brief_lectores;
drop policy if exists "briefs · lectura del equipo" on public.briefs;

-- La lista: sólo el admin la lee y la edita.
create policy "brief_lectores · admin"
  on public.brief_lectores for all
  to authenticated
  using (public.es_admin())
  with check (public.es_admin());

-- Los briefs: los lee el equipo. Sin políticas de escritura: escribe sólo el
-- Worker con la service_role.
create policy "briefs · lectura del equipo"
  on public.briefs for select
  to authenticated
  using (public.es_lector_brief());


-- ── 4. Verificación ────────────────────────────────────────────────────────
-- Tiene que listar las dos tablas con RLS activo.
select c.relname as tabla, c.relrowsecurity as rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('briefs', 'brief_lectores');
