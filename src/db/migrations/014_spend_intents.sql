-- Spend intents (docs/spend-intents.md): an app_spend row an agent opens BEFORE a merchant authorizes the card. Under
-- Miden customer-managed authorization we approve an authorization only when it matches an open intent.
-- A row is an intent when expires_at is set; plain agent payments (pay) leave every new column at its default.
ALTER TABLE app_spend
  ADD COLUMN expires_at TIMESTAMPTZ,
  -- The most an authorization may reach (amount_cents plus the tip/FX tolerance). The hold is this amount.
  ADD COLUMN max_amount_cents BIGINT,
  -- Normalised merchant name the authorization's merchantName must contain, and/or the exact merchantAcceptorId.
  ADD COLUMN merchant_match TEXT,
  ADD COLUMN merchant_acceptor_id TEXT,
  ADD COLUMN uses_allowed INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN uses INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN approval TEXT NOT NULL DEFAULT 'none',
  -- Miden cardTransactionAuthorizationId of the authorization that consumed the intent.
  ADD COLUMN auth_ref TEXT,
  ADD COLUMN auth_state TEXT,
  -- merchantAcceptorId of that authorization: a repeat must carry the same one.
  ADD COLUMN auth_acceptor_id TEXT,
  -- What has left toward the merchant for this intent so far (authorized, then adjusted by settlement, reversals, refunds).
  ADD COLUMN captured_cents BIGINT NOT NULL DEFAULT 0,
  -- Agent text shown to the owner; plain text.
  ADD COLUMN context TEXT,
  ADD CONSTRAINT app_spend_approval_check CHECK (approval IN ('none', 'pending', 'approved')),
  ADD CONSTRAINT app_spend_auth_state_check CHECK (auth_state IN ('provisional', 'settled')),
  ADD CONSTRAINT app_spend_uses_check CHECK (uses >= 0 AND uses <= uses_allowed),
  ADD CONSTRAINT app_spend_captured_cents_check CHECK (captured_cents >= 0),
  ADD CONSTRAINT app_spend_context_check CHECK (char_length(context) <= 500),
  ADD CONSTRAINT app_spend_intent_check CHECK (
    expires_at IS NULL
    OR (max_amount_cents IS NOT NULL AND max_amount_cents >= amount_cents AND (merchant_match IS NOT NULL OR merchant_acceptor_id IS NOT NULL))
  );

ALTER TABLE app_spend DROP CONSTRAINT app_spend_status_check;
ALTER TABLE app_spend ADD CONSTRAINT app_spend_status_check CHECK (status IN ('processing', 'approved', 'declined', 'voided', 'expired'));

-- One authorization consumes at most one spend.
CREATE UNIQUE INDEX app_spend_auth_ref ON app_spend (auth_ref) WHERE auth_ref IS NOT NULL;
-- The callback's candidate search and the expiry sweeper.
CREATE INDEX app_spend_open_intents ON app_spend (card_id, expires_at) WHERE status = 'processing' AND expires_at IS NOT NULL;

-- Every Miden event we acted on, from the authorization callback or the webhook route. Inserted FIRST in the deciding
-- transaction: the primary key makes a replayed eventId return the stored decision instead of moving money twice.
CREATE TABLE miden_event (
  event_id     TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('callback', 'webhook')),
  request_type TEXT,
  card_id      TEXT,
  spend_id     TEXT,
  -- The JSON answer we gave (callback), or what we did (webhook).
  decision     TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
