import { createHash } from "node:crypto";
import type { IntentForApproval } from "../../domain/repositories/ApprovalRepository.js";

/**
 * Whether a new intent must wait for its owner's passkey approval. Compared against the intent's max amount (the most
 * an authorization may reach), not its nominal amount, so a tip or FX tolerance cannot slip a payment past approval.
 * SpendIntents.createIntent calls this and inserts the intent with approval='pending' when it is true.
 */
export function approvalRequired(agent: { approvalAboveCents: number | null }, maxAmountCents: number): boolean {
  return agent.approvalAboveCents !== null && maxAmountCents > agent.approvalAboveCents;
}

/** The longest agent-written context the owner is shown (SpendIntents enforces it on create too). */
export const CONTEXT_MAX = 500;

/**
 * The canonical statement an owner signs when deciding an intent, as UTF-8 JSON with a fixed key order. The WebAuthn
 * challenge is base64url(nonce(16) || sha256(statement)), so the authenticator's signature over clientDataJSON
 * commits to exactly these details: anyone holding the stored evidence can re-hash the statement and check it.
 *
 * v2 signs what the card authorization actually binds on (SpendIntents' matcher): maxAmountCents, merchantMatch,
 * merchantAcceptorId, mcc, usesAllowed and expiresAt. `merchant`, `amountCents` and `context` are the agent's own
 * description, signed as "what the owner was shown" but never used to match a payment.
 */
export function approvalStatement(decision: "approved" | "denied", i: IntentForApproval, rpId: string): string {
  return JSON.stringify({
    v: 2,
    type: "spendkit.intent-decision",
    decision,
    rpId,
    spendId: i.spendId,
    cardId: i.cardId,
    agentId: i.agentId,
    currency: "USD",
    maxAmountCents: i.maxAmountCents,
    merchantMatch: i.merchantMatch,
    merchantAcceptorId: i.merchantAcceptorId,
    mcc: i.mcc,
    usesAllowed: i.usesAllowed,
    expiresAt: i.expiresAt.toISOString(),
    shown: { agentName: i.agentName, amountCents: i.amountCents, merchant: i.merchant, context: i.context },
  });
}

/**
 * What an owner signs to loosen an agent's approval threshold: raise it (`toCents` higher) or switch it off
 * (`toCents` null). `fromCents` pins the value they saw, so a concurrent change makes the signature stale.
 */
export function thresholdStatement(
  c: { cardId: string; agentId: string; agentName: string; fromCents: number; toCents: number | null }, rpId: string,
): string {
  return JSON.stringify({
    v: 1,
    type: "spendkit.approval-threshold",
    rpId,
    cardId: c.cardId,
    agentId: c.agentId,
    agentName: c.agentName,
    currency: "USD",
    fromCents: c.fromCents,
    toCents: c.toCents,
  });
}

export function statementDigest(statement: string): Buffer {
  return createHash("sha256").update(statement, "utf8").digest();
}

/** True when a base64url challenge is nonce(16) || sha256(statement). */
export function challengeCommitsTo(challenge: string, statement: string): boolean {
  const raw = Buffer.from(challenge, "base64url");
  return raw.length === 48 && raw.subarray(16).equals(statementDigest(statement));
}
