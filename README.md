# bunroutine

Go-goroutine-flavored concurrency for [Bun](https://bun.sh): a real worker-thread
pool for parallel work, plus Go-style `Channel`, `select`, `WaitGroup`, and
`Mutex` for coordinating async code on a single thread.

```ts
import { go, Channel, WaitGroup } from "bunroutine";

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

const wg = new WaitGroup();
const found = new Channel<number>(4);

for (const n of candidates) {
  wg.add(1);
  go(isPrime, n).then((prime) => {
    if (prime) found.send(n);
    wg.done();
  });
}
wg.wait().then(() => found.close());

for await (const prime of found) console.log(prime);
```

## Two concurrency models, not one

Go gets away with a single `go func(){}` because goroutines share memory:
the runtime multiplexes many goroutines onto a handful of OS threads, and a
mutex or channel is enough to keep them from stepping on each other. In
JavaScript there's no equivalent of "many logical threads sharing one heap,
some of which happen to run in parallel." You get one of two very different
things:

1. **A single thread running many concurrent async functions** — cheap,
   ordinary `Promise`s, sharing the same heap, but never actually running
   two pieces of JS at once.
2. **Multiple OS threads (Bun `Worker`s)** — real parallelism, but each
   thread has an *isolated* heap. Nothing is shared by default; every
   message between threads is a structured-clone copy.

bunroutine doesn't pretend these are the same thing. It gives you a
primitive for each:

| | same-thread concurrency | cross-thread parallelism |
|---|---|---|
| primitive | `Channel`, `select`, `WaitGroup`, `Mutex` | `go()` / `WorkerPool` |
| memory | shared (same heap) | isolated (structured-clone only) |
| use for | coordinating async I/O, producer/consumer pipelines | CPU-bound work: hashing, parsing, image/data processing |
| cost | ~free | worker startup + message serialization |

`examples/fanin.ts` shows them combined: `go()` fans CPU work out to real
threads, and a `Channel` + `select()` fan the results back in on the main
thread — the same shape as idiomatic Go code that mixes goroutines and
channels.

## Layout

```
src/
  index.ts        public API: go(), goModule(), setPoolSize(), shutdown()
  pool.ts         WorkerPool — spawns and schedules Bun Worker threads
  worker.ts       code that runs inside each worker thread
  task.ts         function -> source-string serialization for go()
  channel.ts      Channel<T> — buffered/unbuffered, same-thread only
  select.ts       select() — race multiple channel receives
  sync.ts         WaitGroup, Mutex — same-thread only
  shared-mutex.ts SharedMutex — real cross-thread lock via SharedArrayBuffer
  errors.ts       PanicError, ChannelClosedError
examples/         runnable demos (bun run examples/<name>.ts)
test/             bun:test suite
```

## API

- **`go(fn, ...args)`** — runs `fn(...args)` on the shared default worker
  pool, returns a `Promise` of the result. Closest analogue to `go func(){}()`.
  `fn` is reconstructed from source in the worker, so it can't close over
  outer scope — see below.
- **`goModule(specifier, exportName, ...args)`** — same idea, but instead of
  serializing a closure, the worker `import()`s the module at `specifier`
  and calls its `exportName` export. No free-variable landmine, at the cost
  of the task needing to be a real exported function rather than an inline
  closure. `specifier` must resolve on its own inside the worker — pass an
  absolute URL, e.g. `new URL("./tasks.ts", import.meta.url)`.
- **`new WorkerPool({ size })`** — an explicit pool (default size is the
  machine's available parallelism) with `.run(fn, ...args)`,
  `.runModule(specifier, exportName, ...args)`, `.size`, `.queued`, `.destroy()`.
- **`new Channel<T>(capacity = 0)`** — `send`, `receive`, `tryReceive`,
  `close`, async-iterable. Capacity 0 is a Go-style unbuffered/rendezvous
  channel. Same-thread only.
- **`select(channels)`** — resolves `{ done: false, index, value }` for
  whichever channel produces a value first, or `{ done: true, index: -1 }`
  if one is closed and drained.
- **`new WaitGroup()`** — `add(n)`, `done()`, `wait()`. Same-thread only.
- **`new Mutex()`** — `lock()` returns a release function; `withLock(fn)`
  runs `fn` while held. Same-thread only.
- **`new SharedMutex(buffer?)`** — real mutual exclusion *across worker
  threads*, backed by a `SharedArrayBuffer` and `Atomics`. Share `.buffer`
  with a worker (it's passed by reference, not copied) and reconstruct with
  `new SharedMutex(buffer)` on the other side to lock the same memory.

## Key problems (and where they currently stand)

**Closures don't survive the thread boundary.** `go()` reconstructs a
function from `fn.toString()` inside the worker via `eval`, so `fn` may only
reference its own parameters, globals, and — for named functions — itself.
Anything it closes over from the outer scope is invisible on the other side;
if the source references a free variable, you get a `ReferenceError` at
call time, not a compile error. This is the single biggest gap between this
library's DX and Go's: Go's compiler lets a goroutine capture anything;
here, capture silently doesn't work.

One sharp edge already found and fixed: a `function` declared *inside a
block* (`if`/`try`/etc.) gets compiled by Bun to something like
`var fib; { fib = function(n) { ... } }` — so `fn.toString()` returns the
*anonymous* literal, and the name that made recursion work lives on the
outer `var`, not in the source text. `serializeTask()` (`src/task.ts`)
detects this (`fn.name` set but missing from the source) and splices the
name back into the reconstructed function so self-recursion still works.
Arrow functions have no equivalent fix — they were never self-referencing
in the first place, so recursive arrows genuinely cannot cross the thread
boundary; use a named `function`.

**Resolved:** `goModule()` / `WorkerPool.runModule()` is the honest long-term
fix — point the worker at an exported function in its own module instead of
relying on `toString`/`eval`. More verbose (no inline closures), but none of
the free-variable or minifier failure modes. Use `go()` for quick inline
tasks, `goModule()` once a task needs to reference real outer state.

**No shared memory across `go()` calls — partially resolved.** Every
argument and return value passed through `go()`/`goModule()` is still
structured-cloned; fine for typical payloads, a serialization tax for large
ones. But `SharedArrayBuffer` + `Atomics` *is* now used where it matters
most: `Atomics.waitAsync` is confirmed working on Bun (tested directly —
one worker `Atomics.wait`s on a `SharedArrayBuffer` cell, another
`Atomics.notify`s it from a different OS thread, and the first one wakes,
non-blockingly), so `SharedMutex` gives real cross-thread mutual exclusion
today. Verified with an actual regression test (`test/shared-mutex.test.ts`):
two real worker threads race 500 increments each against a shared counter;
with the lock the count lands exactly on 1000, and a manual no-lock control
run of the same setup landed on 500 — i.e. the test would actually catch a
broken lock, not just pass by construction.

A cross-thread `Channel` (queue instead of a single lock cell) is the
natural next step on the same primitive, but isn't built yet — it needs a
ring buffer of shared slots plus the send/receive rendezvous logic
`Channel` already has, redone in terms of indices into a `SharedArrayBuffer`
rather than a plain JS array.

**The `postMessage` envelope has a real, measured cost.** Bun 1.2.21+ has a
fast path that shares a string's pointer across threads instead of copying
it — but only when the string is the *sole* value in the message (per
[Bun's writeup](https://bun.com/blog/how-we-made-postMessage-string-500x-faster)).
Benchmarked directly against this library's shape: round-tripping a 3MB
string alone took ~0.06ms; the exact same string wrapped in our task
envelope (`{ id, kind, source, args }`) took ~1.5ms — about 25x slower —
and it doesn't matter whether the wrapper is an object or an array, only
whether the string has sibling fields at all. So today, every `go()`/
`goModule()` call pays the slow structured-clone path for its arguments and
return value, string or not, because `id`/`kind`/`args` always ride along.
This is invisible for typical small payloads but a real, avoidable cost for
large string arguments or results (e.g. passing a big blob of text into a
worker). Fixing it would mean a second, bare-string send path alongside the
normal envelope — not built yet.

**`select()` can't be perfectly fair.** Go's `select` atomically commits to
one ready case, chosen at random among ties, without disturbing the others.
Built on promises, the best available is: synchronously check every channel
first (`tryReceive`), and only if none are ready, register a cancellable
waiter on all of them and race. That's implemented (`Channel._waitReceive`
+ cancellation in `select.ts`), and it's correct for the common case, but
ties are broken by array order, not randomly, and cancellation of the
losing waiters happens in a microtask after the winner is chosen rather
than atomically.

**Worker startup cost.** Spawning a `Worker` isn't free (tens of ms). The
pool amortizes this by keeping threads warm and reusing them across `run()`
calls rather than spawning per task — the tradeoff is a fixed-size pool with
a FIFO queue once every thread is busy, rather than unbounded fan-out.
`examples/fibonacci.ts` demonstrates the payoff: parallel CPU-bound work
across 4 threads beats sequential by roughly the thread count for
sufficiently chunky tasks; for tiny tasks the message-passing overhead can
dominate and a single-threaded loop wins.

**Error propagation.** An uncaught throw inside a worker task rejects the
caller's promise with a `PanicError` carrying the original name/message/stack
(round-tripped as a plain object, since `Error` isn't structured-cloneable
as-is). There's no `recover()`-equivalent yet, and no distinction between "the
task threw" and "the worker itself crashed" (`worker.onerror`) beyond both
producing a `PanicError`.

**No cancellation/context.** Go's `context.Context` has no analogue here yet.
A `go()` call that never resolves (infinite loop in the task) currently just
occupies its worker slot forever. An `AbortSignal`-based `go(fn, args, { signal })`
that terminates the specific worker is on the roadmap but not implemented.

## Roadmap

- [x] `goModule()` — module-reference-based task dispatch as a robust
      alternative to `toString`/`eval` for anything that needs closures.
- [x] `Atomics.waitAsync` feasibility check on Bun/JSC — confirmed working,
      including a real cross-thread wake (one worker waits, a different OS
      thread notifies).
- [x] Cross-thread `Mutex` backed by `SharedArrayBuffer` + `Atomics` — done
      as `SharedMutex`, with a test that spawns two real worker threads and
      would fail if the lock didn't actually exclude.
- [ ] Cross-thread `Channel` — same `SharedArrayBuffer`/`Atomics` foundation
      as `SharedMutex`, extended to a ring buffer for a queue of values
      instead of a single lock bit.
- [ ] A bare-string fast send path for large string args/results, to
      actually get Bun's `postMessage` string fast path instead of losing
      it to the `{id, kind, args}` envelope every task currently rides in.
      Only matters once a task's argument or return value is a large
      string; measured cost is documented above.
- [ ] Cancellation via `AbortSignal`, tearing down the specific worker.
- [ ] Benchmarks comparing `go()` throughput/latency against a plain
      `Promise.all` baseline and against Node's `worker_threads` pool
      libraries (Piscina, workerpool), across a range of task sizes.

Deliberately not planned, and why:

- **Least-busy/work-stealing dispatch.** Moot under the current model —
  each worker runs exactly one task at a time, so "busy" is already binary
  and "first idle slot, else FIFO queue" *is* least-busy dispatch. This
  would only become a real question if a worker were ever allowed to run
  multiple tasks concurrently, which it isn't.
- **`.d.ts` build output.** Unnecessary: this package only runs on Bun (it
  uses Bun's `Worker`/`import.meta.url` resolution throughout, see
  `engines.bun` in `package.json`), so every consumer already has a
  TypeScript-aware runtime pointed straight at `src/index.ts` — the real
  source *is* the type declaration. A `.d.ts`/JS build would only matter
  for consumers on a different runtime, which this package doesn't support
  anyway.

## Development

```sh
bun install
bun test               # run the test suite
bun run typecheck      # tsc --noEmit
bun run examples/fibonacci.ts
bun run examples/pipeline.ts
bun run examples/fanin.ts
bun run examples/module-task.ts
```
