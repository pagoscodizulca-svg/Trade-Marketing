-- =====================================================================
-- RutaDegustación · tabla public.entregas_degustacion
-- Supabase es la ÚNICA fuente de datos de la app: no hay semilla ni datos de ejemplo.
-- Ejecutar en el SQL Editor de Supabase (o con `supabase db push`).
-- =====================================================================

create table if not exists public.entregas_degustacion (
  id text primary key,
  fecha text not null,
  turno text not null,
  numero_grupo_turno text not null,
  cliente text not null,
  producto text not null,
  vendedor text not null default '',
  promotora text not null default '',
  stand_entregado boolean not null default false,
  producto_entregado boolean not null default false,
  completado boolean not null default false,
  hora_entrega text,
  notas_chofer text not null default '',
  created_at timestamptz not null default now()
);

-- Realtime: la app se suscribe a los cambios de esta tabla.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'entregas_degustacion'
  ) then
    alter publication supabase_realtime add table public.entregas_degustacion;
  end if;
end $$;

-- Para que los eventos UPDATE/DELETE de Realtime lleguen con la fila completa.
alter table public.entregas_degustacion replica identity full;

-- Row Level Security (Zero Trust — rol anon bloqueado al 100%)
alter table public.entregas_degustacion enable row level security;

revoke all on public.entregas_degustacion from public, anon;
grant select, insert, update, delete on public.entregas_degustacion to authenticated;

drop policy if exists "entregas_degustacion_select" on public.entregas_degustacion;
drop policy if exists "entregas_degustacion_insert" on public.entregas_degustacion;
drop policy if exists "entregas_degustacion_update" on public.entregas_degustacion;
drop policy if exists "entregas_degustacion_delete" on public.entregas_degustacion;

create policy "entregas_degustacion_select_authenticated"
  on public.entregas_degustacion for select
  to authenticated
  using ((select auth.uid()) is not null);

create policy "entregas_degustacion_insert_coord"
  on public.entregas_degustacion for insert
  to authenticated
  with check (
    lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'app_role', (select auth.jwt()) -> 'app_metadata' ->> 'role', ''))
      in ('super_admin', 'admin', 'coordinacion', 'coordinadora', 'supervisor')
  );

create policy "entregas_degustacion_update_logistics"
  on public.entregas_degustacion for update
  to authenticated
  using (
    lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'app_role', (select auth.jwt()) -> 'app_metadata' ->> 'role', ''))
      in ('super_admin', 'admin', 'coordinacion', 'coordinadora', 'supervisor', 'chofer')
  )
  with check (
    lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'app_role', (select auth.jwt()) -> 'app_metadata' ->> 'role', ''))
      in ('super_admin', 'admin', 'coordinacion', 'coordinadora', 'supervisor', 'chofer')
  );

create policy "entregas_degustacion_delete_coord"
  on public.entregas_degustacion for delete
  to authenticated
  using (
    lower(coalesce((select auth.jwt()) -> 'app_metadata' ->> 'app_role', (select auth.jwt()) -> 'app_metadata' ->> 'role', ''))
      in ('super_admin', 'admin', 'coordinacion', 'coordinadora', 'supervisor')
  );
