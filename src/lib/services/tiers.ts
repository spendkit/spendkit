import type { FundingReceipt, Stablecoin } from "../../domain/interfaces/FundingSource.js";
import type { SpendPolicy } from "./spendPolicy.js";
import type { AgentCard, CardholderKyc, CardIssuerPort } from "../../domain/interfaces/CardIssuing.js";

export type Tier = "quick" | "full";

export interface TierLimits {
  perTransactionCents: number;
  dailyCents: number;
  /** Total a user may ever load onto cards at this tier. */
  lifetimeFundedCents: number;
}

/** PLACEHOLDER amounts: thresholds are not set. Inject real values. */
export const DEFAULT_TIERS: Record<Tier, TierLimits> = {
  quick: { perTransactionCents: 5_000, dailyCents: 10_000, lifetimeFundedCents: 50_000 },
  full: { perTransactionCents: 100_000, dailyCents: 500_000, lifetimeFundedCents: Number.MAX_SAFE_INTEGER },
};

const TIER_FIELDS = ["perTransactionCents", "dailyCents", "lifetimeFundedCents"] as const;

/**
 * The tier caps for this deployment: DEFAULT_TIERS with TIER_LIMITS (JSON) laid over it, field by field, e.g.
 * `{"quick":{"perTransactionCents":2500,"dailyCents":5000,"lifetimeFundedCents":25000}}`. Read once at startup, before
 * any KYC or card issue, because a card's limits at the provider are copied from its tier when it is issued.
 * Production refuses to start without TIER_LIMITS: the defaults are placeholders.
 */
export function tiersFromEnv(raw: string | undefined, opts: { production: boolean }): Record<Tier, TierLimits> {
  if (raw === undefined || raw.trim() === "") {
    if (opts.production) throw new Error("APP_ENV=production needs TIER_LIMITS (the default tier caps are placeholders)");
    return DEFAULT_TIERS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TIER_LIMITS must be JSON, e.g. {\"quick\":{\"perTransactionCents\":2500}}");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("TIER_LIMITS must be a JSON object keyed by tier");
  const out = { quick: { ...DEFAULT_TIERS.quick }, full: { ...DEFAULT_TIERS.full } } as Record<Tier, TierLimits>;
  for (const [tier, over] of Object.entries(parsed as Record<string, unknown>)) {
    if (tier !== "quick" && tier !== "full") throw new Error(`TIER_LIMITS: unknown tier "${tier}" (quick or full)`);
    if (typeof over !== "object" || over === null || Array.isArray(over)) throw new Error(`TIER_LIMITS.${tier} must be an object`);
    for (const [field, v] of Object.entries(over as Record<string, unknown>)) {
      if (!(TIER_FIELDS as readonly string[]).includes(field)) throw new Error(`TIER_LIMITS.${tier}: unknown field "${field}" (${TIER_FIELDS.join(", ")})`);
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error(`TIER_LIMITS.${tier}.${field} must be a positive whole number of cents`);
      out[tier][field as (typeof TIER_FIELDS)[number]] = v;
    }
  }
  for (const tier of ["quick", "full"] as const) {
    const l = out[tier];
    if (l.perTransactionCents > l.dailyCents) throw new Error(`TIER_LIMITS.${tier}: perTransactionCents cannot be more than dailyCents`);
    if (l.dailyCents > l.lifetimeFundedCents) throw new Error(`TIER_LIMITS.${tier}: dailyCents cannot be more than lifetimeFundedCents`);
  }
  for (const field of TIER_FIELDS) {
    if (out.quick[field] > out.full[field]) throw new Error(`TIER_LIMITS: quick.${field} cannot be more than full.${field}`);
  }
  return out;
}

export type TierDecision = { ok: true } | { ok: false; reason: string; upgradeRequired: boolean };

/** Clamps a requested policy to the tier's caps; never raises it. */
export function capPolicy(limits: TierLimits, requested: SpendPolicy): SpendPolicy {
  return {
    ...requested,
    perTransactionCents: Math.min(requested.perTransactionCents, limits.perTransactionCents),
    dailyCents: Math.min(requested.dailyCents, limits.dailyCents),
  };
}

export interface TieredCard extends AgentCard {
  userId: string;
  tier: Tier;
}

/**
 * Every user completes their own Card KYC at signup and gets one real card under their own customer at the card provider.
 * The tier is how deep that KYC was: "quick" (fast check, low limits) or "full" (more verification, higher limits).
 * Funding past a quick user's lifetime cap is refused until they reach "full".
 */
export class TieredCardIssuer {
  /** Funded per user, in memory only (lost on restart); persist before production. */
  private readonly funded = new Map<string, number>();

  constructor(
    private readonly cards: Pick<CardIssuerPort, "issue" | "topUp" | "authorize">,
    private readonly tiers: Record<Tier, TierLimits> = DEFAULT_TIERS,
  ) {}

  /** One card per user. The card's limits are the tier's caps (pushed to the provider as card limits). */
  async issue(userId: string, kyc: CardholderKyc, tier: Tier, clientReference: string): Promise<TieredCard> {
    const limits = this.tiers[tier];
    const policy = capPolicy(limits, { perTransactionCents: limits.perTransactionCents, dailyCents: limits.dailyCents });
    const card = await this.cards.issue(`user-${userId}`, policy, kyc, clientReference);
    return { ...card, userId, tier };
  }

  limits(tier: Tier): TierLimits {
    return this.tiers[tier];
  }

  /** Checks a load against the user's remaining lifetime allowance. Does not record it. */
  checkFunding(userId: string, tier: Tier, amountCents: number): TierDecision {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return { ok: false, reason: "amount must be a positive whole number of cents", upgradeRequired: false };
    }
    const cap = this.tiers[tier].lifetimeFundedCents;
    if ((this.funded.get(userId) ?? 0) + amountCents > cap) {
      return {
        ok: false,
        reason: tier === "quick" ? "funding limit reached; verify identity to raise it" : "funding limit reached",
        upgradeRequired: tier === "quick",
      };
    }
    return { ok: true };
  }

  async topUp(card: TieredCard, amountCents: number, asset: Stablecoin, idempotencyKey: string): Promise<FundingReceipt> {
    const decision = this.checkFunding(card.userId, card.tier, amountCents);
    if (!decision.ok) throw new Error(decision.reason);
    // Reserve before awaiting so concurrent loads cannot both pass the cap; release if the load fails.
    this.funded.set(card.userId, (this.funded.get(card.userId) ?? 0) + amountCents);
    try {
      return await this.cards.topUp(card, amountCents, asset, idempotencyKey);
    } catch (err) {
      this.funded.set(card.userId, (this.funded.get(card.userId) ?? 0) - amountCents);
      throw err;
    }
  }
}
