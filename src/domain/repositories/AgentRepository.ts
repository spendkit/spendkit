import type { Agent } from "../types/Entities.js";

/** app_agent: agents and their limits on a card. */
export interface AgentRepository {
  all(): Promise<Agent[]>;
  /** Oldest first. */
  listByCard(cardId: string): Promise<Agent[]>;
  find(cardId: string, agentId: string): Promise<Agent | undefined>;
  /** A non-revoked agent by its token hash, with the card's owner. */
  findActiveByTokenHash(tokenHash: string): Promise<{ cardId: string; agentId: string; name: string; userId: string } | undefined>;
  create(agent: {
    cardId: string;
    agentId: string;
    name: string;
    tokenHash: string;
    perTxnCents: number;
    dailyCents: number;
    allowedMccs: string[] | null;
    approvalAboveCents?: number | null;
  }): Promise<void>;
  /**
   * Sets the agent's limits. With `onlyIfApprovalAbove`, only while approval_above_cents still equals it (NULL-safe);
   * false when it had changed and nothing was written.
   */
  updateLimits(
    cardId: string, agentId: string,
    limits: { perTxnCents: number; dailyCents: number; allowedMccs: string[] | null; approvalAboveCents?: number | null },
    onlyIfApprovalAbove?: number | null,
  ): Promise<boolean>;
  /** Sets revoked_at to now, keeping an earlier revocation time. */
  revoke(cardId: string, agentId: string): Promise<void>;
}
