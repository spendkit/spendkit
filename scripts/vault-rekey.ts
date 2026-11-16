// Moves every card-vault row onto the current vault key after a key rotation.
//
//   1. Make a new key: openssl rand -base64 32
//   2. Restart the server with CARD_VAULT_KEY=<new>, CARD_VAULT_KEY_ID=<new id, e.g. v2> and
//      CARD_VAULT_OLD_KEYS=v1:<old key>. New cards are sealed under v2 and old rows still open.
//   3. Run this with the same environment: pnpm vault:rekey
//   4. Once it reports nothing left, drop CARD_VAULT_OLD_KEYS and destroy the old key.
//
// Safe to repeat and to run beside the server: each row is re-sealed atomically, audited as 'rekey', and a row
// that changed meanwhile is skipped. Prints counts only, never card data or key material.
import pg from "pg";
import { SealedCardVault, vaultKeyringFromEnv } from "../src/adapters/cardVault/CardVault.js";
import { createDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createCardVaultRepository } from "../src/db/repositories/createCardVaultRepository.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost/agent_cards", max: 2 });
try {
  await migrate(pool);
  const ring = vaultKeyringFromEnv(process.env);
  const repo = createCardVaultRepository(createDatabase(pool));
  const { moved, skipped } = await new SealedCardVault(repo, ring).rekeyAll();
  console.log(`re-sealed ${moved} row(s) under vault key ${ring.current.id}`);
  if (skipped.length) {
    console.log(`${skipped.length} row(s) are under a key not in CARD_VAULT_OLD_KEYS; add it and run again`);
    process.exitCode = 1;
  } else {
    console.log("no rows left under an old key: CARD_VAULT_OLD_KEYS can be removed and the old key destroyed");
  }
} finally {
  await pool.end();
}
