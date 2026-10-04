-- ═══════════════════════════════════════════════════════════════════════
-- 0062 — Venta del día: facturada y sólo CxC
--
-- Con la facturación consolidada (0060) hay lavados que se prestan y se
-- cargan a CxC sin factura del día. El ingreso del día se parte en dos:
--   · venta_facturada: lo que tiene su documento (contado o crédito con DTE).
--     Es la que cuadra la caja;
--   · venta_solo_cxc: lavados al crédito sin facturar (facturacion_diferida).
-- gross_revenue sigue siendo la suma de las dos. Columnas nuevas al final.
-- ═══════════════════════════════════════════════════════════════════════

create or replace view public.v_daily_totals as
 SELECT branch_id,
    (created_at AT TIME ZONE 'America/El_Salvador'::text)::date AS sale_date,
    COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'::text AND (order_kind = ANY (ARRAY['service'::text, 'voucher_sale'::text]))), 0::numeric) AS gross_revenue,
    COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'voucher_sale'::text), 0::numeric) AS voucher_revenue,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND (order_kind = ANY (ARRAY['service'::text, 'voucher_redemption'::text]))) AS services_delivered,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'voucher_redemption'::text) AS vouchers_redeemed,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'voucher_sale'::text) AS voucher_sales,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'voucher_gift'::text) AS voucher_gifts,
        CASE
            WHEN count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'service'::text) > 0 THEN round(sum(total) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'service'::text) / count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'service'::text)::numeric, 2)
            ELSE 0::numeric
        END AS avg_ticket,
    COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'::text AND order_kind = ANY (ARRAY['service'::text, 'voucher_sale'::text]) AND NOT facturacion_diferida), 0::numeric) AS venta_facturada,
    COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'::text AND facturacion_diferida), 0::numeric) AS venta_solo_cxc,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND facturacion_diferida) AS servicios_solo_cxc
   FROM work_orders wo
  GROUP BY branch_id, ((created_at AT TIME ZONE 'America/El_Salvador'::text)::date);
