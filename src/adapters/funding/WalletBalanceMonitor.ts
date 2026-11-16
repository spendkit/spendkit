import type { Alerter } from "../../lib/services/Alerter.js";
import type { MidenClient } from "../../lib/clients/cardIssuing/miden/MidenClient.js";

interface BalancesResponse {
  data?: { walletNumber?: string; walletCurrency?: string; walletAvailableBalance?: number }[];
  isSuccessful?: boolean;
  responseCode?: string;
  responseMessage?: string;
}

export interface WalletBalanceMonitorOptions {
  miden: MidenClient;
  /** Alert when the USD wallet's spendable balance (dollars) is below this (MIDEN_WALLET_MIN_USD). */
  minUsd: number;
  /** The shared alerter: logs, POSTs to ALERT_WEBHOOK_URL, repeats hourly while still low, says RECOVERED once. */
  alerts: Pick<Alerter, "raise" | "clear">;
  /** Minimum gap between Miden reads, ms. */
  intervalMs?: number;
  now?: () => number;
}

const LOW = "miden-wallet-low";
const UNREADABLE = "miden-wallet-unreadable";

/**
 * Top-ups are paid from the Miden USD wallet, not from received USDC, so an empty wallet means funded cards
 * cannot be topped up. Reads GET api/v1/wallet/balances (walletAvailableBalance, USD) and raises an alert while it
 * is below the floor (first time, then at most hourly until it is funded, then one RECOVERED line). A failed read is
 * its own alert: not knowing the balance is itself something to know.
 */
export class WalletBalanceMonitor {
  private last = 0;
  constructor(private readonly o: WalletBalanceMonitorOptions) {}

  /** Last observed spendable USD balance, undefined before the first successful read. */
  lastBalanceUsd: number | undefined;

  async check(): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    if (this.last && now - this.last < (this.o.intervalMs ?? 60_000)) return;
    this.last = now;
    let usd: number;
    try {
      const res = await this.o.miden.request<BalancesResponse>("GET", "/api/v1/wallet/balances?walletCurrency=USD");
      if (res.isSuccessful === false) throw new Error(`${res.responseCode ?? "?"} ${res.responseMessage ?? ""}`.trim());
      const wallets = (res.data ?? []).filter((w) => w.walletCurrency === undefined || w.walletCurrency === "USD");
      if (wallets.length === 0) throw new Error("no USD wallet in the response");
      usd = wallets.reduce((s, w) => s + (Number(w.walletAvailableBalance) || 0), 0);
    } catch (e) {
      // The low alert (if raised) stays raised: an unreadable balance is not a recovered one.
      await this.o.alerts.raise(UNREADABLE, `Miden USD wallet balance could not be read: ${(e as Error).message}`);
      return;
    }
    await this.o.alerts.clear(UNREADABLE, "Miden USD wallet balance can be read again.");
    this.lastBalanceUsd = usd;
    if (usd < this.o.minUsd) {
      await this.o.alerts.raise(LOW, `LOW BALANCE: Miden USD wallet has $${usd.toFixed(2)} available, below the $${this.o.minUsd.toFixed(2)} floor (MIDEN_WALLET_MIN_USD). Card top-ups will fail once it runs out: fund it now.`);
    } else {
      await this.o.alerts.clear(LOW, `Miden USD wallet balance ok again: $${usd.toFixed(2)} available.`);
    }
  }
}
