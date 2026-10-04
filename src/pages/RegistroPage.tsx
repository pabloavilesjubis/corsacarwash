/**
 * CORSA Carwash — Registro de clientes por QR (0055)
 *
 * Página pública, sin sesión: el cliente escanea el QR de la sucursal desde
 * su teléfono y se da de alta con sus carros. Tiene que llenarse en un minuto
 * parado frente a la caja, así que pide lo mínimo para atenderlo y facturarle;
 * los datos de CCF (actividad, dirección fiscal) se completan en caja.
 *
 * Todo lo que se valida acá se vuelve a validar en public_customer_signup: la
 * página es de cualquiera, la función es la que decide.
 */
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { CorsaLogoCompleto } from '../components/ui/CorsaLogoCompleto'

type Tipo = 'individual' | 'company'
type Tamano = 'S' | 'M' | 'L'

interface Vehiculo { placa: string; marca: string; modelo: string; color: string; tamano: Tamano | '' }

const TAMANOS: { id: Tamano; nombre: string; ejemplo: string }[] = [
  { id: 'S', nombre: 'Pequeño', ejemplo: 'Sedán, hatchback' },
  { id: 'M', nombre: 'Mediano', ejemplo: 'SUV, crossover' },
  { id: 'L', nombre: 'Grande', ejemplo: 'Pickup, van, SUV grande' },
]

const vacio = (): Vehiculo => ({ placa: '', marca: '', modelo: '', color: '', tamano: '' })
const digitos = (s: string) => s.replace(/[^0-9]/g, '')

/** 7777-8888 mientras se escribe. */
function formatoTelefono(s: string) {
  const d = digitos(s).slice(0, 8)
  return d.length > 4 ? `${d.slice(0, 4)}-${d.slice(4)}` : d
}
/** 01234567-8 mientras se escribe. */
function formatoDui(s: string) {
  const d = digitos(s).slice(0, 9)
  return d.length > 8 ? `${d.slice(0, 8)}-${d.slice(8)}` : d
}

export function RegistroPage() {
  const [params] = useSearchParams()
  const sucursal = params.get('s') ?? ''

  const [tipo, setTipo] = useState<Tipo | null>(null)
  const [nombre, setNombre] = useState('')
  const [apellido, setApellido] = useState('')
  const [razon, setRazon] = useState('')
  const [comercial, setComercial] = useState('')
  const [dui, setDui] = useState('')
  const [nit, setNit] = useState('')
  const [nrc, setNrc] = useState('')
  const [telefono, setTelefono] = useState('')
  const [correo, setCorreo] = useState('')
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([vacio()])
  const [acepta, setAcepta] = useState(false)
  // Trampa para bots: un campo que una persona no ve ni llena.
  const [web, setWeb] = useState('')

  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listo, setListo] = useState<{ existente: boolean; vehiculos: string[]; omitidos: string[] } | null>(null)

  const cambiarVehiculo = (i: number, campo: keyof Vehiculo, valor: string) =>
    setVehiculos(vs => vs.map((v, j) => (j === i ? { ...v, [campo]: valor } : v)))

  // El primer problema, en palabras: el botón dice qué falta en vez de sólo apagarse.
  const falta = useMemo((): string | null => {
    if (!tipo) return 'Elegí persona o empresa'
    if (tipo === 'individual' && (!nombre.trim() || !apellido.trim())) return 'Falta tu nombre y apellido'
    if (tipo === 'company' && !razon.trim()) return 'Falta la razón social'
    if (tipo === 'company' && !/^(\d{14}|\d{9})$/.test(digitos(nit))) return 'Revisá el NIT (14 dígitos)'
    if (tipo === 'individual' && dui && digitos(dui).length !== 9) return 'Revisá el DUI (9 dígitos)'
    if (tipo === 'company' && nrc && !/^\d{1,8}$/.test(digitos(nrc))) return 'Revisá el NRC'
    if (digitos(telefono).length !== 8) return 'Falta tu teléfono (8 dígitos)'
    if (correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo.trim())) return 'Revisá el correo'
    for (const v of vehiculos) {
      if (v.placa.replace(/[^A-Za-z0-9]/g, '').length < 3) return 'Falta la placa de un vehículo'
      if (!v.tamano) return `Elegí el tamaño de ${v.placa.toUpperCase() || 'tu vehículo'}`
    }
    if (!acepta) return 'Aceptá el uso de tus datos'
    return null
  }, [tipo, nombre, apellido, razon, nit, dui, nrc, telefono, correo, vehiculos, acepta])

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (falta || enviando) return
    if (web) { setListo({ existente: false, vehiculos: [], omitidos: [] }); return }
    setEnviando(true); setError(null)
    const { data, error } = await (supabase as any).rpc('public_customer_signup', {
      p_branch_code: sucursal,
      p_datos: {
        tipo, nombre, apellido, razon_social: razon, nombre_comercial: comercial,
        dui: tipo === 'individual' ? dui : '', nit: tipo === 'company' ? nit : '', nrc: tipo === 'company' ? nrc : '',
        telefono, correo, acepta,
        vehiculos: vehiculos.map(v => ({ placa: v.placa, marca: v.marca, modelo: v.modelo, color: v.color, tamano: v.tamano })),
      },
    })
    setEnviando(false)
    if (error) { setError(error.message || 'No se pudo completar el registro. Intentá de nuevo.'); return }
    setListo({ existente: !!data?.existente, vehiculos: data?.vehiculos ?? [], omitidos: data?.omitidos ?? [] })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const saludo = tipo === 'company' ? (comercial.trim() || razon.trim()) : nombre.trim()

  return (
    <div className="reg-page">
      <header className="reg-hero">
        <div className="reg-logo"><CorsaLogoCompleto width={150}/></div>
        {!listo && (<>
          <h1 className="reg-title">Registrate en CORSA</h1>
          <p className="reg-sub">Un minuto y quedás listo: en tu próxima visita te atendemos más rápido y te facturamos sin dictar datos.</p>
        </>)}
      </header>

      <main className="reg-card">
        {!sucursal ? (
          <div className="reg-aviso">Este enlace no trae el código de la sucursal. Escaneá de nuevo el QR que está en caja.</div>
        ) : listo ? (
          <div className="reg-listo">
            <div className="reg-check" aria-hidden="true">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            {listo.existente ? (<>
              <h2>Ya estabas registrado</h2>
              <p>Tus datos ya están en CORSA. Si querés agregar un carro o cambiar algo, decíselo al cajero.</p>
            </>) : (<>
              <h2>¡Listo{saludo ? `, ${saludo}` : ''}!</h2>
              <p>Ya estás registrado. En caja te encontramos por tu nombre o tu placa.</p>
              {listo.vehiculos.length > 0 && (
                <div className="reg-placas">{listo.vehiculos.map(p => <span key={p} className="reg-placa">{p}</span>)}</div>
              )}
              {listo.omitidos.length > 0 && (
                <p className="reg-nota">
                  {listo.omitidos.join(', ')} ya {listo.omitidos.length === 1 ? 'estaba registrada' : 'estaban registradas'}:
                  pedile al cajero que la{listo.omitidos.length === 1 ? '' : 's'} asocie a tu cuenta.
                </p>
              )}
            </>)}
          </div>
        ) : (
          <form onSubmit={enviar} noValidate>
            {/* 1. Tipo */}
            <section className="reg-seccion">
              <div className="reg-paso"><span>1</span>¿Cómo te registrás?</div>
              <div className="reg-tipos">
                {([
                  { id: 'individual', titulo: 'Persona', sub: 'A mi nombre',
                    icono: <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/> },
                  { id: 'company', titulo: 'Empresa', sub: 'Factura a la empresa',
                    icono: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1"/> },
                ] as const).map(o => (
                  <button key={o.id} type="button" id={`reg-tipo-${o.id}`}
                          className={`reg-tipo${tipo === o.id ? ' sel' : ''}`} onClick={() => setTipo(o.id)}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{o.icono}</svg>
                    <strong>{o.titulo}</strong>
                    <small>{o.sub}</small>
                  </button>
                ))}
              </div>
            </section>

            {tipo && (<>
              {/* 2. Datos */}
              <section className="reg-seccion">
                <div className="reg-paso"><span>2</span>{tipo === 'company' ? 'Datos de la empresa' : 'Tus datos'}</div>
                {tipo === 'individual' ? (<>
                  <div className="reg-fila">
                    <Campo label="Nombre" requerido>
                      <input id="reg-nombre" value={nombre} onChange={e => setNombre(e.target.value)} autoComplete="given-name" maxLength={60}/>
                    </Campo>
                    <Campo label="Apellido" requerido>
                      <input id="reg-apellido" value={apellido} onChange={e => setApellido(e.target.value)} autoComplete="family-name" maxLength={60}/>
                    </Campo>
                  </div>
                  <Campo label="DUI" ayuda="Opcional. Para facturarte a tu nombre.">
                    <input id="reg-dui" value={dui} onChange={e => setDui(formatoDui(e.target.value))} inputMode="numeric" placeholder="00000000-0"/>
                  </Campo>
                </>) : (<>
                  <Campo label="Razón social" requerido>
                    <input id="reg-razon" value={razon} onChange={e => setRazon(e.target.value)} autoComplete="organization" maxLength={120} placeholder="Empresa, S.A. de C.V."/>
                  </Campo>
                  <Campo label="Nombre comercial">
                    <input id="reg-comercial" value={comercial} onChange={e => setComercial(e.target.value)} maxLength={120}/>
                  </Campo>
                  <div className="reg-fila">
                    <Campo label="NIT" requerido>
                      <input id="reg-nit" value={nit} onChange={e => setNit(digitos(e.target.value).slice(0, 14))} inputMode="numeric" placeholder="14 dígitos"/>
                    </Campo>
                    <Campo label="NRC">
                      <input id="reg-nrc" value={nrc} onChange={e => setNrc(digitos(e.target.value).slice(0, 8))} inputMode="numeric"/>
                    </Campo>
                  </div>
                </>)}
                <div className="reg-fila">
                  <Campo label="Teléfono" requerido>
                    <input id="reg-telefono" value={telefono} onChange={e => setTelefono(formatoTelefono(e.target.value))} inputMode="tel" autoComplete="tel" placeholder="7777-8888"/>
                  </Campo>
                  <Campo label="Correo" ayuda={tipo === 'company' ? 'Donde reciben las facturas.' : 'Para tu factura electrónica.'}>
                    <input id="reg-correo" type="email" value={correo} onChange={e => setCorreo(e.target.value)} autoComplete="email" inputMode="email" maxLength={100}/>
                  </Campo>
                </div>
              </section>

              {/* 3. Vehículos */}
              <section className="reg-seccion">
                <div className="reg-paso"><span>3</span>{vehiculos.length > 1 ? 'Tus vehículos' : 'Tu vehículo'}</div>
                {vehiculos.map((v, i) => (
                  <div key={i} className="reg-vehiculo">
                    <div className="reg-vehiculo-top">
                      <Campo label="Placa" requerido>
                        <input id={`reg-placa-${i}`} className="reg-input-placa" value={v.placa}
                               onChange={e => cambiarVehiculo(i, 'placa', e.target.value.toUpperCase().slice(0, 12))}
                               autoCapitalize="characters" placeholder="P123-456"/>
                      </Campo>
                      {vehiculos.length > 1 && (
                        <button type="button" className="reg-quitar" aria-label={`Quitar vehículo ${i + 1}`}
                                onClick={() => setVehiculos(vs => vs.filter((_, j) => j !== i))}>×</button>
                      )}
                    </div>
                    <div className="reg-tamanos" role="radiogroup" aria-label="Tamaño">
                      {TAMANOS.map(t => (
                        <button key={t.id} type="button" role="radio" aria-checked={v.tamano === t.id}
                                className={`reg-tamano${v.tamano === t.id ? ' sel' : ''}`}
                                onClick={() => cambiarVehiculo(i, 'tamano', t.id)}>
                          <strong>{t.nombre}</strong>
                          <small>{t.ejemplo}</small>
                        </button>
                      ))}
                    </div>
                    <div className="reg-fila reg-fila-3">
                      <Campo label="Marca"><input value={v.marca} onChange={e => cambiarVehiculo(i, 'marca', e.target.value)} maxLength={40} placeholder="Toyota"/></Campo>
                      <Campo label="Modelo"><input value={v.modelo} onChange={e => cambiarVehiculo(i, 'modelo', e.target.value)} maxLength={40} placeholder="RAV4"/></Campo>
                      <Campo label="Color"><input value={v.color} onChange={e => cambiarVehiculo(i, 'color', e.target.value)} maxLength={30} placeholder="Blanco"/></Campo>
                    </div>
                  </div>
                ))}
                {vehiculos.length < 10 && (
                  <button type="button" id="reg-agregar-vehiculo" className="reg-agregar"
                          onClick={() => setVehiculos(vs => [...vs, vacio()])}>
                    + Agregar otro vehículo
                  </button>
                )}
              </section>

              {/* Trampa para bots: fuera de la vista y del teclado. */}
              <input className="reg-trampa" tabIndex={-1} autoComplete="off" aria-hidden="true"
                     value={web} onChange={e => setWeb(e.target.value)} name="website"/>

              <label className="reg-acepta">
                <input type="checkbox" checked={acepta} onChange={e => setAcepta(e.target.checked)}/>
                <span>Acepto que CORSA Carwash guarde estos datos para atenderme, facturarme y avisarme de mis servicios.</span>
              </label>

              {error && <div className="reg-error" role="alert">{error}</div>}

              <button type="submit" id="reg-enviar" className="reg-enviar" disabled={!!falta || enviando}>
                {enviando ? 'Registrando…' : falta ?? 'Registrarme'}
              </button>
            </>)}
          </form>
        )}
      </main>

      <footer className="reg-footer">CORSA Carwash · Tus datos se usan sólo para atenderte.</footer>
    </div>
  )
}

function Campo({ label, requerido, ayuda, children }: {
  label: string
  requerido?: boolean
  ayuda?: string
  children: React.ReactNode
}) {
  return (
    <label className="reg-campo">
      <span className="reg-label">{label}{requerido && <em> *</em>}</span>
      {children}
      {ayuda && <span className="reg-ayuda">{ayuda}</span>}
    </label>
  )
}
