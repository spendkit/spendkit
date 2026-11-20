import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { ApprovalRepository, IntentForApproval } from "../../domain/repositories/ApprovalRepository.js";
import type { Database, Executor } from "../client.js";
import { toSafeInt } from "../schema/columns.js";
import { appAgentApprovalChange, appPasskey, appSpendApproval, appWebauthnChallenge } from "../schema/index.js";

// The intent columns (expires_at, max_amount_cents, merchant_match, merchant_acceptor_id, uses_allowed, approval, context) come from migration 014, which belongs to the
// spend-intents work. They are read with SQL rather than through the Drizzle appSpend table, so this file does not
// depend on how that branch models them. app_spend.approval is the only one of them this file writes.

type IntentRow = {
  spend_id: string; card_id: string; agent_id: string; agent_name: string; amount_cents: string; max_amount_cents: string | null;
  merchant: string; merchant_match: string | null; merchant_acceptor_id: string | null; uses_allowed: number; mcc: string | null; context: string | null; expires_at: Date; status: string; approval: string; created_at: Date;
};

const INTENT_COLUMNS = sql`s.spend_id, s.card_id, s.agent_id, a.name AS agent_name, s.amount_cents, s.max_amount_cents, s.merchant,
  s.merchant_match, s.merchant_acceptor_id, s.uses_allowed, s.mcc,
  s.context, s.expires_at, s.status, s.approval, s.created_at`;
const INTENT_FROM = sql`app_spend s
  JOIN app_card c ON c.card_id = s.card_id
  JOIN app_agent a ON a.card_id = s.card_id AND a.agent_id = s.agent_id`;

function intentOf(r: IntentRow): IntentForApproval {
  return {
    spendId: r.spend_id, cardId: r.card_id, agentId: r.agent_id, agentName: r.agent_name,
    amountCents: toSafeInt(r.amount_cents),
    maxAmountCents: toSafeInt(r.max_amount_cents ?? r.amount_cents),
    merchant: r.merchant, merchantMatch: r.merchant_match, merchantAcceptorId: r.merchant_acceptor_id, usesAllowed: Number(r.uses_allowed), mcc: r.mcc, context: r.context, expiresAt: new Date(r.expires_at), status: r.status,
    approval: r.approval as IntentForApproval["approval"], createdAt: new Date(r.created_at),
  };
}

async function selectIntent(ex: Executor, userId: string, spendId: string, lock: boolean): Promise<IntentForApproval | undefined> {
  const r = await ex.execute<IntentRow>(sql`SELECT ${INTENT_COLUMNS} FROM ${INTENT_FROM}
    WHERE s.spend_id = ${spendId} AND c.user_id = ${userId} ${lock ? sql`FOR UPDATE OF s` : sql``}`);
  const row = r.rows[0];
  return row ? intentOf(row) : undefined;
}

/**
 * Advances a passkey's sign count only if the new count is higher (or the authenticator does not count, 0), so two
 * parallel assertions with the same count cannot both pass. False when another assertion got there first.
 */
async function bumpSignCount(ex: Executor, credentialId: string, newCount: number, now: Date): Promise<boolean> {
  const r = await ex.update(appPasskey).set({ signCount: newCount, lastUsedAt: now })
    .where(and(eq(appPasskey.credentialId, credentialId), or(sql`${appPasskey.signCount} < ${newCount}`, sql`${newCount} = 0`)))
    .returning({ id: appPasskey.credentialId });
  return r.length > 0;
}

export const createApprovalRepository = (db: Database): ApprovalRepository => ({
  passkeysOf(userId) {
    return db.select().from(appPasskey).where(eq(appPasskey.userId, userId)).orderBy(asc(appPasskey.createdAt));
  },

  async findPasskey(credentialId) {
    const [row] = await db.select().from(appPasskey).where(eq(appPasskey.credentialId, credentialId));
    return row;
  },

  async addFirstPasskey(p) {
    return db.transaction(async (tx) => {
      // The user row lock serialises two enrolments racing each other, so a user never ends up with two "first" keys.
      await tx.execute(sql`SELECT 1 FROM app_user WHERE id = ${p.userId} FOR UPDATE`);
      const [existing] = await tx.select({ id: appPasskey.credentialId }).from(appPasskey).where(eq(appPasskey.userId, p.userId)).limit(1);
      if (existing) return "exists" as const;
      await tx.insert(appPasskey).values(p);
      return "added" as const;
    });
  },

  async putChallenge(c) {
    await db.insert(appWebauthnChallenge).values(c);
  },

  async takeChallenge(challenge, userId, now) {
    // user_id is in the WHERE, so one user cannot burn another user's outstanding challenge.
    const [row] = await db.delete(appWebauthnChallenge)
      .where(and(eq(appWebauthnChallenge.challenge, challenge), eq(appWebauthnChallenge.userId, userId))).returning();
    if (!row || row.expiresAt <= now) return undefined;
    return row;
  },

  async pruneChallenges(now) {
    const r = await db.delete(appWebauthnChallenge).where(lte(appWebauthnChallenge.expiresAt, now)).returning({ c: appWebauthnChallenge.challenge });
    return r.length;
  },

  intentFor(userId, spendId) {
    return selectIntent(db, userId, spendId, false);
  },

  async listPending(userId, now) {
    const r = await db.execute<IntentRow>(sql`SELECT ${INTENT_COLUMNS} FROM ${INTENT_FROM}
      WHERE c.user_id = ${userId} AND s.approval = 'pending' AND s.status = 'processing' AND s.expires_at > ${now}
        AND NOT EXISTS (SELECT 1 FROM app_spend_approval d WHERE d.spend_id = s.spend_id)
      ORDER BY s.expires_at ASC LIMIT 100`);
    return r.rows.map(intentOf);
  },

  async decide(d, statementOf) {
    return db.transaction(async (tx) => {
      const intent = await selectIntent(tx, d.userId, d.spendId, true);
      if (!intent) return { outcome: "not_found" as const };
      if (intent.approval !== "pending" || intent.status !== "processing" || intent.expiresAt <= d.now) return { outcome: "not_pending" as const, intent };
      // A denial whose hold release has not happened yet still reads as pending: it is decided all the same.
      const [prior] = await tx.select({ d: appSpendApproval.decision }).from(appSpendApproval).where(eq(appSpendApproval.spendId, d.spendId));
      if (prior) return { outcome: "not_pending" as const, intent };
      if (statementOf(intent) !== d.expectedStatement) return { outcome: "statement_mismatch" as const };
      if (!(await bumpSignCount(tx, d.credentialId, d.newSignCount, d.now))) return { outcome: "counter_race" as const };
      await tx.insert(appSpendApproval).values({
        spendId: d.spendId, userId: d.userId, decision: d.decision, credentialId: d.credentialId,
        statement: d.expectedStatement, challenge: d.challenge, assertion: d.assertion, decidedAt: d.now,
      });
      if (d.decision === "approved") {
        await tx.execute(sql`UPDATE app_spend SET approval = 'approved' WHERE spend_id = ${d.spendId} AND approval = 'pending'`);
        intent.approval = "approved";
      }
      return { outcome: "recorded" as const, intent };
    });
  },

  async agentFor(userId, agentId) {
    const r = await db.execute<{ card_id: string; agent_id: string; name: string; approval_above_cents: string | null }>(sql`
      SELECT a.card_id, a.agent_id, a.name, a.approval_above_cents FROM app_agent a JOIN app_card c ON c.card_id = a.card_id
      WHERE c.user_id = ${userId} AND a.agent_id = ${agentId}`);
    const row = r.rows[0];
    return row ? {
      cardId: row.card_id, agentId: row.agent_id, name: row.name,
      approvalAboveCents: row.approval_above_cents === null ? null : toSafeInt(row.approval_above_cents),
    } : undefined;
  },

  async recordApprovalChange(c) {
    return db.transaction(async (tx) => {
      if (c.passkey && !(await bumpSignCount(tx, c.passkey.credentialId, c.passkey.newSignCount, c.now))) return "counter_race" as const;
      await tx.insert(appAgentApprovalChange).values({
        cardId: c.cardId, agentId: c.agentId, userId: c.userId, fromCents: c.fromCents, toCents: c.toCents, via: c.via,
        credentialId: c.passkey?.credentialId ?? null, statement: c.passkey?.statement ?? null,
        challenge: c.passkey?.challenge ?? null, assertion: c.passkey?.assertion ?? null, changedAt: c.now,
      });
      return "recorded" as const;
    });
  },

  async decisionFor(spendId) {
    const [row] = await db.select().from(appSpendApproval).where(eq(appSpendApproval.spendId, spendId));
    return row;
  },
});
