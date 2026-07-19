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
  index.ts     public API: go(), setPoolSize(), shutdown()
  pool.ts      WorkerPool — spawns and schedules Bun Worker threads
  worker.ts    code that runs inside each worker thread
  task.ts      function -> source-string serialization for go()
  channel.ts   Channel<T> — buffered/unbuffered, same-thread only
  select.ts    select() — race multiple channel receives
  sync.ts      WaitGroup, Mutex — same-thread only
  errors.ts    PanicError, ChannelClosedError
examples/      runnable demos (bun run examples/<name>.ts)
test/          bun:test suite
```

## API

- **`go(fn, ...args)`** — runs `fn(...args)` on the shared default worker
  pool, returns a `Promise` of the result. Closest analogue to `go func(){}()`.
- **`new WorkerPool({ size })`** — an explicit pool (default size is the
  machine's available parallelism) with `.run(fn, ...args)`, `.size`,
  `.queued`, `.destroy()`.
- **`new Channel<T>(capacity = 0)`** — `send`, `receive`, `tryReceive`,
  `close`, async-iterable. Capacity 0 is a Go-style unbuffered/rendezvous
  channel.
- **`select(channels)`** — resolves `{ done: false, index, value }` for
  whichever channel produces a value first, or `{ done: true, index: -1 }`
  if one is closed and drained.
- **`new WaitGroup()`** — `add(n)`, `done()`, `wait()`.
- **`new Mutex()`** — `lock()` returns a release function; `withLock(fn)`
  runs `fn` while held.

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

The honest long-term fix is a second, non-inline way to define worker
tasks: point `go()` at an exported function in its own module (`import()`
it inside the worker) instead of relying on `toString`/`eval`. That's more
verbose — no more inline closures — but has none of the free-variable or
minifier failure modes. Worth adding as an opt-in `goModule(url, exportName, ...args)`
once the toString-based path's limits become a real pain point.

**No shared memory across `go()` calls.** Every argument and return value is
structured-cloned. Fine for typical task payloads; a serialization tax for
large buffers. `SharedArrayBuffer` + `Atomics` would let two threads see the
same bytes, which is the real prerequisite for a cross-thread `Channel` or
`Mutex` — not yet implemented. Whether Bun's JSC supports `Atomics.waitAsync`
(needed for a non-blocking cross-thread wait) needs to be checked before
building that.

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

- [ ] `goModule()` — module-reference-based task dispatch as a robust
      alternative to `toString`/`eval` for anything that needs closures.
- [ ] Cross-thread `Channel`/`Mutex` backed by `SharedArrayBuffer` + `Atomics`
      (pending an `Atomics.waitAsync` feasibility check on Bun/JSC).
- [ ] Cancellation via `AbortSignal`, tearing down the specific worker.
- [ ] Least-busy or work-stealing dispatch instead of "first idle slot,
      else FIFO queue" — matters once tasks have very uneven cost.
- [ ] Benchmarks comparing `go()` throughput/latency against a plain
      `Promise.all` baseline and against Node's `worker_threads` pool
      libraries (Piscina, workerpool), across a range of task sizes.
- [ ] `.d.ts` build output / publish to npm — currently intended for direct
      TS import (`"module"`/`"types"` both point at `src/index.ts`).

## Development

```sh
bun install
bun test               # run the test suite
bun run typecheck      # tsc --noEmit
bun run examples/fibonacci.ts
bun run examples/pipeline.ts
bun run examples/fanin.ts
```
