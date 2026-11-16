import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { english, generateMnemonic } from "viem/accounts";
import { HdDepositWallet } from "../src/adapters/wallet/HdDepositWallet.js";
import { checkWalletMatchesIssued, loadDepositWallet } from "../src/adapters/wallet/depositWalletSeed.js";

const PHRASE = generateMnemonic(english);
const quiet = () => {};
const secrets = (values: Record<string, string>) => {
  const reads: string[] = [];
  const readSecret = async (id: string) => {
    reads.push(id);
    const v = values[id];
    if (v === undefined) throw new Error(`ResourceNotFoundException: ${id}`);
    return v;
  };
  return { reads, readSecret };
};

test("production without DEPOSIT_WALLET_SECRET_ID refuses to start and writes no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    await assert.rejects(loadDepositWallet({}, { production: true, log: quiet }), /needs DEPOSIT_WALLET_SECRET_ID.*never generated/);
    assert.equal(existsSync(join(dir, ".sandbox-wallet.json")), false);
  } finally {
    process.chdir(prev);
  }
});

test("production refuses DEPOSIT_WALLET_FILE alongside the secret", async () => {
  const { readSecret } = secrets({ s: PHRASE });
  await assert.rejects(
    loadDepositWallet({ DEPOSIT_WALLET_SECRET_ID: "s", DEPOSIT_WALLET_FILE: "/tmp/x.json" }, { production: true, readSecret, log: quiet }),
    /unset DEPOSIT_WALLET_FILE/,
  );
});

test("production reads the seed from the secret: the same addresses on every start", async () => {
  const { readSecret, reads } = secrets({ "arn:seed": PHRASE });
  const a = await loadDepositWallet({ DEPOSIT_WALLET_SECRET_ID: "arn:seed" }, { production: true, readSecret, log: quiet });
  const b = await loadDepositWallet({ DEPOSIT_WALLET_SECRET_ID: "arn:seed" }, { production: true, readSecret, log: quiet });
  assert.deepEqual(reads, ["arn:seed", "arn:seed"]);
  assert.equal(a.address(7), b.address(7));
  assert.equal(a.payoutAccount().address, b.payoutAccount().address);
  assert.equal(a.address(7), HdDepositWallet.fromMnemonic(PHRASE, "t").address(7));
});

test("the secret may be the sandbox file's JSON shape", async () => {
  const { readSecret } = secrets({ s: JSON.stringify({ note: "x", mnemonic: PHRASE }) });
  const w = await loadDepositWallet({ DEPOSIT_WALLET_SECRET_ID: "s" }, { production: true, readSecret, log: quiet });
  assert.equal(w.address(0), HdDepositWallet.fromMnemonic(PHRASE, "t").address(0));
});

test("a missing or unreadable secret stops startup", async () => {
  const { readSecret } = secrets({});
  await assert.rejects(loadDepositWallet({ DEPOSIT_WALLET_SECRET_ID: "gone" }, { production: true, readSecret, log: quiet }), /ResourceNotFound/);
});

test("a secret that is not a valid mnemonic is refused, and its value is not echoed", async () => {
  const bad = PHRASE.split(" ").reverse().join(" "); // valid words, almost surely a bad checksum
  for (const value of ["", "hunter2", "{}", "{oops", bad + " extra", JSON.stringify({ mnemonic: 42 })]) {
    const { readSecret } = secrets({ s: value });
    await assert.rejects(
      loadDepositWallet({ DEPOSIT_WALLET_SECRET_ID: "s" }, { production: true, readSecret, log: quiet }),
      (e: Error) => /secret s/.test(e.message) && (value.length < 8 || !e.message.includes(value)),
    );
  }
});

test("the sandbox still creates and reuses a local file when no secret id is set", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "seed-")), "w.json");
  const a = await loadDepositWallet({ DEPOSIT_WALLET_FILE: file }, { production: false, log: quiet });
  const b = await loadDepositWallet({ DEPOSIT_WALLET_FILE: file }, { production: false, log: quiet });
  assert.equal(a.address(2), b.address(2));
});

test("a seed that does not re-derive the issued addresses: production refuses, sandbox warns", () => {
  const issuedFrom = HdDepositWallet.fromMnemonic(PHRASE, "t");
  const issued = [0, 5, 41].map((i) => ({ derivationIndex: i, address: issuedFrom.address(i) }));
  const other = HdDepositWallet.fromMnemonic(generateMnemonic(english), "t");

  checkWalletMatchesIssued(issuedFrom, issued, { production: true, log: quiet });
  checkWalletMatchesIssued(issuedFrom, [], { production: true, log: quiet });
  assert.throws(() => checkWalletMatchesIssued(other, issued, { production: true, log: quiet }), /refusing to start: the deposit wallet does not match/);
  const lines: string[] = [];
  checkWalletMatchesIssued(other, issued, { production: false, log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /WARNING: the deposit wallet does not match/);
});
