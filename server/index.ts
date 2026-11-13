/**
 * Berry Bots game server: runs the game loop, the bot brains (LLM or heuristic) and the chain
 * adapter, and streams rounds to the web UI over WebSocket.
 *
 *   CHAIN_MODE=local   (default) chain mocked in memory, fully offline
 *   CHAIN_MODE=testnet settle on NEAR testnet (needs the env vars in .env.example)
 *   NEAR_AI_API_KEY    enables LLM brains via NEAR AI Cloud (OpenAI-compatible)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { llmConfigFromEnv } from "../src/bots/llm";
import { MockChain } from "../src/chain/mock";
import type { ChainAdapter } from "../src/chain/types";
import { GameRunner, Packet } from "../src/runner";

try {
  (process as any).loadEnvFile?.(".env");
} catch {
  /* no .env file: fine */
}

const PORT = Number(process.env.PORT ?? 8787);
const CHAIN_MODE = (process.env.CHAIN_MODE ?? "local") as "local" | "testnet";
const BRAIN_MODE = process.env.BRAIN_MODE ?? "auto"; // auto | heuristic | llm
const llm = BRAIN_MODE === "heuristic" ? undefined : llmConfigFromEnv();
if (BRAIN_MODE === "llm" && !llm) {
  console.error("BRAIN_MODE=llm needs NEAR_AI_API_KEY (or LLM_API_KEY). Falling back to heuristic brains.");
}

let makeChain: () => ChainAdapter = () => new MockChain(Number(process.env.SETTLE_EVERY ?? 5));
let accountSuffix = "berrybots.local";
if (CHAIN_MODE === "testnet") {
  const { NearTestnetChain, testnetEnv } = await import("../src/chain/near-testnet");
  const env = testnetEnv();
  makeChain = () => new NearTestnetChain(env);
  accountSuffix = env.botParent;
}

const runner = new GameRunner({
  config: {
    seed: Number(process.env.SEED ?? 7),
    rounds: Number(process.env.ROUNDS ?? 120),
    roundMs: Number(process.env.ROUND_MS ?? (llm ? 6000 : 2500)),
  },
  makeChain,
  llm,
  llmBots: process.env.LLM_BOTS ? process.env.LLM_BOTS.split(",").map((s) => s.trim()) : undefined,
  accountSuffix,
  autoRestartMs: Number(process.env.AUTO_RESTART_MS ?? 20000),
  log: (m) => console.log(m),
});
await runner.newGame();
runner.start();

const app = express();
app.use(express.json({ limit: "8kb" }));

const lastWhisper = new Map<string, number>();
const throttle = (req: express.Request, ms: number) => {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  if ((lastWhisper.get(key) ?? 0) + ms > now) return false;
  lastWhisper.set(key, now);
  return true;
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, round: runner.state.round, finished: runner.state.finished, chain: runner.chain.info(), meta: runner.meta() });
});
app.get("/api/state", (_req, res) => res.json(runner.snapshot()));
app.get("/api/replay", (_req, res) =>
  res.json({ config: runner.state.config, bots: runner.state.bots, frames: runner.frames }),
);
app.post("/api/whisper", (req, res) => {
  const { botId, text } = req.body ?? {};
  if (!throttle(req, 1500)) return res.status(429).json({ ok: false, error: "slow down" });
  const ok = runner.whisper(String(botId), String(text ?? ""));
  res.status(ok ? 200 : 400).json({ ok });
});
app.post("/api/back", (req, res) => {
  if (!throttle(req, 500)) return res.status(429).json({ ok: false, error: "slow down" });
  const ok = runner.back(String(req.body?.botId));
  res.status(ok ? 200 : 400).json({ ok });
});
app.post("/api/control", async (req, res) => {
  const { action, value } = req.body ?? {};
  if (action === "pause") runner.setPaused(true);
  else if (action === "resume") runner.setPaused(false);
  else if (action === "speed") runner.setSpeed(Number(value));
  else if (action === "step") await runner.step();
  else if (action === "new") await runner.newGame(value !== undefined ? Number(value) : runner.state.config.seed + 1);
  else return res.status(400).json({ ok: false });
  res.json({ ok: true, meta: runner.meta() });
});

const dist = path.resolve("dist");
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify(runner.snapshot()));
});
runner.subscribe((p: Packet) => {
  const msg = JSON.stringify(p);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
});

server.listen(PORT, () => {
  const brains = llm ? `LLM (${llm.model} via ${llm.baseUrl})` : "heuristic (no NEAR_AI_API_KEY set)";
  console.log(`\n🍓 Berry Bots server on http://localhost:${PORT}`);
  console.log(`   brains: ${brains}`);
  console.log(`   chain:  ${runner.chain.info().network} (${runner.chain.info().contractId})`);
  console.log(`   UI:     http://localhost:5173 (npm run dev)${fs.existsSync(path.join(dist, "index.html")) ? ` or http://localhost:${PORT} (built)` : ""}\n`);
});
