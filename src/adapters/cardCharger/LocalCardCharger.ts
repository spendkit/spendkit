// The in-process CardCharger: everything that touches card data for a hosted checkout, in one place.
// Step 1 of docs/card-service-split.md. card-service will run this same class behind its HTTP API.
import type { CardVault } from "../cardVault/CardVault.js";
import { scrub, type CardDetails, type CheckoutFiller, type FillResult } from "../checkoutFillers/CheckoutFiller.js";
import type { CardIssuerPort } from "../../domain/interfaces/CardIssuing.js";
import type { CardCharger, ChargeCardResult, ChargeHooks, ChargeRequest, ChargeResult } from "../../domain/interfaces/CardCharger.js";
import { AgentCardsError } from "../../errors.js";
import { issueOneTimeCard, oneTimeIssueRefusal } from "../../lib/services/issueOneTimeCard.js";

export interface LocalCardChargerDeps {
  cardIssuer: Pick<CardIssuerPort, "issueOneTime">;
  vault: Pick<CardVault, "reveal" | "discard">;
  filler: CheckoutFiller;
  log?: (line: string) => void;
}

/** Stripe's public test card (docs.stripe.com/testing). Not anyone's card. */
const stripeTestCard = (): CardDetails => ({
  pan: "4242424242424242", cvv: "123", expMonth: 12, expYear: new Date().getUTCFullYear() + 3, nameOnCard: "Agent Card Test", billingZip: "94107",
  billingAddress: { line1: "510 Townsend St", city: "San Francisco", state: "CA", country: "US" },
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const notFilled = (detail: string): ChargeResult["fill"] => ({ outcome: "error", submitted: false, detail });

export class LocalCardCharger implements CardCharger {
  constructor(private readonly d: LocalCardChargerDeps) {}

  private log(line: string): void {
    (this.d.log ?? console.log)(line);
  }

  async charge(req: ChargeRequest, hooks: ChargeHooks = {}): Promise<ChargeResult> {
    const { swapId } = req;
    let card: CardDetails | null = null;
    let cardResult: ChargeCardResult | undefined;
    let vaultedId: string | undefined;
    try {
      if (req.card.kind === "test") {
        this.log(`swap ${swapId}: test link or test shop, paying with Stripe's test card (the vault is not opened)`);
        cardResult = { state: "test" };
        card = stripeTestCard();
      } else {
        let id: string;
        let last4: string | undefined;
        if (req.card.kind === "existing") {
          id = req.card.cardId;
        } else {
          // As late as possible: after the debit, right before the page, so a payment that never gets here costs no card.
          const out = await issueOneTimeCard(this.d.cardIssuer, req.card.cardholder, req.expectedAmountCents, req.card.ref, true);
          if (out.kind === "refused") {
            return { fill: notFilled("one-time card refused by the issuer"), card: { state: "none", detail: out.why }, refusal: oneTimeIssueRefusal.refused(out.why) };
          }
          if (out.kind === "lost") {
            this.log(`swap ${swapId}: one-time card issue answer lost, flagged for review`);
            return { fill: notFilled("one-time card not confirmed"), card: { state: "unknown", detail: `issue answer lost: ${out.why}` }, refusal: oneTimeIssueRefusal.lost };
          }
          if (!out.detailsCaptured) {
            return {
              fill: notFilled("one-time card details unavailable"),
              card: { state: "unusable", id: out.cardId, ...(out.last4 ? { last4: out.last4 } : {}), detail: "card issued but its details could not be captured" },
              refusal: oneTimeIssueRefusal.noDetails,
            };
          }
          id = out.cardId;
          last4 = out.last4;
        }
        cardResult = { state: "issued", id, ...(last4 ? { last4 } : {}) };
        vaultedId = id;
        await hooks.cardIssued?.({ id, ...(last4 ? { last4 } : {}) });
        card = await this.d.vault.reveal(id, `checkout:${swapId}`);
        if (!card) return { fill: notFilled("card details not on file"), card: cardResult, refusal: "this card's details are not on file; nothing was charged" };
      }
      // The live view is for Stripe's public test card only.
      const watch = req.card.kind === "test" ? hooks.watch : undefined;
      let fill: FillResult;
      try {
        fill = await this.d.filler.fill({ url: req.checkoutUrl, expectedAmountCents: req.expectedAmountCents, card, email: req.receiptEmail, ...(watch ? { watch } : {}) });
      } catch (e) {
        // The filler reports its own errors; this is something unexpected, before any submit.
        return { fill: notFilled(errText(e).slice(0, 200)), card: cardResult, refusal: "could not start the checkout; nothing was charged" };
      }
      return { fill: { outcome: fill.outcome, submitted: fill.submitted, detail: fill.detail ?? null }, card: cardResult };
    } catch (e) {
      // A hook, the vault, or something unexpected, before any submit.
      const refusal = e instanceof AgentCardsError ? e.message : "could not start the checkout; nothing was charged";
      return { fill: notFilled(errText(e).slice(0, 200)), card: cardResult ?? { state: "unknown", detail: errText(e).slice(0, 200) }, refusal };
    } finally {
      scrub(card);
      card = null;
      // A one-time card is single use: once the page has had it, nothing needs its details again.
      if (vaultedId) {
        await this.d.vault.discard(vaultedId, `checkout:${swapId}:done`).catch((e) => this.log(`swap ${swapId}: could not discard the one-time card's details: ${errText(e)}`));
      }
    }
  }
}
