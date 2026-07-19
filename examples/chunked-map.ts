// Parallelizing expensive per-item work over a big array of nested objects.
//
// Two lessons in one example:
// 1. Chunk the array instead of calling go() per item — one go() call per
//    item pays a structured-clone round trip per item; chunking pays that
//    tax once per batch, and comes out ahead once the per-item work is
//    expensive enough to dominate it.
// 2. `processChunk` here calls a sibling helper (`expensiveWork`), which
//    `go()` can't handle — reconstructing `processChunk` from
//    `fn.toString()` only gets its own body text, not the functions it
//    calls, so it would fail with "expensiveWork is not defined" inside the
//    worker. `goModuleFn()` is the fix: pass the real, already-imported
//    `processChunk` function and it's dispatched by its own `.name` — no
//    string to typo, no type arguments to write, and the worker imports
//    fixtures/chunked-map-tasks.ts for real instead of reconstructing
//    `processChunk` from source, so it can see `expensiveWork` too. The
//    tradeoff (documented in the README): that module now also loads on
//    this thread, not just inside each worker — free here since it's just
//    two small function definitions with no expensive top-level work.
//
// Run with: bun run examples/chunked-map.ts
import { goModuleFn, shutdown } from "../src/index.ts";
import { expensiveWork, processChunk, type Item } from "./fixtures/chunked-map-tasks.ts";

const tasksModule = import.meta.resolve("./fixtures/chunked-map-tasks.ts");

const N = 400;
const items: Item[] = Array.from({ length: N }, (_, i) => ({
  id: i,
  name: `item-${i}`,
  position: { x: Math.random(), y: Math.random(), z: Math.random() },
  tags: ["a", "b", "c"],
}));

console.time("sequential (main thread)");
const sequential = items.map(expensiveWork);
console.timeEnd("sequential (main thread)");

console.time("chunked parallel (worker pool via goModuleFn)");
const chunkCount = navigator.hardwareConcurrency;
const chunkSize = Math.ceil(items.length / chunkCount);
const chunks: Item[][] = [];
for (let i = 0; i < items.length; i += chunkSize) {
  chunks.push(items.slice(i, i + chunkSize));
}
const parallel = (
  await Promise.all(chunks.map((chunk) => goModuleFn(processChunk, tasksModule, chunk)))
).flat();
console.timeEnd("chunked parallel (worker pool via goModuleFn)");

console.log("results match:", JSON.stringify(sequential) === JSON.stringify(parallel));

await shutdown();
