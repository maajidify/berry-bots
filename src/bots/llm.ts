/**
 * LLM brain over any OpenAI-compatible /chat/completions endpoint.
 * Default: NEAR AI Cloud (https://cloud-api.near.ai/v1), key from NEAR_AI_API_KEY.
 * Any failure (no key, timeout, HTTP error, invalid JSON, schema mismatch) falls back
 * to the bot's heuristic brain, so the game never stalls.
 */
import type { BotAction, GameState } from "../engine/types";
import { botById } from "../engine/engine";
import { PERSONA_PROMPTS } from "./personalities";
import { parseLlmAction } from "./schema";
import { RESPONSE_FORMAT, RULES_TEXT, summarizeForBot } from "./view";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature: number;
}

export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | undefined {
  const apiKey = env.NEAR_AI_API_KEY || env.LLM_API_KEY || "";
  if (!apiKey) return undefined;
  return {
    baseUrl: (env.LLM_BASE_URL || "https://cloud-api.near.ai/v1").replace(/\/$/, ""),
    apiKey,
    model: env.LLM_MODEL || "deepseek/deepseek-v4.1-flash",
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 15000),
    temperature: Number(env.LLM_TEMPERATURE || 0.8),
  };
}

export function buildMessages(state: GameState, botId: string) {
  const bot = botById(state, botId)!;
  const system = [
    `You are ${bot.name}, an autonomous AI bot playing Berry Bots with your own NEAR wallet (${bot.accountId}).`,
    PERSONA_PROMPTS[bot.personality],
    RULES_TEXT,
    RESPONSE_FORMAT,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: summarizeForBot(state, botId) + "\n\nYour move? JSON only." },
  ];
}

export async function llmDecide(state: GameState, botId: string, cfg: LlmConfig, fetchImpl: typeof fetch = fetch): Promise<BotAction> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: buildMessages(state, botId),
        temperature: cfg.temperature,
        max_tokens: 700,
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data: any = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    return parseLlmAction(botId, content);
  } finally {
    clearTimeout(timer);
  }
}
