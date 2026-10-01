-- Lo que 0047 necesita además de 0043_prereq.sql y 0046_prereq.sql: las
-- columnas de invoices que lee y work_order_items.
--
--   psql … -f supabase/tests/0043_prereq.sql
--   psql … -f supabase/tests/0046_prereq.sql
--   psql … -f supabase/tests/0047_prereq.sql
--   psql … -f supabase/migrations/0043_motor_fiscal_dte.sql
--   psql … -f supabase/migrations/0046_contabilidad_fiscal.sql
--   psql … -f supabase/migrations/0047_dte_desde_pos.sql
--   psql … -f supabase/tests/0047_dte_desde_pos.test.sql

do $$ begin
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create table if not exists public.work_orders (id uuid primary key default gen_random_uuid());

alter table public.invoices
  add column if not exists work_order_id uuid references public.work_orders(id),
  add column if not exists customer_id   uuid,
  add column if not exists status        text not null default 'issued';

create table if not exists public.work_order_items (
  id                   uuid          primary key default gen_random_uuid(),
  work_order_id        uuid          not null references public.work_orders(id) on delete cascade,
  description_snapshot text          not null,
  quantity             int           not null default 1,
  unit_price           numeric(10,2) not null,
  discount_amount      numeric(10,2) not null default 0,
  sort_order           int           not null default 0,
  created_at           timestamptz   not null default now()
);
