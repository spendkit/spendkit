import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { ApprovalRepository, IntentForApproval } from "../../domain/repositories/ApprovalRepository.js";
import type { UserRepository } from "../../domain/repositories/UserRepository.js";
import type { SpendStatus } from "../../domain/types/Entities.js";
import { badRequestError, conflictError, forbiddenError, notFoundError, unauthorizedError } from "../../errors.js";
import { approvalStatement, challengeCommitsTo, statementDigest, thresholdStatement } from "../services/approvalPolicy.js";
import type { ApprovalLoosening } from "./CardholderInteractor.js";

/** The one SpendIntents call approval needs: release a held intent's money when the owner denies it. */
export interface IntentReleasePort {
  releaseIntent(spendId: string, reason: "owner_denied" | "expired"): Promise<{ released: boolean; status: SpendStatus | null }>;
}

export interface ApprovalContext {
  approvals: ApprovalRepository;
  users: Pick<UserRepository, "findById">;
  intents: IntentReleasePort;
  /** The dashboard's public origin. The WebAuthn relying party is its host name, so it cannot be an IP address. */
  publicUrl: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** How the caller reached the owner API: the owner's own token (uk_) or a developer-issued session (us_). */
export type OwnerAuth = "owner_token" | "session";
export type Decision = "approve" | "deny";

const CHALLENGE_TTL_MS = 5 * 60_000;
const WEBAUTHN_TIMEOUT_MS = 2 * 60_000;

export interface IntentApprovalView {
  spendId: string;
  agentId: string;
  agentName: string;
  amountCents: number;
  maxAmountCents: number;
  currency: "USD";
  /** The agent's description of the merchant. Display only. */
  merchant: string;
  /** What the card authorization must match (these bind; the owner signs them). */
  merchantMatch: string | null;
  merchantAcceptorId: string | null;
  mcc: string | null;
  usesAllowed: number;
  /** Written by the agent. Show it as plain text, never as HTML. */
  context: string | null;
  expiresAt: string;
  status: string;
  approval: IntentForApproval["approval"];
  decision: { decision: "approved" | "denied"; decidedAt: string } | null;
}

function view(i: IntentForApproval, decision: IntentApprovalView["decision"] = null): IntentApprovalView {
  return {
    spendId: i.spendId, agentId: i.agentId, agentName: i.agentName, amountCents: i.amountCents, maxAmountCents: i.maxAmountCents,
    currency: "USD", merchant: i.merchant, merchantMatch: i.merchantMatch, merchantAcceptorId: i.merchantAcceptorId, mcc: i.mcc,
    usesAllowed: i.usesAllowed, context: i.context, expiresAt: i.expiresAt.toISOString(),
    status: i.status, approval: i.approval, decision,
  };
}

/** The challenge the browser signed, read from the response's clientDataJSON (verified properly afterwards). */
function signedChallenge(r: { response?: { clientDataJSON?: unknown } } | undefined): string {
  const cd = r?.response?.clientDataJSON;
  if (typeof cd !== "string") throw badRequestError("credential response is missing clientDataJSON");
  try {
    const c = (JSON.parse(Buffer.from(cd, "base64url").toString("utf8")) as { challenge?: unknown }).challenge;
    if (typeof c === "string" && c.length > 0 && c.length <= 128) return c;
  } catch { /* fall through */ }
  throw badRequestError("credential response has an unreadable clientDataJSON");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Human approval of spend intents. An intent above its agent's `approvalAboveCents` is created pending
 * (SpendIntents); the owner approves or denies it here with a WebAuthn passkey, before any card authorization can
 * match it. Every decision is stored with the signed assertion and the exact statement the owner saw.
 */
export class ApprovalInteractor {
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  readonly rpId: string;
  readonly origin: string;

  constructor(private readonly d: ApprovalContext) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? (() => undefined);
    const url = new URL(d.publicUrl);
    this.rpId = url.hostname;
    this.origin = url.origin;
  }

  /** Where the owner decides an intent; returned to the agent with `status: pending_approval`. */
  approvalUrl(spendId: string): string {
    return `${this.origin}/app/approve/${encodeURIComponent(spendId)}`;
  }

  // ---------- passkeys ----------

  async passkeys(userId: string) {
    const keys = await this.d.approvals.passkeysOf(userId);
    return {
      hasPasskey: keys.length > 0,
      passkeys: keys.map((k) => ({
        credentialId: k.credentialId, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        deviceType: k.deviceType, backedUp: k.backedUp, registeredVia: k.registeredVia,
      })),
    };
  }

  /** Options for enrolling the owner's passkey. First use only: a second passkey is refused (see docs). */
  async registrationOptions(userId: string) {
    if ((await this.d.approvals.passkeysOf(userId)).length) throw conflictError("a passkey is already registered");
    const user = await this.d.users.findById(userId);
    if (!user) throw notFoundError("user not found");
    const challenge = randomBytes(32);
    const options = await generateRegistrationOptions({
      rpName: "Spendkit",
      rpID: this.rpId,
      userName: user.email,
      userID: new Uint8Array(Buffer.from(userId, "utf8")),
      challenge: new Uint8Array(challenge),
      timeout: WEBAUTHN_TIMEOUT_MS,
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    await this.d.approvals.putChallenge({
      challenge: options.challenge, userId, purpose: "register", spendId: null, statement: null,
      expiresAt: new Date(this.now().getTime() + CHALLENGE_TTL_MS),
    });
    return options;
  }

  async register(userId: string, via: OwnerAuth, response: unknown) {
    if (!isObject(response)) throw badRequestError("credential is required");
    const challenge = signedChallenge(response);
    const c = await this.d.approvals.takeChallenge(challenge, userId, this.now());
    if (!c || c.purpose !== "register") throw unauthorizedError("unknown or expired registration challenge");
    let info;
    try {
      const v = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: c.challenge, expectedOrigin: this.origin, expectedRPID: this.rpId, requireUserVerification: true,
      });
      if (!v.verified) throw new Error("not verified");
      info = v.registrationInfo;
    } catch (e) {
      this.log(`passkey registration for ${userId} failed verification: ${(e as Error).message}`);
      throw unauthorizedError("passkey registration could not be verified");
    }
    const added = await this.d.approvals.addFirstPasskey({
      credentialId: info.credential.id, userId, publicKey: Buffer.from(info.credential.publicKey), signCount: info.credential.counter,
      transports: info.credential.transports ?? null, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, registeredVia: via,
    });
    if (added === "exists") throw conflictError("a passkey is already registered");
    // TODO(owner notice): email the owner here once the server can send email (Lin's review #3).
    this.log(`passkey registered for ${userId} via ${via}`);
    return this.passkeys(userId);
  }

  // ---------- intents ----------

  async listPending(userId: string): Promise<IntentApprovalView[]> {
    return (await this.d.approvals.listPending(userId, this.now())).map((i) => view(i));
  }

  async getIntent(userId: string, spendId: string): Promise<IntentApprovalView> {
    const i = await this.d.approvals.intentFor(userId, spendId);
    if (!i) throw notFoundError("intent not found");
    const dec = await this.d.approvals.decisionFor(spendId);
    return view(i, dec ? { decision: dec.decision, decidedAt: dec.decidedAt.toISOString() } : null);
  }

  /** The intent must still be awaiting a decision; throws 409 otherwise. */
  private assertPending(i: IntentForApproval): void {
    if (i.approval !== "pending" || i.status !== "processing") throw conflictError(`intent is no longer awaiting approval (${i.approval === "approved" ? "approved" : i.status})`);
    if (i.expiresAt <= this.now()) throw conflictError("intent has expired");
  }

  /**
   * WebAuthn request options for approving or denying one intent. The challenge commits to the statement returned
   * alongside it, so the owner's signature covers the amount, merchant, context and expiry they were shown.
   */
  async decisionOptions(userId: string, spendId: string, decision: Decision) {
    const intent = await this.d.approvals.intentFor(userId, spendId);
    if (!intent) throw notFoundError("intent not found");
    this.assertPending(intent);
    if (await this.d.approvals.decisionFor(spendId)) throw conflictError("intent has already been decided");
    const keys = await this.d.approvals.passkeysOf(userId);
    if (!keys.length) throw conflictError("register a passkey before deciding intents");
    const statement = approvalStatement(decision === "approve" ? "approved" : "denied", intent, this.rpId);
    const raw = Buffer.concat([randomBytes(16), statementDigest(statement)]);
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: keys.map((k) => ({ id: k.credentialId, ...(k.transports ? { transports: k.transports } : {}) })),
      challenge: new Uint8Array(raw),
      userVerification: "required",
      timeout: WEBAUTHN_TIMEOUT_MS,
    });
    const ttlEnd = Math.min(this.now().getTime() + CHALLENGE_TTL_MS, intent.expiresAt.getTime());
    await this.d.approvals.putChallenge({
      challenge: options.challenge, userId, purpose: decision, spendId, statement, expiresAt: new Date(ttlEnd),
    });
    return { options, statement: JSON.parse(statement) as Record<string, unknown> };
  }

  /** Verifies the owner's passkey assertion and records the decision. A denial then releases the intent's hold. */
  async decide(userId: string, spendId: string, decision: Decision, response: unknown): Promise<IntentApprovalView> {
    if (!isObject(response)) throw badRequestError("credential is required");
    const challenge = signedChallenge(response);
    const c = await this.d.approvals.takeChallenge(challenge, userId, this.now());
    if (!c || c.purpose !== decision || c.spendId !== spendId || !c.statement || !challengeCommitsTo(c.challenge, c.statement)) {
      throw unauthorizedError("unknown or expired approval challenge; ask for new options");
    }
    const { key, newCounter } = await this.verifyAssertion(userId, c.challenge, response, `intent ${spendId}`);
    const recorded = decision === "approve" ? "approved" : "denied";
    const r = await this.d.approvals.decide({
      spendId, userId, decision: recorded, credentialId: key.credentialId, newSignCount: newCounter, challenge: c.challenge,
      expectedStatement: c.statement, assertion: response, now: this.now(),
    }, (i) => approvalStatement(recorded, i, this.rpId));
    if (r.outcome === "not_found") throw notFoundError("intent not found");
    if (r.outcome === "not_pending") { this.assertPending(r.intent); throw conflictError("intent has already been decided"); }
    if (r.outcome === "counter_race") throw unauthorizedError("this passkey was used for another signature at the same moment; try again");
    if (r.outcome === "statement_mismatch") throw conflictError("the intent changed after these options were made; ask for new options");
    const decided = { decision: recorded, decidedAt: this.now().toISOString() } as const;
    if (recorded === "approved") {
      this.log(`intent ${spendId}: approved by owner ${userId}`);
      return view(r.intent, decided);
    }
    // Denied: release the hold. The intent stays pending until then, so nothing can authorize against it. If the
    // release fails here, the sweeper still releases it on expires_at; the denial evidence is already stored.
    try {
      const rel = await this.d.intents.releaseIntent(spendId, "owner_denied");
      if (rel.status) r.intent.status = rel.status;
      this.log(`intent ${spendId}: denied by owner ${userId}, hold ${rel.released ? "released" : "already released"}`);
    } catch (e) {
      this.log(`intent ${spendId}: denied, but releasing the hold failed (the sweeper will release it at expiry): ${(e as Error).message}`);
    }
    return view(r.intent, decided);
  }

  // ---------- loosening an agent's approval threshold ----------

  private async loosening(userId: string, agentId: string, toIn: unknown): Promise<ApprovalLoosening> {
    const agent = await this.d.approvals.agentFor(userId, agentId);
    if (!agent) throw notFoundError("agent not found");
    if (toIn !== null && (typeof toIn !== "number" || !Number.isSafeInteger(toIn) || toIn < 0)) {
      throw badRequestError("approvalAboveCents must be null or a whole number of cents, 0 or more");
    }
    const to = toIn as number | null;
    if (agent.approvalAboveCents === null || (to !== null && to <= agent.approvalAboveCents)) {
      throw badRequestError("this change does not raise or switch off the threshold, so it needs no passkey");
    }
    return { cardId: agent.cardId, agentId, agentName: agent.name, fromCents: agent.approvalAboveCents, toCents: to };
  }

  /**
   * WebAuthn request options to raise or switch off an agent's approval threshold. The challenge commits to
   * {agentId, from, to}; send the assertion as `credential` with the same `approvalAboveCents` to the limits route.
   */
  async loosenOptions(userId: string, agentId: string, approvalAboveCents: unknown) {
    const change = await this.loosening(userId, agentId, approvalAboveCents);
    const keys = await this.d.approvals.passkeysOf(userId);
    if (!keys.length) throw conflictError("you have no passkey; loosen the threshold with your own owner token instead");
    const statement = thresholdStatement(change, this.rpId);
    const raw = Buffer.concat([randomBytes(16), statementDigest(statement)]);
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: keys.map((k) => ({ id: k.credentialId, ...(k.transports ? { transports: k.transports } : {}) })),
      challenge: new Uint8Array(raw),
      userVerification: "required",
      timeout: WEBAUTHN_TIMEOUT_MS,
    });
    await this.d.approvals.putChallenge({
      challenge: options.challenge, userId, purpose: "loosen", spendId: null, statement,
      expiresAt: new Date(this.now().getTime() + CHALLENGE_TTL_MS),
    });
    return { options, statement: JSON.parse(statement) as Record<string, unknown> };
  }

  /**
   * Authorizes a raise or switch-off of an agent's approval threshold, on any owner route, and stores the evidence.
   * Once the owner has a passkey, it needs a passkey assertion over this exact change (`credential`), whatever token
   * the caller used. Without a passkey, only the owner's own token (uk_) may loosen; a developer session (us_) may not.
   * Throws when not authorized. CardholderInteractor.updateAgentLimits calls it (via the owner controller).
   */
  async authorizeLoosen(userId: string, via: OwnerAuth, change: ApprovalLoosening, credential: unknown): Promise<void> {
    const keys = await this.d.approvals.passkeysOf(userId);
    if (!keys.length) {
      if (via !== "owner_token") throw forbiddenError("raising or switching off approval needs the owner's own token or passkey");
      await this.d.approvals.recordApprovalChange({ ...change, userId, via: "owner_token", now: this.now() });
      this.log(`agent ${change.agentId}: approval threshold loosened ${change.fromCents} -> ${change.toCents} with the owner token`);
      return;
    }
    if (!isObject(credential)) {
      throw forbiddenError("raising or switching off approval needs your passkey: get options from POST /api/me/agents/:agentId/approval-threshold/options");
    }
    const statement = thresholdStatement(change, this.rpId);
    const challenge = signedChallenge(credential);
    const c = await this.d.approvals.takeChallenge(challenge, userId, this.now());
    if (!c || c.purpose !== "loosen" || !c.statement || !challengeCommitsTo(c.challenge, c.statement)) {
      throw unauthorizedError("unknown or expired passkey challenge; ask for new options");
    }
    if (c.statement !== statement) throw conflictError("the threshold changed after these options were made; ask for new options");
    const { key, newCounter } = await this.verifyAssertion(userId, c.challenge, credential, `agent ${change.agentId} threshold`);
    const r = await this.d.approvals.recordApprovalChange({
      ...change, userId, via: "passkey", now: this.now(),
      passkey: { credentialId: key.credentialId, newSignCount: newCounter, statement, challenge: c.challenge, assertion: credential },
    });
    if (r === "counter_race") throw unauthorizedError("this passkey was used for another signature at the same moment; try again");
    this.log(`agent ${change.agentId}: approval threshold loosened ${change.fromCents} -> ${change.toCents} with a passkey`);
  }

  private async verifyAssertion(userId: string, challenge: string, response: Record<string, unknown>, what: string) {
    const credentialId = typeof response.id === "string" ? response.id : "";
    const key = credentialId ? await this.d.approvals.findPasskey(credentialId) : undefined;
    if (!key || key.userId !== userId) throw forbiddenError("this passkey is not registered to you");
    try {
      const v = await verifyAuthenticationResponse({
        response: response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpId, requireUserVerification: true,
        credential: { id: key.credentialId, publicKey: new Uint8Array(key.publicKey), counter: key.signCount, ...(key.transports ? { transports: key.transports } : {}) },
      });
      if (!v.verified) throw new Error("not verified");
      return { key, newCounter: v.authenticationInfo.newCounter };
    } catch (e) {
      // Only the library's message is logged, never the assertion itself.
      this.log(`${what}: passkey assertion failed verification: ${(e as Error).message}`);
      throw unauthorizedError("passkey signature could not be verified");
    }
  }

  /** Drops expired challenges (background workers). */
  pruneChallenges(): Promise<number> {
    return this.d.approvals.pruneChallenges(this.now());
  }
}
