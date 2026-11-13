import { GameConfig, UNIT } from "./types";

export const DEFAULT_CONFIG: GameConfig = {
  seed: 7,
  width: 64,
  height: 64,
  rounds: 120,
  roundMs: 2500,
  startBalance: 250 * UNIT,
  basePrice: 1 * UNIT,
  heatMultiplier: 1.5,
  heatHalfLife: 6,
  ownerShareBps: 5000,
  maxPaintsPerRound: 48,
  maxOffersPerRound: 2,
  offerTtl: 3,
  maxTreatyRounds: 30,
  maxDealAmount: 100 * UNIT,
  maxChatLength: 140,
  landValue: 1 * UNIT,
  emission: {
    initialRate: 10, // 0.010 BERRY per pixel per round // 0.06 BERRY per pixel per round
    minRate: 2,
    maxRate: 30,
    calmRatio: 0.8, // burn < 80% of mint => calm
    calmRoundsToHalve: 3,
    hotRatio: 1.5, // burn > 150% of mint => frenzy
    frenzyMinPaint: 0.01,
    hotFactor: 1.25,
  },
};

export function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    emission: { ...DEFAULT_CONFIG.emission, ...(overrides.emission ?? {}) },
  };
}

export const fmt = (milli: number, digits = 1) => (milli / UNIT).toFixed(digits);
