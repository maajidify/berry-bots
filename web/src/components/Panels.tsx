import { useEffect, useMemo, useState } from "react";
import { PALETTE } from "../../../src/engine/palette";
import type { Bot, GameEvent, Offer, TokenPoint, Treaty } from "../../../src/engine/types";
import { client, type ViewState } from "../client";

export const berry = (milli: number, d = 1) => (milli / 1000).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

const PERSONA_LABEL: Record<string, string> = {
  greedy: "GREEDY",
  artist: "ARTIST",
  diplomat: "DIPLOMAT",
  troll: "TROLL",
  hoarder: "HOARDER",
  mercenary: "MERCENARY",
  expansionist: "EXPANSIONIST",
  gambler: "GAMBLER",
};

export function Avatar({ bot, size = 36 }: { bot: Bot; size?: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size, background: PALETTE[bot.color], fontSize: size * 0.55 }}>
      <span>{bot.emoji}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

export function RoundTimer({ g }: { g: ViewState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const total = g.config?.rounds ?? 120;
  const ms = g.meta ? g.meta.roundMs / g.meta.speed : 2500;
  const left = g.meta?.nextRoundAt ? Math.max(0, g.meta.nextRoundAt - now) : 0;
  const pct = g.meta?.paused || g.finished ? 0 : Math.min(1, left / ms);
  return (
    <div className="round-timer">
      <div className="label">ROUND</div>
      <div className="big">
        {String(g.round).padStart(3, "0")}
        <span className="muted">/{total}</span>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${(g.round / total) * 100}%` }} />
      </div>
      <div className="next">
        {g.finished ? "GAME OVER" : g.meta?.paused ? "PAUSED" : `next in ${(left / 1000).toFixed(1)}s`}
        <div className="pie" style={{ background: `conic-gradient(var(--berry) ${pct * 360}deg, transparent 0)` }} />
      </div>
    </div>
  );
}

export function Sparkline({ points, w = 160, h = 36, color = "#ff004d", accessor }: { points: TokenPoint[]; w?: number; h?: number; color?: string; accessor: (p: TokenPoint) => number }) {
  const path = useMemo(() => {
    if (points.length < 2) return "";
    const vals = points.map(accessor);
    const min = Math.min(...vals), max = Math.max(...vals);
    return vals
      .map((v, i) => {
        const x = (i / (vals.length - 1)) * w;
        const y = h - 2 - ((v - min) / Math.max(1, max - min)) * (h - 4);
        return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points, w, h, accessor]);
  return (
    <svg width={w} height={h} className="spark">
      <path d={path} fill="none" stroke={color} strokeWidth={2} shapeRendering="crispEdges" />
    </svg>
  );
}

const supplyOf = (p: TokenPoint) => p.supply;
const rateOf = (p: TokenPoint) => p.rate;

export function TokenTicker({ g }: { g: ViewState }) {
  const last = g.history[g.history.length - 1];
  const halvings = g.events.filter((e) => e.type === "halving").length;
  return (
    <div className="ticker">
      <div className="coin">
        <span className="berry-icon">🍓</span>
        <div>
          <div className="label">$BERRY SUPPLY</div>
          <div className="big">{berry(g.supply, 0)}</div>
        </div>
        <Sparkline points={g.history.slice(-80)} accessor={supplyOf} />
      </div>
      <div className="coin">
        <div>
          <div className="label">EMISSION / PX / ROUND</div>
          <div className="big">{(g.rate / 1000).toFixed(3)}</div>
        </div>
        <Sparkline points={g.history.slice(-80)} accessor={rateOf} color="#ffa300" w={110} />
      </div>
      <div className="coin small">
        <div className="label">BURNED 🔥</div>
        <div className="mid">{berry(g.burned, 0)}</div>
        <div className="tiny">{last ? `last round: −${berry(last.burned)} burn · +${berry(last.minted)} mint` : "no rounds yet"}</div>
        <div className="tiny">{halvings > 0 ? `${halvings} halving${halvings > 1 ? "s" : ""} so far` : "halves after 3 calm rounds"}</div>
      </div>
    </div>
  );
}

export function ChainBadge({ g }: { g: ViewState }) {
  const r = g.receipts[g.receipts.length - 1];
  return (
    <div className="chain-badge" title={g.chain?.contractId}>
      <div className="label">⛓ {g.chain?.mode === "testnet" ? "NEAR TESTNET" : "LOCAL CHAIN (MOCK)"}</div>
      <div className="small-text">{g.chain?.contractId}</div>
      {r ? (
        <div className={`small-text ${r.ok ? "ok" : "bad"}`}>
          r{r.round} {r.ok ? "settled" : "failed"} · {r.txHashes.length} settle_round · {r.dealTxs.length} bot_pay{r.consistent ? " · ledger ✓" : ""}
          {r.explorerUrl && (
            <a href={r.explorerUrl} target="_blank" rel="noreferrer">
              {" "}
              ↗
            </a>
          )}
        </div>
      ) : (
        <div className="small-text muted">settles every {g.chain?.settleEvery ?? 5} rounds</div>
      )}
      <div className="small-text muted">
        {g.status === "offline" ? "offline demo · in-browser" : "live server"} · brains:{" "}
        {g.meta?.model ? `LLM ${g.meta.model}` : "heuristic"}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ roster */

export function Roster({ g, focus, setFocus, onWhisper }: { g: ViewState; focus: string | null; setFocus: (id: string | null) => void; onWhisper: (id: string) => void }) {
  const max = Math.max(1, ...g.bots.map((b) => b.pixels));
  return (
    <div className="panel roster">
      <h2>BOTS</h2>
      <div className="roster-grid">
        {g.bots.map((b) => {
          const treaties = g.treaties.filter((t) => t.a === b.id || t.b === b.id);
          return (
            <div
              key={b.id}
              className={`bot-card ${focus === b.id ? "focus" : ""}`}
              onMouseEnter={() => setFocus(b.id)}
              onMouseLeave={() => setFocus(null)}
              style={{ ["--bot" as any]: PALETTE[b.color] }}
            >
              <div className="bot-head">
                <Avatar bot={b} />
                <div className="bot-name">
                  <div className="name">{b.name}</div>
                  <div className="tag">{PERSONA_LABEL[b.personality]}</div>
                </div>
                <div className={`brain ${b.brain}`}>{b.brain === "llm" ? "LLM" : "BOT"}</div>
              </div>
              <div className="bot-stats">
                <span title="$BERRY balance">🍓 {berry(b.balance)}</span>
                <span title="pixels owned">▦ {b.pixels}</span>
                <span title="human backers">📣 {b.backers}</span>
                {treaties.length > 0 && <span title="active treaties">🤝 {treaties.length}</span>}
              </div>
              <div className="land-bar">
                <div style={{ width: `${(b.pixels / max) * 100}%` }} />
              </div>
              <div className="thought" title={b.lastThought}>
                “{b.lastThought || b.tagline}”
              </div>
              <div className="wallet" title="NEAR account">
                {b.accountId}
              </div>
              <div className="bot-actions">
                <button onClick={() => client.back(b.id)}>BACK</button>
                <button onClick={() => onWhisper(b.id)}>WHISPER</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ leaderboard */

export function Leaderboard({ g, compact = false }: { g: ViewState; compact?: boolean }) {
  const land = g.config?.landValue ?? 1000;
  const rows = [...g.bots].map((b) => ({ b, score: b.balance + b.pixels * land })).sort((a, b) => b.score - a.score);
  const top = Math.max(1, rows[0]?.score ?? 1);
  return (
    <div className={`panel leaderboard ${compact ? "compact" : ""}`}>
      <h2>LEADERBOARD</h2>
      {rows.map(({ b, score }, i) => (
        <div key={b.id} className="lb-row">
          <span className="rank">{i === 0 ? "👑" : `${i + 1}.`}</span>
          <Avatar bot={b} size={22} />
          <span className="lb-name">{b.name}</span>
          <div className="lb-bar">
            <div style={{ width: `${(score / top) * 100}%`, background: PALETTE[b.color] }} />
          </div>
          <span className="lb-score">{berry(score, 0)}</span>
        </div>
      ))}
      {!compact && <div className="muted small-text">score = $BERRY + 1 per pixel owned</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ feed */

const ICON: Record<string, string> = {
  chat: "💬",
  offer: "📜",
  deal: "🤝",
  reject: "✋",
  expire: "⌛",
  treaty_end: "⌛",
  war: "⚔️",
  halving: "🌙",
  frenzy: "🔥",
  whisper: "🤫",
  back: "📣",
  settle: "⛓️",
  game_over: "🏁",
  info: "ℹ️",
};

export function Feed({ g, filter, setFilter }: { g: ViewState; filter: string; setFilter: (f: string) => void }) {
  const filters: Record<string, (e: GameEvent) => boolean> = {
    all: () => true,
    chat: (e) => e.type === "chat" || e.type === "whisper",
    deals: (e) => ["offer", "deal", "reject", "treaty_end"].includes(e.type),
    economy: (e) => ["halving", "frenzy", "settle", "war", "game_over"].includes(e.type),
  };
  const list = g.events.filter(filters[filter] ?? filters.all).slice(-60).reverse();
  return (
    <div className="panel feed">
      <div className="feed-head">
        <h2>FEED</h2>
        <div className="tabs">
          {Object.keys(filters).map((f) => (
            <button key={f} className={f === filter ? "on" : ""} onClick={() => setFilter(f)}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="feed-list">
        {list.map((e, i) => (
          <div key={`${e.round}-${i}-${e.text}`} className={`ev ev-${e.type}`}>
            <span className="ev-round">r{e.round}</span>
            <span className="ev-icon">{ICON[e.type] ?? "•"}</span>
            <span className="ev-text">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Diplomacy({ offers, treaties, bots }: { offers: Offer[]; treaties: Treaty[]; bots: Bot[] }) {
  const n = (id?: string) => bots.find((b) => b.id === id)?.name ?? id;
  if (!offers.length && !treaties.length) return null;
  return (
    <div className="panel diplomacy">
      <h2>TREATIES</h2>
      {treaties.slice(-6).map((t) => (
        <div key={t.id} className="small-text">
          {t.kind === "peace" ? "🕊️" : t.kind === "alliance" ? "🛡️" : "🗡️"} {n(t.a)} {t.kind === "hire" ? `hired ${n(t.b)} vs ${n(t.victim)} (${t.hits} hits)` : `${t.kind === "peace" ? "paid" : "+"} ${n(t.b)}`} · until r{t.endRound}
        </div>
      ))}
      {offers.slice(-4).map((o) => (
        <div key={o.id} className="small-text muted">
          📜 {n(o.from)} → {n(o.to)}: {o.kind} {berry(o.amount)} (pending)
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ whisper */

const SUGGESTIONS = ["attack the leader", "make peace with Grief", "save your berries", "go all in", "defend your home", "paint in pink"];

export function WhisperBox({ g, target, setTarget }: { g: ViewState; target: string; setTarget: (id: string) => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const bot = g.bots.find((b) => b.id === target);
  const leader = [...g.bots].sort((a, b) => b.pixels - a.pixels)[0];
  const send = async (t: string) => {
    const msg = t.replace("the leader", leader ? leader.name : "the leader");
    if (!msg.trim()) return;
    const ok = await client.whisper(target, msg);
    setSent(ok ? `Whispered to ${bot?.name}: “${msg}”` : "Couldn't whisper (slow down?)");
    setText("");
    setTimeout(() => setSent(null), 4000);
  };
  return (
    <div className="panel whisper">
      <h2>BACK A BOT · WHISPER A STRATEGY</h2>
      <div className="whisper-row">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {g.bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.emoji} {b.name}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => client.back(target)}>
          📣 BACK {bot?.name.toUpperCase()}
        </button>
      </div>
      <form
        className="whisper-row"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input value={text} maxLength={200} placeholder={`Tell ${bot?.name ?? "a bot"} what to do, in plain words…`} onChange={(e) => setText(e.target.value)} />
        <button type="submit">🤫 SEND</button>
      </form>
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>
      <div className="small-text muted">{sent ?? `${bot?.name ?? "The bot"} weighs your whisper next round, and stays in character. LLM bots read it verbatim.`}</div>
    </div>
  );
}
