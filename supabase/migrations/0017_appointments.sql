-- ============================================================
-- Migration: 0017_appointments.sql
-- Description: Appointment scheduling. Prepared for availability
--   and capacity management. No overbooking enforcement yet.
-- ============================================================

create table public.appointments (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete restrict,
  branch_id                 uuid        not null references public.branches(id) on delete restrict,
  customer_id               uuid        references public.customers(id) on delete set null,
  vehicle_id                uuid        references public.vehicles(id) on delete set null,
  scheduled_at              timestamptz not null,
  estimated_duration_minutes int,
  status                    text        not null default 'scheduled'
                                        check (status in ('scheduled','confirmed','arrived','in_service','cancelled','no_show','completed')),
  notes                     text,
  created_by                uuid        references public.profiles(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.appointments is 'Appointment scheduling. Linked to work_orders.appointment_id when customer arrives.';

create trigger appointments_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

create index idx_appointments_branch_date on public.appointments(branch_id, scheduled_at);
create index idx_appointments_customer on public.appointments(customer_id);
create index idx_appointments_status on public.appointments(branch_id, status);

alter table public.appointments enable row level security;

create policy "appointments_select"
  on public.appointments for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('appointments.read')
  );

create policy "appointments_insert"
  on public.appointments for insert
  with check (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('appointments.manage')
  );

create policy "appointments_update"
  on public.appointments for update
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('appointments.manage')
  );

-- Now add FK from work_orders to appointments (deferred since appointments comes after work_orders)
alter table public.work_orders
  add constraint work_orders_appointment_fk
  foreign key (appointment_id) references public.appointments(id) on delete set null;
