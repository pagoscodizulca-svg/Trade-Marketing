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

-- Row Level Security
alter table public.entregas_degustacion enable row level security;

-- ADVERTENCIA / TODO: estas políticas son PERMISIVAS (cualquiera con la anon key puede leer y escribir)
-- porque la app aún no autentica usuarios. DEBEN ENDURECERSE antes de uso en producción
-- (p. ej. exigir rol `authenticated` y filtrar por usuario/organización).
-- Nota: la app no usa `delete` con la anon key salvo al importar en modo "reemplazar";
-- si se endurecen las políticas, hay que conservar delete para quien importe.

drop policy if exists "entregas_degustacion_select" on public.entregas_degustacion;
create policy "entregas_degustacion_select"
  on public.entregas_degustacion for select
  to anon, authenticated
  using (true);

drop policy if exists "entregas_degustacion_insert" on public.entregas_degustacion;
create policy "entregas_degustacion_insert"
  on public.entregas_degustacion for insert
  to anon, authenticated
  with check (true);

drop policy if exists "entregas_degustacion_update" on public.entregas_degustacion;
create policy "entregas_degustacion_update"
  on public.entregas_degustacion for update
  to anon, authenticated
  using (true)
  with check (true);

-- Importación en modo "reemplazar": la app elimina los registros anteriores tras insertar los nuevos.
drop policy if exists "entregas_degustacion_delete" on public.entregas_degustacion;
create policy "entregas_degustacion_delete"
  on public.entregas_degustacion for delete
  to anon, authenticated
  using (true);

grant select, insert, update, delete on public.entregas_degustacion to anon, authenticated;
