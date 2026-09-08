/**
 * CORSA Carwash — Messaging Provider Interface
 *
 * Abstraction for WhatsApp, Email, and SMS communications.
 *
 * STATUS: NOT IMPLEMENTED — architecture placeholder only.
 *
 * When implementing:
 * 1. Create concrete providers (WhatsAppProvider, EmailProvider, etc.)
 * 2. Store API keys in Supabase Edge Function secrets ONLY
 * 3. Edge Function calls provider and logs to communication_logs table
 * 4. Never expose provider credentials to frontend
 *
 * TODO(security): When implementing:
 * - Rate limit outbound messages per customer/per day
 * - Validate phone numbers before WhatsApp delivery
 * - Implement unsubscribe/opt-out respecting communication_preferences
 * - Never include sensitive data in message payloads
 */

export type MessageChannel = 'whatsapp' | 'email' | 'sms'

export interface MessagePayload {
  customerId: string
  channel: MessageChannel
  template: string
  variables: Record<string, string>  // safe interpolation, no raw HTML
  to: string  // phone or email
}

export interface MessageResult {
  sent: boolean
  externalId?: string
  error?: string
}

export interface MessagingProvider {
  send(payload: MessagePayload): Promise<MessageResult>
  getDeliveryStatus(externalId: string): Promise<'pending' | 'delivered' | 'failed'>
}

export class UnimplementedMessagingProvider implements MessagingProvider {
  send(): Promise<MessageResult> {
    throw new Error('MessagingProvider not implemented. Configure a WhatsApp/Email provider.')
  }
  getDeliveryStatus(): Promise<'pending' | 'delivered' | 'failed'> {
    throw new Error('MessagingProvider not implemented.')
  }
}
