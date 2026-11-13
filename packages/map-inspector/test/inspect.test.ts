import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyBlock, inspectGbx, checkMedals, formatTime, buildGeometry, columnsUpTo, isoBlocksAt, filterNames, colourForNew, PLOT_COLOR, PLOT_PALETTE, orderFill, NEWEST_COLOR, routeCounts } from "../src/index.ts";
import { collect } from "../src/read.ts";
import { readInto, type WorkerMsg } from "../src/gbx.worker.ts";
import { LZO } from "../src/lzo1x.ts";

/** A map as the worker hands it over (gbx.js field names). */
function node(blocks: [string, number, number, number, number][], extra: Record<string, unknown> = {}) {
  return {
    mapName: "$f00Test",
    authorLogin: "me",
    mapInfo: { id: "uid123", collection: "Stadium", author: "me" },
    decoration: { id: "Day" },
    size: { x: 8, y: 32, z: 8 },
    authorTime: 30000,
    goldTime: 32000,
    silverTime: 36000,
    bronzeTime: 45000,
    blocks: blocks.map(([blockName, x, y, z, direction]) => ({ blockName, direction, position: { x, y, z } })),
    ...extra,
  };
}

test("route blocks: StartLine only, multilap before start and finish", () => {
  assert.equal(classifyBlock("StadiumRoadMainStartLine"), "start");
  assert.equal(classifyBlock("StadiumPlatformLoopStart"), null);
  assert.equal(classifyBlock("StadiumRoadMainStartFinish"), "multilap");
  assert.equal(classifyBlock("StadiumCheckpointRingV"), "checkpoint");
  assert.equal(classifyBlock("IslandHighWayFinish"), "finish");
});

test("inspectGbx: summary, route, block names, footprint", () => {
  const i = inspectGbx(
    node([
      ["StadiumRoadMainStartLine", 1, 1, 1, 0],
      ["StadiumRoadMain", 2, 1, 1, 1],
      ["StadiumRoadMain", 3, 2, 1, 1],
      ["StadiumCheckpoint", 4, 2, 1, 1],
      ["StadiumRoadMainFinishLine", 5, 1, 1, 2],
    ]),
    null,
  )!;
  assert.equal(i.summary.name, "$f00Test");
  assert.equal(i.summary.uid, "uid123");
  assert.equal(i.summary.environment, "Stadium");
  assert.equal(i.summary.blocks, 5);
  assert.deepEqual(i.route.map((b) => b.kind), ["start", "checkpoint", "finish"]);
  assert.equal(i.route[0].direction, "North");
  assert.deepEqual(i.names[0], { name: "StadiumRoadMain", count: 2 });
  assert.equal(i.ground.cells.size, 5);
  assert.equal(i.ground.maxY, 2);
  assert.equal(i.hasLayout, true);
  assert.equal(i.source, "gbx");
  assert.deepEqual(routeCounts(i.route), { start: 1, checkpoint: 1, finish: 1 });
});

test("inspectGbx: not a map without name and uid", () => {
  assert.equal(inspectGbx({ blocks: [] }, null), null);
});

test("medals: generated set matches, an edited one does not", () => {
  assert.ok(checkMedals(30000, { gold: 32000, silver: 36000, bronze: 45000 }).every((c) => c.ok));
  const bad = checkMedals(30000, { gold: 31000 });
  assert.equal(bad[0].ok, false);
  assert.equal(bad[0].offBy, -1000);
  assert.equal(formatTime(63370), "1:03.37");
});

test("geometry: mirrored grid, route index, plotted cells, build order", () => {
  const i = inspectGbx(
    node([
      ["StadiumRoadMainStartLine", 0, 1, 0, 0],
      ["StadiumWater", 1, 1, 0, 0],
      ["StadiumRoadMainFinishLine", 7, 1, 7, 0],
    ]),
    null,
  )!;
  const g = buildGeometry(i, new Map([["StadiumWater", "#35d6c8"]]))!;
  assert.equal(g.w, 8);
  assert.equal(g.ordered, true);
  // x/z run the other way round in the drawing.
  assert.deepEqual(g.route.map((r) => [r.x, r.z]), [[7, 7], [0, 0]]);
  assert.deepEqual(g.routeIndex, [0, 2]);
  assert.equal(g.plottedCells.get("6,7"), "#35d6c8");
  assert.equal(columnsUpTo(g, 2).length, 2);
  const step = isoBlocksAt(g, 2, false);
  assert.equal(step.length, 2);
  assert.equal(step[1].mark, "#35d6c8"); // a plotted block keeps its colour, not the newest outline
  assert.equal(isoBlocksAt(g, 3, false), g.isoBlocks);
  const coloured = isoBlocksAt(g, 3, true);
  assert.equal(coloured[0].fill, orderFill(0, 3));
  const plain = buildGeometry(i, new Map())!;
  assert.equal(isoBlocksAt(plain, 2, false)[1].mark, NEWEST_COLOR);
});

test("block name filter and colour picking", () => {
  const names = [{ name: "StadiumWater" }, { name: "StadiumPool" }, { name: "StadiumRoadMain" }];
  assert.equal(filterNames(names, "water|pool").length, 2);
  assert.equal(filterNames(names, "(").length, 0); // a broken pattern falls back to a substring
  assert.equal(colourForNew(new Map(), PLOT_COLOR), PLOT_COLOR);
  assert.equal(colourForNew(new Map([["a", PLOT_COLOR]]), PLOT_COLOR), PLOT_PALETTE[1].hex);
});

test("collect: header first, body later; a failed body keeps the header", () => {
  const n = node([["StadiumRoadMainStartLine", 1, 1, 1, 0]]);
  const c = collect();
  assert.equal(c.take({ kind: "header", node: { ...n, blocks: undefined }, thumbnail: "AAAA" }), null);
  const full = c.take({ kind: "full", node: n, thumbnail: null });
  assert.ok(full && "inspection" in full);
  assert.equal(full.inspection.summary.thumbnail, "AAAA");
  assert.equal(full.layoutTimedOut, false);
  const c2 = collect();
  c2.take({ kind: "header", node: { ...n, blocks: undefined }, thumbnail: null });
  const head = c2.take({ kind: "body-failed", message: "x" });
  assert.ok(head && "inspection" in head && head.layoutTimedOut);
  assert.deepEqual(collect().take({ kind: "error", message: "bad" }), { error: "bad" });
});

test("readInto: garbage is an error, not a hang", async () => {
  const got: WorkerMsg[] = [];
  await readInto(new Uint8Array([1, 2, 3, 4]), (m) => got.push(m));
  assert.equal(got[0].kind, "error");
});

test("lzo1x: literal-only stream decodes, compress refuses", () => {
  // 17 + n marks a first literal run of n bytes, then the end marker 0x11 0x00 0x00.
  const out = LZO.decompress(new Uint8Array([17 + 3, 65, 66, 67, 0x11, 0, 0]));
  assert.deepEqual([...out], [65, 66, 67]);
  assert.throws(() => LZO.compress());
});

// A real map, read the way the worker reads it: MAP_INSPECTOR_SAMPLE=<file.Challenge.Gbx> npm test.
// Not committed: community maps are their authors' work. Needs the lzo-ts alias (see index.ts), which
// Node has not got, so only the header part is asserted when the body needs LZO.
const sample = process.env.MAP_INSPECTOR_SAMPLE;
test("a real .Gbx (MAP_INSPECTOR_SAMPLE)", { skip: !sample }, async () => {
  const got: WorkerMsg[] = [];
  await readInto(new Uint8Array(readFileSync(sample!)), (m) => got.push(m));
  const c = collect();
  let r = null;
  for (const m of got) r = c.take(m) ?? r;
  r ??= c.headerOnly();
  assert.ok(r && "inspection" in r, JSON.stringify(got.map((m) => m.kind)));
  console.log(r.inspection.summary.name, r.inspection.summary.blocks, "blocks", r.inspection.route.length, "route", r.layoutTimedOut ? "(header only)" : "");
});
