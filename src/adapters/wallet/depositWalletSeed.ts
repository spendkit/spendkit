// Where the deposit wallet's mnemonic comes from. Production reads it from AWS Secrets Manager and refuses to start
// without it: generating one would give every deploy new deposit and payout keys, and money sent to the old addresses
// would be stranded. The sandbox keeps the local file (created on first use) unless a secret id is given.
import { HdDepositWallet } from "./HdDepositWallet.js";

/** Reads a secret's string value by id or ARN. */
export type SecretReader = (secretId: string) => Promise<string>;

/** AWS Secrets Manager, loaded only when used (region and credentials from the standard AWS environment / task role). */
export const awsSecretReader: SecretReader = async (secretId) => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
  if (typeof out.SecretString !== "string" || !out.SecretString) throw new Error(`secret ${secretId} has no string value`);
  return out.SecretString;
};

/** The secret holds either the bare phrase or the sandbox file's JSON shape, {"mnemonic": "..."}. */
function mnemonicFromSecret(value: string, secretId: string): string {
  const v = value.trim();
  if (!v.startsWith("{")) return v;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    throw new Error(`secret ${secretId} looks like JSON but does not parse`);
  }
  const m = (parsed as { mnemonic?: unknown }).mnemonic;
  if (typeof m !== "string") throw new Error(`secret ${secretId} is JSON without a "mnemonic" string`);
  return m;
}

export interface DepositWalletOptions {
  production: boolean;
  readSecret?: SecretReader;
  log: (line: string) => void;
}

/**
 * DEPOSIT_WALLET_SECRET_ID set: the mnemonic is read from that secret (required in production).
 * Otherwise, sandbox only: the local file DEPOSIT_WALLET_FILE (default .sandbox-wallet.json), created on first use.
 */
export async function loadDepositWallet(env: NodeJS.ProcessEnv, opts: DepositWalletOptions): Promise<HdDepositWallet> {
  const secretId = env.DEPOSIT_WALLET_SECRET_ID;
  if (opts.production) {
    if (!secretId) {
      throw new Error("APP_ENV=production needs DEPOSIT_WALLET_SECRET_ID (the Secrets Manager id of the deposit wallet mnemonic); a production wallet is never generated");
    }
    if (env.DEPOSIT_WALLET_FILE) throw new Error("APP_ENV=production reads the deposit wallet from DEPOSIT_WALLET_SECRET_ID only: unset DEPOSIT_WALLET_FILE");
  }
  if (secretId) {
    const value = await (opts.readSecret ?? awsSecretReader)(secretId);
    const wallet = HdDepositWallet.fromMnemonic(mnemonicFromSecret(value, secretId), `secret ${secretId}`);
    opts.log(`deposit wallet: from secret ${secretId}`);
    return wallet;
  }
  const file = env.DEPOSIT_WALLET_FILE ?? ".sandbox-wallet.json";
  opts.log(`deposit wallet: local file ${file} (sandbox)`);
  return HdDepositWallet.loadOrCreate(file);
}

/** One issued address and the index it was derived from. */
export interface DerivedAddress {
  address: string;
  derivationIndex: number;
}

/**
 * Checks the wallet against addresses already handed out. A different seed (a new secret, a lost sandbox file)
 * re-derives different addresses, and deposits to the old ones would never be credited or recoverable.
 * Production refuses to start; the sandbox warns.
 */
export function checkWalletMatchesIssued(wallet: HdDepositWallet, issued: DerivedAddress[], opts: DepositWalletOptions): void {
  const wrong = issued.filter((d) => wallet.address(d.derivationIndex) !== d.address.toLowerCase());
  if (wrong.length === 0) {
    if (issued.length) opts.log(`deposit wallet: matches ${issued.length} issued address(es)`);
    return;
  }
  const first = wrong[0]!;
  const msg = `the deposit wallet does not match addresses already issued (index ${first.derivationIndex} should be ${first.address}, ` +
    `this seed gives ${wallet.address(first.derivationIndex)}): it is not the seed those deposits were sent to`;
  if (opts.production) throw new Error(`refusing to start: ${msg}`);
  opts.log(`WARNING: ${msg}. Deposits to the old addresses will not be credited (sandbox, so starting anyway)`);
}

/**
 * Classifies deposit addresses from before migration 013 (no rail yet) as 'hd' or 'circle' by whether `wallet` derives
 * them. That decision is permanent and leans entirely on the seed: with a wrong seed every real HD address would be
 * marked 'circle' and its deposits never scanned again, and the startup seed check cannot catch it, because it only
 * samples rows already on the 'hd' rail. So production never classifies: it refuses to start while any row is unrailed
 * (a production database created after migration 013 has none). The sandbox classifies as before.
 */
export async function classifyOlderAddresses(
  addresses: { unrailedCount(): Promise<number>; classifyUnrailed(isHd: (address: string, derivationIndex: number) => boolean): Promise<number> },
  wallet: Pick<HdDepositWallet, "address">,
  opts: DepositWalletOptions,
): Promise<number> {
  if (opts.production) {
    const n = await addresses.unrailedCount();
    if (n > 0) {
      throw new Error(`refusing to start: ${n} deposit address(es) have no rail (from before migration 013). Production does not ` +
        "classify them, because a wrong seed would mark real HD addresses as Circle for good. Classify them in a sandbox run against " +
        "a copy, or by hand, after checking the seed");
    }
    return 0;
  }
  const classified = await addresses.classifyUnrailed((a, i) => wallet.address(i).toLowerCase() === a);
  if (classified > 0) opts.log(`deposit addresses: classified ${classified} older address(es) as HD or Circle`);
  return classified;
}
