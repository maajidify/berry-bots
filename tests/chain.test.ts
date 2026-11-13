import { describe, expect, it } from "vitest";
import { MockChain } from "../src/chain/mock";
import { planSettlement } from "../src/chain/types";
import { GameRunner } from "../src/runner";

describe("local chain (mock of the berry contract)", () => {
  it("settles a whole game and the NEP-141 mirror always matches the engine", async () => {
    const runner = new GameRunner({ config: { seed: 11, rounds: 60 }, makeChain: () => new MockChain(5) });
    await runner.newGame();
    await runner.runToEnd();
    expect(runner.receipts.length).toBe(12);
    for (const r of runner.receipts) {
      expect(r.ok).toBe(true);
      expect(r.consistent).toBe(true);
    }
    const chain = runner.chain as MockChain;
    expect(chain.totalSupply).toBe(runner.state.token.totalSupply);
  });

  it("deals become bot_pay steps between folded settle_round batches", () => {
    const L = (round: number, deals = 0) => ({
      round,
      mints: { a: 10 },
      burns: {},
      transfers: [],
      deals: Array.from({ length: deals }, () => ({ from: "a", to: "b", amount: 5, reason: "deal" as const })),
      boardHash: `h${round}`,
    });
    const steps = planSettlement([L(1), L(2), L(3, 1), L(4)]);
    expect(steps.map((s) => s.kind)).toEqual(["settle", "deal", "settle"]);
    expect(steps[0].kind === "settle" && steps[0].batch.mints.a).toBe(20);
    expect(steps[2].kind === "settle" && steps[2].batch.fromRound).toBe(3);
  });

  it("rejects replayed rounds and over-cap bot payments like the contract", async () => {
    const c = new MockChain(5, 100);
    await c.setup([{ id: "a" }, { id: "b" }] as any, 1000);
    c.settleRound({ fromRound: 1, round: 1, boardHash: "x", mints: {}, burns: {}, overwrites: [] });
    expect(() => c.settleRound({ fromRound: 1, round: 1, boardHash: "x", mints: {}, burns: {}, overwrites: [] })).toThrow("round already settled");
    expect(() => c.botPay("a", "b", 101)).toThrow("cap");
    expect(() => c.botPay("a", "a", 1)).toThrow("self");
  });
});
