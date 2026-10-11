import type { VoiceDelivery, VoiceStoredResult } from '../types/voice'

/**
 * What the app shows for a send or new chat the server does itself (auto-send
 * or a tap in a chooser): a countdown with Cancel, then the outcome.
 */

/** The server has it in hand: counting down, going out, or gone. The composer stays empty. */
export function isDeliveryActive(delivery: VoiceDelivery | null | undefined): delivery is VoiceDelivery {
  return delivery?.state === 'pending' || delivery?.state === 'sending' || delivery?.state === 'sent'
}

/** Still waiting or going out, so the app keeps asking the server how it went. */
export function isDeliveryUnsettled(delivery: VoiceDelivery | null | undefined): boolean {
  return delivery?.state === 'pending' || delivery?.state === 'sending'
}

/** Every delivery a result carries: its own and its steps'. */
export function resultDeliveries(result: VoiceStoredResult | null | undefined): VoiceDelivery[] {
  if (!result) return []
  return [result.delivery, ...(result.steps ?? []).map((step) => step.delivery)].filter((value): value is VoiceDelivery => Boolean(value))
}

/** Whole seconds left, rounded up, so the count reads 5, 4, 3, 2, 1 and never 0 while waiting. */
export function secondsLeft(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
}

export type DeliveryTone = 'counting' | 'sending' | 'done' | 'problem' | 'cancelled'
export type DeliveryCopy = { title: string; detail: string; tone: DeliveryTone }

const quoted = (message: string) => (message ? `“${message}”` : '')

export function describeDelivery(delivery: VoiceDelivery, seconds: number): DeliveryCopy {
  const send = delivery.kind === 'send'
  const label = delivery.label
  switch (delivery.state) {
    case 'pending':
      return { title: send ? `Sending to ${label} in ${seconds}\u00a0s` : `Starting new ${label} chat in ${seconds}\u00a0s`, detail: quoted(delivery.message), tone: 'counting' }
    case 'sending':
      return { title: send ? `Sending to ${label}…` : `Starting new ${label} chat…`, detail: quoted(delivery.message), tone: 'sending' }
    case 'sent':
      return { title: send ? `Sent ✓ · ${label}` : `Started ✓ · new ${label} chat`, detail: quoted(delivery.message), tone: 'done' }
    case 'failed':
      return { title: send ? `Couldn't send to ${label}` : `Couldn't start the ${label} chat`, detail: 'The message is typed in. Check it and send it yourself.', tone: 'problem' }
    default:
      return { title: 'Cancelled · nothing was sent', detail: 'The message is typed in, ready to edit.', tone: 'cancelled' }
  }
}

/** A step row's pill on the Steps screen. */
export function deliveryPill(delivery: VoiceDelivery, seconds: number): { pill: string; pillTone: 'unread' | 'attention' | 'accent' } {
  switch (delivery.state) {
    case 'pending': return { pill: `In ${seconds}\u00a0s`, pillTone: 'accent' }
    case 'sending': return { pill: delivery.kind === 'send' ? 'Sending…' : 'Starting…', pillTone: 'accent' }
    case 'sent': return { pill: delivery.kind === 'send' ? 'Sent ✓' : 'Started ✓', pillTone: 'unread' }
    case 'failed': return { pill: "Didn't go", pillTone: 'attention' }
    default: return { pill: 'Cancelled', pillTone: 'unread' }
  }
}
