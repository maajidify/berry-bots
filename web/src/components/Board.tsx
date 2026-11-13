import { useEffect, useRef, useState } from "react";
import { EMPTY_COLOR, PALETTE } from "../../../src/engine/palette";
import type { Bot } from "../../../src/engine/types";

interface Props {
  owner: Uint8Array;
  color: Uint8Array;
  lastRound?: Int32Array;
  round: number;
  bots: Bot[];
  size?: number;
  focusBot?: string | null;
  width?: number;
  height?: number;
  flash?: boolean;
}

const RGB = PALETTE.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
const EMPTY = [parseInt(EMPTY_COLOR.slice(1, 3), 16), parseInt(EMPTY_COLOR.slice(3, 5), 16), parseInt(EMPTY_COLOR.slice(5, 7), 16)];

/** The 64x64 board, drawn pixel-perfect and scaled up with CSS. Fresh paint flashes. */
export function Board({ owner, color, lastRound, round, bots, size = 640, focusBot, width = 64, height = 64, flash = true }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  const [tick, setTick] = useState(0);
  const changedAt = useRef(performance.now());

  useEffect(() => {
    changedAt.current = performance.now();
    if (!flash) return;
    let raf = 0;
    const loop = () => {
      const t = performance.now() - changedAt.current;
      setTick(t);
      if (t < 900) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [round, flash]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(width, height);
    const focusIdx = focusBot ? bots.find((b) => b.id === focusBot)?.index : undefined;
    const glow = flash ? Math.max(0, 1 - tick / 900) : 0;
    for (let i = 0; i < width * height; i++) {
      const o = owner[i];
      let [r, g, b] = o ? RGB[color[i]] : EMPTY;
      // subtle checker on empty land
      if (!o && ((i % width) + Math.floor(i / width)) % 2 === 0) [r, g, b] = [r + 6, g + 4, b + 8];
      if (focusIdx !== undefined && o !== focusIdx) [r, g, b] = [r * 0.25, g * 0.25, b * 0.3];
      if (glow > 0 && lastRound && lastRound[i] === round && round > 0) {
        r = r + (255 - r) * glow * 0.75;
        g = g + (255 - g) * glow * 0.75;
        b = b + (255 - b) * glow * 0.75;
      }
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [owner, color, lastRound, round, focusBot, bots, tick, width, height, flash]);

  const ownerBot = hover ? bots[owner[hover.y * width + hover.x] - 1] : undefined;
  const painted = hover && lastRound ? lastRound[hover.y * width + hover.x] : -1;

  return (
    <div className="board-wrap" style={{ width: size, height: size }}>
      <canvas
        ref={canvas}
        width={width}
        height={height}
        className="board"
        style={{ width: size, height: size }}
        onMouseMove={(e) => {
          const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const x = Math.floor(((e.clientX - r.left) / r.width) * width);
          const y = Math.floor(((e.clientY - r.top) / r.height) * height);
          setHover({ x, y, px: e.clientX - r.left, py: e.clientY - r.top });
        }}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
        <div className="tooltip" style={{ left: Math.min(hover.px + 14, size - 170), top: Math.min(hover.py + 14, size - 60) }}>
          <div>
            ({hover.x},{hover.y}) {ownerBot ? `${ownerBot.emoji} ${ownerBot.name}` : "unclaimed"}
          </div>
          {painted >= 0 && <div className="muted">painted r{painted}{round - painted < 6 ? " · 🔥 hot" : ""}</div>}
        </div>
      )}
    </div>
  );
}
