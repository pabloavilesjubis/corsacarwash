/**
 * CORSA Carwash — Contabilidad: piezas compartidas por las cuatro pantallas.
 */

import {
  DEPARTAMENTOS, getMunicipiosFor, TIPOS_DOCUMENTO_RECEPTOR,
} from '../../lib/mh-catalogs'
import {
  ESTADO_CLASE, ESTADO_ETIQUETA,
  type Ambiente, type Direccion, type EstadoServicio, type Persona,
} from '../../services/fiscal.service'

export function Encabezado({ titulo, subtitulo, servicio, accion }: {
  titulo: string
  subtitulo: React.ReactNode
  servicio: EstadoServicio | null
  accion?: React.ReactNode
}) {
  return (
    <>
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>
            {titulo}
          </h1>
          <div className="page-header-sub">{subtitulo}</div>
        </div>
        <div className="page-header-actions">
          {servicio && <AmbienteBadge ambiente={servicio.ambiente}/>}
          {accion}
        </div>
      </div>
      {servicio && !servicio.disponible && (
        <div className="alert-banner danger">
          <div className="alert-body">
            <div className="alert-title">El servicio fiscal no está disponible</div>
            <div className="alert-desc">{servicio.mensaje ?? 'No se puede emitir hasta que vuelva.'} El historial sí se puede consultar.</div>
          </div>
        </div>
      )}
    </>
  )
}

export function AmbienteBadge({ ambiente }: { ambiente: Ambiente }) {
  return ambiente === '01'
    ? <span className="badge badge-orange" title="Los documentos tienen validez fiscal">Producción</span>
    : <span className="badge badge-neutral" title="Sandbox de Hacienda: sin validez fiscal">Ambiente de pruebas</span>
}

export function EstadoBadge({ estado }: { estado: string }) {
  return <span className={`badge ${ESTADO_CLASE[estado] ?? 'badge-neutral'}`}>{ESTADO_ETIQUETA[estado] ?? estado}</span>
}

export function Dato({ label, valor, mono }: { label: string; valor: React.ReactNode; mono?: boolean }) {
  if (valor == null || valor === '') return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span className={mono ? 'font-mono' : undefined}
            style={{ fontSize: 12.5, color: 'var(--text-primary)', textAlign: 'right', wordBreak: 'break-all' }}>
        {valor}
      </span>
    </div>
  )
}

export function Campo({ label, children, ancho, ayuda }: {
  label: string; children: React.ReactNode; ancho?: string; ayuda?: string
}) {
  return (
    <div className="field" style={{ flex: ancho ?? '1 1 180px', minWidth: 0 }}>
      <label>{label}</label>
      {children}
      {ayuda && <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{ayuda}</span>}
    </div>
  )
}

export function Fila({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>{children}</div>
}

export function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="panel-section-label" style={{ marginBottom: 0 }}>{titulo}</div>
      {children}
    </div>
  )
}

export function CamposDireccion({ valor, onChange }: { valor: Direccion; onChange: (d: Direccion) => void }) {
  const municipios = valor.departamento ? getMunicipiosFor(valor.departamento) : []
  return (
    <Fila>
      <Campo label="Departamento" ancho="1 1 150px">
        <select className="corsa-input" value={valor.departamento}
                onChange={e => onChange({ ...valor, departamento: e.target.value, municipio: '' })}>
          <option value="">—</option>
          {DEPARTAMENTOS.map(d => <option key={d.codigo} value={d.codigo}>{d.nombre}</option>)}
        </select>
      </Campo>
      <Campo label="Municipio" ancho="1 1 150px">
        <select className="corsa-input" value={valor.municipio} disabled={!valor.departamento}
                onChange={e => onChange({ ...valor, municipio: e.target.value })}>
          <option value="">—</option>
          {municipios.map(m => <option key={m.codigo} value={m.codigo}>{m.nombre}</option>)}
        </select>
      </Campo>
      <Campo label="Dirección" ancho="2 1 260px">
        <input className="corsa-input" value={valor.complemento} maxLength={200}
               onChange={e => onChange({ ...valor, complemento: e.target.value })}/>
      </Campo>
    </Fila>
  )
}

export function SelectTipoDocumento({ valor, onChange }: { valor: string; onChange: (v: string) => void }) {
  return (
    <select className="corsa-input" value={valor} onChange={e => onChange(e.target.value)}>
      {TIPOS_DOCUMENTO_RECEPTOR.map(t => <option key={t.codigo} value={t.codigo}>{t.nombre}</option>)}
    </select>
  )
}

export function CamposPersona({ valor, onChange }: { valor: Persona; onChange: (p: Persona) => void }) {
  return (
    <Fila>
      <Campo label="Nombre" ancho="2 1 220px">
        <input className="corsa-input" value={valor.nombre} maxLength={100}
               onChange={e => onChange({ ...valor, nombre: e.target.value })}/>
      </Campo>
      <Campo label="Documento" ancho="0 1 130px">
        <SelectTipoDocumento valor={valor.tipoDocumento} onChange={v => onChange({ ...valor, tipoDocumento: v })}/>
      </Campo>
      <Campo label="Número" ancho="1 1 140px">
        <input className="corsa-input" value={valor.numDocumento} maxLength={20}
               onChange={e => onChange({ ...valor, numDocumento: e.target.value.replace(/[\s-]/g, '') })}/>
      </Campo>
    </Fila>
  )
}
