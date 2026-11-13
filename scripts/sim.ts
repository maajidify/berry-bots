/**
 * Headless simulation: plays a full game in local mode as fast as possible and prints the result.
 *   npm run sim                       # default seed
 *   npm run sim -- --seed 7 --rounds 200 --out replays/game.json
 * The --out file holds every round's ledger (for `npm run testnet:settle`) and the replay frames.
 */
import fs from "node:fs";
import path from "node:path";
import { llmConfigFromEnv } from "../src/bots/llm";
import { MockChain } from "../src/chain/mock";
import { fmt } from "../src/engine/config";
import { leaderboard } from "../src/engine/engine";
import type { RoundLedger } from "../src/engine/types";
import { GameRunner } from "../src/runner";

try {
  (process as any).loadEnvFile?.(".env");
} catch {
  /* optional */
}
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = Number(arg("seed") ?? 7);
const rounds = Number(arg("rounds") ?? 120);
const useLlm = args.includes("--llm");
const out = arg("out");

const ledgers: RoundLedger[] = [];
const allEvents: { type: string }[] = [];
const runner = new GameRunner({
  config: { seed, rounds },
  makeChain: () => new MockChain(5),
  llm: useLlm ? llmConfigFromEnv() : undefined,
});
await runner.newGame();
runner.subscribe((p) => {
  if (p.type === "round") allEvents.push(...p.events);
});
const t0 = Date.now();
let mismatches = 0;
while (!runner.state.finished) {
  const p = await runner.step();
  if (p?.receipt && (!p.receipt.ok || p.receipt.consistent === false)) mismatches++;
}
// collect ledgers by replaying the receipts is not needed: re-run deterministically to capture them
const s = runner.state;
const ms = Date.now() - t0;
const types = (t: string) => allEvents.filter((e) => e.type === t).length;

console.log(`\n🍓 BERRY BOTS: seed ${seed}, ${s.round} rounds in ${ms} ms (${useLlm ? "LLM" : "heuristic"} brains, local chain)\n`);
console.log("rank  bot          pixels   $BERRY    score   minted   burned  deals±");
leaderboard(s).forEach(({ bot, score }, i) => {
  console.log(
    `${String(i + 1).padStart(3)}.  ${(bot.emoji + " " + bot.name).padEnd(12)} ${String(bot.pixels).padStart(6)} ${fmt(bot.balance).padStart(9)} ${fmt(score).padStart(8)} ${fmt(bot.stats.minted).padStart(8)} ${fmt(bot.stats.burned).padStart(8)} ${fmt(bot.stats.dealsReceived - bot.stats.dealsPaid).padStart(7)}`,
  );
});
console.log(
  `\n$BERRY supply ${fmt(s.token.totalSupply)} (minted ${fmt(s.token.minted)}, burned ${fmt(s.token.burned)}), final emission ${(s.token.rate / 1000).toFixed(3)}/px/round`,
);
console.log(`events: ${types("deal")} deals, ${types("offer")} offers, ${types("war")} raids, ${types("halving")} halvings, ${types("frenzy")} frenzies, ${types("chat")} chats`);
console.log(`chain: ${runner.receipts.length} settlements, ${mismatches === 0 ? "every settlement matched the engine ✓" : `${mismatches} MISMATCHES ✗`}`);

if (out) {
  // Deterministic: replay the same seed to capture raw ledgers for on-chain settlement.
  const { createGame, applyRound } = await import("../src/engine/engine");
  const { makeConfig } = await import("../src/engine/config");
  const { BOT_SPECS } = await import("../src/bots/personalities");
  const { heuristicDecide } = await import("../src/bots/heuristics");
  if (!useLlm) {
    const g = createGame(makeConfig({ seed, rounds }), BOT_SPECS);
    while (!g.finished) ledgers.push(applyRound(g, g.bots.map((b) => heuristicDecide(g, b.id))).ledger);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ seed, rounds, startBalance: s.config.startBalance, bots: s.bots.map((b) => ({ id: b.id, name: b.name, personality: b.personality })), ledgers, frames: runner.frames }, null, 0));
  console.log(`replay written to ${out}${useLlm ? " (frames only; LLM games are not re-playable for ledgers)" : ""}`);
}
if (mismatches) process.exit(1);
if (args.includes("--curve")) {
  for (const h of runner.state.token.history.filter((_, i) => i % 5 === 0)) console.log(`r${h.round}\tsupply ${fmt(h.supply)}\trate ${h.rate}\tpainted ${h.painted}\tburn ${fmt(h.burned)}\tmint ${fmt(h.minted)}`);
}
if (args.includes("--art")) {
  const { strawberryPixels } = await import("../src/bots/shapes");
  const a = runner.state.bots.find((b) => b.personality === "artist")!;
  const px = strawberryPixels(a.home.x, a.home.y, 2);
  const ok = px.filter((p) => { const i = p.y * 64 + p.x; return runner.state.board.owner[i] === a.index && runner.state.board.color[i] === p.color; }).length;
  console.log(`strawberry intact: ${ok}/${px.length}`);
}
