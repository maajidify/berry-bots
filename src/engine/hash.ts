/** FNV-1a based 64-bit (two lanes) hex digest. Not cryptographic; used for board fingerprints and mock tx ids. */
export function fnv64(input: string | Uint8Array | ArrayLike<number>): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcbf29ce4 >>> 0;
  const feed = (b: number) => {
    h1 ^= b & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (b * 31 + 7) & 0xff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  };
  if (typeof input === "string") {
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      feed(c);
      feed(c >>> 8);
    }
  } else {
    for (let i = 0; i < input.length; i++) feed(input[i]);
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
