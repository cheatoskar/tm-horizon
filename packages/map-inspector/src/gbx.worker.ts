import { GBX } from "gbx";

/**
 * Reading a .Gbx, off the main thread.
 *
 * In a worker for one specific reason: the body parser can hang. Measured on
 * four real TMNF maps, three parsed in 12-30 ms and one never returned at all -
 * a block loop that decrements its own counter, so a file it cannot make sense
 * of spins forever. On the main thread that is a frozen tab with no way back.
 * Here the page can simply terminate the worker and carry on.
 *
 * Two messages, deliberately. The header is a few milliseconds and is where
 * the identity, the medals and the thumbnail live, so it goes out immediately
 * and the page can draw. The body - which is only the block layout - follows
 * when and if it arrives.
 *
 * From 100tmx.com (src/workers/gbx.worker.ts). The host has to point the
 * `lzo-ts` import inside `gbx` at `./lzo1x.ts` (an alias in its bundler), see
 * the licence note in index.ts.
 */

type Plain = Record<string, unknown>;

/**
 * Copy out the fields we use.
 *
 * The parser returns class instances whose numeric keys are chunk-reader
 * *functions*, and `postMessage` clones structurally: a function anywhere in
 * the object throws DataCloneError. Picking fields explicitly also keeps the
 * megabytes of chunk bookkeeping out of the message.
 */
export function pick(node: Plain): Plain {
  const o = (v: unknown) => (v && typeof v === "object" ? (v as Plain) : null);
  const info = o(node.mapInfo);
  const deco = o(node.decoration);
  const size = o(node.size);
  const player = o(node.playerModel);

  const blocks = Array.isArray(node.blocks)
    ? node.blocks.map((b) => {
        const bb = o(b) ?? {};
        const p = o(bb.position);
        return {
          blockName: bb.blockName,
          direction: bb.direction,
          position: p ? { x: p.x, y: p.y, z: p.z } : null,
        };
      })
    : undefined;

  return {
    mapName: node.mapName,
    authorLogin: node.authorLogin,
    authorNickname: node.authorNickname,
    mapInfo: info ? { id: info.id, collection: info.collection, author: info.author } : null,
    decoration: deco ? { id: deco.id, collection: deco.collection } : null,
    size: size ? { x: size.x, y: size.y, z: size.z } : null,
    playerModel: player ? { id: player.id } : null,
    bronzeTime: node.bronzeTime,
    silverTime: node.silverTime,
    goldTime: node.goldTime,
    authorTime: node.authorTime,
    authorScore: node.authorScore,
    isLapRace: node.isLapRace,
    nbLaps: node.nbLaps,
    nbCheckpoints: node.nbCheckpoints,
    mapType: node.mapType,
    comments: node.comments,
    blocks,
  };
}

/** The thumbnail arrives as a byte array; the page wants base64. */
export function toBase64(data: unknown): string | null {
  const bytes = data instanceof Uint8Array ? Array.from(data) : data;
  if (!Array.isArray(bytes) || bytes.length === 0) return null;
  let binary = "";
  // In chunks: String.fromCharCode(...bytes) on a 100 KB image blows the
  // argument limit and throws rather than returning a truncated string.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...(bytes.slice(i, i + 8192) as number[]));
  }
  try {
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * The parser's types ask for `Buffer | number[]`, which is Node's view of the
 * world; in a worker there is no Buffer, and turning a megabyte file into a
 * number array to satisfy a type would be a real copy for no reason. Its reader
 * only ever indexes bytes and calls `.length`, which `Uint8Array` does.
 */
type ByteInput = ConstructorParameters<typeof GBX>[0];
const asInput = (b: Uint8Array) => b as unknown as ByteInput;

export type WorkerMsg =
  | { kind: "header"; node: Plain; thumbnail: string | null }
  | { kind: "full"; node: Plain; thumbnail: string | null }
  | { kind: "error"; message: string }
  | { kind: "body-failed"; message: string };

/** Both readings of one file, as the messages the worker posts. Also usable without a worker (tests). */
export async function readInto(bytes: Uint8Array, post: (msg: WorkerMsg) => void): Promise<void> {
  let header: Plain;
  try {
    header = (await new GBX(asInput(bytes), 0).parseHeaders()) as unknown as Plain;
  } catch (err) {
    post({ kind: "error", message: (err as Error).message });
    return;
  }

  post({ kind: "header", node: pick(header), thumbnail: toBase64(header.thumbnailData) });

  // A second reader over the same bytes: the first one has already consumed
  // its stream, and re-reading 15 KB costs nothing next to the parse.
  try {
    const full = (await new GBX(asInput(bytes), 0).parse()) as unknown as Plain;
    post({ kind: "full", node: pick(full), thumbnail: toBase64(full.thumbnailData) });
  } catch (err) {
    post({ kind: "body-failed", message: (err as Error).message });
  }
}

// Only when running as a worker: no `window`, a `postMessage` on the global.
interface WorkerScope {
  onmessage: ((event: MessageEvent<{ bytes: ArrayBuffer }>) => void) | null;
  postMessage: (msg: WorkerMsg) => void;
}
const scope = globalThis as unknown as WorkerScope & { window?: unknown; document?: unknown };
if (typeof scope.document === "undefined" && typeof scope.postMessage === "function" && typeof scope.window === "undefined") {
  scope.onmessage = (event) => {
    void readInto(new Uint8Array(event.data.bytes), (msg) => scope.postMessage(msg));
  };
}
