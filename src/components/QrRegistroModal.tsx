/**
 * El QR del registro de clientes (0055), para ponerlo en caja.
 *
 * Lleva a /registro?s=<código de la sucursal>: la sucursal decide a qué
 * organización entra el cliente. Se puede copiar el enlace o imprimir un
 * cartel tamaño carta con la marca.
 */
import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { qrSvg } from '../lib/fiscal/qr'
import { LOGO_PATH, LOGO_VIEWBOX } from '../brand/logoCompleto'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function cartelHTML(url: string, qr: string, sucursal: string): string {
  const logo = `<svg viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" style="width:230px;height:auto" role="img" aria-label="CORSA Carwash"><path d="${LOGO_PATH}" fill="#fff" fill-rule="evenodd"/></svg>`
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Registro CORSA · ${esc(sucursal)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Outfit:wght@700;800&display=swap" rel="stylesheet"/>
<style>
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Inter, Arial, sans-serif; color: #16191A; }
  .hoja { width: 8.5in; height: 11in; display: flex; flex-direction: column; }
  .arriba { background: #16191A; color: #fff; text-align: center; padding: 0.7in 0.6in 1.4in; }
  h1 { font-family: Outfit, Arial, sans-serif; font-weight: 800; font-size: 54px; letter-spacing: -0.02em; margin: 34px 0 0; }
  .raya { width: 70px; height: 6px; border-radius: 3px; background: #DFF56B; margin: 18px auto 0; }
  .sub { font-size: 20px; color: rgba(255,255,255,0.75); margin-top: 18px; }
  .qr { width: 4.1in; height: 4.1in; margin: -1.05in auto 0; background: #fff; border-radius: 28px; padding: 0.28in;
        box-shadow: 0 0 0 6px #DFF56B; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .pasos { display: flex; justify-content: center; gap: 0.35in; margin-top: 0.5in; }
  .paso { width: 1.9in; text-align: center; font-size: 15px; line-height: 1.35; }
  .paso b { display: flex; width: 40px; height: 40px; border-radius: 50%; background: #16191A; color: #DFF56B;
            align-items: center; justify-content: center; margin: 0 auto 10px; font-family: Outfit, Arial; font-size: 18px; }
  .pie { margin-top: auto; text-align: center; font-size: 12px; color: #7A827D; padding-bottom: 0.45in; }
</style></head><body><div class="hoja">
  <div class="arriba">${logo}<h1>Registrate en 1 minuto</h1><div class="raya"></div>
    <div class="sub">Escaneá el código con la cámara de tu teléfono</div></div>
  <div class="qr">${qr}</div>
  <div class="pasos">
    <div class="paso"><b>1</b>Escaneá el QR</div>
    <div class="paso"><b>2</b>Llená tus datos y tus carros</div>
    <div class="paso"><b>3</b>En caja te atendemos más rápido</div>
  </div>
  <div class="pie">${esc(url)}</div>
</div></body></html>`
}

export function QrRegistroModal({ branchCode, branchName, onCerrar }: {
  branchCode: string
  branchName: string
  onCerrar: () => void
}) {
  const url = `${window.location.origin}/registro?s=${encodeURIComponent(branchCode)}`
  const qr = useMemo(() => qrSvg(url, { color: '#16191A', margen: 0 }), [url])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar])

  const imprimir = () => {
    const w = window.open('', 'corsa_qr_registro', 'width=900,height=1100')
    if (!w) { toast.error('El navegador bloqueó la ventana. Permití popups para este sitio.'); return }
    w.document.open()
    w.document.write(cartelHTML(url, qr, branchName))
    w.document.close()
    // Las fuentes del cartel tardan un instante; imprimir antes las cambia por Arial.
    setTimeout(() => { w.focus(); w.print() }, 900)
  }

  const copiar = async () => {
    try { await navigator.clipboard.writeText(url); toast.success('Enlace copiado') }
    catch { toast.error('No se pudo copiar el enlace') }
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCerrar() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, width: '100%', maxWidth: 400, padding: 22, boxShadow: '0 24px 64px rgba(0,0,0,0.25)', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>QR de registro</div>
          <button onClick={onCerrar} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', textAlign: 'left' }}>
          El cliente lo escanea y se registra con sus carros. Entra a {branchName} y queda en Clientes con la nota «Registro por QR».
        </div>
        <div style={{ background: '#fff', borderRadius: 16, padding: 16, margin: '16px auto', width: 240, height: 240, boxShadow: '0 0 0 4px #DFF56B' }}
             dangerouslySetInnerHTML={{ __html: qr }}/>
        <div className="font-mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all', marginBottom: 14 }}>{url}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={copiar}>Copiar enlace</button>
          <a className="btn btn-ghost" href={url} target="_blank" rel="noreferrer">Abrir formulario</a>
          <button className="btn btn-primary" onClick={imprimir}>Imprimir cartel</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
