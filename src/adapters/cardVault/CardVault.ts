import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CardVaultRepository } from "../../domain/repositories/CardVaultRepository.js";

/**
 * Full card details of a one-time card, captured from Miden at issue and held only until its single checkout.
 * Never log, return to an agent, or send to a merchant: only the checkout swap reads them, and only through
 * CardVault.reveal (audited). Reusable cards' details are never captured.
 */
export interface CardDetails {
  pan: string;
  cvv: string;
  /** 1-12. */
  expMonth: number;
  /** Four digits, e.g. 2028. */
  expYear: number;
  nameOnCard?: string;
  billingZip?: string;
  /**
   * Street billing address. Some Stripe Checkout sessions (tax collection, billing_address_collection=required)
   * will not submit without it; without one on file the filler stops before paying.
   */
  billingAddress?: BillingAddress;
}

export interface BillingAddress {
  line1: string;
  line2?: string;
  city: string;
  /** Two-letter state or region code, e.g. "CA". */
  state?: string;
  /** ISO 3166 alpha-2, e.g. "US". */
  country: string;
}

/** Where the details came from: the issue response's secureCardDetails, or the full-PAN endpoint. */
export type CaptureSource = "issue" | "full-pan";

export interface CardVault {
  put(cardId: string, details: CardDetails, opts?: { source?: CaptureSource }): Promise<void>;
  /** Audited: every call writes a row with `purpose` before anything is decrypted. null if nothing is stored. */
  reveal(cardId: string, purpose: string): Promise<CardDetails | null>;
  has(cardId: string): Promise<boolean>;
  /** Deletes a card's stored details (audited). For one-time cards once their checkout has been filled. */
  discard(cardId: string, purpose: string): Promise<void>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** CARD_VAULT_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). The value never appears in an error. */
export function vaultKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.CARD_VAULT_KEY;
  if (!raw) throw new Error("Missing env var CARD_VAULT_KEY");
  return decodeKey(raw, "CARD_VAULT_KEY");
}

/**
 * The vault's keys: the current one seals everything new; older ones (after a rotation) can still open rows sealed
 * under them until `rekey()` has moved those rows to the current key. Ids are stored with each row.
 */
export interface VaultKeyring {
  current: { id: string; key: Buffer };
  old?: Record<string, Buffer>;
}

const KEY_ID_RE = /^[A-Za-z0-9_.-]{1,32}$/;

function decodeKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error(`${name} must be ${KEY_BYTES} bytes, base64-encoded`);
  return key;
}

/**
 * CARD_VAULT_KEY (current key) and CARD_VAULT_KEY_ID (its id, default "v1"); after a rotation, CARD_VAULT_OLD_KEYS
 * lists the previous keys as `id:base64` pairs separated by commas, until scripts/vault-rekey.ts has moved every row.
 * No key value ever appears in an error.
 */
export function vaultKeyringFromEnv(env: NodeJS.ProcessEnv = process.env): VaultKeyring {
  const id = env.CARD_VAULT_KEY_ID?.trim() || "v1";
  if (!KEY_ID_RE.test(id)) throw new Error("CARD_VAULT_KEY_ID must be 1-32 letters, digits, '_', '.' or '-'");
  const old: Record<string, Buffer> = {};
  for (const part of (env.CARD_VAULT_OLD_KEYS ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const oldId = i > 0 ? part.slice(0, i) : "";
    if (!KEY_ID_RE.test(oldId)) throw new Error("CARD_VAULT_OLD_KEYS entries must be id:base64key");
    if (oldId === id || oldId in old) throw new Error(`CARD_VAULT_OLD_KEYS repeats key id ${oldId}`);
    old[oldId] = decodeKey(part.slice(i + 1), `CARD_VAULT_OLD_KEYS (${oldId})`);
  }
  return { current: { id, key: vaultKeyFromEnv(env) }, old };
}

export function validateDetails(d: CardDetails): void {
  if (!/^\d{12,19}$/.test(d.pan)) throw new Error("card details: pan must be 12-19 digits");
  if (!/^\d{3,4}$/.test(d.cvv)) throw new Error("card details: cvv must be 3-4 digits");
  if (!Number.isInteger(d.expMonth) || d.expMonth < 1 || d.expMonth > 12) throw new Error("card details: bad expMonth");
  if (!Number.isInteger(d.expYear) || d.expYear < 2000 || d.expYear > 2099) throw new Error("card details: bad expYear");
}

function checkPurpose(purpose: string): void {
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 200) throw new Error("reveal needs a purpose (1-200 chars)");
}

/** AES-256-GCM, random 96-bit IV per record, card id bound in as AAD so a row cannot be moved to another card. */
export function seal(key: Buffer, cardId: string, details: CardDetails): { iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`card-vault:v1:${cardId}`));
  const ciphertext = Buffer.concat([c.update(JSON.stringify(details), "utf8"), c.final()]);
  return { iv, ciphertext, tag: c.getAuthTag() };
}

export function open(key: Buffer, cardId: string, box: { iv: Buffer; ciphertext: Buffer; tag: Buffer }): CardDetails {
  const d = createDecipheriv("aes-256-gcm", key, box.iv);
  d.setAAD(Buffer.from(`card-vault:v1:${cardId}`));
  d.setAuthTag(box.tag);
  return JSON.parse(Buffer.concat([d.update(box.ciphertext), d.final()]).toString("utf8")) as CardDetails;
}

/**
 * The production vault: seals details in this process (the key never reaches the database) and keeps the sealed
 * boxes and the audit trail in a CardVaultRepository.
 */
export class SealedCardVault implements CardVault {
  private readonly key: Buffer;
  private readonly keyId: string;
  private readonly oldKeys = new Map<string, Buffer>();

  /** A keyring, or (one key, no rotation) a bare key and its id. The key id is stored with each row. */
  constructor(private readonly repo: CardVaultRepository, keys: VaultKeyring | Buffer, keyId = "v1") {
    const ring: VaultKeyring = Buffer.isBuffer(keys) ? { current: { id: keyId, key: keys } } : keys;
    for (const k of [ring.current.key, ...Object.values(ring.old ?? {})]) {
      if (k.length !== KEY_BYTES) throw new Error(`vault key must be ${KEY_BYTES} bytes`);
    }
    this.key = Buffer.from(ring.current.key);
    this.keyId = ring.current.id;
    for (const [id, k] of Object.entries(ring.old ?? {})) this.oldKeys.set(id, Buffer.from(k));
  }

  private keyFor(cardId: string, keyId: string): Buffer {
    const key = keyId === this.keyId ? this.key : this.oldKeys.get(keyId);
    if (!key) throw new Error(`card ${cardId} is sealed under vault key ${keyId}, which this process does not have`);
    return key;
  }

  async put(cardId: string, details: CardDetails, opts: { source?: CaptureSource } = {}): Promise<void> {
    validateDetails(details);
    await this.repo.store(cardId, { keyId: this.keyId, ...seal(this.key, cardId, details) }, { last4: details.pan.slice(-4), source: opts.source ?? "issue" });
  }

  async reveal(cardId: string, purpose: string): Promise<CardDetails | null> {
    checkPurpose(purpose);
    const box = await this.repo.find(cardId);
    // The audit row is written before decrypting: no audit, no reveal.
    await this.repo.audit(cardId, box ? "reveal" : "reveal_miss", purpose);
    if (!box) return null;
    return open(this.keyFor(cardId, box.keyId), cardId, box);
  }

  /**
   * Re-seals every row still under an older key with the current key (each audited as 'rekey'). Safe to repeat and
   * to run beside live traffic: a row that changed meanwhile is skipped. Returns how many rows moved and which
   * could not (no key for them here).
   */
  async rekeyAll(): Promise<{ moved: number; skipped: string[] }> {
    let moved = 0;
    const skipped: string[] = [];
    for (const cardId of await this.repo.idsNotUnderKey(this.keyId)) {
      const box = await this.repo.find(cardId);
      if (!box || box.keyId === this.keyId) continue;
      const oldKey = this.oldKeys.get(box.keyId);
      if (!oldKey) {
        skipped.push(cardId);
        continue;
      }
      const details = open(oldKey, cardId, box);
      try {
        if (await this.repo.rekey(cardId, box.keyId, { keyId: this.keyId, ...seal(this.key, cardId, details) })) moved++;
      } finally {
        details.pan = details.cvv = "";
      }
    }
    return { moved, skipped };
  }

  has(cardId: string): Promise<boolean> {
    return this.repo.exists(cardId);
  }

  async discard(cardId: string, purpose: string): Promise<void> {
    checkPurpose(purpose);
    if (await this.repo.remove(cardId)) await this.repo.audit(cardId, "discard", purpose);
  }
}

/** In-memory vault for tests: same sealing and audit semantics, no database. */
export class MemoryCardVault implements CardVault {
  readonly audit: { cardId: string; action: string; purpose: string }[] = [];
  private readonly rows = new Map<string, ReturnType<typeof seal>>();
  private readonly key: Buffer;

  constructor(key: Buffer = randomBytes(KEY_BYTES)) {
    this.key = Buffer.from(key);
  }

  async put(cardId: string, details: CardDetails, opts: { source?: CaptureSource } = {}): Promise<void> {
    validateDetails(details);
    const existed = this.rows.has(cardId);
    this.rows.set(cardId, seal(this.key, cardId, details));
    this.audit.push({ cardId, action: existed ? "overwrite" : "put", purpose: `capture:${opts.source ?? "issue"}` });
  }

  async reveal(cardId: string, purpose: string): Promise<CardDetails | null> {
    checkPurpose(purpose);
    const box = this.rows.get(cardId);
    this.audit.push({ cardId, action: box ? "reveal" : "reveal_miss", purpose });
    return box ? open(this.key, cardId, box) : null;
  }

  async has(cardId: string): Promise<boolean> {
    return this.rows.has(cardId);
  }

  async discard(cardId: string, purpose: string): Promise<void> {
    checkPurpose(purpose);
    if (this.rows.delete(cardId)) this.audit.push({ cardId, action: "discard", purpose });
  }
}
