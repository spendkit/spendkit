import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import type { IntentRepository, IntentTx, OpenIntent } from "../../domain/repositories/IntentRepository.js";
import type { Database, Executor, Transaction } from "../client.js";
import { appAgent, appCard, appOneTimeCard, appSpend, midenEvent } from "../schema/index.js";
import { toSafeInt } from "../schema/columns.js";
import { createLedgerStore } from "./createLedgerStore.js";

const holdsMoney = inArray(appSpend.status, ["approved", "processing"]);
/**
 * What a spend holds against the daily limits: a plain payment its amount; an open intent its maximum (the hold);
 * an authorized intent what actually left (the rest of the hold returns at settlement).
 */
const heldAmount = sql`COALESCE(sum(CASE
  WHEN ${appSpend.expiresAt} IS NULL THEN ${appSpend.amountCents}
  WHEN ${appSpend.authRef} IS NULL THEN ${appSpend.maxAmountCents}
  ELSE ${appSpend.capturedCents} END), 0)`.mapWith(toSafeInt);

async function sumHeld(q: Executor, where: SQL | undefined): Promise<number> {
  const [row] = await q.select({ s: heldAmount }).from(appSpend).where(where);
  return row!.s;
}

function intentTx(tx: Transaction): IntentTx {
  return {
    ledger: createLedgerStore(tx),

    async claimEvent(e) {
      const inserted = await tx.insert(midenEvent).values({ ...e, decision: "pending" }).onConflictDoNothing().returning({ eventId: midenEvent.eventId });
      if (inserted.length) return undefined;
      const [row] = await tx.select({ eventId: midenEvent.eventId, source: midenEvent.source, decision: midenEvent.decision }).from(midenEvent).where(eq(midenEvent.eventId, e.eventId));
      return row;
    },

    async setEventDecision(eventId, decision, spendId) {
      await tx.update(midenEvent).set({ decision, spendId }).where(eq(midenEvent.eventId, eventId));
    },

    async findCard(midenCardId) {
      const [card] = await tx.select({ cardId: appCard.cardId }).from(appCard).where(eq(appCard.cardId, midenCardId));
      if (card) return { kind: "reusable", cardId: card.cardId };
      const [one] = await tx.select({ spendId: appOneTimeCard.spendId }).from(appOneTimeCard).where(eq(appOneTimeCard.cardId, midenCardId));
      return one ? { kind: "one_time", cardId: midenCardId, spendId: one.spendId } : undefined;
    },

    async findAgent(cardId, agentId) {
      const [row] = await tx
        .select({ perTxnCents: appAgent.perTxnCents, dailyCents: appAgent.dailyCents, allowedMccs: appAgent.allowedMccs, revokedAt: appAgent.revokedAt })
        .from(appAgent)
        .where(and(eq(appAgent.cardId, cardId), eq(appAgent.agentId, agentId)));
      return row;
    },

    async lockCard(cardId) {
      const [card] = await tx.select({ cardId: appCard.cardId }).from(appCard).where(eq(appCard.cardId, cardId)).for("update");
      return Boolean(card);
    },

    async openIntentsForUpdate(cardId, now) {
      const rows = await tx
        .select({ spend: appSpend, perTxnCents: appAgent.perTxnCents, dailyCents: appAgent.dailyCents, allowedMccs: appAgent.allowedMccs })
        .from(appSpend)
        .innerJoin(appAgent, and(eq(appAgent.cardId, appSpend.cardId), eq(appAgent.agentId, appSpend.agentId)))
        .where(and(
          eq(appSpend.cardId, cardId),
          eq(appSpend.status, "processing"),
          isNotNull(appSpend.expiresAt),
          gt(appSpend.expiresAt, now),
          lt(appSpend.uses, appSpend.usesAllowed),
          ne(appSpend.approval, "pending"),
          isNull(appSpend.authRef),
          isNull(appAgent.revokedAt),
        ))
        .orderBy(asc(appSpend.createdAt))
        .for("update", { of: appSpend });
      return rows.map((r): OpenIntent => ({ ...r.spend, agent: { perTxnCents: r.perTxnCents, dailyCents: r.dailyCents, allowedMccs: r.allowedMccs } }));
    },

    async lockSpend(spendId) {
      const [row] = await tx.select().from(appSpend).where(eq(appSpend.spendId, spendId)).for("update");
      return row;
    },

    async findByAuthRefForUpdate(authRef) {
      const [row] = await tx.select().from(appSpend).where(eq(appSpend.authRef, authRef)).for("update");
      return row;
    },

    async update(spendId, set) {
      const [row] = await tx.update(appSpend).set(set).where(eq(appSpend.spendId, spendId)).returning();
      if (!row) throw new Error(`spend ${spendId} not found`);
      return row;
    },

    async insert(row) {
      const [spend] = await tx.insert(appSpend).values(row).returning();
      return spend!;
    },

    async findByKey(cardId, agentId, idempotencyKey) {
      const [row] = await tx.select().from(appSpend).where(and(eq(appSpend.cardId, cardId), eq(appSpend.agentId, agentId), eq(appSpend.idempotencyKey, idempotencyKey)));
      return row;
    },

    async dailyTotals(cardId, agentId, [start, end]) {
      // Same lock as SpendRepository.open: every limit check on the card queues behind it, in any process.
      const [card] = await tx.select({ dailyCents: appCard.dailyCents }).from(appCard).where(eq(appCard.cardId, cardId)).for("update");
      if (!card) return undefined;
      const window = and(eq(appSpend.cardId, cardId), holdsMoney, gte(appSpend.createdAt, start), lt(appSpend.createdAt, end));
      return {
        cardDailyCents: card.dailyCents,
        cardSpentCents: await sumHeld(tx, window),
        agentSpentCents: await sumHeld(tx, and(window, eq(appSpend.agentId, agentId))),
      };
    },
  };
}

export const createIntentRepository = (db: Database): IntentRepository => ({
  transaction(fn, opts = {}) {
    return db.transaction(async (tx) => {
      if (opts.timeoutMs !== undefined) {
        const ms = Math.max(1, Math.floor(opts.timeoutMs));
        // SET LOCAL cannot take a bind parameter; ms is an integer we computed.
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${ms}`));
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${ms}`));
      }
      return fn(intentTx(tx));
    });
  },

  async find(spendId) {
    const [row] = await db.select().from(appSpend).where(eq(appSpend.spendId, spendId));
    return row;
  },

  async expiredIds(before, limit) {
    const rows = await db
      .select({ spendId: appSpend.spendId })
      .from(appSpend)
      .where(and(eq(appSpend.status, "processing"), isNotNull(appSpend.expiresAt), lte(appSpend.expiresAt, before), isNull(appSpend.authRef)))
      .orderBy(asc(appSpend.expiresAt))
      .limit(limit);
    return rows.map((r) => r.spendId);
  },
});
