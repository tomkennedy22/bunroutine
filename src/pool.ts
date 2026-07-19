import os from "node:os";
import { serializeTask } from "./task.ts";
import { PanicError } from "./errors.ts";

interface PendingTask {
  source: string;
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
    if (this.#destroyed) {
      return Promise.reject(new Error("bunroutine: pool is destroyed"));
    }
    const { source } = serializeTask(fn);
    return new Promise<R>((resolve, reject) => {
      const task: PendingTask = { source, args, resolve, reject };
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
    const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
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
    slot.worker.postMessage({ id, source: task.source, args: task.args });
  }
}

function defaultPoolSize(): number {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  if (nav?.hardwareConcurrency) return nav.hardwareConcurrency;
  const osAny = os as unknown as { availableParallelism?: () => number };
  return osAny.availableParallelism ? osAny.availableParallelism() : os.cpus().length;
}
