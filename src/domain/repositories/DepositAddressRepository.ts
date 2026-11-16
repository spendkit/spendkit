import type { DepositAddresses } from "../../adapters/deposits/BaseUsdcWatcher.js";

/** How a deposit address is credited: our HD wallet through the chain watcher, or a Circle wallet through its webhook. */
export type DepositRail = "hd" | "circle";

/** Deposit addresses we issued on one chain. One address funds exactly one card. `all`/`cardFor` cover every rail. */
export interface DepositAddressRepository extends DepositAddresses {
  /** Records an address for a card. Re-adding the same pair is a no-op; moving it to another card is refused. Default rail 'hd'. */
  add(address: string, cardId: string, rail?: DepositRail): Promise<void>;
  /** The card's first address issued from a derivation index (the one the dashboard shows), if any. */
  issuedAddressOf(cardId: string): Promise<string | undefined>;
  /** Draws the next unique derivation index (sequence deposit_derivation_seq). */
  nextDerivationIndex(): Promise<number>;
  /** Records an address for a card together with the derivation index it came from, atomically. Default rail 'hd'. */
  assign(address: string, cardId: string, derivationIndex: number, rail?: DepositRail): Promise<void>;
  /**
   * Only the addresses of one rail: give the chain watcher `onRail("hd")` and Circle `onRail("circle")`, so one on-chain
   * transfer is credited by one rail only. Rows not yet classified (from before migration 013) belong to neither.
   */
  onRail(rail: DepositRail): DepositAddresses;
  /**
   * Classifies rows from before migration 013: `isHd(address, derivationIndex)` says whether our HD wallet derives that
   * address; true means 'hd', false 'circle'. Rows without a derivation index predate Circle and are 'hd'. Returns how many it set.
   */
  classifyUnrailed(isHd: (address: string, derivationIndex: number) => boolean): Promise<number>;
  /**
   * Up to `limit` addresses on the 'hd' rail with their derivation indexes (lowest and highest first), to check the seed
   * at startup. Circle wallets and unclassified rows are left out: our seed does not derive them.
   */
  derivedSample(limit: number): Promise<{ address: string; derivationIndex: number }[]>;
}
