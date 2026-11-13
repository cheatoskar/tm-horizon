import { inspectGbx, type Inspection } from "./gbx.ts";
import type { WorkerMsg } from "./gbx.worker.ts";

/**
 * Drive the .Gbx worker from the page, with the clock running.
 *
 * The worker exists because the body parser can hang; this is the half that
 * actually saves the tab, by terminating it when it does. Everything the page
 * shows apart from the map drawing comes from the header, which is a few
 * milliseconds and does not hang, so a timed-out body costs the layout and
 * nothing else.
 *
 * From 100tmx.com (src/lib/tools/read-gbx.ts), split so a host that has the
 * bytes already (the launcher reads them from disk through its backend) does
 * not need a `File`.
 */

export interface GbxReadResult {
  inspection: Inspection;
  /** True when the header read but the body never came back. */
  layoutTimedOut: boolean;
}

/** Generous: a healthy body parse is 12-30 ms, so anything near this is stuck. */
const BODY_TIMEOUT_MS = 8000;
const HEADER_TIMEOUT_MS = 5000;

/** A big TMF map is a couple of megabytes; anything past this is not a map. */
export const MAX_MAP_BYTES = 32 * 1024 * 1024;

/** The messages that end in the user's language are the host's business; these are the defaults. */
export interface ReadMessages {
  tooSlow: string;
  notAMap: string;
  failedToStart: string;
}
const DEFAULT_MESSAGES: ReadMessages = {
  tooSlow: "Reading that file took too long.",
  notAMap: "That file did not read as a map.",
  failedToStart: "The map reader failed to start.",
};

type HeaderMsg = Extract<WorkerMsg, { kind: "header" }>;

/**
 * Turn the worker's messages into one answer. Separate from the worker itself
 * so it can be tested without one.
 */
export function collect(messages: ReadMessages = DEFAULT_MESSAGES) {
  let header: HeaderMsg | null = null;
  return {
    /** Null while more is to come; otherwise the result or an error message. */
    take(msg: WorkerMsg): GbxReadResult | { error: string } | null {
      if (msg.kind === "error") return { error: msg.message };
      if (msg.kind === "header") {
        header = msg;
        return null;
      }
      if (msg.kind === "body-failed") return this.headerOnly();
      // The header's thumbnail is the one to keep: the body re-read does not
      // always carry it, and losing the picture to gain the blocks is a
      // strange trade to make silently.
      const inspection = inspectGbx(msg.node, msg.thumbnail ?? header?.thumbnail ?? null);
      if (!inspection) return this.headerOnly();
      return { inspection, layoutTimedOut: false };
    },
    get hasHeader() {
      return header !== null;
    },
    headerOnly(): GbxReadResult | { error: string } {
      if (!header) return { error: messages.notAMap };
      const inspection = inspectGbx(header.node, header.thumbnail);
      if (!inspection) return { error: messages.notAMap };
      return { inspection, layoutTimedOut: true };
    },
  };
}

/** Read a map from its bytes in a worker. The buffer is transferred, so the caller loses it. */
export function readGbxBytes(bytes: ArrayBuffer, messages: ReadMessages = DEFAULT_MESSAGES): Promise<GbxReadResult> {
  return new Promise((resolve, reject) => {
    if (bytes.byteLength > MAX_MAP_BYTES) {
      reject(new Error(messages.notAMap));
      return;
    }
    const worker = new Worker(new URL("./gbx.worker.ts", import.meta.url), { type: "module" });
    const state = collect(messages);
    let settled = false;
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;

    const end = (r: GbxReadResult | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      clearTimeout(bodyTimer);
      worker.terminate();
      if ("error" in r) reject(new Error(r.error));
      else resolve(r);
    };

    const headerTimer = setTimeout(() => end({ error: messages.tooSlow }), HEADER_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<WorkerMsg>) => {
      const r = state.take(event.data);
      if (r) return end(r);
      // The body clock only starts once the header is in, so a slow disk read
      // does not eat the layout's budget.
      if (event.data.kind === "header") {
        clearTimeout(headerTimer);
        bodyTimer = setTimeout(() => end(state.headerOnly()), BODY_TIMEOUT_MS);
      }
    };
    worker.onerror = (e) => end({ error: e.message || messages.failedToStart });
    worker.postMessage({ bytes }, [bytes]);
  });
}

/** The website's entry point: a dropped or picked file. */
export async function readGbxFile(file: File, messages: ReadMessages = DEFAULT_MESSAGES): Promise<GbxReadResult> {
  if (file.size > MAX_MAP_BYTES) throw new Error(messages.notAMap);
  return readGbxBytes(await file.arrayBuffer(), messages);
}

/** `.Challenge.Gbx`, `.Map.Gbx`, or anything a person has renamed. */
export function looksLikeGbx(name: string): boolean {
  return /\.gbx$/i.test(name);
}
