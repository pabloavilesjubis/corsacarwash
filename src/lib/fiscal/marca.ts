/**
 * La marca, sin datos fiscales. Aparte de emisor.ts porque ese módulo carga el
 * cliente de Supabase del navegador, y el cupón también se arma en el
 * servidor de correo (Cuponera Digital, 0083).
 */
import type { TicketEmisor } from '../ticket/corsaTicket'

export const MARCA: TicketEmisor = { nombreComercial: 'CORSA CARWASH' }
