/** The Artist's masterpiece: a strawberry (a nod to Berry Club), drawn at 2x scale. */
const STRAWBERRY = [
  ".....gl.....",
  "...lggggl...",
  "..gggllggg..",
  "...rrrrrr...",
  "..rrryrrrr..",
  ".rrrrrrryrr.",
  ".ryrrrrrrrr.",
  ".rrrrryrrrr.",
  ".rrprrrrryr.",
  "..rrrrrrrr..",
  "..rryrrrrr..",
  "...rrrryr...",
  "....rrrr....",
  ".....rr.....",
];
const COLORS: Record<string, number> = { r: 8, p: 14, y: 10, g: 3, l: 11 };

export interface ShapePixel {
  x: number;
  y: number;
  color: number;
}

export function strawberryPixels(originX: number, originY: number, scale = 2): ShapePixel[] {
  const out: ShapePixel[] = [];
  STRAWBERRY.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = COLORS[ch];
      if (color === undefined) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) out.push({ x: originX + x * scale + dx, y: originY + y * scale + dy, color });
    });
  });
  return out;
}
