/**
 * Settle a recorded local game on testnet, round by round, exactly as the live server would:
 *   npm run sim -- --out replays/game.json
 *   npm run testnet:settle -- replays/game.json          # dry run: prints the plan
 *   npm run testnet:settle -- replays/game.json --yes    # sends bot_pay + settle_round txs
 * The contract must be freshly deployed and the bots registered (npm run testnet:setup).
 */
import fs from "node:fs";
import { NearTestnetChain } from "../../src/chain/near-testnet";
import { planSettlement } from "../../src/chain/types";
import type { Bot, RoundLedger } from "../../src/engine/types";
import { env, plan, YES } from "./common";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) throw new Error("usage: npm run testnet:settle -- <replay.json> [--yes]");
const replay = JSON.parse(fs.readFileSync(file, "utf8")) as { ledgers: RoundLedger[]; bots: { id: string }[] };
if (!replay.ledgers?.length) throw new Error("replay has no ledgers (LLM games cannot be re-settled; record a heuristic game)");

const every = env.settleEvery;
const steps = planSettlement(replay.ledgers);
plan([
  `${replay.ledgers.length} rounds → ${steps.filter((s) => s.kind === "settle").length} settle_round calls (operator) + ${steps.filter((s) => s.kind === "deal").length} bot_pay calls (signed by each bot's function-call key)`,
  `contract ${env.contractId}, flushing every ${every} rounds`,
]);
if (!YES) process.exit(0);

const chain = new NearTestnetChain(env);
const bots = replay.bots as unknown as Bot[];
await chain.setup(bots);
for (let i = 0; i < replay.ledgers.length; i += every) {
  const r = await chain.settle(replay.ledgers.slice(i, i + every));
  console.log(r.ok ? `rounds ${r.fromRound}-${r.round} ✓ ${r.explorerUrl ?? ""}` : `rounds ${r.fromRound}-${r.round} ✗ ${r.error}`);
  if (!r.ok) process.exit(1);
}
