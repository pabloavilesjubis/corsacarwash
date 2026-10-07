/** Los tres lavados de CORSA y el mix premium (ÉLITE + SIGNATURE). */
import type { CodigoLavado, MetricasPeriodo } from '../../services/analitica.service'
import { dividir } from './variacion'

export const SERVICIOS: { code: CodigoLavado; label: string; color: string }[] = [
  { code: 'PRO', label: 'PRO', color: 'var(--text-secondary)' },
  { code: 'ELITE', label: 'ÉLITE', color: 'var(--corsa-orange)' },
  { code: 'SIGNATURE', label: 'SIGNATURE', color: 'var(--corsa-green)' },
]

export function premiumDe(m: MetricasPeriodo): number | null {
  return dividir((m.mix.ELITE?.lavados ?? 0) + (m.mix.SIGNATURE?.lavados ?? 0), m.lavados)
}
