import { WorkerPool, type WorkerPoolOptions } from "./pool.ts";

export { WorkerPool } from "./pool.ts";
export type { WorkerPoolOptions } from "./pool.ts";
export { Channel } from "./channel.ts";
export { select } from "./select.ts";
export type { SelectResult } from "./select.ts";
export { WaitGroup, Mutex } from "./sync.ts";
export { PanicError, ChannelClosedError } from "./errors.ts";

let defaultPool: WorkerPool | undefined;

function defaultPoolInstance(): WorkerPool {
  return (defaultPool ??= new WorkerPool());
}

/**
 * Runs `fn(...args)` on a worker thread from the shared default pool and
 * returns a promise for its result — the closest analogue here to Go's
 * `go func(){ ... }()`, except this always runs on a real OS thread and
 * `fn` cannot close over outer variables (see README).
 */
export function go<Args extends unknown[], R>(
  fn: (...args: Args) => R | Promise<R>,
  ...args: Args
): Promise<R> {
  return defaultPoolInstance().run(fn, ...args);
}

/**
 * Replaces the default pool used by `go()` with one of the given size.
 * Must be called before the first `go()` call.
 */
export function setPoolSize(size: number): void {
  if (defaultPool) {
    throw new Error(
      "bunroutine: default pool already in use; construct a WorkerPool explicitly instead",
    );
  }
  defaultPool = new WorkerPool({ size } satisfies WorkerPoolOptions);
}

/** Terminates the shared default pool, if one has been created. */
export async function shutdown(): Promise<void> {
  if (!defaultPool) return;
  const pool = defaultPool;
  defaultPool = undefined;
  await pool.destroy();
}
