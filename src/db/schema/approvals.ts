import { sql } from "drizzle-orm";
import { bigserial, boolean, check, foreignKey, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { appAgent, appSpend, appUser } from "./cardholders.js";
import { bigintNumber, bytea, timestamptz } from "./columns.js";

// Human approval of spend intents (migration 016): the owner's passkeys, outstanding WebAuthn challenges, and each
// signed decision kept as dispute evidence.

export const appPasskey = pgTable(
  "app_passkey",
  {
    credentialId: text("credential_id").primaryKey(),
    userId: text("user_id").notNull(),
    publicKey: bytea("public_key").notNull(),
    signCount: bigintNumber("sign_count").notNull().default(0),
    transports: text("transports").array(),
    deviceType: text("device_type"),
    backedUp: boolean("backed_up").notNull().default(false),
    registeredVia: text("registered_via", { enum: ["owner_token", "session"] }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    lastUsedAt: timestamptz("last_used_at"),
  },
  (t) => [
    foreignKey({ name: "app_passkey_user_id_fkey", columns: [t.userId], foreignColumns: [appUser.id] }),
    index("app_passkey_user_id_idx").on(t.userId),
    check("app_passkey_registered_via_check", sql`${t.registeredVia} IN ('owner_token', 'session')`),
  ],
);

export const CHALLENGE_PURPOSES = ["register", "approve", "deny", "loosen"] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

export const appWebauthnChallenge = pgTable(
  "app_webauthn_challenge",
  {
    challenge: text("challenge").primaryKey(),
    userId: text("user_id").notNull(),
    purpose: text("purpose", { enum: CHALLENGE_PURPOSES }).notNull(),
    spendId: text("spend_id"),
    statement: text("statement"),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "app_webauthn_challenge_user_id_fkey", columns: [t.userId], foreignColumns: [appUser.id] }),
    foreignKey({ name: "app_webauthn_challenge_spend_id_fkey", columns: [t.spendId], foreignColumns: [appSpend.spendId] }),
    index("app_webauthn_challenge_expires_at_idx").on(t.expiresAt),
    check("app_webauthn_challenge_purpose_check", sql`${t.purpose} IN ('register', 'approve', 'deny', 'loosen')`),
    check("app_webauthn_challenge_check", sql`(${t.purpose} IN ('approve', 'deny')) = (${t.spendId} IS NOT NULL)`),
  ],
);

export const APPROVAL_DECISIONS = ["approved", "denied"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** One signed decision per intent. Append-only, enforced by triggers (migration 016). */
export const appSpendApproval = pgTable(
  "app_spend_approval",
  {
    spendId: text("spend_id").primaryKey(),
    userId: text("user_id").notNull(),
    decision: text("decision", { enum: APPROVAL_DECISIONS }).notNull(),
    credentialId: text("credential_id").notNull(),
    /** The canonical JSON the owner saw; the signed challenge is base64url(nonce(16) || sha256(statement)). */
    statement: text("statement").notNull(),
    challenge: text("challenge").notNull(),
    /** The WebAuthn AuthenticationResponseJSON exactly as the browser sent it. */
    assertion: jsonb("assertion").$type<Record<string, unknown>>().notNull(),
    decidedAt: timestamptz("decided_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "app_spend_approval_spend_id_fkey", columns: [t.spendId], foreignColumns: [appSpend.spendId] }),
    foreignKey({ name: "app_spend_approval_user_id_fkey", columns: [t.userId], foreignColumns: [appUser.id] }),
    foreignKey({ name: "app_spend_approval_credential_id_fkey", columns: [t.credentialId], foreignColumns: [appPasskey.credentialId] }),
    check("app_spend_approval_decision_check", sql`${t.decision} IN ('approved', 'denied')`),
  ],
);

/**
 * Every loosening of an agent's approval threshold (raised or switched off), with the owner's passkey assertion when
 * they have a passkey. Append-only, enforced by triggers (migration 016).
 */
export const appAgentApprovalChange = pgTable(
  "app_agent_approval_change",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cardId: text("card_id").notNull(),
    agentId: text("agent_id").notNull(),
    userId: text("user_id").notNull(),
    fromCents: bigintNumber("from_cents").notNull(),
    toCents: bigintNumber("to_cents"),
    via: text("via", { enum: ["owner_token", "passkey"] }).notNull(),
    credentialId: text("credential_id"),
    statement: text("statement"),
    challenge: text("challenge"),
    assertion: jsonb("assertion").$type<Record<string, unknown>>(),
    changedAt: timestamptz("changed_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "app_agent_approval_change_card_id_agent_id_fkey", columns: [t.cardId, t.agentId], foreignColumns: [appAgent.cardId, appAgent.agentId] }),
    foreignKey({ name: "app_agent_approval_change_user_id_fkey", columns: [t.userId], foreignColumns: [appUser.id] }),
    foreignKey({ name: "app_agent_approval_change_credential_id_fkey", columns: [t.credentialId], foreignColumns: [appPasskey.credentialId] }),
    check("app_agent_approval_change_via_check", sql`${t.via} IN ('owner_token', 'passkey')`),
    check("app_agent_approval_change_check", sql`(${t.via} = 'passkey') = (${t.credentialId} IS NOT NULL AND ${t.statement} IS NOT NULL AND ${t.challenge} IS NOT NULL AND ${t.assertion} IS NOT NULL)`),
  ],
);
