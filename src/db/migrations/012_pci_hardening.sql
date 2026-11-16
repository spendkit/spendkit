-- PCI hardening.
--
-- 1. No reusable card details are kept. Every real checkout is paid with a one-time card, whose details live only
--    until its single payment, so the security code is never kept after authorization (PCI DSS 3.3.1). Details
--    already stored for users' reusable cards are discarded here. Each discard gets an audit row first.
INSERT INTO card_vault_audit (card_id, action, purpose)
SELECT v.card_id, 'discard', 'pci: reusable card details are no longer kept'
FROM card_vault v
WHERE NOT EXISTS (SELECT 1 FROM app_one_time_card o WHERE o.card_id = v.card_id);

DELETE FROM card_vault v
WHERE NOT EXISTS (SELECT 1 FROM app_one_time_card o WHERE o.card_id = v.card_id);

-- 2. Key rotation: a row re-sealed under a newer vault key is audited as 'rekey'.
ALTER TABLE card_vault_audit DROP CONSTRAINT card_vault_audit_action_check;
ALTER TABLE card_vault_audit ADD CONSTRAINT card_vault_audit_action_check
  CHECK (action IN ('put', 'overwrite', 'reveal', 'reveal_miss', 'discard', 'rekey'));

-- 3. The vault audit trail is append-only, enforced by the database rather than by convention (PCI DSS 10.3.2):
--    rows can be added but never changed, deleted or truncated.
CREATE FUNCTION card_vault_audit_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'card_vault_audit is append-only'; END $$;

CREATE TRIGGER card_vault_audit_immutable BEFORE UPDATE OR DELETE ON card_vault_audit
  FOR EACH ROW EXECUTE FUNCTION card_vault_audit_reject_change();
CREATE TRIGGER card_vault_audit_no_truncate BEFORE TRUNCATE ON card_vault_audit
  FOR EACH STATEMENT EXECUTE FUNCTION card_vault_audit_reject_change();

-- 4. Owner tokens expire after a stretch of not being used (OWNER_TOKEN_IDLE_DAYS). Existing tokens start the
--    clock now rather than being cut off at once.
ALTER TABLE app_user ADD COLUMN token_used_at TIMESTAMPTZ NOT NULL DEFAULT now();
