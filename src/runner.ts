/**
 * GameRunner: drives rounds (brains -> engine -> chain settlement) and broadcasts packets.
 * Used by the Node server and, with heuristic brains only, directly in the browser
 * ("offline demo" mode when no server is reachable).
 */
import { decide } from "./bots/brains";
import type { LlmConfig } from "./bots/llm";
import { BOT_SPECS } from "./bots/personalities";
import type { ChainAdapter, ChainInfo, SettleReceipt } from "./chain/types";
import { makeConfig } from "./engine/config";
import { addBacker, addWhisper, applyRound, createGame, serializeState, SerializedState } from "./engine/engine";
import type { BotSpec } from "./engine/engine";
import type { Bot, GameConfig, GameEvent, GameState, Offer, PixelChange, RoundLedger, TokenPoint, Treaty } from "./engine/types";

export interface Frame {
  round: number;
  changes: PixelChange[];
  supply: number;
  rate: number;
  headline?: string;
}

export interface RoundPacket {
  type: "round";
  round: number;
  changes: PixelChange[];
  events: GameEvent[];
  bots: Bot[];
  token: TokenPoint & { totalBurned: number; totalMinted: number };
  offers: Offer[];
  treaties: Treaty[];
  finished: boolean;
  receipt?: SettleReceipt;
}

export interface SnapshotPacket {
  type: "snapshot";
  state: SerializedState;
  frames: Frame[];
  chain: ChainInfo;
  receipts: SettleReceipt[];
  meta: RunnerMeta;
}

export interface MetaPacket {
  type: "meta";
  meta: RunnerMeta;
  events?: GameEvent[];
  bots?: Bot[];
}

export interface RunnerMeta {
  paused: boolean;
  speed: number;
  roundMs: number;
  nextRoundAt: number;
  brains: Record<string, string>;
  model?: string;
  gameNo: number;
  offline: boolean;
}

export type Packet = RoundPacket | SnapshotPacket | MetaPacket;

export interface RunnerOptions {
  config?: Partial<GameConfig>;
  specs?: BotSpec[];
  makeChain: () => ChainAdapter;
  llm?: LlmConfig;
  /** bot ids that use the LLM brain when `llm` is set; default all */
  llmBots?: string[];
  accountSuffix?: string;
  autoRestartMs?: number;
  offline?: boolean;
  log?: (msg: string) => void;
}

const HEADLINE_TYPES = new Set(["deal", "war", "halving", "frenzy", "game_over", "whisper"]);

export class GameRunner {
  state!: GameState;
  frames: Frame[] = [];
  receipts: SettleReceipt[] = [];
  chain!: ChainAdapter;
  private pending: RoundLedger[] = [];
  private listeners = new Set<(p: Packet) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  paused = false;
  speed = 1;
  nextRoundAt = 0;
  gameNo = 0;
  brainErrors = 0;

  constructor(private opts: RunnerOptions) {}

  async newGame(seed?: number) {
    const config = makeConfig({ ...this.opts.config, ...(seed !== undefined ? { seed } : {}) });
    const specs = (this.opts.specs ?? BOT_SPECS).map((s) => ({
      ...s,
      brain: this.opts.llm && (!this.opts.llmBots || this.opts.llmBots.includes(s.id)) ? ("llm" as const) : ("heuristic" as const),
    }));
    this.state = createGame(config, specs, this.opts.accountSuffix);
    this.frames = [{ round: 0, changes: [], supply: this.state.token.totalSupply, rate: this.state.token.rate }];
    this.receipts = [];
    this.pending = [];
    this.chain = this.opts.makeChain();
    await this.chain.setup(this.state.bots, config.startBalance);
    this.gameNo++;
    this.broadcast(this.snapshot());
  }

  meta(): RunnerMeta {
    return {
      paused: this.paused,
      speed: this.speed,
      roundMs: this.state.config.roundMs,
      nextRoundAt: this.nextRoundAt,
      brains: Object.fromEntries(this.state.bots.map((b) => [b.id, b.brain])),
      model: this.opts.llm?.model,
      gameNo: this.gameNo,
      offline: !!this.opts.offline,
    };
  }

  snapshot(): SnapshotPacket {
    return {
      type: "snapshot",
      state: serializeState(this.state),
      frames: this.frames,
      chain: this.chain.info(),
      receipts: this.receipts.slice(-20),
      meta: this.meta(),
    };
  }

  subscribe(fn: (p: Packet) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(p: Packet) {
    for (const fn of this.listeners) {
      try {
        fn(p);
      } catch {
        /* a broken listener must not stop the game */
      }
    }
  }

  /** Play exactly one round. */
  async step(): Promise<RoundPacket | undefined> {
    if (this.busy || this.state.finished) return;
    this.busy = true;
    try {
      const state = this.state;
      const results = await Promise.all(state.bots.map((b) => decide(state, b.id, this.opts.llm)));
      for (const r of results) {
        if (r.error) {
          this.brainErrors++;
          this.opts.log?.(`[brain] ${r.action.botId} fell back to heuristic: ${r.error}`);
        }
      }
      if (state !== this.state) return; // game was reset while thinking
      const res = applyRound(state, results.map((r) => r.action));
      const headline = res.events.find((e) => HEADLINE_TYPES.has(e.type))?.text;
      this.frames.push({ round: res.round, changes: res.changes, supply: state.token.totalSupply, rate: state.token.rate, headline });
      this.pending.push(res.ledger);
      let receipt: SettleReceipt | undefined;
      const every = this.chain.info().settleEvery;
      if (this.pending.length >= every || state.finished) {
        const batch = this.pending;
        this.pending = [];
        receipt = await this.chain.settle(batch, state.bots);
        this.receipts.push(receipt);
        const ev: GameEvent = {
          round: res.round,
          type: "settle",
          text: receipt.ok
            ? `⛓️ Rounds ${receipt.fromRound}–${receipt.round} settled: ${receipt.txHashes.length} settle_round + ${receipt.dealTxs.length} bot_pay${receipt.consistent === false ? " ⚠️ ledger mismatch" : receipt.consistent ? " ✓ ledger matches" : ""}`
            : `⛓️ Settlement failed for rounds ${receipt.fromRound}–${receipt.round}: ${receipt.error}`,
        };
        state.events.push(ev);
        res.events.push(ev);
      }
      const last = state.token.history[state.token.history.length - 1];
      const packet: RoundPacket = {
        type: "round",
        round: res.round,
        changes: res.changes,
        events: res.events,
        bots: state.bots,
        token: { ...last, totalBurned: state.token.burned, totalMinted: state.token.minted },
        offers: state.offers.filter((o) => o.status === "pending"),
        treaties: state.treaties,
        finished: state.finished,
        receipt,
      };
      this.broadcast(packet);
      return packet;
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      const t0 = Date.now();
      if (!this.paused) {
        if (this.state.finished) {
          if (this.opts.autoRestartMs !== undefined) {
            await sleep(this.opts.autoRestartMs);
            await this.newGame(this.state.config.seed + 1);
          } else {
            this.timer = undefined;
            return;
          }
        } else {
          try {
            await this.step();
          } catch (e) {
            this.opts.log?.(`[runner] round failed: ${(e as Error).message}`);
          }
        }
      }
      const wait = Math.max(50, this.state.config.roundMs / this.speed - (Date.now() - t0));
      this.nextRoundAt = Date.now() + wait;
      this.timer = setTimeout(loop, wait);
      this.broadcast({ type: "meta", meta: this.meta() });
    };
    this.timer = setTimeout(loop, 300);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.broadcast({ type: "meta", meta: this.meta() });
  }

  setSpeed(s: number) {
    this.speed = Math.min(20, Math.max(0.25, s));
    this.broadcast({ type: "meta", meta: this.meta() });
  }

  whisper(botId: string, text: string) {
    const ok = addWhisper(this.state, botId, text);
    if (ok) this.broadcast({ type: "meta", meta: this.meta(), events: this.state.events.slice(-1), bots: this.state.bots });
    return ok;
  }

  back(botId: string) {
    const ok = addBacker(this.state, botId);
    if (ok) this.broadcast({ type: "meta", meta: this.meta(), events: this.state.events.slice(-1), bots: this.state.bots });
    return ok;
  }

  /** Run the rest of the game as fast as possible (used by `npm run sim` and tests). */
  async runToEnd(maxRounds = Infinity) {
    let n = 0;
    while (!this.state.finished && n++ < maxRounds) await this.step();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
