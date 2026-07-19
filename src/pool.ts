import os from "node:os";
import { serializeTask } from "./task.ts";
import { PanicError } from "./errors.ts";

type TaskPayload =
  | { kind: "closure"; source: string }
  | { kind: "module"; specifier: string; exportName: string };

interface PendingTask {
  payload: TaskPayload;
  args: unknown[];
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  current?: { resolve: (v: any) => void; reject: (e: unknown) => void };
}

interface WorkerResultMessage {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; stack?: string };
}

let nextTaskId = 0;

/** The exported names of `M` whose value is callable — i.e. usable as a `goModule`/`runModule` task. */
export type ModuleTaskNames<M> = {
  [K in keyof M]: M[K] extends (...args: any[]) => any ? K : never;
}[keyof M];

/** The real function type behind export `K` of module `M`, for deriving `Parameters`/`ReturnType`. */
export type ModuleTaskFn<M, K extends keyof M> = M[K] extends (...args: any[]) => any
  ? M[K]
  : never;

export interface WorkerPoolOptions {
  /** Number of OS threads to keep warm. Defaults to the machine's available parallelism. */
  size?: number;
}

/**
 * A fixed-size pool of real OS threads (Bun `Worker`s) used to run CPU-bound
 * work in parallel. Tasks are plain functions plus structured-cloneable
 * arguments — there is no shared memory or closure capture across the
 * thread boundary. See README for the tradeoffs this implies.
 */
export class WorkerPool {
  #slots: WorkerSlot[] = [];
  #queue: PendingTask[] = [];
  #destroyed = false;

  constructor(options: WorkerPoolOptions = {}) {
    const size = options.size ?? defaultPoolSize();
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError("bunroutine: pool size must be a positive integer");
    }
    for (let i = 0; i < size; i++) {
      this.#slots.push(this.#spawnSlot());
    }
  }

  /** Number of worker threads in the pool. */
  get size(): number {
    return this.#slots.length;
  }

  /** Number of tasks waiting for a free worker thread. */
  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Runs `fn(...args)` on a worker thread and resolves with its return
   * value. `fn` must not close over outer scope — see README for what's
   * safe to pass.
   */
  run<Args extends unknown[], R>(
    fn: (...args: Args) => R | Promise<R>,
    ...args: Args
  ): Promise<R> {
    const { source } = serializeTask(fn);
    return this.#enqueue({ kind: "closure", source }, args);
  }

  /**
   * Runs the export named `exportName` from the module at `specifier`,
   * passing `args`. Unlike `run()`, this never touches `fn.toString()` —
   * the worker just `import()`s the module itself — so there's no
   * closure/free-variable landmine, at the cost of the task having to live
   * in its own module instead of an inline closure. `specifier` must resolve
   * on its own from inside the worker, so pass an absolute URL — the
   * standard way is `import.meta.resolve("./tasks.ts")`.
   *
   * `M` is supplied explicitly as `typeof import("./tasks.ts")` — a
   * type-only import, erased at runtime — so `exportName` is checked
   * against the module's real exports (typo it and it won't compile) and
   * `args`/the return type are derived from that export's actual signature,
   * not hand-asserted. The one thing TypeScript can't verify is that the
   * type-level path in `typeof import(...)` and the runtime `specifier`
   * string point at the same file — keep those two in sync yourself.
   */
  runModule<M, K extends ModuleTaskNames<M> & string>(
    specifier: string | URL,
    exportName: K,
    ...args: Parameters<ModuleTaskFn<M, K>>
  ): Promise<Awaited<ReturnType<ModuleTaskFn<M, K>>>> {
    return this.#enqueue({ kind: "module", specifier: specifier.toString(), exportName }, args);
  }

  /**
   * Like `runModule()`, but instead of naming the export with a string and
   * a manually-supplied `M`/`K`, pass the already-imported function itself
   * — a real (non-type-only) import, so it costs loading the module on the
   * calling side too, not just inside the worker:
   *
   * ```ts
   * import { double } from "./tasks.ts";
   * const result = await pool.runModuleFn(double, import.meta.resolve("./tasks.ts"), 21);
   * ```
   *
   * `Fn` is inferred from `fn` — no type arguments to write — and the
   * export name dispatched to the worker is `fn.name`, which reflects the
   * function's *original* declared name even through a renamed import
   * (`import { double as d }` — `d.name` is still `"double"`). A function
   * without a usable name (anonymous, or wrapped with `.bind()`, which
   * mangles the name to `"bound double"`) fails clearly instead of silently
   * calling the wrong thing. `specifier` still has to be supplied
   * separately and kept in sync with wherever `fn` actually came from —
   * nothing here can check that the two agree.
   */
  runModuleFn<Fn extends (...args: any[]) => any>(
    fn: Fn,
    specifier: string | URL,
    ...args: Parameters<Fn>
  ): Promise<Awaited<ReturnType<Fn>>> {
    if (!fn.name) {
      throw new TypeError(
        "bunroutine: runModuleFn() requires a named function so its .name can be dispatched to the worker",
      );
    }
    return this.#enqueue(
      { kind: "module", specifier: specifier.toString(), exportName: fn.name },
      args,
    );
  }

  #enqueue<R>(payload: TaskPayload, args: unknown[]): Promise<R> {
    if (this.#destroyed) {
      return Promise.reject(new Error("bunroutine: pool is destroyed"));
    }
    return new Promise<R>((resolve, reject) => {
      const task: PendingTask = { payload, args, resolve, reject };
      const idle = this.#slots.find((slot) => !slot.busy);
      if (idle) {
        this.#dispatch(idle, task);
      } else {
        this.#queue.push(task);
      }
    });
  }

  /** Terminates all worker threads. Queued and in-flight tasks are rejected. */
  async destroy(): Promise<void> {
    this.#destroyed = true;
    const stale = this.#queue.splice(0);
    for (const task of stale) {
      task.reject(new Error("bunroutine: pool destroyed before task ran"));
    }
    await Promise.all(this.#slots.map((slot) => slot.worker.terminate()));
  }

  #spawnSlot(): WorkerSlot {
    const worker = new Worker(import.meta.resolve("./worker.ts"));
    const slot: WorkerSlot = { worker, busy: false };

    worker.onmessage = (event: MessageEvent<WorkerResultMessage>) => {
      const { ok, value, error } = event.data;
      const current = slot.current;
      slot.current = undefined;
      slot.busy = false;
      if (current) {
        if (ok) current.resolve(value);
        else current.reject(new PanicError(error!.message, error));
      }
      this.#drain(slot);
    };

    worker.onerror = (event: ErrorEvent) => {
      const current = slot.current;
      slot.current = undefined;
      slot.busy = false;
      if (current) {
        current.reject(new PanicError(event.message ?? "bunroutine: worker error"));
      }
      this.#drain(slot);
    };

    return slot;
  }

  #drain(slot: WorkerSlot): void {
    const next = this.#queue.shift();
    if (next) this.#dispatch(slot, next);
  }

  #dispatch(slot: WorkerSlot, task: PendingTask): void {
    slot.busy = true;
    slot.current = { resolve: task.resolve, reject: task.reject };
    const id = nextTaskId++;
    slot.worker.postMessage({ id, args: task.args, ...task.payload });
  }
}

function defaultPoolSize(): number {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  if (nav?.hardwareConcurrency) return nav.hardwareConcurrency;
  const osAny = os as unknown as { availableParallelism?: () => number };
  return osAny.availableParallelism ? osAny.availableParallelism() : os.cpus().length;
}
