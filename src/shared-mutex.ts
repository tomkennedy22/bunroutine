const UNLOCKED = 0;
const LOCKED = 1;

/**
 * A mutex that provides real mutual exclusion *across OS threads*, not just
 * within one — unlike `Mutex`, which only coordinates same-thread async
 * code. Backed by a `SharedArrayBuffer` and `Atomics`, so the lock state is
 * literally the same memory on every thread that holds a reference to it.
 *
 * To share one across threads, pass `.buffer` through `go()`/`WorkerPool`
 * (a `SharedArrayBuffer` is shared by reference over `postMessage`, not
 * copied) and reconstruct it on the other side with `new SharedMutex(buffer)`:
 *
 * ```ts
 * const mutex = new SharedMutex();
 * await go((buffer: SharedArrayBuffer) => {
 *   const mutex = new SharedMutex(buffer);
 *   return mutex.withLock(() => { ... });
 * }, mutex.buffer);
 * ```
 */
export class SharedMutex {
  readonly buffer: SharedArrayBuffer;
  readonly #state: Int32Array;

  constructor(buffer: SharedArrayBuffer = new SharedArrayBuffer(4)) {
    if (buffer.byteLength < 4) {
      throw new RangeError("bunroutine: SharedMutex buffer must be at least 4 bytes");
    }
    this.buffer = buffer;
    this.#state = new Int32Array(buffer);
  }

  /** Acquires the lock, waiting (without blocking the event loop) if another thread holds it. */
  async lock(): Promise<() => void> {
    while (Atomics.compareExchange(this.#state, 0, UNLOCKED, LOCKED) !== UNLOCKED) {
      const wait = Atomics.waitAsync(this.#state, 0, LOCKED);
      if (wait.async) await wait.value;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      Atomics.store(this.#state, 0, UNLOCKED);
      Atomics.notify(this.#state, 0, 1);
    };
  }

  /** Runs `fn` while holding the lock, releasing it even if `fn` throws. */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const unlock = await this.lock();
    try {
      return await fn();
    } finally {
      unlock();
    }
  }
}
