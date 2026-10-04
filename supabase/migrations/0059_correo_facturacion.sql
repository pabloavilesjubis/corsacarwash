-- ═══════════════════════════════════════════════════════════════════════
-- 0059 — Correo de facturación: el mismo que el general, salvo que se diga
--
-- billing_email es el correo al que se envían el DTE y los demás documentos.
-- Casi siempre es el correo del cliente, pero una empresa puede recibir las
-- facturas en otra casilla (contabilidad@…).
--
--   · billing_email_same (por defecto true): el de facturación ES el general,
--     y la base lo mantiene así en cada alta y cada cambio, venga de donde
--     venga (ficha, registro por QR, alta rápida del POS, carga masiva).
--   · false: el de facturación es otro y se respeta tal cual.
--
-- Retroactivo: los clientes sin correo de facturación, o con el mismo que el
-- general, quedan con la casilla marcada y su correo copiado. Al aplicar esto
-- había 34 sin correo de facturación y ninguno con uno distinto.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.customers
  add column if not exists billing_email_same boolean not null default true;

comment on column public.customers.billing_email_same is
  'true: el correo de facturación (billing_email) es el mismo que el general y se mantiene igual. false: es otro.';

create or replace function public.customers_sync_billing_email()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.billing_email_same then
    new.billing_email := nullif(trim(new.email), '');
  end if;
  return new;
end;
$$;

drop trigger if exists customers_sync_billing_email on public.customers;
create trigger customers_sync_billing_email
  before insert or update of email, billing_email, billing_email_same on public.customers
  for each row execute function public.customers_sync_billing_email();

-- ── Retroactivo ──
-- Distinto = hay uno de facturación y no coincide con el general: se respeta.
update public.customers
   set billing_email_same = not (
         nullif(trim(billing_email), '') is not null
         and lower(trim(billing_email)) <> lower(trim(coalesce(email, '')))
       );

-- El trigger copia el general a los que quedaron con la casilla marcada.
update public.customers set email = email where billing_email_same;
