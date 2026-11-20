import type { Agent, NewSpend, Spend } from "../types/Entities.js";
import type { LedgerRepository } from "./LedgerStore.js";

export type MidenEventSource = "callback" | "webhook";

/** A Miden event we recorded (miden_event), with the decision stored for a replay. */
export interface StoredMidenEvent {
  eventId: string;
  source: MidenEventSource;
  decision: string;
}

/** The card an authorization arrived on: the owner's reusable card, or a one-time card bound to one spend. */
export type IntentCard =
  | { kind: "reusable"; cardId: string }
  | { kind: "one_time"; cardId: string; spendId: string };

/** An open intent with its agent's limits, as the callback reads it under lock. */
export type OpenIntent = Spend & { agent: Pick<Agent, "perTxnCents" | "dailyCents" | "allowedMccs"> };

/** Card and agent totals in the current day window, read under the card's row lock. */
export interface IntentDailyTotals {
  cardDailyCents: number;
  cardSpentCents: number;
  agentSpentCents: number;
}

/** Everything one SpendIntents step does, inside one Postgres transaction. */
export interface IntentTx {
  /** Ledger store bound to this transaction: postings commit or roll back with the rest. */
  ledger: LedgerRepository;
  /**
   * Inserts the event first. Returns undefined when this call inserted it; otherwise the event already stored
   * (same id, any source). Uses ON CONFLICT DO NOTHING, so a duplicate never aborts the transaction.
   */
  claimEvent(e: { eventId: string; source: MidenEventSource; requestType: string | null; cardId: string | null }): Promise<StoredMidenEvent | undefined>;
  setEventDecision(eventId: string, decision: string, spendId: string | null): Promise<void>;
  findCard(midenCardId: string): Promise<IntentCard | undefined>;
  findAgent(cardId: string, agentId: string): Promise<Pick<Agent, "perTxnCents" | "dailyCents" | "allowedMccs" | "revokedAt"> | undefined>;
  /**
   * Open intents on the card: processing, expires_at > now, uses < uses_allowed, approval not pending, agent not
   * revoked. FOR UPDATE SKIP LOCKED, so a concurrent authorization never waits on (or takes) the same row.
   */
  openIntentsForUpdate(cardId: string, now: Date): Promise<OpenIntent[]>;
  lockSpend(spendId: string): Promise<Spend | undefined>;
  findByAuthRefForUpdate(authRef: string): Promise<Spend | undefined>;
  update(spendId: string, set: Partial<Pick<Spend, "status" | "reason" | "uses" | "authRef" | "authState" | "capturedCents" | "approval" | "midenAuthId">>): Promise<Spend>;
  insert(row: NewSpend): Promise<Spend>;
  findByKey(cardId: string, agentId: string, idempotencyKey: string): Promise<Spend | undefined>;
  /** Locks the card row (serialising every limit check on the card) and sums the window. Undefined if no card. */
  dailyTotals(cardId: string, agentId: string, window: [Date, Date]): Promise<IntentDailyTotals | undefined>;
}

export interface IntentRepository {
  /** Runs fn in one transaction. `timeoutMs` sets statement_timeout and lock_timeout for it (the callback's budget). */
  transaction<T>(fn: (tx: IntentTx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>;
  find(spendId: string): Promise<Spend | undefined>;
  /** Processing intents with no authorization whose expires_at is before `before`, oldest first. */
  expiredIds(before: Date, limit: number): Promise<string[]>;
}
