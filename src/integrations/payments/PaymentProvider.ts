/**
 * CORSA Carwash — Payment Provider Interface
 *
 * Abstraction for card payment terminals and gateways.
 *
 * STATUS: NOT IMPLEMENTED — placeholder only.
 *
 * SECURITY REQUIREMENTS when implementing:
 * - NEVER store full card numbers (PCI compliance)
 * - Only store: authorization_code, last 4 digits max, card brand
 * - Integration must happen server-side (Edge Function), never frontend
 * - Use tokenization from the payment provider
 * - Implement idempotency keys to prevent double charging
 */

export interface PaymentRequest {
  amount: number
  currency: string
  idempotencyKey: string
  description?: string
}

export interface PaymentResult {
  approved: boolean
  authorizationCode?: string
  externalReference?: string
  errorCode?: string
  errorMessage?: string
}

export interface PaymentProvider {
  charge(request: PaymentRequest): Promise<PaymentResult>
  void(externalReference: string): Promise<PaymentResult>
  refund(externalReference: string, amount: number): Promise<PaymentResult>
}

export class UnimplementedPaymentProvider implements PaymentProvider {
  charge(): Promise<PaymentResult> {
    throw new Error('PaymentProvider not implemented. Configure a payment terminal/gateway.')
  }
  void(): Promise<PaymentResult> {
    throw new Error('PaymentProvider not implemented.')
  }
  refund(): Promise<PaymentResult> {
    throw new Error('PaymentProvider not implemented.')
  }
}
