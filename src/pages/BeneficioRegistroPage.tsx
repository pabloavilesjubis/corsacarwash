/**
 * CORSA Carwash — Registro de empleados con beneficio corporativo (0079)
 *
 * Página pública, sin sesión: la empresa aliada comparte el enlace
 * /beneficio?c=<código> con sus empleados. Cada uno se registra con su número
 * de carnet y sus carros, y queda activo de inmediato: al buscarlo en caja, la
 * caja cobra los precios del beneficio.
 *
 * Mismo formulario que el registro por QR (RegistroPage), para una persona.
 * Todo se vuelve a validar en public_benefit_signup.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { CorsaLogoCompleto } from '../components/ui/CorsaLogoCompleto'
import { Campo } from './RegistroPage'
import {
  TAMANOS, digitos, formatoDui, formatoPais, formatoTelefono, telefonoValido, vacio, type Vehiculo,
} from '../lib/registro/formato'

export function BeneficioRegistroPage() {
  const [params] = useSearchParams()
  const codigo = (params.get('c') ?? '').trim().toUpperCase()

  // undefined = consultando; null = el código no existe o está apagado.
  const [empresa, setEmpresa] = useState<string | null | undefined>(codigo ? undefined : null)

  const [nombre, setNombre] = useState('')
  const [apellido, setApellido] = useState('')
  const [carnet, setCarnet] = useState('')
  const [dui, setDui] = useState('')
  const [telefono, setTelefono] = useState('')
  const [pais, setPais] = useState('+503')
  const [correo, setCorreo] = useState('')
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([vacio()])
  const [acepta, setAcepta] = useState(false)
  // Trampa para bots: un campo que una persona no ve ni llena.
  const [web, setWeb] = useState('')

  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listo, setListo] = useState<{ existente: boolean; yaInscrito: boolean; vehiculos: string[]; omitidos: string[] } | null>(null)

  useEffect(() => {
    if (!codigo) return
    let vivo = true
    ;(supabase as any).rpc('public_benefit_info', { p_code: codigo }).then(({ data, error }: any) => {
      if (vivo) setEmpresa(error ? null : (data?.nombre ?? null))
    })
    return () => { vivo = false }
  }, [codigo])

  const cambiarVehiculo = (i: number, campo: keyof Vehiculo, valor: string) =>
    setVehiculos(vs => vs.map((v, j) => (j === i ? { ...v, [campo]: valor } : v)))

  const falta = useMemo((): string | null => {
    if (!nombre.trim() || !apellido.trim()) return 'Falta tu nombre y apellido'
    if (!carnet.replace(/[^A-Za-z0-9]/g, '')) return 'Falta tu número de carnet'
    if (dui && digitos(dui).length !== 9) return 'Revisá el DUI (9 dígitos)'
    if (!telefonoValido(telefono, pais)) return digitos(pais) === '503' ? 'Falta tu teléfono (8 dígitos)' : 'Revisá el teléfono'
    if (correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo.trim())) return 'Revisá el correo'
    for (const v of vehiculos) {
      if (v.placa.replace(/[^A-Za-z0-9]/g, '').length < 3) return 'Falta la placa de un vehículo'
      if (!v.tamano) return `Elegí el tamaño de ${v.placa.toUpperCase() || 'tu vehículo'}`
    }
    if (!acepta) return 'Aceptá el uso de tus datos'
    return null
  }, [nombre, apellido, carnet, dui, telefono, pais, correo, vehiculos, acepta])

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (falta || enviando) return
    if (web) { setListo({ existente: false, yaInscrito: false, vehiculos: [], omitidos: [] }); return }
    setEnviando(true); setError(null)
    const { data, error } = await (supabase as any).rpc('public_benefit_signup', {
      p_code: codigo,
      p_datos: {
        nombre, apellido, carnet, dui, telefono, codigo_pais: pais, correo, acepta,
        vehiculos: vehiculos.map(v => ({ placa: v.placa, marca: v.marca, modelo: v.modelo, color: v.color, tamano: v.tamano })),
      },
    })
    setEnviando(false)
    if (error) { setError(error.message || 'No se pudo completar el registro. Intentá de nuevo.'); return }
    setListo({
      existente: !!data?.existente, yaInscrito: !!data?.ya_inscrito,
      vehiculos: data?.vehiculos ?? [], omitidos: data?.omitidos ?? [],
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="reg-page">
      <header className="reg-hero">
        <div className="reg-logo"><CorsaLogoCompleto width={150}/></div>
        {!listo && empresa && (<>
          <h1 className="reg-title">Beneficio {empresa}</h1>
          <p className="reg-sub">
            Como empleado de {empresa} tenés tarifa especial en CORSA. Registrate con tu carnet y
            en caja te cobramos el precio del beneficio.
          </p>
        </>)}
      </header>

      <main className="reg-card">
        {empresa === undefined ? (
          <div className="reg-aviso"><div className="spinner" style={{ margin: '0 auto' }}/></div>
        ) : empresa === null ? (
          <div className="reg-aviso">Este enlace de beneficio no es válido o ya no está vigente. Pedile el enlace correcto a tu empresa.</div>
        ) : listo ? (
          <div className="reg-listo">
            <div className="reg-check" aria-hidden="true">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            {listo.yaInscrito ? (<>
              <h2>Ya tenés un beneficio activo</h2>
              <p>Tu registro en CORSA ya tiene un beneficio corporativo. Si cambiaste de empresa, decíselo al cajero.</p>
            </>) : listo.existente ? (<>
              <h2>¡Listo, {nombre.trim()}!</h2>
              <p>Ya eras cliente de CORSA: activamos el beneficio de {empresa} en tu registro. Si tenés un carro nuevo, decíselo al cajero.</p>
            </>) : (<>
              <h2>¡Listo, {nombre.trim()}!</h2>
              <p>Tu beneficio de {empresa} está activo. En caja te encontramos por tu nombre o tu placa.</p>
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
            {/* 1. Datos */}
            <section className="reg-seccion">
              <div className="reg-paso"><span>1</span>Tus datos</div>
              <div className="reg-fila">
                <Campo label="Nombre" requerido>
                  <input id="ben-nombre" value={nombre} onChange={e => setNombre(e.target.value)} autoComplete="given-name" maxLength={60}/>
                </Campo>
                <Campo label="Apellido" requerido>
                  <input id="ben-apellido" value={apellido} onChange={e => setApellido(e.target.value)} autoComplete="family-name" maxLength={60}/>
                </Campo>
              </div>
              <div className="reg-fila">
                <Campo label={`Número de carnet de ${empresa}`} requerido ayuda="El que aparece en tu carnet de empleado.">
                  <input id="ben-carnet" value={carnet} onChange={e => setCarnet(e.target.value.toUpperCase().slice(0, 30))}
                         autoCapitalize="characters" autoComplete="off"/>
                </Campo>
                <Campo label="DUI (opcional)" ayuda="Si ya sos cliente de CORSA, con tu DUI te encontramos.">
                  <input id="ben-dui" value={dui} onChange={e => setDui(formatoDui(e.target.value))} inputMode="numeric" placeholder="00000000-0"/>
                </Campo>
              </div>
              <div className="reg-fila">
                <Campo label="Teléfono" requerido>
                  <div className="reg-telefono">
                    <input id="ben-pais" className="reg-pais" value={pais} aria-label="Código de país"
                           onChange={e => { const p = formatoPais(e.target.value); setPais(p); setTelefono(t => formatoTelefono(t, p)) }}
                           inputMode="tel" autoComplete="tel-country-code"/>
                    <input id="ben-telefono" value={telefono} onChange={e => setTelefono(formatoTelefono(e.target.value, pais))}
                           inputMode="tel" autoComplete="tel-national" placeholder={digitos(pais) === '503' ? '7777-8888' : 'Número'}/>
                  </div>
                </Campo>
                <Campo label="Correo" ayuda="Para tu factura electrónica.">
                  <input id="ben-correo" type="email" value={correo} onChange={e => setCorreo(e.target.value)} autoComplete="email" inputMode="email" maxLength={100}/>
                </Campo>
              </div>
            </section>

            {/* 2. Vehículos */}
            <section className="reg-seccion">
              <div className="reg-paso"><span>2</span>{vehiculos.length > 1 ? 'Tus vehículos' : 'Tu vehículo'}</div>
              {vehiculos.map((v, i) => (
                <div key={i} className="reg-vehiculo">
                  <div className="reg-vehiculo-top">
                    <Campo label="Placa" requerido>
                      <input id={`ben-placa-${i}`} className="reg-input-placa" value={v.placa}
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
                <button type="button" className="reg-agregar" onClick={() => setVehiculos(vs => [...vs, vacio()])}>
                  + Agregar otro vehículo
                </button>
              )}
            </section>

            <input className="reg-trampa" tabIndex={-1} autoComplete="off" aria-hidden="true"
                   value={web} onChange={e => setWeb(e.target.value)} name="website"/>

            <label className="reg-acepta">
              <input type="checkbox" checked={acepta} onChange={e => setAcepta(e.target.checked)}/>
              <span>
                Acepto que CORSA Carwash guarde estos datos para atenderme y facturarme, y que informe a {empresa} cuántas
                veces uso el beneficio, con mi nombre y mi carnet.
              </span>
            </label>

            {error && <div className="reg-error" role="alert">{error}</div>}

            <button type="submit" id="ben-enviar" className="reg-enviar" disabled={!!falta || enviando}>
              {enviando ? 'Registrando…' : falta ?? 'Activar mi beneficio'}
            </button>
          </form>
        )}
      </main>

      <footer className="reg-footer">CORSA Carwash · Tus datos se usan sólo para atenderte y para el informe del beneficio a tu empresa.</footer>
    </div>
  )
}
