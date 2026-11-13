/**
 * Game client store. Connects to the Node server over WebSocket ("live" mode).
 * If no server answers (e.g. the static build is hosted alone, or ?offline=1), it runs the
 * same engine + heuristic brains + mocked chain right in the browser ("offline" mode).
 */
import { useSyncExternalStore } from "react";
import { MockChain } from "../../src/chain/mock";
import type { ChainInfo, SettleReceipt } from "../../src/chain/types";
import type { Bot, GameConfig, GameEvent, Offer, TokenPoint, Treaty } from "../../src/engine/types";
import { GameRunner, type Frame, type Packet, type RunnerMeta } from "../../src/runner";

export interface ViewState {
  status: "connecting" | "live" | "offline";
  config?: GameConfig;
  bots: Bot[];
  owner: Uint8Array;
  color: Uint8Array;
  lastRound: Int32Array;
  round: number;
  finished: boolean;
  events: GameEvent[];
  history: TokenPoint[];
  supply: number;
  rate: number;
  burned: number;
  minted: number;
  offers: Offer[];
  treaties: Treaty[];
  frames: Frame[];
  chain?: ChainInfo;
  receipts: SettleReceipt[];
  meta?: RunnerMeta;
  version: number;
}

type Listener = () => void;

class GameClient {
  state: ViewState = {
    status: "connecting",
    bots: [],
    owner: new Uint8Array(64 * 64),
    color: new Uint8Array(64 * 64),
    lastRound: new Int32Array(64 * 64).fill(-1),
    round: 0,
    finished: false,
    events: [],
    history: [],
    supply: 0,
    rate: 0,
    burned: 0,
    minted: 0,
    offers: [],
    treaties: [],
    frames: [],
    receipts: [],
    version: 0,
  };
  private listeners = new Set<Listener>();
  private ws?: WebSocket;
  private local?: GameRunner;
  private failures = 0;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.state;

  private set(patch: Partial<ViewState>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  start() {
    const params = new URLSearchParams(location.search);
    if (params.has("offline")) return this.startOffline();
    this.connect();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.failures = 0;
    };
    ws.onmessage = (m) => this.apply(JSON.parse(m.data) as Packet, "live");
    ws.onclose = () => {
      if (this.local) return;
      this.failures++;
      if (!opened && this.failures >= 4 && this.state.status !== "live") return this.startOffline();
      setTimeout(() => this.connect(), Math.min(4000, 500 * this.failures));
    };
  }

  private async startOffline() {
    this.ws?.close();
    const runner = new GameRunner({
      config: { seed: 7 },
      makeChain: () => new MockChain(5),
      autoRestartMs: 15000,
      offline: true,
    });
    this.local = runner;
    runner.subscribe((p) => this.apply(p, "offline"));
    await runner.newGame();
    runner.start();
  }

  private apply(p: Packet, status: ViewState["status"]) {
    if (p.type === "snapshot") {
      const s = p.state;
      const n = s.config.width * s.config.height;
      const lastRound = new Int32Array(n).fill(-1);
      for (const f of p.frames) for (const [idx] of f.changes) lastRound[idx] = f.round;
      this.set({
        status,
        config: s.config,
        bots: s.bots,
        owner: Uint8Array.from(s.board.owner),
        color: Uint8Array.from(s.board.color),
        lastRound,
        round: s.round,
        finished: s.finished,
        events: s.events.slice(-150),
        history: s.token.history,
        supply: s.token.totalSupply,
        rate: s.token.rate,
        burned: s.token.burned,
        minted: s.token.minted,
        offers: s.offers.filter((o) => o.status === "pending"),
        treaties: s.treaties,
        frames: p.frames,
        chain: p.chain,
        receipts: p.receipts,
        meta: p.meta,
      });
    } else if (p.type === "round") {
      const owner = this.state.owner.slice();
      const color = this.state.color.slice();
      const lastRound = this.state.lastRound.slice();
      for (const [idx, o, c] of p.changes) {
        owner[idx] = o;
        color[idx] = c;
        lastRound[idx] = p.round;
      }
      const frames = [...this.state.frames, { round: p.round, changes: p.changes, supply: p.token.supply, rate: p.token.rate, headline: p.events.find((e) => ["deal", "war", "halving", "frenzy", "game_over", "whisper"].includes(e.type))?.text }];
      this.set({
        status,
        owner,
        color,
        lastRound,
        round: p.round,
        finished: p.finished,
        bots: p.bots,
        events: [...this.state.events, ...p.events].slice(-150),
        history: [...this.state.history, p.token],
        supply: p.token.supply,
        rate: p.token.rate,
        burned: p.token.totalBurned,
        minted: p.token.totalMinted,
        offers: p.offers,
        treaties: p.treaties,
        frames,
        receipts: p.receipt ? [...this.state.receipts, p.receipt].slice(-20) : this.state.receipts,
      });
    } else if (p.type === "meta") {
      this.set({
        status,
        meta: p.meta,
        ...(p.bots ? { bots: p.bots } : {}),
        ...(p.events ? { events: [...this.state.events, ...p.events].slice(-150) } : {}),
      });
    }
  }

  async whisper(botId: string, text: string) {
    if (this.local) return this.local.whisper(botId, text);
    const r = await fetch("/api/whisper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId, text }) });
    return r.ok;
  }

  async back(botId: string) {
    if (this.local) return this.local.back(botId);
    const r = await fetch("/api/back", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId }) });
    return r.ok;
  }

  async control(action: "pause" | "resume" | "speed" | "new" | "step", value?: number) {
    if (this.local) {
      if (action === "pause") this.local.setPaused(true);
      if (action === "resume") this.local.setPaused(false);
      if (action === "speed") this.local.setSpeed(value ?? 1);
      if (action === "step") await this.local.step();
      if (action === "new") await this.local.newGame(Math.floor(Math.random() * 100000));
      return;
    }
    await fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, value }) });
  }
}

export const client = new GameClient();

export function useGame(): ViewState {
  return useSyncExternalStore(client.subscribe, client.get);
}
