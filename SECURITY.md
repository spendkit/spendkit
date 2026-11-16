# Security policy

This project handles card details, wallet keys and money movement. Please report security problems privately.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository
(https://github.com/spendkit/spendkit/security/advisories/new).

Do not open a public issue, pull request or discussion for a suspected vulnerability.

Please include what you found, how to reproduce it, and what an attacker could do with it. We aim to acknowledge
a report within 3 working days and to tell you what we plan to do within 10.

Never include real secrets, card numbers, mnemonics or personal data in a report. Sandbox values are enough.

## Scope and status

Spendkit is **sandbox only and not production-ready**. It refuses to start against non-sandbox Miden or Circle
hosts. The known gaps are listed in [docs/production-gaps.md](docs/production-gaps.md); those are not
vulnerabilities to report, but fixes are welcome.

If you run it anywhere other than your own machine, be aware that:

- it binds to `127.0.0.1` by default; signups and failed sign-ins are rate limited per address, in memory (one process);
- owner tokens expire after `OWNER_TOKEN_IDLE_DAYS` without use, but email is not verified and there is no self-service login;
- the deposit and payout keys come from one mnemonic in a local file (testnet only);
- with `CARD_VAULT_KEY` set it holds one-time cards' full details (encrypted) from issue until their single checkout, which
  puts a real deployment in PCI DSS scope. Reusable cards' details are never captured, the vault's audit trail is
  append-only in the database, and the key can be rotated (`pnpm vault:rekey`). The plan to shrink that scope to one
  small service is [docs/card-service-split.md](docs/card-service-split.md).

## Supported versions

Only the `main` branch is supported.
