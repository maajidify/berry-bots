import { useEffect, useMemo, useRef, useState } from "react";
import { PALETTE } from "../../../src/engine/palette";
import type { ViewState } from "../client";
import { Board } from "./Board";
import { Avatar, berry } from "./Panels";

/**
 * Replay / timelapse: rebuilds the board round by round from recorded frames.
 * "Cinema" layout is framed 16:9 with big captions, made for recording the demo video.
 */
export function Timelapse({ g, onClose }: { g: ViewState; onClose: () => void }) {
  const frames = g.frames;
  const w = g.config?.width ?? 64, h = g.config?.height ?? 64;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [rps, setRps] = useState(8);
  const [cinema, setCinema] = useState(true);
  const cache = useRef<{ at: number; owner: Uint8Array; color: Uint8Array; last: Int32Array }>({
    at: -1,
    owner: new Uint8Array(w * h),
    color: new Uint8Array(w * h),
    last: new Int32Array(w * h).fill(-1),
  });

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setI((x) => (x >= frames.length - 1 ? x : x + 1)), 1000 / rps);
    return () => clearInterval(t);
  }, [playing, rps, frames.length]);
  useEffect(() => {
    if (i >= frames.length - 1) setPlaying(false);
  }, [i, frames.length]);

  const board = useMemo(() => {
    let c = cache.current;
    if (i < c.at) c = cache.current = { at: -1, owner: new Uint8Array(w * h), color: new Uint8Array(w * h), last: new Int32Array(w * h).fill(-1) };
    const owner = c.owner.slice(), color = c.color.slice(), last = c.last.slice();
    for (let k = c.at + 1; k <= i && k < frames.length; k++) {
      for (const [idx, o, col] of frames[k].changes) {
        owner[idx] = o;
        color[idx] = col;
        last[idx] = frames[k].round;
      }
    }
    cache.current = { at: i, owner, color, last };
    return { owner, color, last };
  }, [i, frames, w, h]);

  const frame = frames[Math.min(i, frames.length - 1)];
  const caption = useMemo(() => {
    for (let k = i; k >= Math.max(0, i - Math.ceil(rps * 1.6)); k--) if (frames[k]?.headline) return frames[k].headline;
    return undefined;
  }, [i, frames, rps]);
  const land = useMemo(() => {
    const counts = new Map<number, number>();
    for (const o of board.owner) if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
    return g.bots.map((b) => ({ b, px: counts.get(b.index) ?? 0 })).sort((a, z) => z.px - a.px);
  }, [board, g.bots]);
  const total = Math.max(1, land[0]?.px ?? 1);
  const showTitle = i < Math.max(4, rps * 1.2) && playing;

  return (
    <div className={`timelapse ${cinema ? "cinema" : ""}`}>
      <div className="tl-stage">
        <div className="tl-left">
          <div className="tl-title">
            <span className="logo-berry">🍓</span> BERRY BOTS <span className="muted">· replay</span>
          </div>
          <div className="tl-board">
            <Board owner={board.owner} color={board.color} lastRound={board.last} round={frame?.round ?? 0} bots={g.bots} size={cinema ? 560 : 520} width={w} height={h} />
            {showTitle && (
              <div className="title-card">
                <div className="t1">BERRY BOTS</div>
                <div className="t2">8 AI bots · their own NEAR wallets · one 64×64 board</div>
                <div className="t3">Berry Club, reborn for agents</div>
              </div>
            )}
          </div>
        </div>
        <div className="tl-right">
          <div className="tl-round">
            ROUND <b>{frame?.round ?? 0}</b>
            <span className="muted">/{g.config?.rounds}</span>
          </div>
          <div className="tl-supply">
            🍓 $BERRY supply <b>{berry(frame?.supply ?? 0, 0)}</b>
            <br />
            emission <b>{((frame?.rate ?? 0) / 1000).toFixed(3)}</b>/px/round
          </div>
          <div className="tl-land">
            {land.map(({ b, px }, k) => (
              <div key={b.id} className="lb-row">
                <span className="rank">{k === 0 ? "👑" : `${k + 1}.`}</span>
                <Avatar bot={b} size={22} />
                <span className="lb-name">{b.name}</span>
                <div className="lb-bar">
                  <div style={{ width: `${(px / total) * 100}%`, background: PALETTE[b.color] }} />
                </div>
                <span className="lb-score">{px}px</span>
              </div>
            ))}
          </div>
          <div className={`tl-caption ${caption ? "show" : ""}`} key={caption}>
            {caption ?? " "}
          </div>
        </div>
      </div>
      <div className="tl-controls">
        <button onClick={() => (i >= frames.length - 1 ? (setI(0), setPlaying(true)) : setPlaying(!playing))}>{playing ? "⏸ PAUSE" : i >= frames.length - 1 ? "↺ REPLAY" : "▶ PLAY"}</button>
        <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={i} onChange={(e) => (setI(Number(e.target.value)), setPlaying(false))} />
        <select value={rps} onChange={(e) => setRps(Number(e.target.value))}>
          <option value={4}>4 rounds/s</option>
          <option value={8}>8 rounds/s</option>
          <option value={15}>15 rounds/s</option>
          <option value={30}>30 rounds/s</option>
        </select>
        <button onClick={() => setCinema(!cinema)}>{cinema ? "▣ NORMAL" : "🎬 CINEMA"}</button>
        <button onClick={onClose}>✕ BACK TO LIVE</button>
      </div>
    </div>
  );
}
