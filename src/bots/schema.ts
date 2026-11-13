/**
 * Structured action schema for LLM brains. The model answers in BERRY (decimals);
 * we validate with zod and convert to engine units (milli-BERRY).
 */
import { z } from "zod";
import { BotAction, UNIT } from "../engine/types";

const int = z.coerce.number().int();

export const LlmActionSchema = z.object({
  thought: z.string().max(400).optional().default(""),
  paints: z
    .array(
      z.object({
        x: int.min(0).max(255),
        y: int.min(0).max(255),
        w: int.min(1).max(64).optional(),
        h: int.min(1).max(64).optional(),
        color: int.min(0).max(15),
      }),
    )
    .max(24)
    .optional()
    .default([]),
  offers: z
    .array(
      z.object({
        to: z.string().min(1).max(32),
        kind: z.enum(["peace", "alliance", "hire"]),
        amount: z.coerce.number().min(0).max(100000),
        rounds: int.min(1).max(30),
        victim: z.string().max(32).optional().nullable(),
        note: z.string().max(100).optional().nullable(),
      }),
    )
    .max(2)
    .optional()
    .default([]),
  responses: z
    .array(z.object({ offerId: int, accept: z.coerce.boolean() }))
    .max(8)
    .optional()
    .default([]),
  chat: z.string().max(280).optional().nullable(),
  chatTo: z.string().max(32).optional().nullable(),
});

export type LlmAction = z.infer<typeof LlmActionSchema>;

/** Pull the first JSON object out of a model reply (tolerates ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(body.slice(start, end + 1));
}

export function parseLlmAction(botId: string, raw: string): BotAction {
  const parsed = LlmActionSchema.parse(extractJson(raw));
  return {
    botId,
    thought: parsed.thought,
    paints: parsed.paints,
    offers: parsed.offers.map((o) => ({
      to: o.to,
      kind: o.kind,
      amount: Math.round(o.amount * UNIT),
      rounds: o.rounds,
      victim: o.victim ?? undefined,
      note: o.note ?? undefined,
    })),
    responses: parsed.responses,
    chat: parsed.chat ?? undefined,
    chatTo: parsed.chatTo ?? undefined,
    source: "llm",
  };
}
