import { describe, expect, it } from "vitest";
import { BOT_SPECS } from "../src/bots/personalities";
import { heuristicDecide } from "../src/bots/heuristics";
import { makeConfig } from "../src/engine/config";
import { applyRound, createGame, isProtected, pixelPrice } from "../src/engine/engine";
import type { BotAction, GameState } from "../src/engine/types";
import { UNIT } from "../src/engine/types";

const two = () =>
  createGame(makeConfig({ seed: 1, rounds: 50 }), [
    { ...BOT_SPECS[0] },
    { ...BOT_SPECS[3] },
  ]);
const act = (botId: string, a: Partial<BotAction> = {}): BotAction => ({ botId, paints: [], offers: [], responses: [], ...a });
const sumBalances = (s: GameState) => s.bots.reduce((t, b) => t + b.balance, 0);

describe("pricing", () => {
  it("fresh pixels cost the base price, hot pixels cost more and cool down", () => {
    const s = two();
    expect(pixelPrice(s, 0)).toBe(1 * UNIT);
    applyRound(s, [act("goldie", { paints: [{ x: 0, y: 0, color: 10 }] })]);
    const hot = pixelPrice(s, 0, s.round); // same round as purchase
    expect(hot).toBe(UNIT + Math.floor(1.5 * UNIT));
    const later = pixelPrice(s, 0, s.round + 6); // one half-life later
    expect(later).toBe(UNIT + Math.floor(0.75 * UNIT));
  });
});

describe("paint economy", () => {
  it("overwriting pays the previous owner 50% and burns the rest", () => {
    const s = two();
    applyRound(s, [act("goldie", { paints: [{ x: 5, y: 5, color: 10 }] })]);
    const g0 = s.bots[0].balance, t0 = s.bots[1].balance;
    const price = pixelPrice(s, 5 * 64 + 5);
    const burnedBefore = s.token.burned;
    const r = applyRound(s, [act("grief", { paints: [{ x: 5, y: 5, color: 2 }] })]);
    expect(s.board.owner[5 * 64 + 5]).toBe(2);
    expect(s.bots[1].balance).toBe(t0 - price + (r.ledger.mints.grief ?? 0));
    expect(s.bots[0].balance).toBe(g0 + price / 2);
    expect(s.token.burned - burnedBefore).toBe(price - price / 2);
    expect(r.ledger.transfers).toEqual([{ from: "grief", to: "goldie", amount: price / 2, reason: "overwrite" }]);
  });

  it("rectangles expand, clip to the board and respect the per-round cap", () => {
    const s = two();
    const r = applyRound(s, [act("goldie", { paints: [{ x: 60, y: 60, w: 10, h: 10, color: 3 }] })]);
    expect(r.changes.length).toBe(16); // 4x4 left after clipping
    const r2 = applyRound(s, [act("grief", { paints: [{ x: 0, y: 0, w: 64, h: 64, color: 2 }] })]);
    expect(r2.changes.length).toBe(s.config.maxPaintsPerRound);
  });

  it("cannot spend more than the balance", () => {
    const s = createGame(makeConfig({ startBalance: 3 * UNIT }), [BOT_SPECS[0]]);
    const r = applyRound(s, [act("goldie", { paints: [{ x: 0, y: 0, w: 10, h: 1, color: 1 }] })]);
    expect(r.changes.length).toBe(3);
    expect(s.bots[0].balance).toBeGreaterThanOrEqual(0);
  });

  it("total supply always equals the sum of balances over a full heuristic game", () => {
    const s = createGame(makeConfig({ seed: 42, rounds: 80 }), BOT_SPECS);
    while (!s.finished) {
      applyRound(s, s.bots.map((b) => heuristicDecide(s, b.id)));
      expect(sumBalances(s)).toBe(s.token.totalSupply);
      expect(s.bots.every((b) => b.balance >= 0)).toBe(true);
      const owned = s.bots.reduce((t, b) => t + b.pixels, 0);
      expect(owned).toBe(s.board.owner.filter((o) => o > 0).length);
    }
  });
});

describe("deals and treaties", () => {
  it("accepting a peace offer pays the target and blocks it from overwriting the payer", () => {
    const s = two();
    applyRound(s, [
      act("goldie", { paints: [{ x: 1, y: 1, color: 10 }], offers: [{ to: "grief", kind: "peace", amount: 8 * UNIT, rounds: 5 }] }),
    ]);
    const offer = s.offers.find((o) => o.status === "pending")!;
    const gBefore = s.bots[0].balance, tBefore = s.bots[1].balance;
    const r = applyRound(s, [act("grief", { responses: [{ offerId: offer.id, accept: true }], paints: [{ x: 1, y: 1, color: 2 }] })]);
    expect(s.bots[1].balance - tBefore).toBe(8 * UNIT + (r.ledger.mints.grief ?? 0));
    expect(gBefore - s.bots[0].balance).toBe(8 * UNIT - (r.ledger.mints.goldie ?? 0));
    expect(s.board.owner[65]).toBe(1); // still goldie's: treaty blocked the overwrite
    expect(isProtected(s, "grief", "goldie")).toBe(true);
    expect(r.ledger.deals).toEqual([{ from: "goldie", to: "grief", amount: 8 * UNIT, reason: "deal" }]);
  });

  it("a deal the proposer can no longer afford fails", () => {
    const s = two();
    applyRound(s, [act("goldie", { offers: [{ to: "grief", kind: "peace", amount: 200 * UNIT > s.config.maxDealAmount ? 100 * UNIT : 200 * UNIT, rounds: 5 }] })]);
    const offer = s.offers[0];
    s.bots[0].balance = 1; // drained
    s.token.totalSupply = sumBalances(s);
    applyRound(s, [act("grief", { responses: [{ offerId: offer.id, accept: true }] })]);
    expect(s.offers.find((o) => o.id === offer.id)!.status).toBe("failed");
  });

  it("rejects invalid offers (self, unknown bot, hire without victim)", () => {
    const s = two();
    applyRound(s, [
      act("goldie", {
        offers: [
          { to: "goldie", kind: "peace", amount: 1, rounds: 3 },
          { to: "nobody", kind: "peace", amount: 1, rounds: 3 },
          { to: "grief", kind: "hire", amount: 1000, rounds: 3 },
        ],
      }),
    ]);
    expect(s.offers.length).toBe(0);
  });
});

describe("memecoin mechanics", () => {
  it("emission halves after 3 calm rounds and grows in a paint frenzy", () => {
    const s = two();
    applyRound(s, [act("goldie", { paints: [{ x: 0, y: 0, w: 8, h: 6, color: 10 }] })]);
    applyRound(s, [act("grief", { paints: [{ x: 0, y: 0, w: 8, h: 6, color: 2 }] })]);
    const rate = s.token.rate;
    expect(rate).toBeGreaterThan(s.config.emission.initialRate); // frenzy: burn >> mint
    for (let i = 0; i < 3; i++) applyRound(s, []); // nobody paints: calm
    expect(s.token.rate).toBe(Math.floor(rate / 2));
    expect(s.events.some((e) => e.type === "halving")).toBe(true);
  });
});

describe("determinism", () => {
  it("same seed, same game", () => {
    const run = () => {
      const s = createGame(makeConfig({ seed: 7, rounds: 30 }), BOT_SPECS);
      const hashes: string[] = [];
      while (!s.finished) hashes.push(applyRound(s, s.bots.map((b) => heuristicDecide(s, b.id))).ledger.boardHash);
      return hashes;
    };
    expect(run()).toEqual(run());
  });
});
