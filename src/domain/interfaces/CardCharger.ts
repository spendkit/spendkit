import type { FillOutcome, FillWatcher } from "../../adapters/checkoutFillers/CheckoutFiller.js";

/**
 * The cardholder-data boundary (docs/card-service-split.md). A CardCharger issues the one-time card for a checkout,
 * opens its details, fills the page, forgets the details, and answers with a card-free result. Nothing on the caller's
 * side of this interface ever holds a PAN, a CVV, or a key that opens one.
 *
 * Today the only implementation is LocalCardCharger (in process). card-service will run the same code behind
 * POST /v1/charges, and the main app will call it through a RemoteCardCharger with the same shape.
 */
export interface CardCharger {
  charge(req: ChargeRequest, hooks?: ChargeHooks): Promise<ChargeResult>;
}

export interface ChargeRequest {
  swapId: string;
  spendId: string;
  checkoutUrl: string;
  expectedAmountCents: number;
  receiptEmail: string;
  card: ChargeCard;
}

/** Which card pays. The caller has already run the one-time card policy (minimum, daily cap, KYC). */
export type ChargeCard =
  /** Sandbox only: Stripe's public 4242 test card. No card is issued and no vault is opened. */
  | { kind: "test" }
  /** Issue a one-time card for exactly this amount under `ref` (idempotent at the issuer), then pay with it. */
  | { kind: "issue"; ref: string; cardholder: { customerId: string; kycToken: string } }
  /** A one-time card already issued for this spend (a repeat of an earlier attempt). */
  | { kind: "existing"; cardId: string };

/** In-process conveniences. A remote charger cannot call back; the caller learns the same facts from the result. */
export interface ChargeHooks {
  /** The one-time card exists, before any page is touched (lets reconcile find the card if the process dies mid-fill). */
  cardIssued?(card: { id: string; last4?: string }): Promise<void>;
  /** Live view. Honoured only for { kind: "test" }: with a real card nothing from the page is captured. */
  watch?: FillWatcher;
}

/** Card-free answer. `detail` is short and never holds card data. */
export interface ChargeResult {
  /** What the page did. "error" with submitted:false also covers stopping before the page (no card, no details). */
  fill: { outcome: FillOutcome; submitted: boolean; detail: string | null };
  card: ChargeCardResult;
  /**
   * Set when the charge stopped before the page was filled: why, written for the agent ("...; nothing was charged").
   * The caller voids the debit.
   */
  refusal?: string;
}

export type ChargeCardResult =
  /** Stripe's test card was used. */
  | { state: "test" }
  /** No card was made (the issuer refused). */
  | { state: "none"; detail: string }
  /** The issue answer was lost: a card may exist and hold the money. A person decides. */
  | { state: "unknown"; detail: string }
  /** The card exists but its details could not be opened, so it was not used. It holds the money until it terminates. */
  | { state: "unusable"; id: string; last4?: string; detail: string }
  /** The card exists and was handed to the page (or would have been, if the page stopped first). */
  | { state: "issued"; id: string; last4?: string };
