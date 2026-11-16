import type { CardIssuerPort } from "../../domain/interfaces/CardIssuing.js";
import { CardProviderApiError, isDefiniteRefusal, providerMessage } from "../../domain/errors/CardProviderErrors.js";

export type OneTimeIssue =
  | { kind: "issued"; cardId: string; last4?: string; detailsCaptured: boolean }
  /** The issuer said no: no card exists. */
  | { kind: "refused"; why: string }
  /** Timeout or lost answer: the card may exist and hold the money. Never guess. */
  | { kind: "lost"; why: string };

/** Issues a one-time card and classifies the answer. Used by the swap charger (with capture) and the simulator path (without). */
export async function issueOneTimeCard(
  issuer: Pick<CardIssuerPort, "issueOneTime">,
  cardholder: { customerId: string; kycToken: string }, amountCents: number, ref: string, capture: boolean,
): Promise<OneTimeIssue> {
  try {
    const out = await issuer.issueOneTime(cardholder, amountCents, ref, { capture });
    return { kind: "issued", cardId: out.cardId, detailsCaptured: out.detailsCaptured, ...(out.lastFour ? { last4: out.lastFour } : {}) };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (isDefiniteRefusal(e)) return { kind: "refused", why: e instanceof CardProviderApiError ? providerMessage(e) : text };
    return { kind: "lost", why: text };
  }
}

/** Agent-facing wording for each way an issue can stop a payment (unchanged from the in-line version). */
export const oneTimeIssueRefusal = {
  refused: (why: string) => `could not make a one-time card (${why}); nothing was charged`,
  lost: "the one-time card could not be confirmed; nothing was charged and the attempt is flagged for review",
  noDetails: "the one-time card was made but its details were unavailable; nothing was charged and the card is flagged for review",
};
