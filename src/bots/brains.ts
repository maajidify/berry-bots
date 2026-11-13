import type { BotAction, GameState } from "../engine/types";
import { heuristicDecide } from "./heuristics";
import { LlmConfig, llmDecide } from "./llm";

export interface BrainResult {
  action: BotAction;
  error?: string;
}

/** Decide one bot's move: LLM if configured for this bot, heuristic otherwise or on any failure. */
export async function decide(state: GameState, botId: string, llm?: LlmConfig): Promise<BrainResult> {
  const bot = state.bots.find((b) => b.id === botId)!;
  if (bot.brain === "llm" && llm) {
    try {
      return { action: await llmDecide(state, botId, llm) };
    } catch (e) {
      const action = heuristicDecide(state, botId);
      action.source = "fallback";
      return { action, error: (e as Error).message };
    }
  }
  return { action: heuristicDecide(state, botId) };
}
