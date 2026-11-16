import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalCardCharger } from "../src/adapters/cardCharger/LocalCardCharger.js";
import { MemoryCardVault } from "../src/adapters/cardVault/CardVault.js";
import type { CardDetails, CheckoutFiller, FillRequest, FillResult } from "../src/adapters/checkoutFillers/CheckoutFiller.js";
import { CardProviderBusinessError } from "../src/domain/errors/CardProviderErrors.js";
import type { ChargeRequest } from "../src/domain/interfaces/CardCharger.js";

const PAN = "4111111111111111";
const details = (): CardDetails => ({ pan: PAN, cvv: "987", expMonth: 1, expYear: 2031, nameOnCard: "A B", billingZip: "10001", billingAddress: { line1: "1 St", city: "NYC", state: "NY", country: "US" } });

class Filler implements CheckoutFiller {
  calls: FillRequest[] = [];
  constructor(private readonly result: FillResult | Error = { outcome: "succeeded", submitted: true }) {}
  async fill(req: FillRequest): Promise<FillResult> {
    this.calls.push(req);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function setup(o: { issue?: "ok" | "refuse" | "lose" | "nodetails"; filler?: Filler } = {}) {
  const vault = new MemoryCardVault();
  const filler = o.filler ?? new Filler();
  const issued: string[] = [];
  const cardIssuer = {
    issueOneTime: async (_k: unknown, _a: number, ref: string, opts: { capture: boolean }) => {
      if (o.issue === "refuse") throw new CardProviderBusinessError("117 Insufficient wallet balance");
      if (o.issue === "lose") throw new Error("socket hang up");
      const cardId = `lite-${ref}`;
      issued.push(cardId);
      if (opts.capture && o.issue !== "nodetails") await vault.put(cardId, details());
      return { cardId, lastFour: "1111", detailsCaptured: opts.capture && o.issue !== "nodetails" };
    },
  };
  const charger = new LocalCardCharger({ cardIssuer, vault, filler, log: () => {} });
  return { charger, vault, filler, issued };
}

const req = (card: ChargeRequest["card"]): ChargeRequest => ({
  swapId: "sw1", spendId: "sp1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_x", expectedAmountCents: 1200, receiptEmail: "o@example.com", card,
});
const issue = { kind: "issue" as const, ref: "ot-sp1", cardholder: { customerId: "c", kycToken: "k" } };

test("issues, records the card before the page, fills, scrubs and discards; the result is card-free", async () => {
  const s = setup();
  const seen: string[] = [];
  const r = await s.charger.charge(req(issue), { cardIssued: async (c) => void seen.push(`${c.id}:${c.last4}:${s.filler.calls.length}`) });
  assert.deepEqual(seen, ["lite-ot-sp1:1111:0"], "cardIssued runs before the filler");
  assert.deepEqual(r, { fill: { outcome: "succeeded", submitted: true, detail: null }, card: { state: "issued", id: "lite-ot-sp1", last4: "1111" } });
  assert.equal(s.filler.calls[0]!.card.pan, "", "details scrubbed");
  assert.deepEqual(s.vault.audit.map((a) => `${a.action}:${a.purpose}`), ["put:capture:issue", "reveal:checkout:sw1", "discard:checkout:sw1:done"]);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(`${PAN}|987`));
});

test("an issuer refusal: no card, nothing filled, an agent-facing refusal", async () => {
  const s = setup({ issue: "refuse" });
  const r = await s.charger.charge(req(issue));
  assert.equal(r.card.state, "none");
  assert.match(r.refusal!, /could not make a one-time card \(.*Insufficient.*\); nothing was charged/);
  assert.equal(r.fill.submitted, false);
  assert.equal(s.filler.calls.length, 0);
});

test("a lost issue answer is unknown (a person decides), never a refusal that implies no card", async () => {
  const s = setup({ issue: "lose" });
  const r = await s.charger.charge(req(issue));
  assert.equal(r.card.state, "unknown");
  assert.match(r.refusal!, /flagged for review/);
  assert.equal(s.filler.calls.length, 0);
});

test("a card issued without details is unusable: not filled, not discarded, flagged", async () => {
  const s = setup({ issue: "nodetails" });
  let hooked = false;
  const r = await s.charger.charge(req(issue), { cardIssued: async () => void (hooked = true) });
  assert.deepEqual(r.card, { state: "unusable", id: "lite-ot-sp1", last4: "1111", detail: "card issued but its details could not be captured" });
  assert.equal(hooked, false);
  assert.equal(s.filler.calls.length, 0);
  assert.equal(s.vault.audit.length, 0);
});

test("a filler that throws: refused before submit, details still scrubbed and discarded", async () => {
  const s = setup({ filler: new Filler(new Error(`boom ${PAN}`)) });
  const r = await s.charger.charge(req(issue));
  assert.equal(r.refusal, "could not start the checkout; nothing was charged");
  assert.equal(r.fill.submitted, false);
  assert.equal(s.filler.calls[0]!.card.pan, "");
  assert.ok(s.vault.audit.some((a) => a.action === "discard"));
});

test("an existing one-time card is revealed, not issued again", async () => {
  const s = setup();
  await s.vault.put("lite-old", details());
  const r = await s.charger.charge(req({ kind: "existing", cardId: "lite-old" }));
  assert.equal(s.issued.length, 0);
  assert.deepEqual(r.card, { state: "issued", id: "lite-old" });
});

test("the live view is only wired for the test card", async () => {
  const s = setup();
  const watch = { step: () => {}, frame: () => {} };
  await s.charger.charge(req(issue), { watch });
  assert.equal(s.filler.calls[0]!.watch, undefined, "real card: no watcher");
  await s.charger.charge(req({ kind: "test" }), { watch });
  assert.equal(s.filler.calls[1]!.watch, watch);
  assert.equal(s.vault.audit.filter((a) => a.action === "reveal").length, 1, "the test card never opens the vault");
});
