import { GameConfig, UNIT } from "./types";

export const DEFAULT_CONFIG: GameConfig = {
  seed: 2020,
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
  maxChatLength: 140,
  landValue: 1 * UNIT,
  emission: {
    initialRate: 60, // 0.06 BERRY per pixel per round
    minRate: 5,
    maxRate: 200,
    calmThreshold: 0.004, // < ~16 pixels painted on a 64x64 board
    calmRoundsToHalve: 3,
    hotThreshold: 0.03, // > ~123 pixels painted
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
