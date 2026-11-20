import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AgentRepository } from "../../domain/repositories/AgentRepository.js";
import type { Database } from "../client.js";
import { appAgent, appCard } from "../schema/index.js";

const agentKey = (cardId: string, agentId: string) => and(eq(appAgent.cardId, cardId), eq(appAgent.agentId, agentId));

export const createAgentRepository = (db: Database): AgentRepository => ({
  all() {
    return db.select().from(appAgent);
  },

  listByCard(cardId) {
    return db.select().from(appAgent).where(eq(appAgent.cardId, cardId)).orderBy(asc(appAgent.createdAt));
  },

  async find(cardId, agentId) {
    const [row] = await db.select().from(appAgent).where(agentKey(cardId, agentId));
    return row;
  },

  async findActiveByTokenHash(tokenHash) {
    const [row] = await db
      .select({ cardId: appAgent.cardId, agentId: appAgent.agentId, name: appAgent.name, userId: appCard.userId })
      .from(appAgent)
      .innerJoin(appCard, eq(appCard.cardId, appAgent.cardId))
      .where(and(eq(appAgent.tokenHash, tokenHash), isNull(appAgent.revokedAt)));
    return row;
  },

  async create(agent) {
    await db.insert(appAgent).values(agent);
  },

  async updateLimits(cardId, agentId, limits, onlyIfApprovalAbove) {
    const guard = onlyIfApprovalAbove === undefined ? undefined : sql`${appAgent.approvalAboveCents} IS NOT DISTINCT FROM ${onlyIfApprovalAbove}`;
    const r = await db.update(appAgent).set(limits).where(guard ? and(agentKey(cardId, agentId), guard) : agentKey(cardId, agentId))
      .returning({ id: appAgent.agentId });
    return r.length > 0;
  },

  async revoke(cardId, agentId) {
    await db
      .update(appAgent)
      .set({ revokedAt: sql`COALESCE(${appAgent.revokedAt}, now())` })
      .where(agentKey(cardId, agentId));
  },
});
