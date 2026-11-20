-- Human approval of spend intents (docs/spend-intents.md, "Who builds what").
--
-- An agent's intent above its owner's threshold starts as app_spend.approval = 'pending' (migration 014). The owner
-- approves or denies it in the dashboard with a WebAuthn passkey. The signed assertion is kept as dispute evidence.
-- This migration does not touch the columns 014 adds, so either may be applied first.

-- 1. Per-agent threshold. NULL = no approval needed. An intent whose max_amount_cents is above it needs approval.
ALTER TABLE app_agent ADD COLUMN approval_above_cents BIGINT
  CONSTRAINT app_agent_approval_above_cents_check CHECK (approval_above_cents IS NULL OR approval_above_cents >= 0);

-- 2. The owner's passkeys. Only the public key is stored. sign_count detects a cloned authenticator.
--    registered_via records how the first-use enrolment was authenticated: the owner's own token (uk_) or a
--    developer-issued browser session (us_). For a developer-managed user the developer is the root of trust.
CREATE TABLE app_passkey (
  credential_id TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES app_user(id),
  public_key    BYTEA NOT NULL,
  sign_count    BIGINT NOT NULL DEFAULT 0,
  transports    TEXT[],
  device_type   TEXT,
  backed_up     BOOLEAN NOT NULL DEFAULT false,
  registered_via TEXT NOT NULL CHECK (registered_via IN ('owner_token', 'session')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX app_passkey_user_id_idx ON app_passkey (user_id);

-- 3. Outstanding WebAuthn challenges. 'loosen' is the owner raising or switching off an agent's threshold (item 5). Single use: consumed with DELETE ... RETURNING. For a decision, the challenge
--    commits to the exact statement shown to the owner (see ApprovalInteractor), which is kept here until used.
CREATE TABLE app_webauthn_challenge (
  challenge  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id),
  purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'approve', 'deny', 'loosen')),
  spend_id   TEXT REFERENCES app_spend(spend_id),
  statement  TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((purpose IN ('approve', 'deny')) = (spend_id IS NOT NULL))
);
CREATE INDEX app_webauthn_challenge_expires_at_idx ON app_webauthn_challenge (expires_at);

-- 4. The owner's decision on an intent, with the signed passkey assertion as evidence (AP2-mandate style):
--    `statement` is the canonical JSON the owner saw, and the WebAuthn challenge they signed is
--    base64url(nonce(16) || sha256(statement)). One decision per intent. Append-only, like card_vault_audit.
CREATE TABLE app_spend_approval (
  spend_id      TEXT PRIMARY KEY REFERENCES app_spend(spend_id),
  user_id       TEXT NOT NULL REFERENCES app_user(id),
  decision      TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  credential_id TEXT NOT NULL REFERENCES app_passkey(credential_id),
  statement     TEXT NOT NULL,
  challenge     TEXT NOT NULL,
  assertion     JSONB NOT NULL,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION app_spend_approval_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

CREATE TRIGGER app_spend_approval_immutable BEFORE UPDATE OR DELETE ON app_spend_approval
  FOR EACH ROW EXECUTE FUNCTION app_spend_approval_reject_change();
CREATE TRIGGER app_spend_approval_no_truncate BEFORE TRUNCATE ON app_spend_approval
  FOR EACH STATEMENT EXECUTE FUNCTION app_spend_approval_reject_change();

-- 5. Every loosening of an agent's approval threshold (raised, or switched off). Once the owner has a passkey, a
--    loosening on any route needs a passkey assertion over the statement {agentId, from, to}; without one, only the
--    owner's own token (uk_) may loosen, never a developer session (us_) or key (dk_). Append-only.
CREATE TABLE app_agent_approval_change (
  id            BIGSERIAL PRIMARY KEY,
  card_id       TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES app_user(id),
  from_cents    BIGINT NOT NULL,
  to_cents      BIGINT,
  via           TEXT NOT NULL CHECK (via IN ('owner_token', 'passkey')),
  credential_id TEXT REFERENCES app_passkey(credential_id),
  statement     TEXT,
  challenge     TEXT,
  assertion     JSONB,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (card_id, agent_id) REFERENCES app_agent(card_id, agent_id),
  CHECK ((via = 'passkey') = (credential_id IS NOT NULL AND statement IS NOT NULL AND challenge IS NOT NULL AND assertion IS NOT NULL))
);

CREATE TRIGGER app_agent_approval_change_immutable BEFORE UPDATE OR DELETE ON app_agent_approval_change
  FOR EACH ROW EXECUTE FUNCTION app_spend_approval_reject_change();
CREATE TRIGGER app_agent_approval_change_no_truncate BEFORE TRUNCATE ON app_agent_approval_change
  FOR EACH STATEMENT EXECUTE FUNCTION app_spend_approval_reject_change();
