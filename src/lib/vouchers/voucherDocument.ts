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

/** Lo mínimo de un cupón para imprimirlo: lo cumplen la fila de Cupones y la del portal. */
export type CuponImprimible = Pick<VoucherRow,
  'id' | 'code' | 'sequence_number' | 'validation_token' | 'service_name' | 'size' |
  'includes_aspirado' | 'is_gift' | 'unit_value' | 'customer_name' | 'batch_id'>

/**
 * Arte de fondo del cupón. Va en public/ y cubre la tarjeta entera
 * (200 × 85 mm, 2362 × 1004 px a 300 dpi). El arte trae la marca, el servicio
 * y la leyenda, así que el cupón sólo imprime encima lo variable: aspirado y
 * titular a la izquierda, y en el talón una tarjeta blanca con número, QR y
 * valor, pegada abajo para no tapar el logo de la esquina. Si el archivo no
 * está, queda el gris oscuro del arte para que el texto claro se siga leyendo.
 */
export const FONDO_CUPON = '/cupones/fondo-cupon.png'

/**
 * `base` es el origen de la app (https://…). En el navegador sale solo; el
 * servidor de correo lo pasa, porque allá no hay window y el PDF necesita la
 * URL completa del QR y del fondo.
 */
export interface OpcionesCupon { base?: string }

function origen(base?: string): string {
  if (base) return base.replace(/\/$/, '')
  return typeof window !== 'undefined' ? window.location.origin : ''
}

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
export function voucherValidationUrl(v: Pick<VoucherRow, 'validation_token'>, base?: string): string {
  return `${origen(base)}/coupons?v=${v.validation_token}`
}

function qrSrc(data: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=0&qzone=1&data=${encodeURIComponent(data)}`
}

/**
 * Una regalía no lleva importe impreso: un "Valor $0.00" haría dudar de si el
 * cupón sirve. Se rotula por lo que es.
 */
function voucherCard(v: CuponImprimible, base?: string): string {
  return `
  <section class="voucher">
    <div class="left">
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
      <div class="stub">
      <div class="code-label">Cupón N°</div>
      <div class="code">${esc(v.code)}</div>
      <div class="seq">Correlativo ${String(v.sequence_number).padStart(6, '0')}</div>
      <img class="qr" src="${esc(qrSrc(voucherValidationUrl(v, base)))}" alt="QR de validación ${esc(v.code)}"/>
      <div class="qr-note">Escaneá para validar</div>
      <div class="value">${v.is_gift ? 'REGALÍA' : `Valor ${money(v.unit_value)}`}</div>
      </div>
    </div>
  </section>`
}

/**
 * @param unico  ajusta la hoja al tamaño de un solo cupón. El cupón mantiene
 *               sus medidas exactas — lo que cambia es el papel, para no
 *               desperdiciar dos tercios de una carta al reimprimir uno solo.
 */
export function buildVouchersHTML(vouchers: CuponImprimible[], unico = false, opciones: OpcionesCupon = {}): string {
  const base = origen(opciones.base)
  const paginas: CuponImprimible[][] = []
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
    border-radius: 3mm;
    overflow: hidden; margin-bottom: 4mm;
    background: #383838 url('${base}${FONDO_CUPON}') center / cover no-repeat;
  }
  .voucher:last-child { margin-bottom: 0; }

  /* Lo variable va en el hueco entre la leyenda del arte y el logo CORSA. */
  .left { flex: 1; padding: 0 0 0 5mm; display: flex; flex-direction: column; }
  .includes { margin-top: 44mm; }
  .pill {
    display: inline-block; font-size: 9.5px; font-weight: 700;
    color: #DFF56B; border: 1.5px solid #DFF56B; border-radius: 20px; padding: 2px 10px;
  }
  .pill-muted { color: #bbb; border-color: #888; font-weight: 600; }

  .holder { margin-top: 2.5mm; }
  .holder-label {
    font-size: 8.5px; font-weight: 800; letter-spacing: 0.12em;
    text-transform: uppercase; color: rgba(255,255,255,0.6);
  }
  .holder-name { font-size: 13px; font-weight: 700; margin-top: 1px; color: #fff; }

  /* Talón derecho, separado por troquel visual. La tarjeta va abajo: arriba está el logo. */
  .right {
    width: 52mm; padding: 0 4mm 3mm;
    border-left: 2px dashed rgba(255,255,255,0.55);
    display: flex; flex-direction: column; justify-content: flex-end;
  }
  .stub {
    background: #fff; border-radius: 2.5mm; padding: 2mm 3mm;
    display: flex; flex-direction: column; align-items: center; text-align: center;
    box-shadow: 0 1mm 3mm rgba(0,0,0,0.25);
  }
  .code-label {
    font-size: 7.5px; font-weight: 800; letter-spacing: 0.12em;
    text-transform: uppercase; color: #666;
  }
  .code {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 22px; font-weight: 900; letter-spacing: 0.12em; line-height: 1.1;
  }
  /* El correlativo va discreto: el número grande es el que se teclea. */
  .seq {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 7.5px; color: #666; margin-top: 0.3mm; letter-spacing: 0.04em;
  }
  .qr { width: 21mm; height: 21mm; margin-top: 1.2mm; }
  .qr-note { font-size: 7px; color: #555; margin-top: 0.6mm; }
  .value { font-size: 10px; font-weight: 800; margin-top: 0.8mm; }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  ${paginas.map(p => `<div class="page">${p.map(v => voucherCard(v, base)).join('')}</div>`).join('')}
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
export function printVouchers(vouchers: CuponImprimible[], unico = false): void {
  if (vouchers.length === 0) throw new Error('No hay cupones para imprimir')
  const w = window.open(
    '',
    `corsa_cupones_${unico ? vouchers[0].id : vouchers[0].batch_id}`,
    'width=900,height=1000'
  )
  if (!w) {
    throw new Error('El navegador bloqueó la ventana. Permití popups para este sitio.')
  }
  escribirCupones(w, vouchers, unico)
}

/**
 * Escribe los cupones en una ventana ya abierta. La Cuponera Digital abre la
 * ventana en el clic y la llena cuando el servidor devuelve los cupones: abrirla
 * después de esperar la respuesta la haría bloquear como popup.
 */
export function escribirCupones(w: Window, vouchers: CuponImprimible[], unico = vouchers.length === 1): void {
  w.document.open()
  w.document.write(buildVouchersHTML(vouchers, unico))
  w.document.close()
}

/** Un cupón solo, en una hoja a su medida. */
export function printSingleVoucher(voucher: CuponImprimible): void {
  printVouchers([voucher], true)
}
