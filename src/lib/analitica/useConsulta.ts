/**
 * Una consulta que se repite cuando cambia su clave. El «cargando» se deriva
 * (la respuesta guardada es de otra clave) en vez de ponerse con setState al
 * empezar: así no hay un render con datos viejos marcados como nuevos, y una
 * respuesta tardía de un filtro anterior no pisa la del actual.
 */
import { useEffect, useRef, useState } from 'react'

export interface Consulta<T> {
  datos: T | null
  cargando: boolean
  error: string | null
  reintentar: () => void
}

export function useConsulta<T>(clave: string, cargar: () => Promise<T>): Consulta<T> {
  const [intento, setIntento] = useState(0)
  const [r, setR] = useState<{ k: string; datos: T | null; error: string | null } | null>(null)
  const cargarRef = useRef(cargar)
  useEffect(() => { cargarRef.current = cargar })
  const k = `${clave}#${intento}`

  useEffect(() => {
    let vivo = true
    cargarRef.current()
      .then(d => { if (vivo) setR({ k, datos: d, error: null }) })
      .catch(e => { if (vivo) setR({ k, datos: null, error: (e as { message?: string })?.message ?? 'No se pudo cargar' }) })
    return () => { vivo = false }
  }, [k])

  const vigente = r?.k === k
  return {
    datos: vigente ? r!.datos : null,
    cargando: !vigente,
    error: vigente ? r!.error : null,
    reintentar: () => setIntento(i => i + 1),
  }
}
