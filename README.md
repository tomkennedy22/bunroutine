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
  index.ts        public API: go(), goModule(), moduleTasks(), goModuleFn(), setPoolSize(), shutdown()
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
- **`goModule<M, K>(specifier, exportName, ...args)`** — same idea, but
  instead of serializing a closure, the worker `import()`s the module at
  `specifier` and calls its `exportName` export. No free-variable landmine,
  at the cost of the task needing to be a real exported function rather
  than an inline closure. `specifier` must resolve on its own inside the
  worker — pass an absolute URL, e.g. `import.meta.resolve("./tasks.ts")`
  (the standard way to turn a relative path into an absolute one from the
  current module).

  `M` and `K` are how this stays fully typed: pass `M` explicitly as
  `typeof import("./tasks.ts")` — a type-only import, erased at runtime —
  and `K` (`exportName`) is checked against `M`'s *real* exports, with
  `args`/the return type derived from that export's actual signature:

  ```ts
  const result = await goModule<typeof import("./tasks.ts"), "double">(
    import.meta.resolve("./tasks.ts"),
    "double",
    21,
  );
  ```

  Typo `"double"`, pass the wrong argument type, or assume the wrong return
  type, and this fails to compile rather than misbehaving at runtime — the
  one thing it *can't* check is whether the type-level path in
  `typeof import(...)` and the runtime `specifier` string agree on which
  file they mean; keep those two in sync yourself.
- **`moduleTasks<M>(specifier)`** — binds `M` and `specifier` once and
  returns `{ run(exportName, ...args) }`, so calling multiple exports from
  the same module doesn't repeat either — only the export name, inferred
  from each `.run()` call rather than written out as a type argument every
  time:

  ```ts
  const tasks = moduleTasks<typeof import("./tasks.ts")>(
    import.meta.resolve("./tasks.ts"),
  );
  await tasks.run("double", 21);
  await tasks.run("delayedSum", 2, 3);
  ```

  `specifier` still appears twice across the snippet above (type argument,
  then runtime value) — that part can't be collapsed further. TypeScript
  requires a literal string directly in a `typeof import(...)` position,
  even behind a generic type parameter (verified directly: `function f<P
  extends string>(p: P): typeof import(P)` is a hard compile error, `String
  literal expected`), so there's no way to derive the type-only import from
  a runtime value. `moduleTasks()` only removes the export-name repetition.
- **`goModuleFn(fn, specifier, ...args)`** — pass the already-imported
  function itself instead of a string `exportName` and manual `M`/`K` type
  arguments:

  ```ts
  import { double } from "./tasks.ts";
  const result = await goModuleFn(double, import.meta.resolve("./tasks.ts"), 21);
  ```

  No type arguments at all — `Fn` is inferred straight from `fn` — and no
  string to typo, since the export name dispatched to the worker is
  `fn.name`, which reflects the function's *original* declared name even
  through a renamed import (`import { double as d }` — `d.name` is still
  `"double"`, verified directly). A function with no usable name — genuinely
  anonymous, or wrapped with `.bind()` (which mangles the name to `"bound
  double"`) — fails clearly (synchronously for anonymous, as a rejected
  promise from the worker for a bound/mangled name) instead of silently
  dispatching the wrong thing.

  The tradeoff: `fn` has to be a real import, so the task module loads on
  the calling thread too, not just inside the worker — negligible for a
  small task module, worth knowing if the module is heavy or has expensive
  top-level side effects, in which case prefer `goModule`/`moduleTasks`
  above (type-only import, never loaded on the calling side). Same residual
  gap as everything else here: nothing checks that `specifier` really
  points at the module `fn` came from.
- **`new WorkerPool({ size })`** — an explicit pool (default size is the
  machine's available parallelism) with `.run(fn, ...args)`,
  `.runModule(specifier, exportName, ...args)`, `.runModuleFn(fn, specifier, ...args)`,
  `.size`, `.queued`, `.destroy()`.
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

It also closes a real type-safety gap `go()` still has. `go(fn, ...args)`
type-checks `Args`/`R` against `fn`'s *declared* signature — as if you were
calling it locally — but what actually executes is `fn` reconstructed from
source in a different realm, so if `fn` depends on a free variable that
doesn't survive that trip, TypeScript has no way to know; it confidently
reports the return type as `R` right up until the `ReferenceError` at
runtime. `goModule<M, K>` doesn't have this gap: passing `M` as
`typeof import("./tasks.ts")` (type-only, erased at runtime) means
`exportName`, `args`, and the return type are all checked against that
module's *real* exports — verified directly: typo the export name, pass a
wrong argument type, or assume the wrong return type, and it fails to
compile (see the worked examples above). The one thing left unchecked is
whether the type-level import path and the runtime `specifier` string
happen to agree on which file they mean — TypeScript has no way to compare
a type-position string against a runtime string value.

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

**Big arrays of nested objects pay a real structured-clone tax — chunk
them.** Benchmarked directly: `postMessage`-ing 100,000 small nested objects
(`{ id, name, position: { x, y, z }, tags: [...] }`) took ~121ms of pure
clone overhead, versus ~2.4ms for the same numeric data reshaped into
`Float64Array`s over a `SharedArrayBuffer` and shared zero-copy. `go()`/
`goModule()` don't do that reshaping for you — a plain array of objects
always gets fully cloned in and back out. Two consequences: if the
per-item work is cheap (a filter/map over a few fields), the clone cost
dominates and parallelizing will likely make things *slower*, not faster —
just do it on the main thread. If the per-item work is genuinely expensive
(parsing, regex, crypto, image processing), don't call `go()`/`goModule()`
once per item either — chunk the array into `hardwareConcurrency`-many
batches and dispatch one task per batch, so the clone tax is paid once per
batch instead of once per item and gets amortized against real CPU work.
`examples/chunked-map.ts` demonstrates this end to end (and, as a bonus,
why it uses `goModuleFn()` rather than `go()`: the chunk-processing function
calls a sibling helper function, which `go()`'s `toString()`-based
reconstruction can't see).

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
bun run examples/chunked-map.ts
```
