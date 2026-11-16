# Card service split (PCI scope reduction)

Status: step 1 done (`CardCharger` port, `LocalCardCharger`); steps 2, 4, 5 in progress; step 3 waits for Miden. Plan written 2026-11-16. Assumes the `pci-hardening` change: only one-time cards (`CardholderInteractor.chargeCardFor`) ever have details captured, and they are discarded after the fill.

## Goal

One small service, **card-service**, is the only cardholder-data environment (CDE). It issues the one-time card, decrypts its details, fills the checkout, forgets the details, and answers with a card-free outcome. The main app (ledger, dashboard, MCP, deposits, payouts) never holds a PAN/CVV, a key that can decrypt one, or a credential that can fetch one.

Moves into card-service:

| Today | Why it is CHD-bearing |
|---|---|
| `src/adapters/cardVault/CardVault.ts`, tables `card_vault`, `card_vault_audit` (`src/db/migrations/008_card_vault.sql`, `011_privacy_mode.sql`) | sealed PAN/CVV, `CARD_VAULT_KEY` |
| `CardService.issueOneTime` / `captureFromIssue` / `captureDetails` / `addBillingDetails` (`src/adapters/virtualCards/CardService.ts`) | receives `secureCardDetails` and full-PAN |
| `src/lib/clients/cardIssuing/miden/cardDetails.ts` | decrypts with `MIDEN_CLIENT_ID` / `MIDEN_UNIQUE_KEY` |
| the `charge` closure in `SwapInteractor.drive` (`src/lib/interactors/SwapInteractor.ts` ~272-322) | `vault.reveal` → `filler.fill` → `scrub` → `vault.discard` |
| `src/adapters/checkoutFillers/*` (Playwright) | types the PAN into the page |

Stays in the main app: ledger and `pay()` (`CardholderInteractor.ts` ~794-815), swap rows, `one_time_cards` policy (min $1, daily cap, KYC check), reconcile, everything else.

## 1. API (main app → card-service)

The seam already exists: `pay(..., { charge })` calls a `Charger(spendId) → ChargeOutcome`, and a thrown error becomes `unknown` (money held). We replace the in-process closure with an HTTP client; `pay()` is unchanged.

`POST /v1/charges` — header `Idempotency-Key: swap:<swapId>` (same value as the ledger key `SWAP_KEY_PREFIX + swapId`).

```json
{ "swapId": "...", "spendId": "...", "checkoutUrl": "https://...", "expectedAmountCents": 1200,
  "oneTimeRef": "ot-<spendId>", "cardholder": { "customerId": "...", "kycToken": "..." },
  "receiptEmail": "...", "testCard": false }
```

`oneTimeRef` replaces "one-time card id" in the request: the card does not exist yet when we call (see 2). The main app still runs the one-time *policy* (`chargeCardFor` lines ~630-658: min amount, `ONE_TIME_MAX_PER_DAY`, KYC lookup, `one_time_cards.start`) before calling.

Response (also returned by `GET /v1/charges/<swapId>`):

```json
{ "swapId": "...", "state": "done",                     // received | issuing | filling | done
  "outcome": "paid" | "refused" | "error",
  "submitted": true,                                     // FillResult.submitted semantics
  "fillOutcome": "succeeded|declined|captcha|three_ds|error|...",
  "detail": "page total $12.00, expected $10.00",       // card-free, ≤200 chars, PAN-redacted
  "card": { "id": "<miden card id>", "last4": "4242", "state": "issued" | "none" | "unknown" } }
```

Mapping in the client (same as today's `outcomeOf`): `paid` → `approved`; `refused`, or `error` with `submitted:false` → `refused` (ledger void); `error` with `submitted:true`, any non-2xx, timeout or connection loss → `unknown` (money held). Card id and last4 are not CHD and cross back so the main app can `setChargeCard`, mark `one_time_cards` and reconcile.

Rules: card data never appears in a response, error body, or header. card-service redacts any 13-19 digit Luhn-valid run from `detail` and from its own logs before writing. The live view (`d.live` frames) is allowed only when `testCard: true`; card-service hard-refuses frames/screenshots/traces for real cards. card-service re-validates `checkoutUrl` (public https, not private, no credentials, as `SwapInteractor.validate`) and does not trust the caller on it.

Auth: mTLS between the two services, plus the service only accepts the main app's client cert.

## 2. Issuing, capture, and keeping the ledger right

**card-service issues the one-time card** (`issueOneTime` with `clientReference = oneTimeRef`, Miden `Reference = referenceFor("issue-lite:" + oneTimeRef)`), decrypts `secureCardDetails` itself, falls back to full-PAN itself, and holds the details **in memory only** for the fill. `secureCardDetails` never leaves the box.

Order of money movement (unchanged, just split):

1. Main app debits the agent in the ledger (`wallets.spend`, key `spend:<spendId>`), commits `ledger_seq`, then calls card-service. A charge is never sent before the debit commits.
2. card-service writes a `charges` row keyed on `swapId` **before** each step: `received → issuing → filling → done`. This row is its idempotency record; it holds outcome, submitted, card id, last4, never details.
3. Repeat `POST` with the same key:
   - same body hash, state `done` → return the stored outcome;
   - state `received`/`issuing` → resume (Miden issue is idempotent on `oneTimeRef`);
   - state `filling` (or `done` with `submitted:true`) → **never fill again**; return the stored or current state. One swap gets at most one press of the pay button, ever;
   - different body hash → 409.
4. Main app on the answer: `approved` → finish approved; `refused` → `voidSpend` (refund) and finish voided; `unknown` → finish `processing`, money held.

**Timeout after submit.** The main app cannot tell "not started" from "paid", so a timeout is always `unknown`: the debit stays, no refund, no retry with a new key. The main app may re-`POST` the same key once (safe by rule 3) or simply leave it to reconcile.

**Reconcile** (`SwapInteractor.reconcile`, `CardholderInteractor.reconcileSpends`) gains one step before card matching:

1. `GET /v1/charges/<swapId>`. `404` and no ledger debit → `voidUndebited` as today. `404` with a debit → card-service never received it (it writes `received` before doing anything), so refund is safe *only after* a grace window longer than the client timeout; earlier, wait.
2. `done` with `submitted:false` → refund (`voidSpend`). Definitive: false guarantees no charge (`FillResult` contract).
3. `paid`, or `submitted:true`, or stuck in `filling` → match on the one-time card's Authorization list (`lifecycle.transactions(cardId, "Authorization")`, card-free data, stays in the main app). A one-time card carries only this payment, so `hasRival` is already false and a match is exact.
4. No evidence past `GIVE_UP_AFTER_MS` → `needs_review`. Never refund on absence of evidence (current rule; keep it).

**Card left holding money.** `card.state: "unknown"` (issue answer lost) or `"issued"` with `submitted:false` maps to today's `one_time_cards` `needs_review` / terminate-on-date path (`chargeCardFor` ~669-675). The agent is refunded (no merchant was paid); the funds on the Lite card are a platform recovery item, as today. Improvement worth taking: card-service terminates the card at once when it knows nothing was submitted.

Log on both sides, with the idempotency key, every state change and every retry. The retry you do not log is the one that costs you.

## 3. Keys

- `CARD_VAULT_KEY` (env, one static AES key in the main app's process) goes away. With in-memory-only details (step 6) there is nothing at rest to encrypt; until then, the vault uses **KMS envelope encryption**: per row, `GenerateDataKey` under a card-service CMK with encryption context `{cardId}`, store the wrapped DEK and `key_id` (column exists) beside the ciphertext, AES-256-GCM with the existing AAD `card-vault:v1:<cardId>`. Plain DEK lives only for the call and is zeroed.
- KMS key policy: `kms:Decrypt` / `GenerateDataKey` only for the card-service runtime role. No main-app role, no CI role, no human by default; break-glass is a separate role needing two approvers, alerted. Automatic yearly rotation. CloudTrail `Decrypt` events are reconciled against `card_vault_audit` rows (each reveal should have one of each).
- `MIDEN_CLIENT_ID` / `MIDEN_UNIQUE_KEY` are effectively card-data keys: they decrypt `secureCardDetails`, and the same credentials can call `GET /api/v1/cards/details/{id}/full-pan` (`MidenClient.request` sends `UniqueKey` on every call). They move to card-service's secret store only. See the blocker below.

**Blocker to resolve with Miden first:** the main app also needs Miden (KYC, `simulateAuthorization`, `transactions`, funding, reusable card issue). If it keeps the same credentials, it can fetch and decrypt any PAN and stays in scope regardless of this split. We need a second Miden credential for the main app **without** full-PAN access and with a different decryption key (or no card-detail fields in its responses). If Miden cannot do that, the fallback is that every Miden call returning card data (`issue`, `issue-lite`, `full-pan`) goes through card-service and the main app's credential is still a CDE key, which defeats most of the point. Ask before building step 4.

## 4. Separation

- **Data:** its own Postgres database (not just a schema), owned by `card_svc_owner` (migrations only). Runtime role `card_svc` has `SELECT, INSERT, DELETE` on `card_vault`, `INSERT` only on `card_vault_audit` (revoke `UPDATE, DELETE`; migration 012 already enforces append-only with triggers, and the grants add a second layer), and `SELECT, INSERT, UPDATE` on `charges`. The main app's DB role has no grant and no network path to it.
- **Network:** private subnet. Ingress: only the main app's security group, port 443, mTLS. Egress: Miden API host, KMS endpoint, and merchant checkouts through an egress proxy that allows public https only and denies RFC1918, link-local and `169.254.169.254` (checkouts are open hosts, so the allowlist is "public internet", enforced at the proxy, not just in code). No egress to the main app's DB, queues or log stack.
- **Logs:** its own sink and retention, PAN-redacting formatter in front of every logger, Playwright tracing/video/HAR off, browser profile and downloads on tmpfs, core dumps off. The main app sees only the API responses. Access to the log sink is restricted to the CDE operators.
- **Code:** card-service has its own entrypoint (`src/cardService/main.ts`) and bootstrap; a dependency rule (dependency-cruiser or `no-restricted-imports`) forbids the main app from importing `adapters/cardVault`, `adapters/checkoutFillers`, `miden/cardDetails`, and card-service from importing the ledger.

## 5. Migration, each step shippable

1. **Port, in-process.** *(Done.)* `src/domain/interfaces/CardCharger.ts`, `src/adapters/cardCharger/LocalCardCharger.ts`; the policy is `CardholderInteractor.prepareOneTime` / `settleOneTime`. Add `CardCharger` (`charge(req) → outcome`) in `src/domain/interfaces`. Move the `drive` charge closure, the issue-lite + capture part of `chargeCardFor`, `vault`, and `filler` behind `LocalCardCharger`. `SwapInteractor` deps drop `vault` and `filler`. No behaviour change; existing swap tests must pass unchanged.
2. **Idempotency record.** Add the `charges` table and the state machine to `LocalCardCharger`; reconcile reads it (section 2). Still one process. Tests: replay at each state, timeout after submit, body-hash mismatch.
3. **Miden credential split** (section 3 blocker). Main app runs on the restricted credential; issue-lite and full-pan only from the charger's credential.
4. **Stand up card-service** with the same `LocalCardCharger` code, own DB, KMS-backed vault, network rules, log sink. Main app gets `RemoteCardCharger` behind `CARD_SERVICE_URL`; ship to sandbox, then a percentage of production swaps (payments cannot be shadowed; canary instead).
5. **Cut over and remove.** Delete `CARD_VAULT_KEY`, `MIDEN_UNIQUE_KEY` (old credential), `SealedCardVault` and the capture config from `src/bootstrap.ts` (~95-118, 177). Verify `card_vault` in the main DB is empty (one-time rows are discarded; migration 012 already purged reusable-card rows), then a migration drops `card_vault` and `card_vault_audit` from the main DB. Export the audit table to card-service first (it is evidence). Securely delete main-DB backups that contain `card_vault` per the retention policy.
6. **No CHD at rest.** Drop the persistent vault in card-service: details live only in memory for one charge; crash recovery re-fetches via full-PAN keyed on `oneTimeRef`. Keep `card_vault_audit` (capture/discard events) only.

## What stays in PCI scope afterwards

- **CDE:** card-service hosts/containers, its database and backups, its KMS key, its secret store entries (Miden card credential), its log sink, the egress proxy.
- **Connected-to / security-impacting** (reduced requirements, not zero): the main app as the only caller (mTLS cert, API client), the CI/CD pipeline and image registry that build and deploy card-service, IAM that grants the roles above.
- **Out of scope** (once step 3 lands): ledger, dashboard, MCP, deposits, payouts and their databases, provided the segmentation is tested (annual pen test of the boundary).

Open items: Miden's answer on scoped credentials (blocks 3); confirm with the QSA how the main app's connected-to status is assessed.
