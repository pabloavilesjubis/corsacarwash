/**
 * CORSA Carwash — Fiscal Provider Interface
 *
 * DTE (Documentos Tributarios Electrónicos) integration for El Salvador Hacienda.
 *
 * STATUS: NOT IMPLEMENTED — architecture placeholder only.
 *
 * This interface defines the contract for any future DTE provider.
 * Implementation requires official Hacienda API documentation,
 * which has not been provided yet.
 *
 * When implementing:
 * 1. Create a concrete class (e.g., HaciendaDTEProvider)
 * 2. Implement all methods below
 * 3. Store API credentials in Supabase Edge Function secrets (never in frontend)
 * 4. The Edge Function will call this provider
 * 5. Results stored in fiscal_documents table
 *
 * Document types for El Salvador:
 * - Factura de Consumidor Final (FCF)
 * - Crédito Fiscal (CCF)
 * - Nota de Crédito (NC)
 * - Nota de Débito (ND)
 *
 * TODO(security): When implementing DTE:
 * - Use Supabase Edge Function secrets for API keys
 * - Implement idempotency to prevent duplicate DTE submissions
 * - Add webhook signature verification for Hacienda callbacks
 * - Never store full private keys in database
 */

export interface FiscalDocumentPayload {
  invoiceId: string
  documentType: 'consumidor_final' | 'credito_fiscal' | 'nota_credito' | 'nota_debito'
  // Additional fields to be defined from official Hacienda API spec
  [key: string]: unknown
}

export interface FiscalDocumentResult {
  accepted: boolean
  documentNumber?: string
  acceptedAt?: string
  errorCode?: string
  errorMessage?: string
  rawResponse?: unknown
}

export interface FiscalProvider {
  /**
   * Submit a fiscal document to the DTE provider.
   * Must be idempotent — safe to call multiple times for the same invoice.
   */
  submitDocument(payload: FiscalDocumentPayload): Promise<FiscalDocumentResult>

  /**
   * Check the status of a previously submitted document.
   */
  checkStatus(documentId: string): Promise<FiscalDocumentResult>

  /**
   * Cancel/void a previously issued document.
   */
  cancelDocument(documentId: string, reason: string): Promise<FiscalDocumentResult>
}

/**
 * Placeholder implementation that throws if called accidentally.
 * Replace with real implementation when DTE spec is available.
 */
export class UnimplementedFiscalProvider implements FiscalProvider {
  submitDocument(): Promise<FiscalDocumentResult> {
    throw new Error('FiscalProvider not implemented. Waiting for Hacienda DTE API specification.')
  }
  checkStatus(): Promise<FiscalDocumentResult> {
    throw new Error('FiscalProvider not implemented.')
  }
  cancelDocument(): Promise<FiscalDocumentResult> {
    throw new Error('FiscalProvider not implemented.')
  }
}
