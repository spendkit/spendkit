// Gives an owner a new token, for an owner whose token expired (OWNER_TOKEN_IDLE_DAYS) or was lost. There is no
// self-service login yet, so an operator runs this after checking who is asking.
//
//   pnpm owner:token-reset -- someone@example.com
//
// The old token stops working at once. The new one is printed once and stored only as a hash: pass it to the owner
// over a channel you trust, and do not paste it into tickets or chat logs.
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const email = process.argv.slice(2).find((a) => a !== "--")?.trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("usage: pnpm owner:token-reset -- <owner email>");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost/agent_cards", max: 1 });
try {
  await migrate(pool);
  // Same format and hashing as CardholderInteractor.signup / rotateToken.
  const token = `uk_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const r = await pool.query("UPDATE app_user SET token_hash = $1, token_used_at = now() WHERE email = $2 RETURNING id", [hash, email]);
  if (!r.rowCount) {
    console.error("no owner with that email");
    process.exitCode = 1;
  } else {
    console.log(`new owner token for user ${r.rows[0].id} (the old one no longer works):\n${token}`);
  }
} finally {
  await pool.end();
}
