/** PICO-8 palette: 16 colors, index 0..15. Pixel colors on the board are palette indices. */
export const PALETTE = [
  "#000000", "#1d2b53", "#7e2553", "#008751",
  "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
  "#ff004d", "#ffa300", "#ffec27", "#00e436",
  "#29adff", "#83769c", "#ff77a8", "#ffccaa",
] as const;

export const COLOR_NAMES = [
  "black", "navy", "plum", "green", "brown", "gray", "silver", "white",
  "red", "orange", "yellow", "lime", "blue", "lavender", "pink", "peach",
] as const;

/** Background color of an unowned pixel (rendered, not stored). */
export const EMPTY_COLOR = "#1a1423";

export function colorIndexFromName(name: string): number | undefined {
  const i = COLOR_NAMES.indexOf(name.toLowerCase() as (typeof COLOR_NAMES)[number]);
  return i >= 0 ? i : undefined;
}
