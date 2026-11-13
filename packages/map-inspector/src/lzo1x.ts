/**
 * LZO1X-1 decompression.
 *
 * Why this exists at all: a Gbx body is LZO-compressed, and every LZO
 * implementation that descends from Oberhumer's `minilzo` - including the
 * `lzo-ts` package this replaces - is GPL-3.0. Shipping one to the browser is
 * conveying it, which put the whole client bundle under the GPL for the sake
 * of two hundred lines of decompressor. This is an independent implementation
 * of the published LZO1X bitstream, written from the format description (the
 * same basis as the MIT-licensed `lzokay` and its Rust and Go ports), so
 * nothing copyleft ships and the licence of this project is a free choice
 * again.
 *
 * Decompression only. Nothing here writes a .Gbx, and a compressor is the half
 * with the patents-and-tuning folklore in it; `compress` therefore refuses
 * rather than pretending.
 *
 * Correctness is not taken on trust: `npm run verify:lzo` round-trips several
 * thousand buffers - random, runs, text, real Gbx-shaped data and the edge
 * cases each branch below needs - through a reference compressor and this
 * decompressor, and compares byte for byte.
 */

/** Thrown on a stream that cannot be decoded, rather than returning rubbish. */
export class LzoError extends Error {
  constructor(message: string) {
    super(`LZO1X: ${message}`);
    this.name = "LzoError";
  }
}

/**
 * The format's own constant: the largest offset an M2 match can encode.
 *
 * It only appears in the M1 match that can follow the *first* literal run,
 * which is the one place the encoder is allowed to assume a longer reach.
 */
const M2_MAX_OFFSET = 0x0800;

/**
 * The stream does not record how big it decompresses to, so the output grows.
 *
 * Gbx does know the size, but the parser this feeds asks for decompression
 * without passing it, so guessing and growing is the only option. Three times
 * the input is a deliberate over-estimate for a first go: Gbx bodies are block
 * tables and strings and run 3-6x, and one doubling is much cheaper than a
 * dozen.
 */
const INITIAL_FACTOR = 3;

export function lzo1xDecompress(src: Uint8Array): Uint8Array {
  if (src.length < 3) throw new LzoError("input too short to be a stream");

  let dst = new Uint8Array(Math.max(1024, src.length * INITIAL_FACTOR));
  let ip = 0;
  let op = 0;
  let t = 0;
  let m = 0;

  /** Make room for `n` more output bytes, doubling rather than creeping. */
  const room = (n: number) => {
    if (op + n <= dst.length) return;
    let size = dst.length;
    while (size < op + n) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(dst.subarray(0, op));
    dst = bigger;
  };

  /** A literal run: `n` bytes straight from the input. */
  const literals = (n: number) => {
    if (ip + n > src.length) throw new LzoError("literal run runs past the end of the input");
    room(n);
    for (let i = 0; i < n; i++) dst[op++] = src[ip++];
  };

  /**
   * A match: `n` bytes from earlier in the *output*.
   *
   * Byte at a time, and it has to be - a match may overlap the cursor it is
   * being written to (that is how LZO encodes a run), so a bulk copy would
   * read the bytes this very loop is supposed to be producing.
   */
  const match = (from: number, n: number) => {
    if (from < 0) throw new LzoError("match points before the start of the output");
    room(n);
    let k = from;
    for (let i = 0; i < n; i++) dst[op++] = dst[k++];
  };

  /** A length encoded as "zero, then a run of 255s, then the remainder". */
  const longLength = (base: number) => {
    let n = 0;
    while (src[ip] === 0) {
      if (ip >= src.length) throw new LzoError("length runs past the end of the input");
      n += 255;
      ip++;
    }
    if (ip >= src.length) throw new LzoError("length runs past the end of the input");
    return n + base + src[ip++];
  };

  // The states are the labels of the reference algorithm. Written out as a
  // machine because the original is a knot of gotos that jump *into* the
  // middle of two loops - flattening it to `while` and `break` either changes
  // the control flow or hides it, and this has to be checkable against the
  // description line by line.
  const TOP = 0;
  const FIRST_LITERAL_RUN = 1;
  const MATCH = 2;
  const COPY_MATCH = 3;
  const MATCH_DONE = 4;
  const MATCH_NEXT = 5;

  let state: number;

  // The first byte is special: a stream that opens with a literal run longer
  // than 17 encodes it here rather than spending a token on it.
  if (src[ip] > 17) {
    t = src[ip++] - 17;
    if (t < 4) {
      state = MATCH_NEXT;
    } else {
      literals(t);
      state = FIRST_LITERAL_RUN;
    }
  } else {
    state = TOP;
  }

  for (;;) {
    switch (state) {
      case TOP: {
        if (ip >= src.length) throw new LzoError("input ended without an end marker");
        t = src[ip++];
        if (t >= 16) {
          state = MATCH;
          break;
        }
        // A literal run. Zero means the length did not fit in the token.
        if (t === 0) t = longLength(15);
        literals(t + 3);
        state = FIRST_LITERAL_RUN;
        break;
      }

      case FIRST_LITERAL_RUN: {
        if (ip >= src.length) throw new LzoError("input ended after a literal run");
        t = src[ip++];
        if (t >= 16) {
          state = MATCH;
          break;
        }
        // The one M1 match that may reach further back, three bytes long.
        m = op - (1 + M2_MAX_OFFSET) - (t >> 2) - (src[ip++] << 2);
        match(m, 3);
        state = MATCH_DONE;
        break;
      }

      case MATCH: {
        if (t >= 64) {
          // M2: length in the top bits, a short offset.
          m = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3);
          t = (t >> 5) - 1;
          state = COPY_MATCH;
        } else if (t >= 32) {
          // M3: length in the token, a 14-bit offset in the next two bytes.
          t &= 31;
          if (t === 0) t = longLength(31);
          m = op - 1 - ((src[ip] >> 2) + (src[ip + 1] << 6));
          ip += 2;
          state = COPY_MATCH;
        } else if (t >= 16) {
          // M4: the long-distance match, and the one that carries the end
          // marker - a match whose offset resolves to the cursor itself is
          // not a match, it is the end of the stream.
          m = op - ((t & 8) << 11);
          t &= 7;
          if (t === 0) t = longLength(7);
          m -= (src[ip] >> 2) + (src[ip + 1] << 6);
          ip += 2;
          if (m === op) return dst.slice(0, op);
          m -= 0x4000;
          state = COPY_MATCH;
        } else {
          // M1: two bytes, very close behind.
          m = op - 1 - (t >> 2) - (src[ip++] << 2);
          match(m, 2);
          state = MATCH_DONE;
        }
        break;
      }

      case COPY_MATCH: {
        match(m, t + 2);
        state = MATCH_DONE;
        break;
      }

      case MATCH_DONE: {
        // The bottom two bits of the token just consumed say how many literals
        // ride along behind the match.
        t = src[ip - 2] & 3;
        state = t === 0 ? TOP : MATCH_NEXT;
        break;
      }

      case MATCH_NEXT: {
        literals(t);
        if (ip >= src.length) throw new LzoError("input ended after a trailing literal");
        t = src[ip++];
        state = MATCH;
        break;
      }

      /* c8 ignore next */
      default:
        throw new LzoError("unreachable state");
    }
  }
}

/**
 * The shape `gbx` reaches for.
 *
 * It does `const { LZO } = await import("lzo-ts")` and calls the statics, so
 * the replacement has to answer to the same name and signatures. Bound to this
 * module by `turbopack.resolveAlias` in `next.config.ts`; see the licence note
 * in README.md for why.
 */
export const LZO = {
  decompress(buffer: Uint8Array | number[]): Uint8Array {
    return lzo1xDecompress(buffer instanceof Uint8Array ? buffer : Uint8Array.from(buffer));
  },

  compress(): never {
    // Nothing in this project writes a .Gbx. Refusing beats shipping a
    // compressor nobody exercises, and beats a silent wrong answer if that
    // ever changes.
    throw new LzoError("compression is not implemented - this build only reads Gbx files");
  },
};

export default { LZO };
