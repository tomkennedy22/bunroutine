import { WorkerPool, type WorkerPoolOptions, type ModuleTaskNames, type ModuleTaskFn } from "./pool.ts";

export { WorkerPool } from "./pool.ts";
export type { WorkerPoolOptions, ModuleTaskNames, ModuleTaskFn } from "./pool.ts";
export { Channel } from "./channel.ts";
export { select } from "./select.ts";
export type { SelectResult } from "./select.ts";
export { WaitGroup, Mutex } from "./sync.ts";
export { SharedMutex } from "./shared-mutex.ts";
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
 * Runs the export named `exportName` from the module at `specifier` on the
 * shared default pool, passing `args`. A closure-free alternative to `go()`
 * for tasks that need to reference outer state — define the task as a
 * top-level export in its own module instead of an inline function.
 *
 * Supply `M` explicitly as `typeof import("./tasks.ts")` (a type-only
 * import, erased at runtime) so `exportName`, `args`, and the return type
 * are all checked against that module's real exports instead of hand-typed:
 *
 * ```ts
 * const result = await goModule<typeof import("./tasks.ts"), "double">(
 *   import.meta.resolve("./tasks.ts"),
 *   "double",
 *   21,
 * );
 * ```
 *
 * See `WorkerPool.runModule` for the full explanation, including the one
 * thing this can't check: that the type-level path and the runtime
 * `specifier` agree on which file they mean.
 */
export function goModule<M, K extends ModuleTaskNames<M> & string>(
  specifier: string | URL,
  exportName: K,
  ...args: Parameters<ModuleTaskFn<M, K>>
): Promise<Awaited<ReturnType<ModuleTaskFn<M, K>>>> {
  return defaultPoolInstance().runModule<M, K>(specifier, exportName, ...args);
}

/**
 * Binds `M` (`typeof import("./tasks.ts")`) and `specifier` once, returning
 * a `.run(exportName, ...args)` you can call repeatedly without repeating
 * either — `exportName` is then inferred from that one call instead of
 * being written out as an explicit type argument each time:
 *
 * ```ts
 * const tasks = moduleTasks<typeof import("./tasks.ts")>(
 *   import.meta.resolve("./tasks.ts"),
 * );
 * const a = await tasks.run("double", 21);
 * const b = await tasks.run("delayedSum", 2, 3);
 * ```
 *
 * `specifier` still has to be written twice across the two calls above (once
 * in the type argument, once at runtime) — that part isn't avoidable.
 * TypeScript requires a literal string directly in a `typeof import(...)`
 * position, even behind a generic type parameter, so there's no way to
 * derive the type-only import from a runtime value. This only removes the
 * *export name* duplication, not the path duplication.
 */
export function moduleTasks<M>(specifier: string | URL) {
  return {
    run<K extends ModuleTaskNames<M> & string>(
      exportName: K,
      ...args: Parameters<ModuleTaskFn<M, K>>
    ): Promise<Awaited<ReturnType<ModuleTaskFn<M, K>>>> {
      return goModule<M, K>(specifier, exportName, ...args);
    },
  };
}

/**
 * Like `goModule()`, but instead of a string `exportName` plus manually
 * supplied `M`/`K` type arguments, pass the already-imported function
 * itself — a real import, so the module loads on the calling side too, not
 * just inside the worker:
 *
 * ```ts
 * import { double } from "./tasks.ts";
 * const result = await goModuleFn(double, import.meta.resolve("./tasks.ts"), 21);
 * ```
 *
 * No type arguments needed — `Fn` is inferred from `fn`, and the export
 * name dispatched to the worker is `fn.name` (which survives a renamed
 * import: `import { double as d }` still has `d.name === "double"`). See
 * `WorkerPool.runModuleFn` for the failure mode on unnamed/bound functions,
 * and for the one thing this still can't check: that `specifier` really
 * points at the module `fn` came from.
 */
export function goModuleFn<Fn extends (...args: any[]) => any>(
  fn: Fn,
  specifier: string | URL,
  ...args: Parameters<Fn>
): Promise<Awaited<ReturnType<Fn>>> {
  return defaultPoolInstance().runModuleFn(fn, specifier, ...args);
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
