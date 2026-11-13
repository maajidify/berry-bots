import { useEffect, useRef, useState } from "react";
import type { GameEvent } from "../../src/engine/types";
import { client, useGame } from "./client";
import { Board } from "./components/Board";
import { ChainBadge, Diplomacy, Feed, Leaderboard, Roster, RoundTimer, TokenTicker, WhisperBox } from "./components/Panels";
import { Timelapse } from "./components/Timelapse";

const BANNER_TYPES = new Set(["halving", "frenzy", "deal", "game_over"]);

export function App() {
  const g = useGame();
  const [focus, setFocus] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [target, setTarget] = useState("pixela");
  const [replay, setReplay] = useState(new URLSearchParams(location.search).has("replay"));
  const [banner, setBanner] = useState<GameEvent | null>(null);
  const seen = useRef(0);

  useEffect(() => {
    const fresh = g.events.slice(Math.max(0, g.events.length - 12)).filter((e) => BANNER_TYPES.has(e.type) && e.round > seen.current);
    if (fresh.length) {
      const pick = fresh.find((e) => e.type === "game_over") ?? fresh.find((e) => e.type === "halving") ?? fresh.find((e) => e.type === "frenzy") ?? fresh[fresh.length - 1];
      setBanner(pick);
      seen.current = g.round;
      const t = setTimeout(() => setBanner(null), pick.type === "game_over" ? 8000 : 2600);
      return () => clearTimeout(t);
    }
    seen.current = Math.max(seen.current, g.round - 1);
  }, [g.round]); // eslint-disable-line react-hooks/exhaustive-deps

  if (g.status === "connecting" && !g.config) {
    return (
      <div className="loading">
        <div className="logo-berry bounce">🍓</div>
        <div>CONNECTING TO THE BOARD…</div>
      </div>
    );
  }

  if (replay) return <Timelapse g={g} onClose={() => setReplay(false)} />;

  const paused = g.meta?.paused;
  const speed = g.meta?.speed ?? 1;

  return (
    <div className="app">
      <header className="top">
        <div className="logo">
          <span className="logo-berry">🍓</span>
          <div>
            <h1>BERRY BOTS</h1>
            <div className="subtitle">AI bots with NEAR wallets fight over one pixel board</div>
          </div>
        </div>
        <RoundTimer g={g} />
        <TokenTicker g={g} />
        <ChainBadge g={g} />
      </header>

      <main className="grid">
        <section className="col-board">
          <div className="board-frame">
            <Board owner={g.owner} color={g.color} lastRound={g.lastRound} round={g.round} bots={g.bots} focusBot={focus} size={620} />
            {banner && (
              <div className={`banner banner-${banner.type}`} key={banner.text}>
                {banner.text}
              </div>
            )}
          </div>
          <div className="controls">
            <button onClick={() => client.control(paused ? "resume" : "pause")}>{paused ? "▶ PLAY" : "⏸ PAUSE"}</button>
            <button onClick={() => client.control("step")} disabled={!paused}>
              ⏭ STEP
            </button>
            {[1, 2, 4, 8].map((s) => (
              <button key={s} className={speed === s ? "on" : ""} onClick={() => client.control("speed", s)}>
                {s}×
              </button>
            ))}
            <button className="primary" onClick={() => setReplay(true)}>
              🎬 TIMELAPSE
            </button>
            <button onClick={() => client.control("new")}>↺ NEW GAME</button>
          </div>
          <Diplomacy offers={g.offers} treaties={g.treaties} bots={g.bots} />
        </section>

        <section className="col-side">
          <Roster
            g={g}
            focus={focus}
            setFocus={setFocus}
            onWhisper={(id) => {
              setTarget(id);
              document.querySelector<HTMLInputElement>(".whisper input")?.focus();
            }}
          />
          <div className="side-row">
            <WhisperBox g={g} target={target} setTarget={setTarget} />
            <Leaderboard g={g} />
          </div>
          <Feed g={g} filter={filter} setFilter={setFilter} />
        </section>
      </main>
      <footer className="foot">
        Built during NEAR Hackathon, Nov 2026 · $BERRY is a NEP-141 token · bots hold function-call keys only · hover a bot to see its land
      </footer>
    </div>
  );
}
