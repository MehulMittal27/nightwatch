/**
 * Which posted approval card belongs to which (event, site).
 *
 * A revocation is triggered by a notice revision landing, not by a click on
 * the card itself — so by the time it fires, the original message's
 * interaction closure is long gone. This is how `void_approval_card` finds
 * the message to edit.
 *
 * In-memory and local to this process. Lost on restart — fine for a demo;
 * once P2's real approval store exists, this mapping (or an equivalent)
 * belongs there instead, keyed the same way the store keys approvals.
 */
import type { MessageRef } from "@copilotkit/channels";

const registry = new Map<string, MessageRef>();

function key(eventId: string, siteId: string): string {
  return `${eventId}:${siteId}`;
}

export function rememberApprovalMessage(eventId: string, siteId: string, ref: MessageRef): void {
  registry.set(key(eventId, siteId), ref);
}

export function getApprovalMessage(eventId: string, siteId: string): MessageRef | undefined {
  return registry.get(key(eventId, siteId));
}

export function forgetApprovalMessage(eventId: string, siteId: string): void {
  registry.delete(key(eventId, siteId));
}
