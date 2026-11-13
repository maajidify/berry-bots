/**
 * Local mode: an in-memory mirror of the `berry` contract (contracts/berry/src/lib.rs).
 * Same semantics as on chain: register_bot mints the start balance, deals go through
 * bot_pay (capped per call), and settle_round applies mints, overwrite payouts (inflows
 * first) and burns. After every flush it checks the mirror equals the engine's balances.
 */
import { fnv64 } from "../engine/hash";
import type { Bot, RoundLedger } from "../engine/types";
import { ChainAdapter, ChainInfo, planSettlement, SettleReceipt, SettlementBatch } from "./types";

export class MockChain implements ChainAdapter {
  private ledger = new Map<string, number>();
  private lastRound = 0;
  totalSupply = 0;
  settled: { round: number; boardHash: string; txHash: string }[] = [];

  constructor(private settleEvery = 5, private maxBotPay = 100_000) {}

  info(): ChainInfo {
    return { mode: "local", network: "local (mocked chain)", contractId: "berry.berrybots.local", settleEvery: this.settleEvery };
  }

  async setup(bots: Bot[], startBalance: number) {
    for (const b of bots) {
      if (this.ledger.has(b.id)) throw new Error("bot already registered");
      this.ledger.set(b.id, startBalance);
      this.totalSupply += startBalance;
    }
  }

  balances() {
    return Object.fromEntries(this.ledger);
  }

  /** mirrors `bot_pay` */
  botPay(from: string, to: string, amount: number) {
    if (from === to) throw new Error("self payment");
    if (amount <= 0 || amount > this.maxBotPay) throw new Error("amount over the per-call cap");
    this.withdraw(from, amount);
    this.deposit(to, amount);
  }

  /** mirrors `settle_round` */
  settleRound(b: SettlementBatch) {
    if (b.round <= this.lastRound) throw new Error("round already settled");
    for (const [id, v] of Object.entries(b.mints)) {
      this.deposit(id, v);
      this.totalSupply += v;
    }
    for (const t of b.overwrites) this.deposit(t.to, t.amount);
    for (const t of b.overwrites) this.withdraw(t.from, t.amount);
    for (const [id, v] of Object.entries(b.burns)) {
      this.withdraw(id, v);
      this.totalSupply -= v;
    }
    this.lastRound = b.round;
  }

  private deposit(id: string, amount: number) {
    if (!this.ledger.has(id)) throw new Error(`not a registered bot: ${id}`);
    this.ledger.set(id, this.ledger.get(id)! + amount);
  }

  private withdraw(id: string, amount: number) {
    const bal = this.ledger.get(id);
    if (bal === undefined) throw new Error(`not a registered bot: ${id}`);
    if (bal < amount) throw new Error(`The account ${id} doesn't have enough balance`);
    this.ledger.set(id, bal - amount);
  }

  async settle(ledgers: RoundLedger[], bots: Bot[]): Promise<SettleReceipt> {
    const fromRound = ledgers[0].round;
    const round = ledgers[ledgers.length - 1].round;
    const txHashes: string[] = [];
    const dealTxs: string[] = [];
    try {
      for (const step of planSettlement(ledgers)) {
        if (step.kind === "deal") {
          const t = step.transfer;
          this.botPay(t.from, t.to, t.amount);
          dealTxs.push(mockHash(`bot_pay:${t.from}:${t.to}:${t.amount}:${step.round}`));
        } else {
          this.settleRound(step.batch);
          const txHash = mockHash(`settle_round:${step.batch.round}:${step.batch.boardHash}`);
          txHashes.push(txHash);
          this.settled.push({ round: step.batch.round, boardHash: step.batch.boardHash, txHash });
        }
      }
      const consistent = bots.every((b) => this.ledger.get(b.id) === b.balance);
      return { mode: "local", fromRound, round, ok: true, txHashes, dealTxs, consistent };
    } catch (e) {
      return { mode: "local", fromRound, round, ok: false, txHashes, dealTxs, error: (e as Error).message };
    }
  }
}

function mockHash(s: string) {
  return "mock_" + fnv64(s) + fnv64(s + "#");
}
