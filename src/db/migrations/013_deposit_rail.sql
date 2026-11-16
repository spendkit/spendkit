-- Which rail credits a deposit address: 'hd' (our HD wallet, credited by the chain watcher) or 'circle' (a Circle
-- wallet, credited by the Circle webhook and reconcile). With CHAIN_WATCHER=1 and Circle both on, the watcher must
-- not scan Circle wallets: it would credit the same transfer again under its own ledger key.
-- NULL only on rows from before this migration; bootstrap classifies them (an address our HD wallet derives at its
-- derivation index is 'hd', anything else 'circle') before any worker starts.
ALTER TABLE deposit_address ADD COLUMN rail TEXT CHECK (rail IN ('hd', 'circle'));
CREATE INDEX deposit_address_chain_rail ON deposit_address (chain, rail);
