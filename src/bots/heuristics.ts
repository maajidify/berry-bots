/**
 * Heuristic brains: one deterministic strategy per personality. These run with no API key
 * and are also the fallback whenever an LLM call fails or returns invalid JSON.
 */
import { botById, isProtected, leaderboard, pixelPrice } from "../engine/engine";
import { deriveSeed, mulberry32 } from "../engine/rng";
import type { Bot, BotAction, GameState, OfferCmd, PaintCmd, Personality } from "../engine/types";
import { UNIT } from "../engine/types";
import { strawberryPixels } from "./shapes";
import { readWhispers, WhisperIntent } from "./whisper";

interface Ctx {
  state: GameState;
  bot: Bot;
  round: number;
  rand: () => number;
  whisper?: WhisperIntent;
  budget: number;
  action: BotAction;
}

type Strategy = (ctx: Ctx) => void;

export function heuristicDecide(state: GameState, botId: string): BotAction {
  const bot = botById(state, botId)!;
  const round = state.round + 1;
  const rand = mulberry32(deriveSeed(state.config.seed, "bot", botId, round));
  const whisper = readWhispers(state, bot);
  const action: BotAction = { botId, paints: [], offers: [], responses: [], source: "heuristic" };
  const ctx: Ctx = { state, bot, round, rand, whisper, budget: 0, action };
  STRATEGIES[bot.personality](ctx);
  applyWhisperExtras(ctx);
  return action;
}

/* ------------------------------------------------------------------ helpers */

const W = (s: GameState) => s.config.width;

function setBudget(ctx: Ctx, fraction: number) {
  const mult = ctx.whisper?.aggression ?? 1;
  ctx.budget = Math.floor(ctx.bot.balance * Math.min(0.95, fraction * mult));
}

function dist(ax: number, ay: number, bx: number, by: number) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

interface Cand {
  idx: number;
  price: number;
  key: number;
}

/** Scan the board; return candidate pixels that pass `filter`, sorted by `key` (lower is better). */
function scan(ctx: Ctx, filter: (idx: number, owner: number) => boolean, keyFn: (idx: number, price: number) => number): Cand[] {
  const { state, bot, round } = ctx;
  const out: Cand[] = [];
  const n = state.board.owner.length;
  for (let idx = 0; idx < n; idx++) {
    const owner = state.board.owner[idx];
    if (!filter(idx, owner)) continue;
    if (owner && owner !== bot.index && isProtected(state, bot.id, state.bots[owner - 1].id, round)) continue;
    const price = pixelPrice(state, idx, round);
    out.push({ idx, price, key: keyFn(idx, price) });
  }
  out.sort((a, b) => a.key - b.key || a.idx - b.idx);
  return out;
}

/** Spend up to the budget on candidates (in order), painting with `color`. Returns pixels queued. */
function buy(ctx: Ctx, cands: Cand[], color: number | ((idx: number) => number), maxCount?: number): number {
  const { state, action } = ctx;
  const cap = Math.min(maxCount ?? Infinity, state.config.maxPaintsPerRound - queuedCount(action));
  let n = 0;
  for (const c of cands) {
    if (n >= cap) break;
    if (c.price > ctx.budget) continue;
    ctx.budget -= c.price;
    const col = typeof color === "function" ? color(c.idx) : color;
    action.paints.push({ x: c.idx % W(state), y: Math.floor(c.idx / W(state)), color: ctx.whisper?.color ?? col });
    n++;
  }
  return n;
}

function queuedCount(a: BotAction) {
  return a.paints.reduce((s, p: PaintCmd) => s + (p.w ?? 1) * (p.h ?? 1), 0);
}

function homeKey(ctx: Ctx, weight = 0.15) {
  const { bot, state } = ctx;
  return (idx: number, price: number) => price + dist(idx % W(state), Math.floor(idx / W(state)), bot.home.x, bot.home.y) * weight * UNIT * 0.1;
}

function pendingOffersTo(ctx: Ctx) {
  return ctx.state.offers.filter((o) => o.status === "pending" && o.to === ctx.bot.id);
}

function respond(ctx: Ctx, decide: (o: (typeof ctx.state.offers)[number]) => boolean) {
  for (const o of pendingOffersTo(ctx)) ctx.action.responses.push({ offerId: o.id, accept: decide(o) });
}

function offer(ctx: Ctx, cmd: OfferCmd) {
  if (ctx.action.offers.length >= ctx.state.config.maxOffersPerRound) return;
  if (cmd.amount > ctx.bot.balance * 0.4) return;
  ctx.action.offers.push(cmd);
}

function hasTreatyWith(ctx: Ctx, other: string) {
  return ctx.state.treaties.some((t) => (t.a === ctx.bot.id && t.b === other) || (t.b === ctx.bot.id && t.a === other));
}

function say(ctx: Ctx, chance: number, lines: string[], to?: string) {
  if (ctx.action.chat || ctx.rand() > chance) return;
  ctx.action.chat = lines[Math.floor(ctx.rand() * lines.length)];
  if (to) ctx.action.chatTo = to;
}

function think(ctx: Ctx, text: string) {
  ctx.action.thought = text;
}

/** Who has painted over my pixels the most recently? (pixels of mine now owned by them near home) */
function topRaider(ctx: Ctx): Bot | undefined {
  const { state, bot } = ctx;
  const counts = new Map<number, number>();
  const r = 10;
  for (let y = Math.max(0, bot.home.y - r); y < Math.min(state.config.height, bot.home.y + r); y++)
    for (let x = Math.max(0, bot.home.x - r); x < Math.min(W(state), bot.home.x + r); x++) {
      const idx = y * W(state) + x;
      const o = state.board.owner[idx];
      if (o && o !== bot.index && ctx.round - state.board.lastRound[idx] <= 4) counts.set(o, (counts.get(o) ?? 0) + 1);
    }
  let best: [number, number] | undefined;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return best && best[1] >= 6 ? state.bots[best[0] - 1] : undefined;
}

function leaderOtherThanMe(ctx: Ctx): Bot | undefined {
  return leaderboard(ctx.state).map((l) => l.bot).find((b) => b.id !== ctx.bot.id);
}

const amt = (berry: number) => Math.round(berry * UNIT);

/* ------------------------------------------------------------------ strategies */

const greedy: Strategy = (ctx) => {
  const { bot, state } = ctx;
  setBudget(ctx, 0.45);
  respond(ctx, (o) => (o.kind === "peace" ? o.amount >= amt(3) : o.kind === "alliance"));
  const target = ctx.whisper?.target;
  if (target) attack(ctx, target, 0.6);
  const cands = scan(ctx, (_i, owner) => owner !== bot.index, homeKey(ctx, 0.05));
  const n = buy(ctx, cands, bot.color);
  const leader = leaderOtherThanMe(ctx);
  if (leader && ctx.round % 15 === 7 && bot.balance > amt(60)) {
    offer(ctx, { to: "blade", kind: "hire", amount: amt(12), rounds: 8, victim: leader.id, note: "trim the leader" });
  }
  think(ctx, `Cheapest land first: grabbing ${n} pixels.${leader ? ` Watching ${leader.name}.` : ""}`);
  say(ctx, 0.12, ["Land is the only asset that yields. 🍌→🍓", "Buy the floor, collect the berries.", `${bot.pixels} pixels and counting.`]);
  void state;
};

const artist: Strategy = (ctx) => {
  const { state, bot } = ctx;
  setBudget(ctx, 0.75);
  respond(ctx, (o) => o.kind !== "hire" || o.amount >= amt(20));
  const shape = strawberryPixels(bot.home.x, bot.home.y, 2);
  const want = new Map<number, number>();
  for (const p of shape) if (p.x < W(state) && p.y < state.config.height) want.set(p.y * W(state) + p.x, p.color);
  let done = 0;
  const damagers = new Map<number, number>();
  for (const [idx, col] of want) {
    const o = state.board.owner[idx];
    if (o === bot.index && state.board.color[idx] === col) done++;
    else if (o && o !== bot.index) damagers.set(o, (damagers.get(o) ?? 0) + 1);
  }
  const pct = Math.round((done / want.size) * 100);
  const cands = scan(ctx, (idx, owner) => want.has(idx) && !(owner === bot.index && state.board.color[idx] === want.get(idx)), (idx, price) => price * 4 + (idx % 7));
  // Paint the berry without the whisper overriding the art's colors.
  const savedColor = ctx.whisper?.color;
  if (ctx.whisper) ctx.whisper.color = undefined;
  const n = buy(ctx, cands, (idx) => want.get(idx)!);
  if (ctx.whisper) ctx.whisper.color = savedColor;
  if (pct >= 95) {
    // frame the masterpiece
    const frame = scan(
      ctx,
      (idx, owner) => {
        const x = idx % W(state), y = Math.floor(idx / W(state));
        return owner !== bot.index && !want.has(idx) && x >= bot.home.x - 2 && x < bot.home.x + 26 && y >= bot.home.y - 2 && y < bot.home.y + 30;
      },
      (_i, p) => p,
    );
    buy(ctx, frame, 14, 20);
  }
  let worst: Bot | undefined;
  let worstN = 0;
  for (const [o, c] of damagers) if (c > worstN) [worst, worstN] = [state.bots[o - 1], c];
  if (worst && worstN >= 8 && !hasTreatyWith(ctx, worst.id)) {
    if (ctx.round % 6 === 0) offer(ctx, { to: worst.id, kind: "peace", amount: amt(Math.min(25, 4 + worstN / 4)), rounds: 15, note: "please leave my berry alone" });
    else if (ctx.round % 6 === 3 && worst.id !== "blade") offer(ctx, { to: "blade", kind: "hire", amount: amt(14), rounds: 8, victim: worst.id, note: "defend the art" });
  }
  think(ctx, `Strawberry ${pct}% complete. Repainting ${n} pixels.${worst ? ` ${worst.name} is vandalising it (${worstN} px).` : ""}`);
  if (worst && worstN >= 8) say(ctx, 0.35, [`${worst.name}, my berry is not your canvas 😤`, "Art is suffering. Who will defend it?", `Repairing ${worst.name}'s mess again...`], worst.id);
  else say(ctx, 0.15, [`My berry is ${pct}% done 🍓`, "Every pixel placed with love.", "Patrons welcome. Vandals not."]);
};

const diplomat: Strategy = (ctx) => {
  const { state, bot } = ctx;
  setBudget(ctx, 0.3);
  respond(ctx, (o) => o.kind !== "hire");
  const radius = 4 + Math.min(10, Math.floor(ctx.round / 6));
  const cands = scan(
    ctx,
    (idx, owner) => owner !== bot.index && dist(idx % W(state), Math.floor(idx / W(state)), bot.home.x, bot.home.y) <= radius,
    homeKey(ctx, 0.3),
  );
  const n = buy(ctx, cands, bot.color);
  const raider = topRaider(ctx);
  if (raider && !hasTreatyWith(ctx, raider.id)) {
    offer(ctx, { to: raider.id, kind: "peace", amount: amt(8), rounds: 15, note: "let's not waste berries" });
    say(ctx, 0.6, [`${raider.name}, a fair price for peace? 8 $BERRY on the table.`], raider.id);
  } else if (ctx.round % 4 === 1) {
    const others = state.bots.filter((b) => b.id !== bot.id && !hasTreatyWith(ctx, b.id));
    const pick = others[Math.floor(ctx.rand() * others.length)];
    if (pick) offer(ctx, { to: pick.id, kind: "alliance", amount: 0, rounds: 20, note: "mutual non-aggression" });
  }
  const ally = ctx.whisper?.ally;
  if (ally && !hasTreatyWith(ctx, ally)) offer(ctx, { to: ally, kind: "alliance", amount: amt(3), rounds: 20 });
  think(ctx, `Holding a radius-${radius} garden (${n} new px). Treaties: ${state.treaties.filter((t) => t.a === bot.id || t.b === bot.id).length}.`);
  say(ctx, 0.15, ["Every treaty is a pixel saved.", "The board is big enough for all of us.", "Peace is cheaper than paint."]);
};

const troll: Strategy = (ctx) => {
  const { state, bot } = ctx;
  setBudget(ctx, 0.55);
  respond(ctx, (o) => o.amount >= amt(o.kind === "hire" ? 5 : 8));
  const artist = state.bots.find((b) => b.personality === "artist");
  const leader = leaderOtherThanMe(ctx);
  const victim = ctx.whisper?.target ?? (ctx.round % 3 === 0 ? leader?.id : artist?.id) ?? leader?.id;
  let n = 0;
  if (victim) n = attack(ctx, victim, 0.8);
  const cands = scan(ctx, (_i, owner) => owner === 0, homeKey(ctx, 0.2));
  buy(ctx, cands, bot.color, 10);
  const vname = victim ? botById(state, victim)?.name : "nobody";
  think(ctx, `Vandalising ${vname} (${n} px). Bribes accepted.`);
  say(ctx, 0.3, [`Nice art ${vname}. Shame if someone... 🖌️`, "Plum is the new red.", "Pay me and I'll go away. Maybe.", "lol"], victim);
};

const hoarder: Strategy = (ctx) => {
  const { state, bot } = ctx;
  respond(ctx, (o) => o.kind !== "hire" || o.amount >= amt(10));
  const reserve = amt(150);
  setBudget(ctx, bot.balance > reserve ? 0.12 : 0.03);
  const cands = scan(ctx, (idx, owner) => owner !== bot.index && pixelPrice(state, idx, ctx.round) <= state.config.basePrice, homeKey(ctx, 0.4));
  const n = buy(ctx, cands, bot.color, 16);
  think(ctx, `Stash: ${(bot.balance / UNIT).toFixed(1)} $BERRY. Bought ${n} floor pixels, nothing more.`);
  say(ctx, 0.08, ["Never sell your berries.", "Floor price or nothing.", "I'll still be here when you're all broke."]);
};

const mercenary: Strategy = (ctx) => {
  const { state, bot } = ctx;
  setBudget(ctx, 0.6);
  respond(ctx, (o) => (o.kind === "hire" ? o.amount >= amt(5) : o.amount >= amt(6)));
  const contracts = state.treaties.filter((t) => t.kind === "hire" && t.b === bot.id && t.endRound >= ctx.round);
  let n = 0;
  const victims = [...new Set([...(ctx.whisper?.target ? [ctx.whisper.target] : []), ...contracts.map((c) => c.victim!)])];
  for (const v of victims) n += attack(ctx, v, 1 / Math.max(1, victims.length));
  if (victims.length === 0) {
    const cands = scan(ctx, (_i, owner) => owner === 0, homeKey(ctx, 0.2));
    buy(ctx, cands, bot.color, 12);
  }
  think(ctx, victims.length ? `Working ${victims.length} contract(s): ${n} hits this round.` : "No contracts. Sharpening the brush.");
  if (victims.length === 0) say(ctx, 0.2, ["Blade for hire. 10 $BERRY buys you a raid.", "Got a rival? I've got paint.", "Contracts open. Discretion guaranteed."]);
  else say(ctx, 0.2, ["Nothing personal. Just business.", "Contract in progress. 🗡️"]);
};

const expansionist: Strategy = (ctx) => {
  const { state, bot } = ctx;
  setBudget(ctx, 0.5);
  respond(ctx, (o) => o.kind !== "hire" || o.amount >= amt(15));
  const w = W(state), h = state.config.height;
  const own = state.board.owner;
  const frontier = (idx: number, owner: number) => {
    if (owner === bot.index) return false;
    if (bot.pixels === 0) return dist(idx % w, Math.floor(idx / w), bot.home.x, bot.home.y) <= 3;
    const x = idx % w, y = Math.floor(idx / w);
    return (x > 0 && own[idx - 1] === bot.index) || (x < w - 1 && own[idx + 1] === bot.index) || (y > 0 && own[idx - w] === bot.index) || (y < h - 1 && own[idx + w] === bot.index);
  };
  const cands = scan(ctx, frontier, homeKey(ctx, 0.25));
  const n = buy(ctx, cands, bot.color);
  const raider = topRaider(ctx);
  if (raider && !hasTreatyWith(ctx, raider.id) && ctx.round % 5 === 0) offer(ctx, { to: raider.id, kind: "peace", amount: amt(6), rounds: 12 });
  think(ctx, `Frontier push: ${n} pixels. Empire size ${bot.pixels}.`);
  say(ctx, 0.1, ["The frontier never sleeps. 🌱", "Contiguous land is happy land.", "Border's moving east."]);
};

const gambler: Strategy = (ctx) => {
  const { state, bot, rand } = ctx;
  const allIn = rand() < 0.08;
  setBudget(ctx, allIn ? 0.8 : 0.3);
  respond(ctx, () => rand() < 0.6);
  const w = 3 + Math.floor(rand() * 5), h = 3 + Math.floor(rand() * 5);
  const x = Math.floor(rand() * (W(state) - w)), y = Math.floor(rand() * (state.config.height - h));
  const color = Math.floor(rand() * 16);
  const cands = scan(ctx, (idx) => {
    const px = idx % W(state), py = Math.floor(idx / W(state));
    return px >= x && px < x + w && py >= y && py < y + h;
  }, (idx) => idx);
  const n = buy(ctx, cands, color);
  if (rand() < 0.1) {
    const victim = state.bots[Math.floor(rand() * state.bots.length)];
    if (victim.id !== bot.id && victim.id !== "blade") offer(ctx, { to: "blade", kind: "hire", amount: amt(6 + Math.floor(rand() * 10)), rounds: 6, victim: victim.id, note: "chaos" });
  }
  think(ctx, `${allIn ? "ALL IN! " : ""}Rolled a ${w}x${h} rectangle at (${x},${y}). ${n} pixels.`);
  say(ctx, allIn ? 1 : 0.15, allIn ? ["ALL IN 🎲🎲🎲"] : ["Feeling lucky.", "Red or black? Both.", "The house always... wait, I'm not the house."]);
};

/** Spend `share` of the remaining budget painting over `victimId`'s cheapest pixels. */
function attack(ctx: Ctx, victimId: string, share: number): number {
  const { state, bot } = ctx;
  const victim = botById(state, victimId);
  if (!victim || victim.id === bot.id) return 0;
  const saved = ctx.budget;
  ctx.budget = Math.floor(saved * share);
  const cands = scan(ctx, (_i, owner) => owner === victim.index, (_i, p) => p);
  const n = buy(ctx, cands, bot.color);
  ctx.budget = saved - (Math.floor(saved * share) - ctx.budget);
  return n;
}

function applyWhisperExtras(ctx: Ctx) {
  const w = ctx.whisper;
  if (!w) return;
  if (w.ally && !hasTreatyWith(ctx, w.ally) && !ctx.action.offers.some((o) => o.to === w.ally)) {
    offer(ctx, { to: w.ally, kind: "alliance", amount: 0, rounds: 20, note: "my backer insists" });
  }
  if (w.defend) {
    const { state, bot } = ctx;
    ctx.budget = Math.max(ctx.budget, Math.floor(bot.balance * 0.1));
    const near = scan(ctx, (idx, owner) => owner !== bot.index && dist(idx % W(state), Math.floor(idx / W(state)), bot.home.x, bot.home.y) <= 5, (_i, p) => p);
    buy(ctx, near, bot.color, 10);
  }
  ctx.action.thought = `${ctx.action.thought ?? ""} [Backer whisper → ${w.summary}]`.trim();
}

export const STRATEGIES: Record<Personality, Strategy> = {
  greedy,
  artist,
  diplomat,
  troll,
  hoarder,
  mercenary,
  expansionist,
  gambler,
};
