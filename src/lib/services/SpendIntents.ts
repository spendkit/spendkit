import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IntentCard, IntentRepository, IntentTx, OpenIntent } from "../../domain/repositories/IntentRepository.js";
import type { Spend } from "../../domain/types/Entities.js";
import { badRequestError, conflictError, notFoundError } from "../../errors.js";
import { webhookSignature } from "../clients/cardIssuing/miden/webhookSignature.js";
import { LedgerError, Ledger } from "./Ledger.js";

/**
 * Spend intents and Miden customer-managed authorization (docs/spend-intents.md). An agent opens an intent first;
 * its maximum is held from the agent's sub-balance. Miden then asks us about every authorization on the card, and we
 * approve only one that matches an open intent. Default is decline.
 */

/** app_spend.idempotency_key prefix of spend intents; pay() refuses it, so a payment can never answer as an intent. */
export const INTENT_KEY_PREFIX = "intent:";

/** Miden's "Supported Authorization Decision Codes", verbatim (docs.miden.co, checked 2026-11-20). Never invent one. */
export const DECISIONS = {
  approve: { responseCode: "000", responseReasonCode: "APPROVE", responseMessage: "Transaction approved" },
  invalidAmount: { responseCode: "111", responseReasonCode: "INVALID_AMT", responseMessage: "Invalid transaction amount" },
  insufficientFunds: { responseCode: "116", responseReasonCode: "INSUFF_FUNDS", responseMessage: "Insufficient funds" },
  notPermitted: { responseCode: "119", responseReasonCode: "TXN_NOT_PERMIT", responseMessage: "Transaction is not permitted" },
  merchantBlocked: { responseCode: "125", responseReasonCode: "BLK_MRCH", responseMessage: "Merchant is not allowed" },
  mccRestricted: { responseCode: "127", responseReasonCode: "RESTRICT_MCC", responseMessage: "Merchant category is not supported" },
  limitExceeded: { responseCode: "129", responseReasonCode: "LIMIT_EXCEED", responseMessage: "Transaction limit exceeded" },
  velocityExceeded: { responseCode: "130", responseReasonCode: "VELOCITY_EXCEED", responseMessage: "Transaction velocity limit exceeded" },
  invalidRequest: { responseCode: "131", responseReasonCode: "INVALID_REQ", responseMessage: "Invalid request" },
  securityError: { responseCode: "137", responseReasonCode: "SEC_ERROR", responseMessage: "Security validation failed" },
  cardClosed: { responseCode: "143", responseReasonCode: "CRD_CLOSED", responseMessage: "Card is closed" },
  error: { responseCode: "911", responseReasonCode: "ERROR", responseMessage: "An unexpected error occurred" },
} as const;
export type Decision = (typeof DECISIONS)[keyof typeof DECISIONS];

/** What the route sends: 401 with no body (Miden applies its default, which must be decline), or 200 with a decision. */
export type CallbackAnswer = { httpStatus: 401 } | { httpStatus: 200; body: Decision };

const DECIDING_TYPES = new Set(["Authorization", "PreAuthorization"]);
const FOLLOW_UP_TYPES = new Set(["Settlement", "Reversal", "PartialReversal", "Refund"]);
const KNOWN_TYPES = new Set([...DECIDING_TYPES, ...FOLLOW_UP_TYPES, "CashWithdrawal"]);

const DEFAULT_EXPIRES_S = 1800;
const MAX_EXPIRES_S = 7 * 24 * 3600;
const MIN_EXPIRES_S = 60;
/** The sweeper waits this long past expires_at: an authorization approved just before expiry can reach us just after. */
export const EXPIRY_GRACE_MS = 2 * 60_000;
const FRESHNESS_MS = 2 * 60_000;
const FUTURE_SKEW_MS = 30_000;
const BYPASS_ALERT_EVERY_MS = 10 * 60_000;

/** Lowercase letters and digits, single spaces: "ACME*Store #12" -> "acme store 12". */
export function normalizeMerchant(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Exact decimal dollars ("3.75", 3.75) to integer cents. Never multiplies floats. Undefined if malformed. */
export function dollarsToCents(v: unknown): number | undefined {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export interface IntentAlerter {
  raise(key: string, msg: string): Promise<void>;
}

export interface SpendIntentsDeps {
  repo: IntentRepository;
  /** MIDEN_WEBHOOK_HASH: the callback is signed like the webhooks. */
  webhookHash: string;
  alerter: IntentAlerter;
  log?: (msg: string) => void;
  now?: () => Date;
  /** Internal decision budget; Miden's deadline is 400 ms. */
  budgetMs?: number;
  /** Mira's approvalPolicy (compares against max_amount_cents). Absent: no intent needs approval. */
  approvalRequired?: (p: { cardId: string; agentId: string }, maxAmountCents: number) => Promise<boolean>;
  /** Mira's ApprovalInteractor.approvalUrl. */
  approvalUrl?: (spendId: string) => string;
}

export interface AgentRef {
  cardId: string;
  agentId: string;
}

export interface IntentView {
  spendId: string;
  status: Spend["status"];
  approval: Spend["approval"];
  amountCents: number;
  maxAmountCents: number;
  merchant: string;
  merchantMatch: string | null;
  merchantAcceptorId: string | null;
  mcc: string | null;
  expiresAt: string;
  reason: string | null;
  authState: Spend["authState"];
  capturedCents: number;
  context: string | null;
  createdAt: string;
}

export type CreateIntentResult =
  | ({ status: "pending_approval"; approvalUrl: string | null } & Omit<IntentView, "status">)
  | IntentView;

export function intentView(s: Spend): IntentView {
  return {
    spendId: s.spendId, status: s.status, approval: s.approval, amountCents: s.amountCents, maxAmountCents: s.maxAmountCents ?? s.amountCents,
    merchant: s.merchant, merchantMatch: s.merchantMatch, merchantAcceptorId: s.merchantAcceptorId, mcc: s.mcc,
    expiresAt: (s.expiresAt ?? s.createdAt).toISOString(), reason: s.reason, authState: s.authState, capturedCents: s.capturedCents,
    context: s.context, createdAt: s.createdAt.toISOString(),
  };
}

/** The caller's input to createIntent, unvalidated (REST or MCP). */
export interface CreateIntentInput {
  amountCents?: unknown;
  maxAmountCents?: unknown;
  merchant?: unknown;
  merchantMatch?: unknown;
  merchantAcceptorId?: unknown;
  mcc?: unknown;
  expiresInSeconds?: unknown;
  context?: unknown;
  idempotencyKey?: unknown;
}

interface ParsedIntent {
  amountCents: number;
  maxAmountCents: number;
  merchant: string;
  merchantMatch: string;
  merchantAcceptorId: string | null;
  mcc: string | null;
  expiresInSeconds: number;
  context: string | null;
  key: string;
}

const cents = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw badRequestError(`${what} must be a positive whole number of cents`);
  return v;
};
const optText = (v: unknown, what: string, max: number): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !v.trim()) throw badRequestError(`${what} must be text`);
  if (v.length > max) throw badRequestError(`${what} is too long`);
  return v.trim();
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

function parseIntent(i: CreateIntentInput): ParsedIntent {
  const amountCents = cents(i.amountCents, "amountCents");
  const maxAmountCents = i.maxAmountCents === undefined || i.maxAmountCents === null ? amountCents : cents(i.maxAmountCents, "maxAmountCents");
  if (maxAmountCents < amountCents) throw badRequestError("maxAmountCents cannot be less than amountCents");
  const merchant = optText(i.merchant, "merchant", 80);
  if (!merchant) throw badRequestError("merchant is required");
  const merchantMatch = normalizeMerchant(optText(i.merchantMatch, "merchantMatch", 80) ?? merchant);
  if (merchantMatch.length < 3) throw badRequestError("merchantMatch must have at least 3 letters or digits");
  const merchantAcceptorId = optText(i.merchantAcceptorId, "merchantAcceptorId", 64);
  const mcc = i.mcc === undefined || i.mcc === null || i.mcc === "" ? null : String(i.mcc);
  if (mcc !== null && !/^\d{4}$/.test(mcc)) throw badRequestError("mcc must be 4 digits");
  const exp = i.expiresInSeconds === undefined || i.expiresInSeconds === null ? DEFAULT_EXPIRES_S : i.expiresInSeconds;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp < MIN_EXPIRES_S || exp > MAX_EXPIRES_S) {
    throw badRequestError(`expiresInSeconds must be a whole number from ${MIN_EXPIRES_S} to ${MAX_EXPIRES_S}`);
  }
  let context: string | null = null;
  if (i.context !== undefined && i.context !== null) {
    if (typeof i.context !== "string") throw badRequestError("context must be text");
    context = i.context.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    if (!context) throw badRequestError("context must not be empty");
    if (context.length > 500) throw badRequestError("context is at most 500 characters");
  }
  const own = optText(i.idempotencyKey, "idempotencyKey", 100);
  const key = INTENT_KEY_PREFIX + (own ?? `auto_${randomBytes(12).toString("hex")}`);
  return { amountCents, maxAmountCents, merchant, merchantMatch, merchantAcceptorId, mcc, expiresInSeconds: exp, context, key };
}

/** True if the stored intent was created from the same request (an idempotent replay). */
function sameIntent(s: Spend, r: ParsedIntent): boolean {
  return s.amountCents === r.amountCents && (s.maxAmountCents ?? s.amountCents) === r.maxAmountCents && s.merchant === r.merchant
    && s.merchantMatch === r.merchantMatch && s.merchantAcceptorId === r.merchantAcceptorId && s.mcc === r.mcc && s.context === r.context;
}

/** The fields of a callback body we use. Everything else (accountNumber first) is ignored and never stored. */
interface CallbackBody {
  eventId: string;
  eventTime: string;
  requestType: string;
  cardId: string;
  totalCents: number | undefined;
  chargeCents: number;
  currency: string | null;
  mcc: string | null;
  merchantName: string;
  merchantAcceptorId: string | null;
  authId: string | null;
  precedingRelatedToken: string | null;
  reference: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

function readBody(b: Record<string, unknown>): CallbackBody {
  const tx = dollarsToCents(b.transactionAmount);
  const charge = b.charge === undefined || b.charge === null || b.charge === "" ? 0 : dollarsToCents(b.charge);
  return {
    eventId: str(b.eventId) ?? "",
    eventTime: typeof b.eventTime === "string" ? b.eventTime : "",
    requestType: str(b.requestType) ?? "",
    cardId: str(b.cardId) ?? "",
    totalCents: tx === undefined || charge === undefined ? undefined : tx + charge,
    chargeCents: charge ?? 0,
    currency: str(b.transactionCurrencyCode),
    mcc: str(b.merchantCategoryCode),
    merchantName: str(b.merchantName) ?? "",
    merchantAcceptorId: str(b.merchantAcceptorId),
    authId: str(b.cardTransactionAuthorizationId),
    precedingRelatedToken: str(b.precedingRelatedToken),
    reference: str(b.reference),
  };
}

/**
 * Checks Miden's `Signature` (or webhook-style `x-signature`) header: HMAC-SHA256 over `${eventId}&${eventTime}`.
 * The webhooks send lowercase hex; Miden's callback example is base64, so hex, base64(hex) and base64(raw digest)
 * are all accepted. Constant time per comparison.
 */
export function verifyCallbackSignature(eventId: string, eventTime: string, header: string | undefined, hash: string): boolean {
  if (!header || !hash || !eventId || !eventTime) return false;
  const hex = webhookSignature(eventId, eventTime, hash);
  const sig = header.trim();
  const candidates = [Buffer.from(sig.toLowerCase())];
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) {
    const raw = Buffer.from(sig, "base64");
    candidates.push(Buffer.from(raw.toString("latin1").toLowerCase()), Buffer.from(raw.toString("hex")));
  }
  const want = Buffer.from(hex);
  let ok = false;
  for (const c of candidates) if (c.length === want.length && timingSafeEqual(c, want)) ok = true;
  return ok;
}

class BudgetExceeded extends Error {}

/** True if the spend was paid with this Miden card: an intent on the reusable card, or the one-time card's own spend. */
function belongsTo(s: Spend, card: IntentCard): boolean {
  return card.kind === "reusable" ? s.cardId === card.cardId && s.expiresAt !== null : s.spendId === card.spendId;
}

export class SpendIntents {
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly budgetMs: number;
  /** Bypass alerts per card: one per 10 minutes, with the count since the last one. */
  private readonly bypass = new Map<string, { last: number; count: number }>();

  constructor(private readonly d: SpendIntentsDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
    this.budgetMs = d.budgetMs ?? 250;
  }

  private ledger(tx: IntentTx): Ledger {
    return new Ledger(this.now, tx.ledger);
  }

  private today(): [Date, Date] {
    const start = new Date(`${this.now().toISOString().slice(0, 10)}T00:00:00Z`);
    return [start, new Date(start.getTime() + 86_400_000)];
  }

  // ---------- the agent side

  /**
   * Opens an intent and holds its maximum from the agent's sub-balance, all in one transaction under the card's row
   * lock. Over a limit, or short of funds, the intent is recorded as declined with the reason and nothing is held.
   * The same idempotency key returns the same intent; a different request under it is a 409.
   */
  async createIntent(p: AgentRef, input: CreateIntentInput): Promise<CreateIntentResult> {
    const r = parseIntent(input);
    const needsApproval = this.d.approvalRequired ? await this.d.approvalRequired(p, r.maxAmountCents) : false;
    let spend: Spend;
    try {
      spend = await this.d.repo.transaction(async (tx) => {
        const prior = await tx.findByKey(p.cardId, p.agentId, r.key);
        if (prior) {
          if (!sameIntent(prior, r)) throw conflictError("that idempotency key was already used for a different intent");
          return prior;
        }
        const agent = await tx.findAgent(p.cardId, p.agentId);
        if (!agent || agent.revokedAt) throw notFoundError("agent not found");
        const totals = await tx.dailyTotals(p.cardId, p.agentId, this.today());
        if (!totals) throw notFoundError("card not found");
        const reason =
          r.maxAmountCents > agent.perTxnCents ? "per-transaction limit exceeded"
          : totals.agentSpentCents + r.maxAmountCents > agent.dailyCents ? "daily limit exceeded"
          : totals.cardSpentCents + r.maxAmountCents > totals.cardDailyCents ? "card daily limit exceeded (shared by all agents on this card)"
          : agent.allowedMccs?.length && (!r.mcc || !agent.allowedMccs.includes(r.mcc)) ? "merchant category not allowed"
          : null;
        const spendId = `sp_${randomBytes(10).toString("hex")}`;
        const row = await tx.insert({
          spendId, cardId: p.cardId, agentId: p.agentId, idempotencyKey: r.key, amountCents: r.amountCents, merchant: r.merchant, mcc: r.mcc,
          status: reason ? "declined" : "processing", reason,
          expiresAt: new Date(this.now().getTime() + r.expiresInSeconds * 1000), maxAmountCents: r.maxAmountCents,
          merchantMatch: r.merchantMatch, merchantAcceptorId: r.merchantAcceptorId, context: r.context,
          approval: needsApproval && !reason ? "pending" : "none",
        });
        if (reason) return row;
        try {
          await this.ledger(tx).holdIntent({ cardId: p.cardId, agentId: p.agentId, spendId, amountCents: r.maxAmountCents });
        } catch (e) {
          if (!(e instanceof LedgerError) || !/insufficient/.test(e.message)) throw e;
          return tx.update(spendId, { status: "declined", reason: "insufficient sub-balance", approval: "none" });
        }
        return row;
      });
    } catch (e) {
      // Two creates with one key at once: the loser's insert hit the unique key and rolled back. Answer with the winner.
      const again = await this.d.repo.transaction((tx) => tx.findByKey(p.cardId, p.agentId, r.key)).catch(() => undefined);
      if (!again || !sameIntent(again, r)) throw e;
      spend = again;
    }
    const view = intentView(spend);
    if (spend.status === "processing" && spend.approval === "pending") {
      return { ...view, status: "pending_approval", approvalUrl: this.d.approvalUrl?.(spend.spendId) ?? null };
    }
    return view;
  }

  async getIntent(p: AgentRef, spendId: string): Promise<IntentView> {
    const s = await this.d.repo.find(spendId);
    if (!s || s.cardId !== p.cardId || s.agentId !== p.agentId || !s.expiresAt) throw notFoundError("intent not found");
    return intentView(s);
  }

  /**
   * Gives the hold back on an intent no authorization used. Acts only on a processing intent with no auth_ref, under
   * a row lock; idempotent. 'owner_denied' -> declined, 'expired' -> expired.
   */
  async releaseIntent(spendId: string, why: "owner_denied" | "expired"): Promise<{ released: boolean; status: Spend["status"] | null }> {
    return this.d.repo.transaction(async (tx) => {
      const s = await tx.lockSpend(spendId);
      if (!s || !s.expiresAt) return { released: false, status: s?.status ?? null };
      if (s.status !== "processing" || s.authRef !== null) return { released: false, status: s.status };
      await this.ledger(tx).releaseIntentHold({ cardId: s.cardId, agentId: s.agentId, spendId, amountCents: s.maxAmountCents! });
      const status = why === "expired" ? "expired" : "declined";
      await tx.update(spendId, { status, reason: why });
      return { released: true, status };
    });
  }

  /** Releases intents past expires_at + 2 min that no authorization used. Run it in the background. */
  async sweepExpired(limit = 200): Promise<number> {
    const ids = await this.d.repo.expiredIds(new Date(this.now().getTime() - EXPIRY_GRACE_MS), limit);
    let n = 0;
    for (const id of ids) {
      try {
        if ((await this.releaseIntent(id, "expired")).released) n++;
      } catch (e) {
        this.log(`intent ${id}: expiry release failed: ${(e as Error).message}`);
      }
    }
    return n;
  }

  // ---------- the Miden side

  /**
   * Miden's authorization callback. `body` is the parsed JSON with accountNumber already stripped by the route.
   * Never throws: any failure declines 911, and nothing commits after a decline.
   */
  async handleCallback(body: Record<string, unknown>, signatureHeader: string | undefined): Promise<CallbackAnswer> {
    const started = Date.now();
    const b = readBody(body);
    if (!verifyCallbackSignature(b.eventId, b.eventTime, signatureHeader, this.d.webhookHash)) return { httpStatus: 401 };
    const answer = (d: Decision): CallbackAnswer => ({ httpStatus: 200, body: d });

    // The signature covers only eventId&eventTime: a replayed signature with a forged body must not count as new.
    const at = Date.parse(b.eventTime);
    const now = this.now().getTime();
    if (!Number.isFinite(at) || at < now - FRESHNESS_MS || at > now + FUTURE_SKEW_MS) return answer(DECISIONS.securityError);

    if (!KNOWN_TYPES.has(b.requestType)) {
      void this.alert(`miden-unknown-type:${b.requestType}`, `Miden callback with unknown requestType "${b.requestType.slice(0, 40)}" on card ${b.cardId}; declined 131`);
      return answer(DECISIONS.invalidRequest);
    }
    if (!b.cardId) return answer(DECISIONS.invalidRequest);

    if (FOLLOW_UP_TYPES.has(b.requestType)) {
      // Not a decision: record it and acknowledge. The money still moves inside the budget when it can.
      try {
        await this.d.repo.transaction((tx) => this.applyFollowUp(tx, b), { timeoutMs: this.budgetMs });
      } catch (e) {
        this.log(`miden ${b.requestType} ${b.eventId}: ${(e as Error).message}`);
        void this.alert(`miden-followup-failed:${b.eventId}`, `Miden ${b.requestType} ${b.eventId} on card ${b.cardId} was not applied: ${(e as Error).message}`);
      }
      return answer(DECISIONS.approve);
    }

    if (b.totalCents === undefined || b.totalCents <= 0) return answer(DECISIONS.invalidAmount);
    if (b.chargeCents > 0 && b.currency && b.currency.toUpperCase() !== "USD" && b.currency !== "840") {
      void this.alert(`miden-charge-currency:${b.cardId}`, `Miden authorization ${b.eventId} has charge ${b.chargeCents}c on a ${b.currency} transaction; charge currency is unconfirmed (assumed USD)`);
    }

    // Commit, then answer. The timer may answer 911 only while still deciding; then the transaction throws and rolls back.
    let phase: "deciding" | "committing" | "done" = "deciding";
    const remaining = Math.max(1, this.budgetMs - (Date.now() - started));
    const work = this.d.repo.transaction(async (tx) => {
      const d = await this.decide(tx, b);
      if (phase !== "deciding") throw new BudgetExceeded();
      phase = "committing";
      return d;
    }, { timeoutMs: remaining });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((res) => (timer = setTimeout(() => res("late"), remaining)));
    try {
      const first = await Promise.race([work, late]);
      if (first !== "late") return answer(first);
      if (phase === "deciding") {
        phase = "done";
        work.catch(() => undefined);
        this.log(`miden ${b.eventId}: decision over budget, declined 911`);
        return answer(DECISIONS.error);
      }
      // Already committing: the commit is bounded by statement_timeout, so its answer is the true one.
      return answer(await work);
    } catch (e) {
      phase = "done";
      if (!(e instanceof BudgetExceeded)) this.log(`miden ${b.eventId}: declined 911: ${(e as Error).message}`);
      return answer(DECISIONS.error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Decides an Authorization or PreAuthorization inside the transaction. Records the event and the answer. */
  private async decide(tx: IntentTx, b: CallbackBody): Promise<Decision> {
    const seen = await tx.claimEvent({ eventId: b.eventId, source: "callback", requestType: b.requestType, cardId: b.cardId });
    if (seen) {
      if (seen.source !== "callback") {
        void this.alert(`miden-cross-source:${b.eventId}`, `Miden callback reused eventId ${b.eventId} first seen on the webhook route; declined`);
        return DECISIONS.notPermitted;
      }
      try {
        return JSON.parse(seen.decision) as Decision;
      } catch {
        return DECISIONS.error; // still being decided by a concurrent call that has not committed
      }
    }
    const record = async (d: Decision, spendId: string | null = null) => {
      await tx.setEventDecision(b.eventId, JSON.stringify(d), spendId);
      return d;
    };
    if (b.requestType === "CashWithdrawal") return record(DECISIONS.notPermitted);

    const card = await tx.findCard(b.cardId);
    if (!card) return record(DECISIONS.cardClosed);
    const total = b.totalCents!;

    // A decision needs Miden's own authorization id: never key one on `reference`, which a merchant may repeat.
    if (!b.authId) return record(DECISIONS.invalidRequest);
    const authRef = b.authId;
    // Lock the card row first: every decision on this card queues behind it, so no intent is ever skipped.
    if (card.kind === "reusable" && !(await tx.lockCard(card.cardId))) return record(DECISIONS.cardClosed);
    // The same authorization asked again under a new eventId: approve again (moving nothing) only if it is the same
    // authorization id, on the same card, for the same amount and the same merchant acceptor. Anything else declines.
    const already = await tx.findByAuthRefForUpdate(authRef);
    if (already) {
      const same = belongsTo(already, card) && already.authState === "provisional" && already.capturedCents === total && already.authAcceptorId === b.merchantAcceptorId;
      if (!same) void this.alert(`miden-authref-reuse:${authRef}`, `Authorization id ${authRef} asked again on card ${b.cardId} (${total}c) but does not match its first use on ${already.spendId}; declined 119`);
      return record(same ? DECISIONS.approve : DECISIONS.notPermitted, already.spendId);
    }

    if (card.kind === "one_time") return record(await this.decideOneTime(tx, card.spendId, total, authRef, b), card.spendId);

    const open = await tx.openIntentsForUpdate(card.cardId, this.now());
    const merchant = normalizeMerchant(b.merchantName);
    const fits = (s: OpenIntent) =>
      total <= s.maxAmountCents!
      && (s.mcc === null || s.mcc === b.mcc)
      && (!s.agent.allowedMccs?.length || (b.mcc !== null && s.agent.allowedMccs.includes(b.mcc)))
      && (s.merchantMatch === null || ` ${merchant} `.includes(` ${s.merchantMatch} `))
      && (s.merchantAcceptorId === null || s.merchantAcceptorId === b.merchantAcceptorId);
    const candidates = open.filter(fits);
    if (candidates.length === 0) {
      this.bypassAlert(card.cardId, b, open.length);
      return record(DECISIONS.notPermitted);
    }
    const agents = new Set(candidates.map((s) => s.agentId));
    if (agents.size > 1) {
      void this.alert(`miden-ambiguous:${card.cardId}`, `Authorization ${b.eventId} on card ${card.cardId} matched intents of ${agents.size} agents; declined 119`);
      return record(DECISIONS.notPermitted);
    }
    // Closest maximum first; the list is oldest first and sort is stable, so ties go to the oldest.
    const pick = [...candidates].sort((x, y) => (x.maxAmountCents! - total) - (y.maxAmountCents! - total))[0]!;
    await this.ledger(tx).captureIntent({ cardId: pick.cardId, spendId: pick.spendId, amountCents: total, authRef });
    await tx.update(pick.spendId, {
      status: "approved", uses: pick.uses + 1, authRef, authState: "provisional", capturedCents: total, authAcceptorId: b.merchantAcceptorId, ...(b.authId ? { midenAuthId: b.authId } : {}),
    });
    return record(DECISIONS.approve, pick.spendId);
  }

  /**
   * A one-time card (hosted checkout) belongs to one spend that pay() already debited. Approve one authorization up
   * to that amount; the money moved at pay time.
   */
  private async decideOneTime(tx: IntentTx, spendId: string, total: number, authRef: string, b: CallbackBody): Promise<Decision> {
    const s = await tx.lockSpend(spendId);
    if (!s || s.status !== "approved" || s.authRef !== null) return DECISIONS.notPermitted;
    if (total > s.amountCents) return DECISIONS.limitExceeded;
    await tx.update(spendId, { authRef, authState: "provisional", capturedCents: total, authAcceptorId: b.merchantAcceptorId, ...(b.authId ? { midenAuthId: b.authId } : {}) });
    return DECISIONS.approve;
  }

  /**
   * Settlement, Reversal, PartialReversal, Refund. Which reference links one to its authorization is not documented,
   * so the authorization id, then precedingRelatedToken, then the reference are tried.
   */
  private async applyFollowUp(tx: IntentTx, b: CallbackBody): Promise<void> {
    const seen = await tx.claimEvent({ eventId: b.eventId, source: "callback", requestType: b.requestType, cardId: b.cardId });
    if (seen) return;
    // Only a spend on this same Miden card can be the one followed up.
    const card = await tx.findCard(b.cardId);
    let s: Spend | undefined;
    for (const ref of card ? [b.authId, b.precedingRelatedToken, b.reference] : []) {
      const found = ref ? await tx.findByAuthRefForUpdate(ref) : undefined;
      if (found && belongsTo(found, card!)) {
        s = found;
        break;
      }
    }
    const done = (what: string) => tx.setEventDecision(b.eventId, what, s?.spendId ?? null);
    const amount = b.totalCents;
    if (!s) {
      // Deviation from the spec's owner-level force post: until Miden confirms settlement funding, no money moves.
      void this.alert(`miden-unmatched:${b.eventId}`, `Miden ${b.requestType} ${b.eventId} on card ${b.cardId} (${amount ?? "?"}c) matches no authorization we approved; needs review`);
      return done("unmatched");
    }
    if (amount === undefined) {
      void this.alert(`miden-bad-amount:${b.eventId}`, `Miden ${b.requestType} ${b.eventId} for ${s.spendId} has an unreadable amount; needs review`);
      return done("bad_amount");
    }
    if (!s.expiresAt) {
      // A hosted-checkout one-time card: pay() moved the money; only note what the network did.
      if (b.requestType === "Settlement") await tx.update(s.spendId, { authState: "settled", capturedCents: amount });
      if (b.requestType !== "Settlement" || amount !== s.amountCents) {
        void this.alert(`miden-checkout-followup:${b.eventId}`, `Miden ${b.requestType} ${b.eventId} of ${amount}c on checkout spend ${s.spendId} (${s.amountCents}c); needs review`);
      }
      return done(`noted:${b.requestType}`);
    }
    const ledger = this.ledger(tx);
    const holdLeft = s.authState === "provisional" ? s.maxAmountCents! - s.capturedCents : 0;
    if (b.requestType === "Settlement") {
      if (s.authState === "settled") {
        if (amount !== s.capturedCents) void this.alert(`miden-resettle:${b.eventId}`, `Second settlement ${b.eventId} of ${amount}c on ${s.spendId} (settled ${s.capturedCents}c); needs review`);
        return done("already_settled");
      }
      try {
        await ledger.settleIntent({ cardId: s.cardId, agentId: s.agentId, spendId: s.spendId, holdRemainderCents: holdLeft, merchantDeltaCents: amount - s.capturedCents });
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        void this.alert(`miden-settle-short:${s.spendId}`, `Settlement ${b.eventId} of ${amount}c on ${s.spendId} could not be posted (${e.message}); needs review`);
        return done("settle_failed");
      }
      if (amount > s.maxAmountCents!) void this.alert(`miden-over-tolerance:${s.spendId}`, `Settlement ${amount}c on ${s.spendId} is above its maximum ${s.maxAmountCents}c`);
      await tx.update(s.spendId, { authState: "settled", capturedCents: amount });
      return done("settled");
    }
    // Reversal, PartialReversal, Refund: money back from the merchant, never more than went out. An amount of 0 is
    // undocumented: alert, never guess "full".
    if (amount === 0) {
      void this.alert(`miden-zero-return:${b.eventId}`, `Miden ${b.requestType} ${b.eventId} on ${s.spendId} has amount 0; nothing returned, needs review`);
      return done("zero_amount");
    }
    const back = Math.min(amount, s.capturedCents);
    if (back > 0) {
      await ledger.returnIntentPayment({ cardId: s.cardId, agentId: s.agentId, spendId: s.spendId, eventId: b.eventId, amountCents: back, kind: b.requestType === "Refund" ? "intent_refund" : "intent_reversal" });
    }
    const captured = s.capturedCents - back;
    if (captured === 0 && s.authState === "provisional") {
      // Fully reversed before settlement: there will be no settlement, so the rest of the hold comes back now.
      if (holdLeft > 0) await ledger.settleIntent({ cardId: s.cardId, agentId: s.agentId, spendId: s.spendId, holdRemainderCents: holdLeft, merchantDeltaCents: 0 });
      await tx.update(s.spendId, { capturedCents: 0, authState: "settled", status: "voided", reason: `reversed by the network (${b.requestType})` });
    } else {
      await tx.update(s.spendId, { capturedCents: captured });
    }
    return done(`${b.requestType}:${back}`);
  }

  /** Someone used the card outside our flow. One alert per card per 10 minutes, with the count since the last. */
  private bypassAlert(cardId: string, b: CallbackBody, openCount: number): void {
    const now = Date.now();
    // Per process and in memory; bounded so card testing across many cards cannot grow it without limit.
    if (this.bypass.size > 10_000 && !this.bypass.has(cardId)) this.bypass.clear();
    const st = this.bypass.get(cardId) ?? { last: 0, count: 0 };
    st.count++;
    this.bypass.set(cardId, st);
    if (now - st.last < BYPASS_ALERT_EVERY_MS) return;
    const n = st.count;
    st.last = now;
    st.count = 0;
    void this.alert(`miden-bypass:${cardId}:${now}`,
      `Card ${cardId}: declined ${n} authorization(s) matching no open intent in the last 10 min; latest ${b.eventId} ${b.totalCents ?? "?"}c at "${b.merchantName.slice(0, 40)}" (mcc ${b.mcc ?? "-"}), ${openCount} open intent(s)`);
  }

  private async alert(key: string, msg: string): Promise<void> {
    try {
      await this.d.alerter.raise(key, msg);
    } catch (e) {
      this.log(`alert failed: ${(e as Error).message}`);
    }
  }
}
