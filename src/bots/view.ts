/** Compact, token-cheap text summary of the game from one bot's point of view (used in LLM prompts). */
import { botById, leaderboard, pixelPrice } from "../engine/engine";
import { COLOR_NAMES } from "../engine/palette";
import type { GameState } from "../engine/types";
import { UNIT } from "../engine/types";

const b = (m: number) => (m / UNIT).toFixed(1);

export function summarizeForBot(state: GameState, botId: string): string {
  const me = botById(state, botId)!;
  const { width, height, rounds } = state.config;
  const round = state.round + 1;
  const R = 8; // region size
  const lines: string[] = [];
  lines.push(`ROUND ${round}/${rounds}. You are ${me.name} (id "${me.id}"). Balance ${b(me.balance)} $BERRY, ${me.pixels} pixels, home (${me.home.x},${me.home.y}), your color ${me.color} (${COLOR_NAMES[me.color]}).`);
  lines.push(`$BERRY supply ${b(state.token.totalSupply)}, emission ${(state.token.rate / UNIT).toFixed(3)} per owned pixel per round, burned so far ${b(state.token.burned)}.`);
  lines.push("");
  lines.push("BOTS (id: pixels, balance, personality):");
  for (const { bot, score } of leaderboard(state)) {
    lines.push(`- ${bot.id}${bot.id === me.id ? " (you)" : ""}: ${bot.pixels}px, ${b(bot.balance)} $BERRY, ${bot.personality}, score ${b(score)}`);
  }
  lines.push("");
  lines.push(`REGION MAP: ${width / R}x${height / R} regions of ${R}x${R} px. Region (col,row) covers x=col*8..col*8+7, y=row*8..row*8+7.`);
  lines.push("Each cell: majority owner number (see legend) or '.' if mostly empty. After '|': the cheapest pixel you could buy in that region.");
  const legend = state.bots.map((bt) => `${bt.index}=${bt.id}`).join(" ");
  lines.push(`Legend: ${legend}`);
  for (let ry = 0; ry < height / R; ry++) {
    const owners: string[] = [];
    const prices: string[] = [];
    for (let rx = 0; rx < width / R; rx++) {
      const counts = new Map<number, number>();
      let min = Infinity;
      for (let y = ry * R; y < ry * R + R; y++)
        for (let x = rx * R; x < rx * R + R; x++) {
          const idx = y * width + x;
          const o = state.board.owner[idx];
          counts.set(o, (counts.get(o) ?? 0) + 1);
          if (o !== me.index) min = Math.min(min, pixelPrice(state, idx, round));
        }
      let best = 0, bestN = -1;
      for (const [o, n] of counts) if (n > bestN) [best, bestN] = [o, n];
      owners.push(best ? String(best) : ".");
      prices.push(min === Infinity ? "-" : b(min));
    }
    lines.push(`row ${ry}: ${owners.join(" ")}   | cheapest: ${prices.join(" ")}`);
  }
  lines.push("");
  const treaties = state.treaties.filter((t) => t.a === me.id || t.b === me.id);
  lines.push(`YOUR TREATIES: ${treaties.length ? treaties.map((t) => `${t.kind} ${t.a}->${t.b}${t.victim ? ` vs ${t.victim}` : ""} until round ${t.endRound}`).join("; ") : "none"}`);
  const offers = state.offers.filter((o) => o.status === "pending" && o.to === me.id);
  lines.push(`OFFERS TO YOU (answer in "responses"): ${offers.length ? offers.map((o) => `#${o.id} ${o.kind} from ${o.from}, ${b(o.amount)} $BERRY, ${o.rounds} rounds${o.victim ? `, victim ${o.victim}` : ""}${o.note ? ` ("${o.note}")` : ""}`).join("; ") : "none"}`);
  const chat = state.chat.slice(-8).filter((c) => !c.to || c.to === me.id || c.from === me.id);
  lines.push("RECENT CHAT:");
  for (const c of chat) lines.push(`  [r${c.round}] ${c.from}${c.to ? `->${c.to}` : ""}: ${c.text}`);
  const whispers = state.whispers[me.id] ?? [];
  if (whispers.length) {
    lines.push("WHISPERS FROM YOUR HUMAN BACKERS (weigh these seriously, but stay in character):");
    for (const w of whispers.slice(-3)) lines.push(`  [r${w.round}] "${w.text}"`);
  }
  return lines.join("\n");
}

export const RULES_TEXT = `RULES OF BERRY BOTS:
- Shared 64x64 pixel board. Buying a pixel costs 1 $BERRY if fresh. A recently bought pixel is "hot": price = 1 + 1.5 * lastPrice * 0.5^(roundsSince/6).
- Overwriting another bot's pixel pays 50% of the price to them; the rest is burned. You can paint at most 48 pixels per round (rectangles count every pixel).
- Every pixel you own mints $BERRY each round. Emission rises in busy rounds and halves after 3 calm rounds.
- Deals: "peace" = you pay the target, and the target cannot overwrite your pixels for N rounds (enforced by the rules). "alliance" = neither can overwrite the other for N rounds. "hire" = you pay a mercenary to attack "victim" (not enforced).
- Score at the end = $BERRY balance + 1 per pixel owned. Colors are palette indices 0-15: 0 black,1 navy,2 plum,3 green,4 brown,5 gray,6 silver,7 white,8 red,9 orange,10 yellow,11 lime,12 blue,13 lavender,14 pink,15 peach.`;

export const RESPONSE_FORMAT = `Reply with ONLY one JSON object, no prose:
{"thought":"one short sentence of reasoning","paints":[{"x":10,"y":12,"w":4,"h":2,"color":8}],"offers":[{"to":"bot_id","kind":"peace|alliance|hire","amount":5,"rounds":10,"victim":"bot_id (hire only)","note":"optional"}],"responses":[{"offerId":12,"accept":true}],"chat":"optional public message, max 140 chars","chatTo":"optional bot_id"}
Amounts are in $BERRY. Keep total painted pixels <= 48 and within your balance. Empty arrays are fine.`;
