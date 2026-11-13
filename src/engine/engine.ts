/**
 * Berry Bots rules engine. Pure and deterministic: the same config, bot roster and
 * sequence of actions always produce the same state and the same board hash.
 * Brains (LLM or heuristic) decide actions outside the engine; the engine validates
 * and applies them.
 */
import { fmt } from "./config";
import { fnv64 } from "./hash";
import { deriveSeed, mulberry32, shuffle } from "./rng";
import {
  Board,
  Bot,
  BotAction,
  GameConfig,
  GameEvent,
  GameState,
  Offer,
  OfferCmd,
  PixelChange,
  RoundLedger,
  RoundResult,
  Transfer,
  Treaty,
} from "./types";

export interface BotSpec {
  id: string;
  name: string;
  personality: Bot["personality"];
  tagline: string;
  emoji: string;
  color: number;
  home: { x: number; y: number };
  brain?: Bot["brain"];
}

const MAX_CHAT = 200;
const MAX_EVENTS = 400;
const MAX_WHISPERS = 5;

export function createGame(config: GameConfig, specs: BotSpec[], accountSuffix = "berrybots.local"): GameState {
  if (specs.length > 250) throw new Error("too many bots");
  const n = config.width * config.height;
  const board: Board = {
    owner: new Uint8Array(n),
    color: new Uint8Array(n),
    lastPrice: new Uint32Array(n),
    lastRound: new Int32Array(n).fill(-1),
  };
  const bots: Bot[] = specs.map((s, i) => ({
    ...s,
    index: i + 1,
    brain: s.brain ?? "heuristic",
    accountId: `${s.id}.${accountSuffix}`,
    balance: config.startBalance,
    pixels: 0,
    backers: 0,
    lastThought: "",
    stats: {
      painted: 0,
      overwrites: 0,
      pixelsLost: 0,
      earnedFromOverwrites: 0,
      minted: 0,
      burned: 0,
      dealsPaid: 0,
      dealsReceived: 0,
      blockedByTreaty: 0,
    },
  }));
  const supply = config.startBalance * bots.length;
  return {
    config,
    round: 0,
    bots,
    board,
    offers: [],
    treaties: [],
    chat: [],
    whispers: Object.fromEntries(bots.map((b) => [b.id, []])),
    events: [{ round: 0, type: "info", text: `${bots.length} bots spawn with ${fmt(config.startBalance, 0)} $BERRY each. Let the pixel war begin.` }],
    token: {
      totalSupply: supply,
      minted: supply,
      burned: 0,
      rate: config.emission.initialRate,
      calmStreak: 0,
      history: [{ round: 0, supply, rate: config.emission.initialRate, painted: 0, burned: 0, minted: supply }],
    },
    finished: false,
    nextId: 1,
  };
}

/* ------------------------------------------------------------------ pricing */

/** Price (milli) to buy pixel `idx` during round `round`. Recently bought pixels are hot and expensive. */
export function pixelPrice(state: GameState, idx: number, round = state.round + 1): number {
  const { board, config } = state;
  const last = board.lastRound[idx];
  if (last < 0) return config.basePrice;
  const age = Math.max(0, round - last);
  const heat = config.heatMultiplier * board.lastPrice[idx] * Math.pow(0.5, age / config.heatHalfLife);
  return config.basePrice + Math.floor(heat);
}

export function botById(state: GameState, id: string): Bot | undefined {
  return state.bots.find((b) => b.id === id);
}

export function score(state: GameState, bot: Bot): number {
  return bot.balance + bot.pixels * state.config.landValue;
}

export function leaderboard(state: GameState): { bot: Bot; score: number }[] {
  return state.bots
    .map((bot) => ({ bot, score: score(state, bot) }))
    .sort((a, b) => b.score - a.score || a.bot.index - b.bot.index);
}

export function boardHash(board: Board): string {
  const buf = new Uint8Array(board.owner.length * 2);
  for (let i = 0; i < board.owner.length; i++) {
    buf[i * 2] = board.owner[i];
    buf[i * 2 + 1] = board.color[i];
  }
  return fnv64(buf);
}

/** Is `painter` forbidden from overwriting pixels of `owner` by an active treaty? */
export function isProtected(state: GameState, painter: string, owner: string, round = state.round + 1): boolean {
  for (const t of state.treaties) {
    if (t.endRound < round) continue;
    if (t.kind === "peace" && t.b === painter && t.a === owner) return true;
    if (t.kind === "alliance" && ((t.a === painter && t.b === owner) || (t.b === painter && t.a === owner))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ validation helpers */

const clampInt = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === "number" ? Math.floor(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
};

/** Expand paint commands (pixels and rectangles) into pixel targets, clipped to the board and capped. */
export function expandPaints(state: GameState, action: BotAction): { idx: number; color: number }[] {
  const { width, height, maxPaintsPerRound } = state.config;
  const out: { idx: number; color: number }[] = [];
  const seen = new Set<number>();
  for (const p of action.paints ?? []) {
    const color = clampInt(p.color, 0, 15);
    const x0 = clampInt(p.x, 0, width - 1);
    const y0 = clampInt(p.y, 0, height - 1);
    if (color === undefined || x0 === undefined || y0 === undefined) continue;
    const w = clampInt(p.w ?? 1, 1, width) ?? 1;
    const h = clampInt(p.h ?? 1, 1, height) ?? 1;
    for (let y = y0; y < Math.min(height, y0 + h); y++) {
      for (let x = x0; x < Math.min(width, x0 + w); x++) {
        const idx = y * width + x;
        if (seen.has(idx)) continue;
        seen.add(idx);
        out.push({ idx, color });
        if (out.length >= maxPaintsPerRound) return out;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the round */

/**
 * Apply one round. `actions` may be in any order; the engine resolves them in a
 * seeded order so the result is deterministic.
 * Order: responses to offers -> paints (interleaved round-robin) -> new offers -> chat -> emission -> housekeeping.
 */
export function applyRound(state: GameState, actions: BotAction[]): RoundResult {
  if (state.finished) throw new Error("game is finished");
  const round = state.round + 1;
  const cfg = state.config;
  const rand = mulberry32(deriveSeed(cfg.seed, "round", round));
  const events: GameEvent[] = [];
  const ledger: RoundLedger = { round, mints: {}, burns: {}, transfers: [], deals: [], boardHash: "" };
  const transferMap = new Map<string, Transfer>();
  const addTransfer = (from: string, to: string, amount: number, reason: Transfer["reason"]) => {
    if (amount <= 0) return;
    const key = `${from}>${to}>${reason}`;
    const t = transferMap.get(key);
    if (t) t.amount += amount;
    else transferMap.set(key, { from, to, amount, reason });
  };
  const addBurn = (bot: Bot, amount: number) => {
    if (amount <= 0) return;
    ledger.burns[bot.id] = (ledger.burns[bot.id] ?? 0) + amount;
    bot.stats.burned += amount;
    state.token.burned += amount;
    state.token.totalSupply -= amount;
  };
  const emit = (e: Omit<GameEvent, "round">) => events.push({ round, ...e });

  // keep only one action per known bot (first wins)
  const byBot = new Map<string, BotAction>();
  for (const a of actions) if (botById(state, a.botId) && !byBot.has(a.botId)) byBot.set(a.botId, a);
  const order = shuffle(state.bots.map((b) => b.id), rand);

  // 0. thoughts
  for (const [id, a] of byBot) {
    if (a.thought) botById(state, id)!.lastThought = String(a.thought).slice(0, 240);
  }

  // 1. responses to pending offers
  for (const id of order) {
    const a = byBot.get(id);
    if (!a) continue;
    for (const r of (a.responses ?? []).slice(0, 8)) {
      const offer = state.offers.find((o) => o.id === r.offerId);
      if (!offer || offer.status !== "pending" || offer.to !== id) continue;
      if (!r.accept) {
        offer.status = "rejected";
        emit({ type: "reject", text: `${name(state, id)} rejected ${name(state, offer.from)}'s ${offer.kind} offer`, bots: [id, offer.from] });
        continue;
      }
      const payer = botById(state, offer.from)!;
      const payee = botById(state, offer.to)!;
      if (payer.balance < offer.amount) {
        offer.status = "failed";
        emit({ type: "reject", text: `${payer.name} couldn't cover the ${offer.kind} deal with ${payee.name}`, bots: [payer.id, payee.id] });
        continue;
      }
      payer.balance -= offer.amount;
      payee.balance += offer.amount;
      payer.stats.dealsPaid += offer.amount;
      payee.stats.dealsReceived += offer.amount;
      if (offer.amount > 0) ledger.deals.push({ from: payer.id, to: payee.id, amount: offer.amount, reason: "deal" });
      offer.status = "accepted";
      const treaty: Treaty = {
        id: state.nextId++,
        kind: offer.kind,
        a: offer.from,
        b: offer.to,
        victim: offer.victim,
        amount: offer.amount,
        startRound: round,
        endRound: round + offer.rounds - 1,
        hits: 0,
      };
      state.treaties.push(treaty);
      emit({ type: "deal", text: dealText(state, treaty), bots: [payer.id, payee.id, ...(offer.victim ? [offer.victim] : [])] });
    }
  }

  // 2. paints, interleaved one pixel per bot per turn in the seeded order
  const queues = new Map<string, { idx: number; color: number }[]>();
  for (const id of order) {
    const a = byBot.get(id);
    if (a) queues.set(id, expandPaints(state, a));
  }
  const changes = new Map<number, PixelChange>();
  const blocked = new Map<string, number>();
  const raids = new Map<string, number>(); // "attacker>victim" -> pixels
  let painted = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (const id of order) {
      const q = queues.get(id);
      if (!q || q.length === 0) continue;
      progress = true;
      const { idx, color } = q.shift()!;
      const bot = botById(state, id)!;
      const ownerIdx = state.board.owner[idx];
      if (ownerIdx === bot.index && state.board.color[idx] === color) continue;
      const prev = ownerIdx ? state.bots[ownerIdx - 1] : undefined;
      if (prev && prev.id !== bot.id && isProtected(state, bot.id, prev.id, round)) {
        blocked.set(id, (blocked.get(id) ?? 0) + 1);
        bot.stats.blockedByTreaty++;
        continue;
      }
      const price = pixelPrice(state, idx, round);
      if (bot.balance < price) continue;
      bot.balance -= price;
      let burn = price;
      if (prev && prev.id !== bot.id) {
        const share = Math.floor((price * cfg.ownerShareBps) / 10000);
        prev.balance += share;
        prev.pixels--;
        prev.stats.pixelsLost++;
        prev.stats.earnedFromOverwrites += share;
        bot.stats.overwrites++;
        addTransfer(bot.id, prev.id, share, "overwrite");
        burn -= share;
        const key = `${bot.id}>${prev.id}`;
        raids.set(key, (raids.get(key) ?? 0) + 1);
        for (const t of state.treaties) {
          if (t.kind === "hire" && t.b === bot.id && t.victim === prev.id && t.endRound >= round) t.hits++;
        }
      }
      addBurn(bot, burn);
      if (!prev || prev.id !== bot.id) bot.pixels++;
      bot.stats.painted++;
      state.board.owner[idx] = bot.index;
      state.board.color[idx] = color;
      state.board.lastPrice[idx] = price;
      state.board.lastRound[idx] = round;
      changes.set(idx, [idx, bot.index, color]);
      painted++;
    }
  }
  for (const [key, n] of raids) {
    if (n < 10) continue;
    const [att, vic] = key.split(">");
    emit({ type: "war", text: `${name(state, att)} raided ${n} of ${name(state, vic)}'s pixels`, bots: [att, vic] });
  }
  for (const [id, n] of blocked) {
    if (n >= 5) emit({ type: "info", text: `${name(state, id)} hit a treaty wall (${n} pixels blocked)`, bots: [id] });
  }

  // 3. new offers
  for (const id of order) {
    const a = byBot.get(id);
    if (!a) continue;
    let made = 0;
    for (const cmd of a.offers ?? []) {
      if (made >= cfg.maxOffersPerRound) break;
      const offer = validateOffer(state, id, cmd, round);
      if (!offer) continue;
      state.offers.push(offer);
      made++;
      emit({ type: "offer", text: offerText(state, offer), bots: [offer.from, offer.to] });
    }
  }

  // 4. chat
  for (const id of order) {
    const a = byBot.get(id);
    if (!a?.chat) continue;
    const text = String(a.chat).replace(/\s+/g, " ").trim().slice(0, cfg.maxChatLength);
    if (!text) continue;
    const to = a.chatTo && botById(state, a.chatTo) && a.chatTo !== id ? a.chatTo : undefined;
    state.chat.push({ round, from: id, to, text });
    emit({ type: "chat", text: `${name(state, id)}${to ? ` → ${name(state, to)}` : ""}: ${text}`, bots: to ? [id, to] : [id] });
  }

  // 5. emission: every owned pixel mints `rate`
  let mintedThisRound = 0;
  for (const bot of state.bots) {
    const m = bot.pixels * state.token.rate;
    if (m <= 0) continue;
    bot.balance += m;
    bot.stats.minted += m;
    ledger.mints[bot.id] = m;
    mintedThisRound += m;
  }
  state.token.minted += mintedThisRound;
  state.token.totalSupply += mintedThisRound;

  // 6. supply reacts to the community: calm board => emission halves, paint frenzy => emission grows
  const burnedThisRound = Object.values(ledger.burns).reduce((s, v) => s + v, 0);
  const frac = painted / (cfg.width * cfg.height);
  const ratio = burnedThisRound / Math.max(1, mintedThisRound);
  const em = cfg.emission;
  if (ratio < em.calmRatio) {
    state.token.calmStreak++;
    if (state.token.calmStreak >= em.calmRoundsToHalve && state.token.rate > em.minRate) {
      state.token.rate = Math.max(em.minRate, Math.floor(state.token.rate / 2));
      state.token.calmStreak = 0;
      emit({ type: "halving", text: `🌙 Calm board: paint burned less than emission for ${em.calmRoundsToHalve} rounds. $BERRY emission HALVED to ${(state.token.rate / 1000).toFixed(3)}/px.` });
    }
  } else {
    state.token.calmStreak = 0;
    if (ratio > em.hotRatio && frac >= em.frenzyMinPaint && state.token.rate < em.maxRate) {
      state.token.rate = Math.min(em.maxRate, Math.ceil(state.token.rate * em.hotFactor));
      emit({ type: "frenzy", text: `🔥 Paint frenzy: ${painted} px painted, burn ${(ratio).toFixed(1)}x emission. $BERRY emission up to ${(state.token.rate / 1000).toFixed(3)}/px.` });
    }
  }
  state.token.history.push({
    round,
    supply: state.token.totalSupply,
    rate: state.token.rate,
    painted,
    burned: burnedThisRound,
    minted: mintedThisRound,
  });

  // 7. housekeeping: expire offers and treaties
  for (const o of state.offers) {
    if (o.status === "pending" && round - o.round >= cfg.offerTtl) o.status = "expired";
  }
  state.offers = state.offers.filter((o) => o.status === "pending" || round - o.round < 10);
  const ended = state.treaties.filter((t) => t.endRound <= round);
  for (const t of ended) {
    if (t.kind === "hire") {
      emit({
        type: "treaty_end",
        text: `${name(state, t.b)}'s contract on ${name(state, t.victim!)} ended: ${t.hits} hits delivered for ${name(state, t.a)}`,
        bots: [t.a, t.b, t.victim!],
      });
    } else {
      emit({ type: "treaty_end", text: `The ${t.kind} between ${name(state, t.a)} and ${name(state, t.b)} expired`, bots: [t.a, t.b] });
    }
  }
  state.treaties = state.treaties.filter((t) => t.endRound > round);

  state.round = round;
  ledger.transfers = [...transferMap.values()];
  ledger.boardHash = boardHash(state.board);

  if (round >= cfg.rounds) {
    state.finished = true;
    const top = leaderboard(state)[0];
    emit({
      type: "game_over",
      text: `🏁 Game over! ${top.bot.emoji} ${top.bot.name} wins with ${top.bot.pixels} px + ${fmt(top.bot.balance)} $BERRY.`,
      bots: [top.bot.id],
    });
  }

  state.events.push(...events);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  if (state.chat.length > MAX_CHAT) state.chat.splice(0, state.chat.length - MAX_CHAT);

  return { round, changes: [...changes.values()], events, ledger, painted };
}

function validateOffer(state: GameState, from: string, cmd: OfferCmd, round: number): Offer | undefined {
  const cfg = state.config;
  const proposer = botById(state, from)!;
  if (!cmd || typeof cmd !== "object") return;
  if (!["peace", "alliance", "hire"].includes(cmd.kind)) return;
  const to = botById(state, cmd.to);
  if (!to || to.id === from) return;
  const amount = clampInt(cmd.amount, 0, Math.min(proposer.balance, cfg.maxDealAmount));
  const rounds = clampInt(cmd.rounds, 1, cfg.maxTreatyRounds);
  if (amount === undefined || rounds === undefined) return;
  let victim: string | undefined;
  if (cmd.kind === "hire") {
    const v = botById(state, cmd.victim ?? "");
    if (!v || v.id === to.id || amount <= 0) return;
    victim = v.id;
  }
  if (state.offers.some((o) => o.status === "pending" && o.from === from && o.to === to.id)) return;
  return {
    id: state.nextId++,
    round,
    from,
    to: to.id,
    kind: cmd.kind,
    amount,
    rounds,
    victim,
    note: cmd.note ? String(cmd.note).slice(0, 100) : undefined,
    status: "pending",
  };
}

/** Record a human whisper for a bot (kept short; the latest few are shown to the bot). */
export function addWhisper(state: GameState, botId: string, text: string, from = "human"): boolean {
  const bot = botById(state, botId);
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!bot || !clean) return false;
  const list = state.whispers[botId];
  list.push({ round: state.round, from, text: clean });
  if (list.length > MAX_WHISPERS) list.splice(0, list.length - MAX_WHISPERS);
  state.events.push({ round: state.round, type: "whisper", text: `🤫 A backer whispered to ${bot.name}: "${clean}"`, bots: [botId] });
  return true;
}

export function addBacker(state: GameState, botId: string): boolean {
  const bot = botById(state, botId);
  if (!bot) return false;
  bot.backers++;
  state.events.push({ round: state.round, type: "back", text: `📣 ${bot.name} gained a backer (${bot.backers} total)`, bots: [botId] });
  return true;
}

function name(state: GameState, id: string): string {
  return botById(state, id)?.name ?? id;
}

function offerText(state: GameState, o: Offer): string {
  const amt = `${fmt(o.amount)} $BERRY`;
  if (o.kind === "peace") return `${name(state, o.from)} offers ${name(state, o.to)} ${amt} for ${o.rounds} rounds of peace`;
  if (o.kind === "alliance") return `${name(state, o.from)} proposes an alliance to ${name(state, o.to)} (${o.rounds} rounds${o.amount ? `, sweetened with ${amt}` : ""})`;
  return `${name(state, o.from)} offers ${name(state, o.to)} ${amt} to hit ${name(state, o.victim!)}`;
}

function dealText(state: GameState, t: Treaty): string {
  const amt = t.amount ? ` for ${fmt(t.amount)} $BERRY` : "";
  if (t.kind === "peace") return `🤝 Deal: ${name(state, t.b)} won't touch ${name(state, t.a)}'s land${amt} (until round ${t.endRound})`;
  if (t.kind === "alliance") return `🛡️ Alliance: ${name(state, t.a)} + ${name(state, t.b)}${amt} (until round ${t.endRound})`;
  return `🗡️ Contract: ${name(state, t.a)} hired ${name(state, t.b)} to hit ${name(state, t.victim!)}${amt}`;
}

/** JSON-safe snapshot for the UI / replays. */
export function serializeState(state: GameState) {
  return {
    ...state,
    board: {
      owner: Array.from(state.board.owner),
      color: Array.from(state.board.color),
    },
  };
}
export type SerializedState = ReturnType<typeof serializeState>;
