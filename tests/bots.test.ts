import { describe, expect, it } from "vitest";
import { decide } from "../src/bots/brains";
import { llmDecide } from "../src/bots/llm";
import { BOT_SPECS } from "../src/bots/personalities";
import { parseLlmAction } from "../src/bots/schema";
import { summarizeForBot } from "../src/bots/view";
import { readWhispers } from "../src/bots/whisper";
import { makeConfig } from "../src/engine/config";
import { addWhisper, applyRound, createGame } from "../src/engine/engine";
import { UNIT } from "../src/engine/types";

const game = (brain: "llm" | "heuristic" = "heuristic") => createGame(makeConfig({ seed: 3 }), BOT_SPECS.map((s) => ({ ...s, brain })));
const cfg = { baseUrl: "http://llm.test/v1", apiKey: "k", model: "m", timeoutMs: 1000, temperature: 0 };

describe("LLM action parsing", () => {
  it("accepts fenced JSON and converts BERRY to engine units", () => {
    const a = parseLlmAction("goldie", '```json\n{"thought":"cheap land","paints":[{"x":1,"y":2,"w":3,"h":1,"color":10}],"offers":[{"to":"grief","kind":"peace","amount":2.5,"rounds":5}],"responses":[{"offerId":4,"accept":true}],"chat":"hi"}\n```');
    expect(a.paints[0]).toEqual({ x: 1, y: 2, w: 3, h: 1, color: 10 });
    expect(a.offers[0].amount).toBe(2.5 * UNIT);
    expect(a.responses[0]).toEqual({ offerId: 4, accept: true });
    expect(a.source).toBe("llm");
  });

  it("rejects out-of-schema actions", () => {
    expect(() => parseLlmAction("goldie", '{"paints":[{"x":1,"y":2,"color":99}]}')).toThrow();
    expect(() => parseLlmAction("goldie", "I think I will paint red")).toThrow();
  });

  it("calls an OpenAI-compatible endpoint and validates the reply", async () => {
    const s = game("llm");
    let body: any;
    const fakeFetch = (async (url: string, init: any) => {
      body = JSON.parse(init.body);
      expect(url).toBe("http://llm.test/v1/chat/completions");
      expect(init.headers.Authorization).toBe("Bearer k");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"thought":"go","paints":[{"x":0,"y":0,"color":8}]}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = await llmDecide(s, "pixela", cfg, fakeFetch);
    expect(a.paints).toHaveLength(1);
    expect(body.messages[0].content).toContain("ARTIST");
    expect(body.messages[1].content).toContain("REGION MAP");
  });

  it("falls back to the heuristic brain when the LLM fails", async () => {
    const s = game("llm");
    const r = await decide(s, "goldie", { ...cfg, baseUrl: "http://127.0.0.1:9/v1", timeoutMs: 300 });
    expect(r.error).toBeTruthy();
    expect(r.action.source).toBe("fallback");
    expect(r.action.paints.length).toBeGreaterThan(0);
  });
});

describe("heuristic brains", () => {
  it("every personality produces a valid action that the engine accepts", async () => {
    const s = game();
    for (let i = 0; i < 5; i++) {
      const actions = await Promise.all(s.bots.map((b) => decide(s, b.id)));
      for (const { action } of actions) expect(action.paints.length).toBeLessThanOrEqual(s.config.maxPaintsPerRound);
      applyRound(s, actions.map((a) => a.action));
    }
    expect(s.bots.filter((b) => b.pixels > 0).length).toBe(8);
  });

  it("backer whispers are understood in plain words", () => {
    const s = game();
    addWhisper(s, "blade", "Go aggressive and attack Goldie, use orange");
    const w = readWhispers(s, s.bots.find((b) => b.id === "blade")!)!;
    expect(w.target).toBe("goldie");
    expect(w.aggression).toBeGreaterThan(1);
    expect(w.color).toBe(9);
    addWhisper(s, "envoy", "please make peace with the troll");
    expect(readWhispers(s, s.bots.find((b) => b.id === "envoy")!)!.ally).toBe("grief");
  });

  it("whispers change behaviour: the mercenary attacks the named bot", () => {
    const s = game();
    for (let i = 0; i < 6; i++) applyRound(s, s.bots.map((b) => decideSync(s, b.id)));
    addWhisper(s, "blade", "attack goldie");
    const goldie = s.bots.find((b) => b.id === "goldie")!;
    const before = goldie.stats.pixelsLost;
    applyRound(s, s.bots.map((b) => decideSync(s, b.id)));
    expect(goldie.stats.pixelsLost).toBeGreaterThan(before);
  });

  it("the LLM prompt summary is compact and mentions whispers", () => {
    const s = game();
    addWhisper(s, "pixela", "defend your berry");
    const text = summarizeForBot(s, "pixela");
    expect(text).toContain("WHISPERS FROM YOUR HUMAN BACKERS");
    expect(text.length).toBeLessThan(4000);
  });
});

import { heuristicDecide } from "../src/bots/heuristics";
function decideSync(s: ReturnType<typeof game>, id: string) {
  return heuristicDecide(s, id);
}
