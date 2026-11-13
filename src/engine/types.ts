/**
 * Core types. All token amounts in the engine are integers in milli-BERRY (1 BERRY = 1000).
 * The on-chain token uses 3 decimals so engine amounts map 1:1 to on-chain units.
 */
export const UNIT = 1000;

export type Personality =
  | "greedy"
  | "artist"
  | "diplomat"
  | "troll"
  | "hoarder"
  | "mercenary"
  | "expansionist"
  | "gambler";

export type BrainKind = "heuristic" | "llm";

export interface EmissionConfig {
  /** milli-BERRY minted per owned pixel per round at start */
  initialRate: number;
  minRate: number;
  maxRate: number;
  /** a round is "calm" when burned/minted falls below this (paint is not keeping up with emission) */
  calmRatio: number;
  /** consecutive calm rounds that trigger a halving */
  calmRoundsToHalve: number;
  /** a round is a "frenzy" when burned/minted exceeds this and at least `frenzyMinPaint` of the board was painted */
  hotRatio: number;
  frenzyMinPaint: number;
  /** multiplier applied in a frenzy round (e.g. 1.25) */
  hotFactor: number;
}

export interface GameConfig {
  seed: number;
  width: number;
  height: number;
  rounds: number;
  roundMs: number;
  startBalance: number;
  basePrice: number;
  /** price = basePrice + heatMultiplier * lastPrice * 0.5^(age / heatHalfLife) */
  heatMultiplier: number;
  heatHalfLife: number;
  /** basis points of an overwrite price paid to the previous owner; the rest is burned */
  ownerShareBps: number;
  maxPaintsPerRound: number;
  maxOffersPerRound: number;
  offerTtl: number;
  maxTreatyRounds: number;
  /** largest single deal payment; mirrors the contract's max_bot_pay cap */
  maxDealAmount: number;
  maxChatLength: number;
  landValue: number;
  emission: EmissionConfig;
}

export interface BotStats {
  painted: number;
  overwrites: number;
  pixelsLost: number;
  earnedFromOverwrites: number;
  minted: number;
  burned: number;
  dealsPaid: number;
  dealsReceived: number;
  blockedByTreaty: number;
}

export interface Bot {
  id: string;
  index: number; // 1-based, used as owner id on the board
  name: string;
  personality: Personality;
  tagline: string;
  emoji: string;
  color: number; // palette index
  home: { x: number; y: number };
  accountId: string; // NEAR account (mock or testnet sub-account)
  balance: number;
  pixels: number;
  brain: BrainKind;
  backers: number;
  lastThought: string;
  stats: BotStats;
}

export type OfferKind = "peace" | "alliance" | "hire";
export type OfferStatus = "pending" | "accepted" | "rejected" | "expired" | "failed";

export interface Offer {
  id: number;
  round: number;
  from: string;
  to: string;
  kind: OfferKind;
  amount: number;
  rounds: number;
  victim?: string;
  note?: string;
  status: OfferStatus;
}

/**
 * peace:    `b` may not overwrite pixels owned by `a` (a paid b).
 * alliance: neither may overwrite the other.
 * hire:     `a` paid mercenary `b` to hit `victim`; not enforced, hits are counted and reported.
 */
export interface Treaty {
  id: number;
  kind: OfferKind;
  a: string;
  b: string;
  victim?: string;
  amount: number;
  startRound: number;
  endRound: number;
  hits: number;
}

export interface ChatMsg {
  round: number;
  from: string; // bot id, or "human"
  to?: string;
  text: string;
}

export interface Whisper {
  round: number;
  from: string;
  text: string;
}

export type EventType =
  | "chat"
  | "offer"
  | "deal"
  | "reject"
  | "expire"
  | "treaty_end"
  | "war"
  | "halving"
  | "frenzy"
  | "whisper"
  | "back"
  | "settle"
  | "game_over"
  | "info";

export interface GameEvent {
  round: number;
  type: EventType;
  text: string;
  bots?: string[];
}

export interface Board {
  owner: Uint8Array; // 0 = nobody, else bot.index
  color: Uint8Array;
  lastPrice: Uint32Array;
  lastRound: Int32Array; // -1 = never bought
}

export interface TokenPoint {
  round: number;
  supply: number;
  rate: number;
  painted: number;
  burned: number;
  minted: number;
}

export interface TokenState {
  totalSupply: number;
  minted: number;
  burned: number;
  rate: number;
  calmStreak: number;
  history: TokenPoint[];
}

export interface GameState {
  config: GameConfig;
  round: number; // completed rounds
  bots: Bot[];
  board: Board;
  offers: Offer[];
  treaties: Treaty[];
  chat: ChatMsg[];
  whispers: Record<string, Whisper[]>;
  events: GameEvent[];
  token: TokenState;
  finished: boolean;
  nextId: number;
}

/* ---------- actions chosen by a brain ---------- */

export interface PaintCmd {
  x: number;
  y: number;
  w?: number;
  h?: number;
  color: number;
}

export interface OfferCmd {
  to: string;
  kind: OfferKind;
  amount: number; // milli
  rounds: number;
  victim?: string;
  note?: string;
}

export interface ResponseCmd {
  offerId: number;
  accept: boolean;
}

export interface BotAction {
  botId: string;
  thought?: string;
  paints: PaintCmd[];
  offers: OfferCmd[];
  responses: ResponseCmd[];
  chat?: string;
  chatTo?: string;
  source?: BrainKind | "fallback";
}

/* ---------- round output (what the chain layer settles and the UI animates) ---------- */

export interface Transfer {
  from: string;
  to: string;
  amount: number;
  reason: "overwrite" | "deal";
}

export interface RoundLedger {
  round: number;
  mints: Record<string, number>;
  burns: Record<string, number>;
  /** overwrite payouts (painter -> previous owner), aggregated per pair */
  transfers: Transfer[];
  /** deal payments in the exact order they happened (each is one bot_pay on chain) */
  deals: Transfer[];
  boardHash: string;
}

/** [pixelIndex, ownerIndex, color] */
export type PixelChange = [number, number, number];

export interface RoundResult {
  round: number;
  changes: PixelChange[];
  events: GameEvent[];
  ledger: RoundLedger;
  painted: number;
}
