import { and, eq, ne, sql } from "drizzle-orm";
import type { CardVaultRepository } from "../../domain/repositories/CardVaultRepository.js";
import type { Database } from "../client.js";
import { cardVault, cardVaultAudit } from "../schema/index.js";

export const createCardVaultRepository = (db: Database): CardVaultRepository => ({
  async store(cardId, box, meta) {
    await db.transaction(async (tx) => {
      const sealed = { keyId: box.keyId, iv: box.iv, ciphertext: box.ciphertext, tag: box.tag, last4: meta.last4, source: meta.source };
      const [row] = await tx
        .insert(cardVault)
        .values({ cardId, ...sealed })
        .onConflictDoUpdate({ target: cardVault.cardId, set: { ...sealed, updatedAt: sql`now()` } })
        // xmax = 0 only on a freshly inserted row: tells a first capture from an overwrite.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      await tx.insert(cardVaultAudit).values({ cardId, action: row!.inserted ? "put" : "overwrite", purpose: `capture:${meta.source}` });
    });
  },

  async find(cardId) {
    const [row] = await db
      .select({ keyId: cardVault.keyId, iv: cardVault.iv, ciphertext: cardVault.ciphertext, tag: cardVault.tag })
      .from(cardVault)
      .where(eq(cardVault.cardId, cardId));
    return row;
  },

  async exists(cardId) {
    const [row] = await db.select({ cardId: cardVault.cardId }).from(cardVault).where(eq(cardVault.cardId, cardId));
    return row !== undefined;
  },

  async remove(cardId) {
    const deleted = await db.delete(cardVault).where(eq(cardVault.cardId, cardId)).returning({ cardId: cardVault.cardId });
    return deleted.length > 0;
  },

  async audit(cardId, action, purpose) {
    await db.insert(cardVaultAudit).values({ cardId, action, purpose });
  },

  async idsNotUnderKey(keyId) {
    const rows = await db.select({ cardId: cardVault.cardId }).from(cardVault).where(ne(cardVault.keyId, keyId));
    return rows.map((r) => r.cardId);
  },

  async rekey(cardId, fromKeyId, box) {
    return db.transaction(async (tx) => {
      const updated = await tx
        .update(cardVault)
        .set({ keyId: box.keyId, iv: box.iv, ciphertext: box.ciphertext, tag: box.tag, updatedAt: sql`now()` })
        .where(and(eq(cardVault.cardId, cardId), eq(cardVault.keyId, fromKeyId)))
        .returning({ cardId: cardVault.cardId });
      if (!updated.length) return false;
      await tx.insert(cardVaultAudit).values({ cardId, action: "rekey", purpose: `rekey:${fromKeyId}->${box.keyId}` });
      return true;
    });
  },
});
