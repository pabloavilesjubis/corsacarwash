/**
 * CORSA Carwash — Inteligencia de negocio.
 *
 * Tablero gerencial: tendencias, crecimiento y mix sobre un período, siempre
 * contra el período anterior equivalente. NO repite el Resumen del día (lo
 * operativo de hoy: máquinas en vivo, mapas de calor, servicios de hoy).
 *
 * Todo número sale agregado de la base (bi_resumen, bi_serie, bi_proyeccion,
 * 0075). Cada bloque carga por separado y tiene su propio estado de carga,
 * vacío y error: un bloque que falla no deja la pantalla en blanco.
 *
 * Definiciones (las mismas de la base):
 *   lavado = un carro lavado (una factura puede llevar varios);
 *   ventas = servicios + venta de cupones + adicionales, sin anuladas;
 *   ticket promedio = ventas de órdenes de servicio ÷ órdenes de servicio.
 */
import { useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { hoyLocal, formatearFecha } from '../utils/fecha'
import {
  calcularPeriodo, ETIQUETA_GRANULARIDAD, etiquetaRango, granularidadesPara, granularidadPorDefecto, PRESETS,
  type Granularidad, type Preset, type Rango,
} from '../lib/analitica/periodos'
import {
  dinero, dividir, entero, porcentaje, textoVariacion, variacion, variacionEnPuntos,
} from '../lib/analitica/variacion'
import {
  fetchClientesBi, fetchCuadre, fetchDemanda, fetchMaquinasBi, fetchPromociones, fetchProyeccion, fetchResumen, fetchSerie,
} from '../services/analitica.service'
import { generarInsights } from '../lib/analitica/insights'
import { nombreMaquina } from '../services/plc.service'
import { useConsulta } from '../lib/analitica/useConsulta'
import { premiumDe } from '../lib/analitica/mix'
import { Bloque, ErrorBloque, Esqueleto, Vacio } from '../components/analitica/Bloque'
import { KpiGerencial } from '../components/analitica/KpiGerencial'
import { GraficaTendencia } from '../components/analitica/GraficaTendencia'
import { MixServicios } from '../components/analitica/MixServicios'
import { ProyeccionCierre } from '../components/analitica/ProyeccionCierre'
import { RendimientoMaquinas } from '../components/analitica/RendimientoMaquinas'
import { CuadrePeriodo } from '../components/analitica/CuadrePeriodo'
import { ClientesRecurrencia } from '../components/analitica/ClientesRecurrencia'
import { PromocionesBloque } from '../components/analitica/PromocionesBloque'
import { Oportunidades } from '../components/analitica/Oportunidades'

export function AnalyticsPage() {
  const { profile, hasPermission } = useAuth()
  const orgId = (profile as any)?.organization_id ?? ''
  const hoy = hoyLocal()

  const [preset, setPreset] = useState<Preset>('30d')
  const [custom, setCustom] = useState<Rango>({ desde: hoy, hasta: hoy })
  const periodo = useMemo(() => calcularPeriodo(preset, custom, hoy), [preset, custom, hoy])
  const opcionesG = granularidadesPara(periodo.actual)
  const [gElegida, setGElegida] = useState<Granularidad | null>(null)
  const granularidad = gElegida && opcionesG.includes(gElegida) ? gElegida : granularidadPorDefecto(periodo.actual)

  const claveRango = `${periodo.actual.desde}|${periodo.actual.hasta}|${periodo.anterior.desde}|${periodo.anterior.hasta}`
  const resumen = useConsulta(claveRango, () => fetchResumen(periodo.actual, periodo.anterior))
  const serie = useConsulta(`${claveRango}|${granularidad}`, async () => {
    const [actual, anterior] = await Promise.all([fetchSerie(periodo.actual, granularidad), fetchSerie(periodo.anterior, granularidad)])
    return { actual, anterior }
  })
  const proy = useConsulta('proyeccion', fetchProyeccion)
  const maq = useConsulta(claveRango, () => fetchMaquinasBi(periodo.actual, periodo.anterior))
  const cuadre = useConsulta(`${periodo.actual.desde}|${periodo.actual.hasta}`, () => fetchCuadre(periodo.actual))
  const cli = useConsulta(claveRango, () => fetchClientesBi(periodo.actual, periodo.anterior))
  const claveActual = `${periodo.actual.desde}|${periodo.actual.hasta}`
  const promos = useConsulta(claveActual, () => fetchPromociones(periodo.actual))
  const demanda = useConsulta(claveActual, () => fetchDemanda(periodo.actual))
  // Filtro de máquina: sólo afecta la sección de máquinas.
  const [maquina, setMaquina] = useState<string | null>(null)
  const cargarResumen = resumen.reintentar
  const cargarSerie = serie.reintentar
  const cargarProyeccion = proy.reintentar

  // ── Base de comparación ──
  // Antes de la primera venta registrada no hay «período anterior»: el POS no
  // existía. Comparar contra eso inventaría crecimiento.
  const r = resumen.datos
  const primera = r?.primera_venta ?? null
  const sinBase = !r ? null
    : !primera ? 'Sin ventas registradas'
    : periodo.anterior.hasta < primera ? `Sin datos del período anterior (el sistema registra ventas desde el ${formatearFecha(primera + 'T12:00:00')})`
    : null
  const anteriorParcial = !!primera && !sinBase && periodo.anterior.desde < primera
  const a = r?.actual, b = r?.anterior

  const vVentas = a && b ? variacion(a.ventas, b.ventas, 'mas_es_mejor', sinBase) : null
  const vLavados = a && b ? variacion(a.lavados, b.lavados, 'mas_es_mejor', sinBase) : null
  const ingresoLavado = a ? dividir(a.ventas, a.lavados) : null
  const vIngreso = a && b ? variacion(ingresoLavado, dividir(b.ventas, b.lavados), 'mas_es_mejor', sinBase) : null
  const ticket = a ? dividir(a.ventas_servicio, a.ordenes_servicio) : null
  const vTicket = a && b ? variacion(ticket, dividir(b.ventas_servicio, b.ordenes_servicio), 'mas_es_mejor', sinBase) : null
  const premium = a ? premiumDe(a) : null
  const vPremium = a && b ? variacionEnPuntos(premium, premiumDe(b), 'mas_es_mejor', sinBase ?? (premiumDe(b) == null ? 'Sin lavados en el período anterior' : null)) : null
  const p = proy.datos
  const metaPct = p?.meta_ventas ? dividir(p.ventas_acumuladas, p.meta_ventas) : null

  const sinMovimiento = a && a.ventas === 0 && a.lavados === 0

  // Las máquinas tienen su propia historia: el PLC registra desde antes que el POS.
  const primerCiclo = maq.datos?.actual.primer_ciclo ?? null
  const sinBaseMaq = !maq.datos ? null
    : !primerCiclo ? 'Sin lavados de máquina registrados'
    : periodo.anterior.hasta < primerCiclo ? 'Sin datos de máquinas del período anterior'
    : null

  // ── Oportunidades: reglas sobre lo ya cargado (lib/analitica/insights) ──
  const insights = generarInsights({
    actual: a, anterior: b,
    // Contra un período anterior incompleto (antes de la primera venta) no se
    // sacan conclusiones de crecimiento.
    comparable: !!r && !sinBase && !anteriorParcial,
    maquinas: maq.datos?.actual ?? null,
    demanda: demanda.datos,
    cuadre: cuadre.datos,
    primeraVenta: primera,
    proyeccion: p,
    esMesEnCurso: periodo.esMesEnCurso,
    clientes: cli.datos?.actual ?? null,
  })
  const insightsIncompletos = resumen.cargando || maq.cargando || demanda.cargando || cuadre.cargando || cli.cargando

  return (
    <div className="page-inner" style={{ gap: 18 }}>
      <div className="page-header">
        <div className="page-header-left">
          <h1>Inteligencia de negocio</h1>
          <div className="page-header-sub">
            {etiquetaRango(periodo.actual)} · comparado con {etiquetaRango(periodo.anterior)}
          </div>
        </div>
      </div>

      {/* ── Filtro global ── */}
      <div className="bi-filtros">
        <div className="filter-pills">
          {PRESETS.map(x => (
            <button key={x.id} id={`bi-periodo-${x.id}`} className={`filter-pill${preset === x.id ? ' active' : ''}`} onClick={() => setPreset(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="date" className="corsa-input" aria-label="Desde" value={custom.desde} max={custom.hasta}
                   onChange={e => e.target.value && setCustom(c => ({ ...c, desde: e.target.value }))}/>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>a</span>
            <input type="date" className="corsa-input" aria-label="Hasta" value={custom.hasta} min={custom.desde} max={hoy}
                   onChange={e => e.target.value && setCustom(c => ({ ...c, hasta: e.target.value }))}/>
          </div>
        )}
      </div>

      {anteriorParcial && (
        <div className="alert-banner warning"><div className="alert-body"><div className="alert-desc">
          El período anterior empieza antes de la primera venta registrada en el sistema ({formatearFecha(primera! + 'T12:00:00')}): las comparaciones son parciales.
        </div></div></div>
      )}

      {/* ── 1. Resumen ejecutivo ── */}
      {resumen.error ? (
        <ErrorBloque mensaje={`No se pudo cargar el resumen: ${resumen.error}`} onReintentar={cargarResumen}/>
      ) : (
        <div className="bi-kpis">
          <KpiGerencial id="bi-kpi-ventas" label="Ventas" cargando={resumen.cargando} valor={dinero(a?.ventas, (a?.ventas ?? 0) >= 1000 ? 0 : 2)} variacion={vVentas}
            sub={a ? `Facturado ${dinero(a.ventas_facturadas)}${a.ventas > a.ventas_facturadas ? ` · ${dinero(a.ventas - a.ventas_facturadas)} por facturar` : ''}` : null}/>
          <KpiGerencial id="bi-kpi-lavados" label="Lavados" cargando={resumen.cargando} valor={entero(a?.lavados)} variacion={vLavados}
            sub={a && a.lavados_sin_cobro > 0 ? `${a.lavados_sin_cobro} sin cobro (canjes)` : 'Un lavado = un carro'}/>
          <KpiGerencial id="bi-kpi-ingreso-lavado" label="Ingreso por lavado" cargando={resumen.cargando} valor={dinero(ingresoLavado)} variacion={vIngreso}
            sub="Ventas ÷ lavados"/>
          <KpiGerencial id="bi-kpi-ticket" label="Ticket promedio" cargando={resumen.cargando} valor={dinero(ticket)} variacion={vTicket}
            sub={a ? `${entero(a.ordenes_servicio)} órdenes de servicio` : null}/>
          <KpiGerencial id="bi-kpi-premium" label="Mix premium" cargando={resumen.cargando} valor={porcentaje(premium)} variacion={vPremium}
            sub="ÉLITE + SIGNATURE"/>
          <KpiGerencial id="bi-kpi-proyeccion" label="Proyección del mes" cargando={periodo.esMesEnCurso && proy.cargando}
            valor={periodo.esMesEnCurso && p ? dinero(p.proyeccion_ventas, 0) : '—'}
            sub={!periodo.esMesEnCurso ? 'Elegí «Este mes» para proyectar el cierre'
              : !p ? (proy.error ? 'No se pudo calcular' : null)
              : p.proyeccion_ventas == null ? 'Desde el primer día operativo completo'
              : metaPct != null ? `${porcentaje(metaPct, 0)} de la meta alcanzado` : 'Sin meta configurada'}/>
        </div>
      )}

      {/* ── 2. Evolución del negocio ── */}
      <Bloque id="bi-tendencia" titulo="Evolución del negocio"
        subtitulo={vVentas && vLavados && (vVentas.relativa != null || vLavados.relativa != null)
          ? `Lavados ${textoVariacion(vLavados)} · ventas ${textoVariacion(vVentas)} · ingreso por lavado ${vIngreso ? textoVariacion(vIngreso) : '—'}`
          : 'Facturación y lavados del período, con el período anterior detrás'}
        accion={opcionesG.length > 1 ? (
          <div className="filter-pills">
            {opcionesG.map(g => (
              <button key={g} className={`filter-pill${granularidad === g ? ' active' : ''}`} onClick={() => setGElegida(g)}>{ETIQUETA_GRANULARIDAD[g]}</button>
            ))}
          </div>
        ) : undefined}>
        {serie.error ? <ErrorBloque mensaje={`No se pudo cargar la tendencia: ${serie.error}`} onReintentar={cargarSerie}/>
          : serie.cargando || !serie.datos ? <Esqueleto alto={240}/>
          : serie.datos.actual.every(x => x.ventas === 0 && x.lavados === 0)
            ? <Vacio titulo="Sin ventas en este período" detalle={primera ? `El sistema registra ventas desde el ${formatearFecha(primera + 'T12:00:00')}.` : undefined}/>
            : <GraficaTendencia actual={serie.datos.actual} anterior={sinBase ? [] : serie.datos.anterior} granularidad={granularidad}/>}
      </Bloque>

      <div className="bi-dos-columnas">
        {/* ── 3. Mix de servicios ── */}
        <Bloque id="bi-mix" titulo="Mix de servicios" subtitulo="PRO · ÉLITE · SIGNATURE, en lavados (un carro = un lavado)">
          {resumen.error ? <ErrorBloque mensaje="No se pudo cargar el mix." onReintentar={cargarResumen}/>
            : resumen.cargando || !a || !b ? <Esqueleto filas={5}/>
            : a.lavados === 0 ? <Vacio titulo="Sin lavados en este período"/>
            : <MixServicios actual={a} anterior={b} sinBase={sinBase} serie={serie.datos?.actual ?? null} granularidad={granularidad}/>}
        </Bloque>

        {/* ── Proyección de cierre (sólo el mes en curso) ── */}
        <Bloque id="bi-proyeccion" titulo="Proyección de cierre"
          subtitulo={p ? `Mes en curso · ${etiquetaRango({ desde: p.mes, hasta: p.fin_de_mes })}` : 'Mes en curso'}>
          {proy.error ? <ErrorBloque mensaje={`No se pudo calcular la proyección: ${proy.error}`} onReintentar={cargarProyeccion}/>
            : proy.cargando || !p ? <Esqueleto filas={6}/>
            : <ProyeccionCierre p={p} orgId={orgId} puedeConfigurar={hasPermission('settings.manage')} onRecargar={cargarProyeccion}/>}
        </Bloque>
      </div>

      <div className="bi-dos-columnas">
        {/* ── 4. Rendimiento de máquinas ── */}
        <Bloque id="bi-maquinas" titulo="Rendimiento de máquinas" subtitulo="Lavados registrados por el PLC en el período"
          accion={maq.datos && maq.datos.actual.maquinas.length > 1 ? (
            <div className="filter-pills">
              <button className={`filter-pill${maquina === null ? ' active' : ''}`} onClick={() => setMaquina(null)}>Todas</button>
              {maq.datos.actual.maquinas.map(m => (
                <button key={m.machine_id} className={`filter-pill${maquina === m.machine_id ? ' active' : ''}`} onClick={() => setMaquina(m.machine_id)}>
                  {nombreMaquina(m.machine_id, m.nombre)}
                </button>
              ))}
            </div>
          ) : undefined}>
          {maq.error ? <ErrorBloque mensaje={`No se pudo cargar el rendimiento de las máquinas: ${maq.error}`} onReintentar={maq.reintentar}/>
            : maq.cargando || !maq.datos ? <Esqueleto filas={7}/>
            : maq.datos.actual.maquinas.length === 0 ? <Vacio titulo="Sin lavados de máquina en este período"/>
            : <RendimientoMaquinas actual={maq.datos.actual} anterior={maq.datos.anterior} maquina={maquina} sinBase={sinBaseMaq}/>}
        </Bloque>

        {/* ── Cuadre caja vs máquinas del período ── */}
        <Bloque id="bi-cuadre" titulo="Cuadre caja vs máquinas" subtitulo="Lavados cobrados contra lavados hechos, por servicio">
          {cuadre.error ? <ErrorBloque mensaje={`No se pudo cargar el cuadre: ${cuadre.error}`} onReintentar={cuadre.reintentar}/>
            : cuadre.cargando || !cuadre.datos || resumen.cargando ? <Esqueleto filas={5}/>
            : <CuadrePeriodo filas={cuadre.datos} desde={primera}/>}
        </Bloque>
      </div>

      {/* ── 5. Clientes y recurrencia ── */}
      <Bloque id="bi-clientes" titulo="Clientes y recurrencia" subtitulo="Sólo clientes identificados · visita = carro lavado">
        {cli.error ? <ErrorBloque mensaje={`No se pudieron cargar los clientes: ${cli.error}`} onReintentar={cli.reintentar}/>
          : cli.cargando || !cli.datos ? <Esqueleto filas={6}/>
          : cli.datos.actual.lavados === 0 ? <Vacio titulo="Sin lavados en este período"/>
          : cli.datos.actual.clientes_activos === 0 ? <Vacio titulo="Ningún lavado del período tiene cliente identificado" detalle="Las ventas a Consumidor Final no se pueden seguir como clientes."/>
          : <ClientesRecurrencia actual={cli.datos.actual} anterior={cli.datos.anterior} sinBase={sinBase}/>}
      </Bloque>

      {/* ── 6. Cupones y promociones ── */}
      <Bloque id="bi-promociones" titulo="Cupones y promociones" subtitulo="Cupones prepagados y seguro de lluvia del período">
        {promos.error ? <ErrorBloque mensaje={`No se pudieron cargar las promociones: ${promos.error}`} onReintentar={promos.reintentar}/>
          : promos.cargando || !promos.datos ? <Esqueleto filas={4}/>
          : <PromocionesBloque p={promos.datos}/>}
      </Bloque>

      {/* ── 7. Oportunidades ── */}
      <Bloque id="bi-oportunidades" titulo="Oportunidades" subtitulo="Lo que cambió lo suficiente como para mirarlo, según reglas sobre los datos del período">
        <Oportunidades insights={insights} incompleto={insightsIncompletos}/>
      </Bloque>

      {/* Rentabilidad: la tabla de costos existe (0077); sin costos cargados no se inventa margen. */}
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        <b>Rentabilidad</b>: el margen por servicio, por vehículo y total se activa cuando se carguen los costos
        (químicos, agua, electricidad, mano de obra variable, mantenimiento y costo por máquina). Hoy no se muestra para no inventarlo.
      </div>

      {sinMovimiento && !resumen.cargando && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          No hay ventas ni lavados en {etiquetaRango(periodo.actual)}.
        </div>
      )}
    </div>
  )
}
