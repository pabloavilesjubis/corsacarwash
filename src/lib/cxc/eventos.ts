/** Cómo se llama, en pantalla y en el estado de cuenta, cada evento del crédito (0045, 0060). Sin dependencias: lo usa también el servidor. */
export const EVENTO_ETIQUETA: Record<string, string> = {
  CREDIT_ENABLED: 'Crédito habilitado',
  CREDIT_DISABLED: 'Crédito deshabilitado',
  LIMIT_CHANGED: 'Cambio de límite',
  CHARGE: 'Venta al crédito',
  CHARGE_OVERRIDE: 'Venta al crédito (sobre el límite)',
  PAYMENT: 'Abono',
  BLOCKED: 'Cuenta bloqueada',
  UNBLOCKED: 'Cuenta desbloqueada',
  CHARGE_VOID: 'Venta al crédito anulada',
  CONSOLIDATED_ON: 'Facturación consolidada activada',
  CONSOLIDATED_OFF: 'Facturación consolidada desactivada',
  CONSOLIDATED_CCF: 'CCF consolidado',
}
