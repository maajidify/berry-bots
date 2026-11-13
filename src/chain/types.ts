import type { Bot, RoundLedger, Transfer } from "../engine/types";

export type ChainMode = "local" | "testnet";

export interface ChainInfo {
  mode: ChainMode;
  network: string;
  contractId: string;
  explorer?: string;
  settleEvery: number;
}

/** Several consecutive rounds folded into one `settle_round` call. */
export interface SettlementBatch {
  fromRound: number;
  round: number;
  boardHash: string;
  mints: Record<string, number>;
  burns: Record<string, number>;
  overwrites: Transfer[];
}

/**
 * Settlement plan. Deal payments are signed by the paying bot itself (`bot_pay` with its
 * function-call key) at the exact point they happened in the game; rounds between deals are
 * folded into a single operator `settle_round`. This ordering guarantees the on-chain balance
 * equals the engine's balance whenever a bot pays, so no step can underflow.
 */
export type SettleStep =
  | { kind: "settle"; batch: SettlementBatch }
  | { kind: "deal"; round: number; transfer: Transfer };

export interface SettleReceipt {
  mode: ChainMode;
  fromRound: number;
  round: number;
  ok: boolean;
  txHashes: string[];
  dealTxs: string[];
  explorerUrl?: string;
  error?: string;
  /** does the adapter's NEP-141 ledger equal the engine's balances after this flush? */
  consistent?: boolean;
}

export interface ChainAdapter {
  info(): ChainInfo;
  /** Register bot wallets and mint starting balances (local: in memory; testnet: register_bot calls). */
  setup(bots: Bot[], startBalance: number): Promise<void>;
  /** Flush a run of consecutive round ledgers to the chain. */
  settle(ledgers: RoundLedger[], bots: Bot[]): Promise<SettleReceipt>;
  /** Mirrored token balances by bot id, if the adapter keeps them. */
  balances?(): Record<string, number>;
}

export function planSettlement(ledgers: RoundLedger[]): SettleStep[] {
  const steps: SettleStep[] = [];
  let cur: SettlementBatch | undefined;
  const ow = new Map<string, Transfer>();
  const flush = () => {
    if (!cur) return;
    cur.overwrites = [...ow.values()];
    steps.push({ kind: "settle", batch: cur });
    cur = undefined;
    ow.clear();
  };
  for (const l of ledgers) {
    if (l.deals.length) {
      flush();
      for (const d of l.deals) steps.push({ kind: "deal", round: l.round, transfer: d });
    }
    if (!cur) cur = { fromRound: l.round, round: l.round, boardHash: l.boardHash, mints: {}, burns: {}, overwrites: [] };
    cur.round = l.round;
    cur.boardHash = l.boardHash;
    for (const [k, v] of Object.entries(l.mints)) cur.mints[k] = (cur.mints[k] ?? 0) + v;
    for (const [k, v] of Object.entries(l.burns)) cur.burns[k] = (cur.burns[k] ?? 0) + v;
    for (const t of l.transfers) {
      const key = `${t.from}>${t.to}`;
      const c = ow.get(key);
      if (c) c.amount += t.amount;
      else ow.set(key, { ...t });
    }
  }
  flush();
  return steps;
}
