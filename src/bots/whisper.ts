/**
 * Turns a backer's plain-words whisper into strategy nudges for heuristic brains.
 * (LLM brains read the raw whisper text instead.)
 */
import { colorIndexFromName, COLOR_NAMES } from "../engine/palette";
import type { Bot, GameState } from "../engine/types";

export interface WhisperIntent {
  target?: string; // bot id to attack
  ally?: string; // bot id to make peace / ally with
  aggression: number; // budget multiplier
  defend: boolean;
  color?: number;
  summary: string;
}

const WHISPER_MEMORY_ROUNDS = 25;

export function readWhispers(state: GameState, bot: Bot): WhisperIntent | undefined {
  const list = (state.whispers[bot.id] ?? []).filter((w) => state.round - w.round <= WHISPER_MEMORY_ROUNDS);
  if (list.length === 0) return undefined;
  const intent: WhisperIntent = { aggression: 1, defend: false, summary: "" };
  const notes: string[] = [];
  for (const w of list) {
    const t = w.text.toLowerCase();
    const named = findBot(state, t, bot.id);
    const peace = /(ally|peace|friend|truce|team up|alliance|protect)/.test(t);
    if (named && peace) {
      intent.ally = named.id;
      notes.push(`make peace with ${named.name}`);
    } else if (named && /(attack|hit|raid|crush|destroy|paint over|go after|take|vandal)/.test(t)) {
      intent.target = named.id;
      notes.push(`hit ${named.name}`);
    }
    if (/(aggressive|all in|go big|spend|faster|yolo)/.test(t)) {
      intent.aggression = 1.6;
      notes.push("spend big");
    }
    if (/(careful|save|hoard|slow|cautious|conserve)/.test(t)) {
      intent.aggression = 0.5;
      notes.push("save berries");
    }
    if (/(defend|protect|hold|repair|guard)/.test(t) && !intent.ally) {
      intent.defend = true;
      notes.push("defend home");
    }
    for (const c of COLOR_NAMES) {
      if (new RegExp(`\\b${c}\\b`).test(t)) {
        intent.color = colorIndexFromName(c);
        notes.push(`use ${c}`);
      }
    }
  }
  intent.summary = notes.length ? [...new Set(notes)].join(", ") : "noted, but unclear";
  return intent;
}

function findBot(state: GameState, text: string, self: string): Bot | undefined {
  return state.bots.find(
    (b) => b.id !== self && (text.includes(b.id) || text.includes(b.name.toLowerCase()) || text.includes(`the ${b.personality}`)),
  );
}
