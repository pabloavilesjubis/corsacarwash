/**
 * CORSA Carwash — Cupón imprimible (carta, 3 por página)
 *
 * Cada cupón ocupa un tercio de página. Un lote de 20 sale como un solo PDF de
 * 7 páginas, que es lo que se descarga o se adjunta al correo.
 *
 * El QR codifica la URL de validación con el `validation_token`, no el número
 * correlativo: los correlativos son adivinables por diseño (000001, 000002…) y
 * el token es un uuid. Así, escanear valida el cupón que se tiene en la mano y
 * no uno deducido.
 */

import type { VoucherRow } from '../../services/vouchers.service'
import { EMISOR } from '../ticket/fromSale'

function esc(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function money(n: number): string {
  return '$' + (Number(n) || 0).toFixed(2)
}

/** URL del QR: abre la pantalla de Cupones con ese cupón ya localizado. */
export function voucherValidationUrl(v: Pick<VoucherRow, 'validation_token'>): string {
  const base = typeof window !== 'undefined' ? window.location.origin : ''
  return `${base}/coupons?v=${v.validation_token}`
}

function qrSrc(data: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=0&qzone=1&data=${encodeURIComponent(data)}`
}

/**
 * Una regalía no lleva importe impreso: un "Valor $0.00" haría dudar de si el
 * cupón sirve. Se rotula por lo que es.
 */
function voucherCard(v: VoucherRow): string {
  const servicio = [v.service_name, v.size].filter(Boolean).join(' ')
  return `
  <section class="voucher">
    <div class="left">
      <div class="brand">${esc(EMISOR.nombreComercial)}</div>
      <div class="kicker">${v.is_gift ? 'Cupón de cortesía' : 'Cupón de servicio · prepagado'}</div>

      <div class="service">${esc(servicio)}</div>
      <div class="includes">
        ${v.includes_aspirado
          ? '<span class="pill">Incluye aspirado de interiores</span>'
          : '<span class="pill pill-muted">Sin aspirado</span>'}
      </div>

      <div class="holder">
        <div class="holder-label">${v.is_gift ? 'Válido para' : 'Adquirido por'}</div>
        <div class="holder-name">${esc(v.customer_name)}</div>
      </div>
    </div>

    <div class="right">
      <div class="code-label">Cupón N°</div>
      <div class="code">${esc(v.code)}</div>
      <div class="seq">Correlativo ${String(v.sequence_number).padStart(6, '0')}</div>
      <img class="qr" src="${esc(qrSrc(voucherValidationUrl(v)))}" alt="QR de validación ${esc(v.code)}"/>
      <div class="qr-note">Escaneá para validar</div>
      <div class="value">${v.is_gift ? 'REGALÍA' : `Valor ${money(v.unit_value)}`}</div>
    </div>
  </section>`
}

/**
 * @param unico  ajusta la hoja al tamaño de un solo cupón. El cupón mantiene
 *               sus medidas exactas — lo que cambia es el papel, para no
 *               desperdiciar dos tercios de una carta al reimprimir uno solo.
 */
export function buildVouchersHTML(vouchers: VoucherRow[], unico = false): string {
  const paginas: VoucherRow[][] = []
  for (let i = 0; i < vouchers.length; i += 3) paginas.push(vouchers.slice(i, i + 3))

  const rango = vouchers.length
    ? ` · ${vouchers[0].code}–${vouchers[vouchers.length - 1].code}`
    : ''

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>Cupones CORSA${rango}</title>
<style>
  @page { size: ${unico ? '216mm 101mm' : 'letter'}; margin: 8mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: #111; }

  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }

  /* Tres por hoja: 279mm menos márgenes, repartidos en tres bloques. */
  .voucher {
    height: 85mm; display: flex;
    border: 2px solid #111; border-radius: 3mm;
    overflow: hidden; margin-bottom: 4mm;
  }
  .voucher:last-child { margin-bottom: 0; }

  .left { flex: 1; padding: 7mm 8mm; display: flex; flex-direction: column; }
  .brand { font-size: 24px; font-weight: 900; letter-spacing: 0.16em; line-height: 1; }
  .kicker {
    font-size: 9px; font-weight: 700; letter-spacing: 0.18em;
    text-transform: uppercase; color: #555; margin-top: 3px;
  }
  .service { font-size: 30px; font-weight: 900; margin-top: 7mm; line-height: 1.05; }
  .includes { margin-top: 3mm; }
  .pill {
    display: inline-block; font-size: 10.5px; font-weight: 700;
    border: 1.5px solid #111; border-radius: 20px; padding: 2px 10px;
  }
  .pill-muted { border-color: #999; color: #666; font-weight: 600; }

  .holder { margin-top: auto; }
  .holder-label {
    font-size: 8.5px; font-weight: 800; letter-spacing: 0.12em;
    text-transform: uppercase; color: #666;
  }
  .holder-name { font-size: 14px; font-weight: 700; margin-top: 1px; }

  /* Talón derecho, separado por troquel visual. */
  .right {
    width: 52mm; padding: 6mm 4mm;
    border-left: 2px dashed #111;
    display: flex; flex-direction: column; align-items: center; text-align: center;
  }
  .code-label {
    font-size: 8.5px; font-weight: 800; letter-spacing: 0.12em;
    text-transform: uppercase; color: #666;
  }
  .code {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 26px; font-weight: 900; letter-spacing: 0.05em; line-height: 1.1;
  }
  /* El correlativo va discreto: el número grande es el que se teclea. */
  .seq {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 8.5px; color: #666; margin-top: 1mm; letter-spacing: 0.04em;
  }
  .qr { width: 28mm; height: 28mm; margin-top: 2mm; }
  .qr-note { font-size: 8.5px; color: #555; margin-top: 1.5mm; }
  .value { font-size: 12px; font-weight: 800; margin-top: auto; }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  ${paginas.map(p => `<div class="page">${p.map(voucherCard).join('')}</div>`).join('')}
  <script>
    if (!new URLSearchParams(location.search).get('noprint')) {
      // Se espera a que carguen los QR: imprimir antes deja los recuadros vacíos.
      window.addEventListener('load', function () {
        setTimeout(function () { window.focus(); window.print(); }, 600);
      });
    }
  </script>
</body>
</html>`
}

/** Abre el lote completo listo para imprimir o guardar como un solo PDF. */
export function printVouchers(vouchers: VoucherRow[], unico = false): void {
  if (vouchers.length === 0) throw new Error('No hay cupones para imprimir')
  const w = window.open(
    '',
    `corsa_cupones_${unico ? vouchers[0].id : vouchers[0].batch_id}`,
    'width=900,height=1000'
  )
  if (!w) {
    throw new Error('El navegador bloqueó la ventana. Permití popups para este sitio.')
  }
  w.document.open()
  w.document.write(buildVouchersHTML(vouchers, unico))
  w.document.close()
}

/** Un cupón solo, en una hoja a su medida. */
export function printSingleVoucher(voucher: VoucherRow): void {
  printVouchers([voucher], true)
}
