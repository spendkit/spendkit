import type { ApprovalDecision, ChallengePurpose } from "../../db/schema/approvals.js";

export interface Passkey {
  credentialId: string;
  userId: string;
  publicKey: Buffer;
  signCount: number;
  transports: string[] | null;
  deviceType: string | null;
  backedUp: boolean;
  registeredVia: "owner_token" | "session";
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface WebauthnChallenge {
  challenge: string;
  userId: string;
  purpose: ChallengePurpose;
  spendId: string | null;
  statement: string | null;
  expiresAt: Date;
}

/** An intent as the owner's approval screen sees it (app_spend with migration 014's columns, plus the agent's name). */
export interface IntentForApproval {
  spendId: string;
  cardId: string;
  agentId: string;
  agentName: string;
  amountCents: number;
  maxAmountCents: number;
  /** The agent's display text for the merchant. Display only: authorization matches on merchantMatch/merchantAcceptorId. */
  merchant: string;
  /** Normalised name the authorization's merchant name must contain (migration 014). Binds. */
  merchantMatch: string | null;
  /** Exact Miden merchantAcceptorId, when set. Binds. */
  merchantAcceptorId: string | null;
  /** When set, the authorization's MCC must equal it. Binds (the agent's allowed MCCs apply on top). */
  mcc: string | null;
  /** How many authorizations the intent allows (1 in v1). Binds. */
  usesAllowed: number;
  context: string | null;
  expiresAt: Date;
  status: string;
  approval: "none" | "pending" | "approved";
  createdAt: Date;
}

export type DecideOutcome =
  | { outcome: "recorded"; intent: IntentForApproval }
  | { outcome: "not_found" }
  /** No longer awaiting a decision: already decided, expired, released or authorized. */
  | { outcome: "not_pending"; intent: IntentForApproval }
  /** The intent no longer reads as the statement the owner signed. */
  | { outcome: "statement_mismatch" }
  /** Another assertion from the same passkey advanced its sign count first (parallel use or a cloned authenticator). */
  | { outcome: "counter_race" };

/** An agent as the threshold-loosening check sees it. */
export interface AgentForApproval {
  cardId: string;
  agentId: string;
  name: string;
  approvalAboveCents: number | null;
}

/** Evidence for one loosening of an agent's approval threshold. */
export interface ApprovalChange {
  cardId: string;
  agentId: string;
  userId: string;
  fromCents: number;
  toCents: number | null;
  via: "owner_token" | "passkey";
  passkey?: { credentialId: string; newSignCount: number; statement: string; challenge: string; assertion: Record<string, unknown> };
  now: Date;
}

/** Passkeys, WebAuthn challenges and signed decisions on spend intents (migration 016). */
export interface ApprovalRepository {
  passkeysOf(userId: string): Promise<Passkey[]>;
  findPasskey(credentialId: string): Promise<Passkey | undefined>;
  /** Adds the user's first passkey. "exists" when the user already has one (enrolment is first-use only). */
  addFirstPasskey(p: Omit<Passkey, "createdAt" | "lastUsedAt" | "signCount"> & { signCount: number }): Promise<"added" | "exists">;
  putChallenge(c: WebauthnChallenge): Promise<void>;
  /** Removes and returns the user's challenge if unexpired (single use). Another user's challenge is left alone. */
  takeChallenge(challenge: string, userId: string, now: Date): Promise<WebauthnChallenge | undefined>;
  /** Drops expired challenges. */
  pruneChallenges(now: Date): Promise<number>;
  /** An intent on the user's card. */
  intentFor(userId: string, spendId: string): Promise<IntentForApproval | undefined>;
  /** The user's intents awaiting a decision and not expired, soonest expiry first. */
  listPending(userId: string, now: Date): Promise<IntentForApproval[]>;
  /**
   * In one transaction: locks the intent row, requires approval='pending', status='processing' and an unexpired
   * expires_at, requires `statementOf(intent)` to equal `expectedStatement`, advances the passkey's sign count, appends
   * the evidence row and, for "approved", sets approval='approved'. A denial leaves approval='pending' (the hold is
   * released by SpendIntents.releaseIntent next, and nothing can authorize against a pending intent meanwhile).
   */
  decide(
    d: {
      spendId: string;
      userId: string;
      decision: ApprovalDecision;
      credentialId: string;
      newSignCount: number;
      challenge: string;
      expectedStatement: string;
      assertion: Record<string, unknown>;
      now: Date;
    },
    statementOf: (intent: IntentForApproval) => string,
  ): Promise<DecideOutcome>;
  /** An agent on the user's card. */
  agentFor(userId: string, agentId: string): Promise<AgentForApproval | undefined>;
  /** Appends threshold-loosening evidence, advancing the passkey's sign count first when one signed it. */
  recordApprovalChange(c: ApprovalChange): Promise<"recorded" | "counter_race">;
  /** The recorded decision on an intent, if any (dispute evidence). */
  decisionFor(spendId: string): Promise<{ decision: ApprovalDecision; credentialId: string; statement: string; challenge: string; assertion: Record<string, unknown>; decidedAt: Date; userId: string } | undefined>;
}
