/**
 * CORSA Carwash — Beneficios corporativos (0079), pestaña de Flotillas.
 *
 * Empresas aliadas cuyos empleados pagan una tarifa especial. Acá se crea la
 * empresa con sus precios (mismo editor que flotillas), se comparte el enlace
 * o el QR para que los empleados se registren con su carnet, se ve quién está
 * inscrito y se arma el resumen de uso del mes para presentárselo a la empresa.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import { useEsMovil } from '../../hooks/useEsMovil'
import { EditorPrecios } from '../EditorPrecios'
import { qrSvg } from '../../lib/fiscal/qr'
import { LOGO_PATH, LOGO_VIEWBOX } from '../../brand/logoCompleto'
import { lineasDesde, SERVICIOS_FLOTILLA, type AcuerdoFlotilla, type LineasEditables } from '../../lib/flotillas/precios'
import {
  activarBeneficio, activarMiembro, actualizarBeneficio, crearBeneficio, enlaceBeneficio, guardarPreciosBeneficio,
  listarBeneficios, listarMiembros, problemaDeBeneficio, resumenUso,
  type Beneficio, type DatosBeneficio, type MiembroBeneficio, type ResumenUso,
} from '../../lib/beneficios/beneficios'
import { formatearFecha, hoyLocal, inicioDelDiaISO } from '../../utils/fecha'

const fmt = (n: number) => 'US$' + n.toFixed(2)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const nombreMes = (mes: string) => { const [a, m] = mes.split('-').map(Number); return `${MESES[m - 1]} ${a}` }
/** [inicio del mes, inicio del siguiente), en hora del carwash. */
function rangoMes(mes: string): [string, string] {
  const [a, m] = mes.split('-').map(Number)
  const sig = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`
  return [inicioDelDiaISO(`${mes}-01`), inicioDelDiaISO(`${sig}-01`)]
}

// ─── Modal genérico ───────────────────────────────────────────

function Modal({ titulo, sub, onCerrar, children, pie, ancho = 560 }: {
  titulo: string; sub?: string; onCerrar: () => void; children: React.ReactNode; pie?: React.ReactNode; ancho?: number
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar])
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCerrar() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: ancho, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>{titulo}</div>
            {sub && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>}
          </div>
          <button onClick={onCerrar} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>
        <div style={{ padding: '18px 22px' }}>{children}</div>
        {pie && <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>{pie}</div>}
      </div>
    </div>,
    document.body
  )
}

function BotonPrincipal({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className="clip-btn-wrap" style={{ opacity: disabled ? 0.6 : 1 }}>
      <div className="clip-btn-corner"/>
      <button className="clip-btn" onClick={onClick} disabled={disabled}>{children}</button>
    </div>
  )
}

// ─── Crear / editar ───────────────────────────────────────────

function CamposEmpresa({ datos, setDatos }: { datos: DatosBeneficio; setDatos: (d: DatosBeneficio) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="field">
        <label>Empresa aliada *</label>
        <input className="corsa-input" value={datos.nombre} maxLength={120} placeholder="Como la conocen sus empleados"
               onChange={e => setDatos({ ...datos, nombre: e.target.value })}/>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label>Contacto en la empresa</label>
          <input className="corsa-input" value={datos.contacto} maxLength={120} placeholder="RR. HH., beneficios…"
                 onChange={e => setDatos({ ...datos, contacto: e.target.value })}/>
        </div>
        <div className="field" style={{ flex: '1 1 200px' }}>
          <label>Correo del contacto</label>
          <input className="corsa-input" type="email" value={datos.correo} maxLength={100}
                 onChange={e => setDatos({ ...datos, correo: e.target.value })}/>
        </div>
      </div>
    </div>
  )
}

function NuevoBeneficioModal({ orgId, onCreado, onCerrar }: { orgId: string; onCreado: (id: string) => void; onCerrar: () => void }) {
  const [datos, setDatos] = useState<DatosBeneficio>({ nombre: '', contacto: '', correo: '' })
  const [lineas, setLineas] = useState<LineasEditables>(() => lineasDesde(null))
  const [aspirado, setAspirado] = useState({ activo: false, precio: '2.50' })
  const [guardando, setGuardando] = useState(false)

  const crear = async () => {
    if (!datos.nombre.trim()) { toast.error('Escribí el nombre de la empresa'); return }
    const problema = problemaDeBeneficio(lineas, aspirado)
    if (problema) { toast.error(problema); return }
    setGuardando(true)
    try {
      const id = await crearBeneficio(orgId, datos, lineas, aspirado)
      toast.success('Beneficio creado ✓')
      onCreado(id)
    } catch (err: any) {
      toast.error(err?.message ?? 'No se pudo crear el beneficio')
    }
    setGuardando(false)
  }

  return (
    <Modal titulo="Nuevo beneficio corporativo" sub="Empresa aliada cuyos empleados pagan tarifa especial" onCerrar={onCerrar}
      pie={<>
        <button onClick={onCerrar} className="btn btn-ghost">Cancelar</button>
        <BotonPrincipal onClick={crear} disabled={guardando}>{guardando ? 'Creando…' : 'Crear beneficio'}</BotonPrincipal>
      </>}>
      <CamposEmpresa datos={datos} setDatos={setDatos}/>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--corsa-orange)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '18px 0 10px' }}>
        Precios para los empleados
      </div>
      <EditorPrecios lineas={lineas} setLineas={setLineas} aspirado={aspirado} setAspirado={setAspirado}/>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10 }}>Lo que no marqués se cobra a tarifa de lista.</div>
    </Modal>
  )
}

function EditarDatosModal({ beneficio, onGuardado, onCerrar }: { beneficio: Beneficio; onGuardado: () => void; onCerrar: () => void }) {
  const [datos, setDatos] = useState<DatosBeneficio>({
    nombre: beneficio.name, contacto: beneficio.contact_name ?? '', correo: beneficio.contact_email ?? '',
  })
  const [guardando, setGuardando] = useState(false)
  const guardar = async () => {
    if (!datos.nombre.trim()) { toast.error('Escribí el nombre de la empresa'); return }
    setGuardando(true)
    try { await actualizarBeneficio(beneficio.id, datos); toast.success('Datos actualizados ✓'); onGuardado() }
    catch (err: any) { toast.error(err?.message ?? 'No se pudieron guardar los datos') }
    setGuardando(false)
  }
  return (
    <Modal titulo="Datos de la empresa" onCerrar={onCerrar} pie={<>
      <button onClick={onCerrar} className="btn btn-ghost">Cancelar</button>
      <BotonPrincipal onClick={guardar} disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</BotonPrincipal>
    </>}>
      <CamposEmpresa datos={datos} setDatos={setDatos}/>
    </Modal>
  )
}

function EditarPreciosModal({ beneficio, onGuardado, onCerrar }: { beneficio: Beneficio; onGuardado: () => void; onCerrar: () => void }) {
  const [lineas, setLineas] = useState<LineasEditables>(() => lineasDesde(beneficio.acuerdo))
  const [aspirado, setAspirado] = useState({
    activo: beneficio.acuerdo.aspirado.activo,
    precio: (beneficio.acuerdo.aspirado.precio ?? 2.5).toFixed(2),
  })
  const [guardando, setGuardando] = useState(false)
  const guardar = async () => {
    const problema = problemaDeBeneficio(lineas, aspirado)
    if (problema) { toast.error(problema); return }
    setGuardando(true)
    try { await guardarPreciosBeneficio(beneficio.id, lineas, aspirado); toast.success('Precios actualizados ✓'); onGuardado() }
    catch (err: any) { toast.error(err?.message ?? 'No se pudieron guardar los precios') }
    setGuardando(false)
  }
  return (
    <Modal titulo="Precios del beneficio" sub={beneficio.name} onCerrar={onCerrar} pie={<>
      <button onClick={onCerrar} className="btn btn-ghost">Cancelar</button>
      <BotonPrincipal onClick={guardar} disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar precios'}</BotonPrincipal>
    </>}>
      <EditorPrecios lineas={lineas} setLineas={setLineas} aspirado={aspirado} setAspirado={setAspirado}/>
    </Modal>
  )
}

// ─── Enlace y QR ──────────────────────────────────────────────

function cartelHTML(url: string, qr: string, empresa: string): string {
  const logo = `<svg viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" style="width:210px;height:auto" role="img" aria-label="CORSA Carwash"><path d="${LOGO_PATH}" fill="#fff" fill-rule="evenodd"/></svg>`
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Beneficio CORSA · ${esc(empresa)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Outfit:wght@700;800&display=swap" rel="stylesheet"/>
<style>
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Inter, Arial, sans-serif; color: #16191A; }
  .hoja { width: 8.5in; height: 11in; display: flex; flex-direction: column; }
  .arriba { background: #16191A; color: #fff; text-align: center; padding: 0.6in 0.6in 1.4in; }
  .para { font-size: 18px; color: #DFF56B; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 28px; }
  h1 { font-family: Outfit, Arial, sans-serif; font-weight: 800; font-size: 50px; letter-spacing: -0.02em; margin: 10px 0 0; }
  .sub { font-size: 19px; color: rgba(255,255,255,0.75); margin-top: 16px; }
  .qr { width: 4.1in; height: 4.1in; margin: -1.05in auto 0; background: #fff; border-radius: 28px; padding: 0.28in; box-shadow: 0 0 0 6px #DFF56B; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .pasos { display: flex; justify-content: center; gap: 0.35in; margin-top: 0.5in; }
  .paso { width: 1.9in; text-align: center; font-size: 15px; line-height: 1.35; }
  .paso b { display: flex; width: 40px; height: 40px; border-radius: 50%; background: #16191A; color: #DFF56B;
            align-items: center; justify-content: center; margin: 0 auto 10px; font-family: Outfit, Arial; font-size: 18px; }
  .pie { margin-top: auto; text-align: center; font-size: 12px; color: #7A827D; padding-bottom: 0.45in; }
</style></head><body><div class="hoja">
  <div class="arriba">${logo}<div class="para">Beneficio para empleados de ${esc(empresa)}</div>
    <h1>Tarifa especial en CORSA</h1><div class="sub">Escaneá el código y registrate con tu carnet</div></div>
  <div class="qr">${qr}</div>
  <div class="pasos">
    <div class="paso"><b>1</b>Escaneá el QR</div>
    <div class="paso"><b>2</b>Registrate con tu carnet y tus carros</div>
    <div class="paso"><b>3</b>En caja pagás el precio del beneficio</div>
  </div>
  <div class="pie">${esc(url)}</div>
</div></body></html>`
}

function abrirParaImprimir(html: string) {
  const w = window.open('', '_blank', 'width=900,height=1100')
  if (!w) { toast.error('El navegador bloqueó la ventana. Permití popups para este sitio.'); return }
  w.document.open(); w.document.write(html); w.document.close()
  // Las fuentes tardan un instante; imprimir antes las cambia por Arial.
  setTimeout(() => { w.focus(); w.print() }, 900)
}

function EnlaceModal({ beneficio, onCerrar }: { beneficio: Beneficio; onCerrar: () => void }) {
  const url = enlaceBeneficio(beneficio.code)
  const qr = useMemo(() => qrSvg(url, { color: '#16191A', margen: 0 }), [url])
  const copiar = async () => {
    try { await navigator.clipboard.writeText(url); toast.success('Enlace copiado') }
    catch { toast.error('No se pudo copiar el enlace') }
  }
  return (
    <Modal titulo="Enlace de registro" sub={beneficio.name} onCerrar={onCerrar} ancho={420}>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
        Compartilo con la empresa para que lo envíe a sus empleados. Cada uno se registra con su carnet y queda activo de inmediato.
      </div>
      <div style={{ background: '#fff', borderRadius: 16, padding: 16, margin: '16px auto', width: 220, height: 220, boxShadow: '0 0 0 4px #DFF56B' }}
           dangerouslySetInnerHTML={{ __html: qr }}/>
      <div className="font-mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all', marginBottom: 14, textAlign: 'center' }}>{url}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-ghost" onClick={copiar}>Copiar enlace</button>
        <a className="btn btn-ghost" href={url} target="_blank" rel="noreferrer">Abrir formulario</a>
        <button className="btn btn-primary" onClick={() => abrirParaImprimir(cartelHTML(url, qr, beneficio.name))}>Imprimir cartel</button>
      </div>
    </Modal>
  )
}

// ─── Resumen para la empresa ──────────────────────────────────

function resumenHTML(b: Beneficio, mes: string, r: ResumenUso): string {
  const filas = r.porMiembro.map(u => `<tr>
    <td>${esc(u.miembro.nombre)}</td><td class="mono">${esc(u.miembro.carnet)}</td>
    <td>${formatearFecha(u.miembro.enrolled_at)}</td>
    <td class="n">${u.lavados}</td><td class="n">${u.ultimaVisita ? formatearFecha(u.ultimaVisita) : '—'}</td>
    <td class="n">${fmt(u.ahorro)}</td></tr>`).join('')
  const servicios = r.porServicio.map(s => `${esc(s.servicio)}: ${s.lavados}`).join(' · ') || 'Sin lavados'
  const kpi = (t: string, v: string) => `<div class="kpi"><div class="v">${v}</div><div class="t">${t}</div></div>`
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Beneficio CORSA · ${esc(b.name)} · ${nombreMes(mes)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Outfit:wght@700;800&display=swap" rel="stylesheet"/>
<style>
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: Inter, Arial, sans-serif; color: #16191A; font-size: 12.5px; }
  .cab { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #16191A; padding-bottom: 12px; }
  .cab svg { width: 150px; height: auto; }
  h1 { font-family: Outfit, Arial, sans-serif; font-size: 26px; margin: 18px 0 2px; }
  .sub { color: #5E6661; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 20px 0; }
  .kpi { border: 1.5px solid #E3E8DE; border-radius: 12px; padding: 12px; }
  .kpi .v { font-family: Outfit, Arial; font-weight: 800; font-size: 24px; }
  .kpi .t { color: #5E6661; font-size: 11.5px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #5E6661; border-bottom: 1.5px solid #16191A; padding: 6px; }
  td { padding: 6px; border-bottom: 1px solid #E3E8DE; }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  th.n { text-align: right; }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .nota { color: #7A827D; font-size: 10.5px; margin-top: 14px; line-height: 1.5; }
</style></head><body>
  <div class="cab">
    <svg viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}"><path d="${LOGO_PATH}" fill="#16191A" fill-rule="evenodd"/></svg>
    <div class="sub">Generado el ${formatearFecha(new Date())}</div>
  </div>
  <h1>Beneficio corporativo · ${esc(b.name)}</h1>
  <div class="sub">Uso del beneficio en ${nombreMes(mes)}</div>
  <div class="kpis">
    ${kpi('Empleados inscritos', String(r.inscritos))}
    ${kpi('Usaron el beneficio', String(r.usaron))}
    ${kpi('Carros lavados', String(r.lavados))}
    ${kpi('Ahorro de sus empleados', fmt(r.ahorro))}
  </div>
  <div><strong>Nuevos inscritos en el mes:</strong> ${r.nuevos} · <strong>Lavados por servicio:</strong> ${servicios}</div>
  <table>
    <thead><tr><th>Empleado</th><th>Carnet</th><th>Inscrito</th><th class="n">Lavados</th><th class="n">Última visita</th><th class="n">Ahorro</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="6">Sin empleados inscritos en el período.</td></tr>'}</tbody>
  </table>
  <div class="nota">
    Un lavado es un carro lavado. El ahorro es la diferencia entre la tarifa de lista de CORSA y el precio del
    beneficio en los lavados pagados. Si algún carnet no corresponde a un empleado activo, avísenos para darlo de baja.
  </div>
</body></html>`
}

function ResumenPanel({ beneficio }: { beneficio: Beneficio }) {
  const [mes, setMes] = useState(() => hoyLocal().slice(0, 7))
  const [resumen, setResumen] = useState<ResumenUso | null>(null)
  const [cargando, setCargando] = useState(false)

  useEffect(() => {
    let vivo = true
    setCargando(true)
    const [desde, hasta] = rangoMes(mes)
    resumenUso(beneficio.id, desde, hasta)
      .then(r => { if (vivo) setResumen(r) })
      .catch((err: any) => { if (vivo) { setResumen(null); toast.error(err?.message ?? 'No se pudo armar el resumen') } })
      .finally(() => { if (vivo) setCargando(false) })
    return () => { vivo = false }
  }, [beneficio.id, mes])

  const kpi = (t: string, v: string) => (
    <div style={{ flex: '1 1 120px', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px' }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{t}</div>
    </div>
  )

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16 }}>Resumen para la empresa</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="month" className="corsa-input" value={mes} max={hoyLocal().slice(0, 7)}
                 onChange={e => e.target.value && setMes(e.target.value)} style={{ width: 160 }}/>
          <button className="btn btn-primary" disabled={!resumen || cargando}
                  onClick={() => resumen && abrirParaImprimir(resumenHTML(beneficio, mes, resumen))}>
            Imprimir / PDF
          </button>
        </div>
      </div>
      {cargando || !resumen ? (
        <div className="loading-center"><div className="spinner"/><span>Calculando…</span></div>
      ) : (<>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {kpi('Inscritos', String(resumen.inscritos))}
          {kpi('Usaron el beneficio', String(resumen.usaron))}
          {kpi('Nuevos en el mes', String(resumen.nuevos))}
          {kpi('Carros lavados', String(resumen.lavados))}
          {kpi('Cobrado', fmt(resumen.pagado))}
          {kpi('Ahorro de empleados', fmt(resumen.ahorro))}
        </div>
        {resumen.porServicio.length > 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 10 }}>
            {resumen.porServicio.map(s => `${s.servicio}: ${s.lavados}`).join(' · ')}
          </div>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 8 }}>
          Cuenta los carros lavados por cada empleado desde que se inscribió. El ahorro es contra la tarifa de lista, sólo en lavados pagados.
        </div>
      </>)}
    </div>
  )
}

// ─── Empleados inscritos ──────────────────────────────────────

function MiembrosPanel({ beneficio, onCambio }: { beneficio: Beneficio; onCambio: () => void }) {
  const [miembros, setMiembros] = useState<MiembroBeneficio[]>([])
  const [cargando, setCargando] = useState(true)
  const [buscar, setBuscar] = useState('')
  const [verBajas, setVerBajas] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    try { setMiembros(await listarMiembros(beneficio.id)) }
    catch (err: any) { toast.error(err?.message ?? 'No se pudieron cargar los empleados') }
    setCargando(false)
  }, [beneficio.id])
  useEffect(() => { cargar() }, [cargar])

  const cambiar = async (m: MiembroBeneficio, activo: boolean) => {
    if (!activo && !confirm(`¿Dar de baja a ${m.nombre} del beneficio? Desde ahora paga tarifa de lista.`)) return
    try { await activarMiembro(m.id, activo); toast.success(activo ? 'Reactivado ✓' : 'Dado de baja ✓'); await cargar(); onCambio() }
    catch (err: any) { toast.error(err?.message ?? 'No se pudo actualizar') }
  }

  const q = buscar.trim().toLowerCase()
  const visibles = miembros
    .filter(m => verBajas || m.active)
    .filter(m => !q || m.nombre.toLowerCase().includes(q) || m.carnet.toLowerCase().includes(q)
      || m.placas.some(p => p.toLowerCase().includes(q)) || (m.telefono ?? '').includes(q))
  const bajas = miembros.filter(m => !m.active).length

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16 }}>
          Empleados inscritos
          <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '2px 8px', borderRadius: 4 }}>
            {miembros.length - bajas} activos
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="corsa-input" value={buscar} onChange={e => setBuscar(e.target.value)}
                 placeholder="Nombre, carnet o placa…" style={{ width: 200 }}/>
          {bajas > 0 && (
            <label style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={verBajas} onChange={e => setVerBajas(e.target.checked)}/> Ver bajas ({bajas})
            </label>
          )}
        </div>
      </div>
      {cargando ? (
        <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
      ) : visibles.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">{miembros.length === 0 ? 'Todavía no se registró nadie' : 'Sin coincidencias'}</div>
          {miembros.length === 0 && <div className="empty-state-sub">Compartí el enlace de registro con la empresa.</div>}
        </div>
      ) : (
        <div>
          {visibles.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', borderBottom: '1px solid var(--border)', opacity: m.active ? 1 : 0.55, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{m.nombre}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {m.telefono ?? 'Sin teléfono'} · desde {formatearFecha(m.enrolled_at)}
                  {!m.active && m.deactivated_at && ` · baja ${formatearFecha(m.deactivated_at)}`}
                </div>
              </div>
              <div className="font-mono" style={{ flex: '0 0 auto', fontSize: 12.5, fontWeight: 700 }}>#{m.carnet}</div>
              <div className="font-mono" style={{ flex: '1 1 120px', fontSize: 12, color: 'var(--text-secondary)' }}>{m.placas.join(' · ') || 'Sin carros'}</div>
              <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => cambiar(m, !m.active)}>
                {m.active ? 'Dar de baja' : 'Reactivar'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Precios (lectura) ────────────────────────────────────────

function Precios({ acuerdo }: { acuerdo: AcuerdoFlotilla }) {
  const servicios = SERVICIOS_FLOTILLA.filter(sv => acuerdo.servicios[sv.codigo])
  if (servicios.length === 0 && !acuerdo.aspirado.activo) {
    return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Sin precios: los empleados pagan tarifa de lista.</div>
  }
  const cifra = (n: number | null) => (
    <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, color: 'var(--corsa-orange)', fontVariantNumeric: 'tabular-nums' }}>{n != null ? fmt(n) : '—'}</span>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {servicios.map(sv => {
        const p = acuerdo.servicios[sv.codigo]!
        return (
          <div key={sv.codigo} style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ width: 96, fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15 }}>{sv.nombre}</div>
            {!acuerdo.porTamano[sv.codigo] ? (
              <div>{cifra(p.M)}<span style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginLeft: 6 }}>cualquier tamaño</span></div>
            ) : (['S', 'M', 'L'] as const).map(t => (
              <div key={t}>{cifra(p[t])}<span style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginLeft: 4 }}>{t}</span></div>
            ))}
          </div>
        )
      })}
      {acuerdo.aspirado.activo && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <div style={{ width: 96, fontWeight: 700, fontSize: 13 }}>Aspirado</div>
          <div>{cifra(acuerdo.aspirado.precio)}<span style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginLeft: 6 }}>cualquier tamaño</span></div>
        </div>
      )}
    </div>
  )
}

// ─── Pestaña ──────────────────────────────────────────────────

export function BeneficiosCorporativos() {
  const { profile } = useAuth()
  const esMovil = useEsMovil()
  const orgId = (profile as any)?.organization_id ?? null

  const [beneficios, setBeneficios] = useState<Beneficio[]>([])
  const [cargando, setCargando] = useState(true)
  const [elegidoId, setElegidoId] = useState<string | null>(null)
  const [buscar, setBuscar] = useState('')
  const [modal, setModal] = useState<'nuevo' | 'datos' | 'precios' | 'enlace' | null>(null)

  const cargar = useCallback(async () => {
    try { setBeneficios(await listarBeneficios()) }
    catch (err: any) { toast.error(err?.message ?? 'No se pudieron cargar los beneficios') }
    setCargando(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const elegido = beneficios.find(b => b.id === elegidoId) ?? null
  const q = buscar.trim().toLowerCase()
  const visibles = q ? beneficios.filter(b => b.name.toLowerCase().includes(q)) : beneficios

  const alternarActivo = async (b: Beneficio) => {
    if (b.active && !confirm(`¿Pausar el beneficio de ${b.name}? El enlace deja de registrar y la caja deja de aplicar los precios.`)) return
    try { await activarBeneficio(b.id, !b.active); toast.success(b.active ? 'Beneficio pausado' : 'Beneficio activo ✓'); cargar() }
    catch (err: any) { toast.error(err?.message ?? 'No se pudo actualizar') }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 560 }}>
          Empresas aliadas que dan a sus empleados tarifa especial en CORSA. Cada empleado se registra con su carnet y la caja le cobra los precios del beneficio.
        </div>
        <div className="clip-btn-wrap">
          <div className="clip-btn-corner"/>
          <button id="btn-nuevo-beneficio" className="clip-btn" onClick={() => setModal('nuevo')} disabled={!orgId}>+ Nuevo beneficio</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Lista */}
        <div style={{ flex: esMovil ? '1 1 100%' : '0 0 320px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input className="corsa-input" value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar empresa…"/>
          {cargando ? (
            <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
          ) : visibles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">No hay beneficios corporativos</div>
              <div className="empty-state-sub">Creá el primero con el botón de arriba.</div>
            </div>
          ) : visibles.map(b => {
            const sel = b.id === elegidoId
            return (
              <div key={b.id} onClick={() => setElegidoId(b.id)} role="button" tabIndex={0}
                style={{
                  background: 'var(--surface)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer',
                  border: `1px solid ${sel ? 'var(--corsa-green)' : 'var(--border)'}`,
                  borderLeft: sel ? '4px solid var(--corsa-green)' : '1px solid var(--border)',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
                  {b.active ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-success-text)', background: 'var(--color-success-tint)', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>Activo</span>
                  ) : (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>Pausado</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {b.miembrosActivos} empleado{b.miembrosActivos !== 1 ? 's' : ''} inscrito{b.miembrosActivos !== 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--corsa-orange)', fontWeight: 600, marginTop: 2 }}>
                  {SERVICIOS_FLOTILLA.filter(sv => b.acuerdo.servicios[sv.codigo]).map(sv => sv.nombre).join(' · ') || 'Sin precios de servicio'}
                  {b.acuerdo.aspirado.activo && ' · aspirado'}
                </div>
              </div>
            )
          })}
        </div>

        {/* Detalle */}
        {elegido ? (
          <div style={{ flex: 1, minWidth: esMovil ? 0 : 320, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20 }}>{elegido.name}</div>
                  {(elegido.contact_name || elegido.contact_email) && (
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                      {[elegido.contact_name, elegido.contact_email].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  <div className="font-mono" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>Código {elegido.code}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setModal('enlace')} disabled={!elegido.active}>Enlace y QR</button>
                  <button className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setModal('datos')}>Editar datos</button>
                  <button className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => alternarActivo(elegido)}>
                    {elegido.active ? 'Pausar' : 'Reactivar'}
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--corsa-orange)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Precios del beneficio</div>
                  <button className="btn btn-ghost" style={{ padding: '5px 12px', fontSize: 12.5 }} onClick={() => setModal('precios')}>Editar precios</button>
                </div>
                <Precios acuerdo={elegido.acuerdo}/>
              </div>
            </div>

            <ResumenPanel beneficio={elegido}/>
            <MiembrosPanel beneficio={elegido} onCambio={cargar}/>
          </div>
        ) : !esMovil && (
          <div className="card" style={{ flex: 1, minWidth: 320, padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13.5 }}>
            Elegí una empresa para ver sus precios, sus empleados inscritos y el resumen de uso.
          </div>
        )}
      </div>

      {modal === 'nuevo' && orgId && (
        <NuevoBeneficioModal orgId={orgId} onCerrar={() => setModal(null)}
          onCreado={id => { setModal(null); setElegidoId(id); cargar() }}/>
      )}
      {modal === 'datos' && elegido && (
        <EditarDatosModal beneficio={elegido} onCerrar={() => setModal(null)} onGuardado={() => { setModal(null); cargar() }}/>
      )}
      {modal === 'precios' && elegido && (
        <EditarPreciosModal beneficio={elegido} onCerrar={() => setModal(null)} onGuardado={() => { setModal(null); cargar() }}/>
      )}
      {modal === 'enlace' && elegido && <EnlaceModal beneficio={elegido} onCerrar={() => setModal(null)}/>}
    </>
  )
}
