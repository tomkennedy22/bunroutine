/**
 * Same-thread equivalent of Go's `sync.WaitGroup`: block until a counter of
 * outstanding goroutines drops back to zero.
 */
export class WaitGroup {
  #count = 0;
  #waiters: Array<() => void> = [];

  /** Increments (or decrements, with a negative `n`) the outstanding count. */
  add(n = 1): void {
    this.#count += n;
    if (this.#count < 0) {
      throw new Error("bunroutine: WaitGroup counter went negative");
    }
    if (this.#count === 0) {
      const waiters = this.#waiters.splice(0);
      for (const wake of waiters) wake();
    }
  }

  /** Marks one unit of work as done. Equivalent to `add(-1)`. */
  done(): void {
    this.add(-1);
  }

  /** Resolves once the counter returns to zero. */
  wait(): Promise<void> {
    if (this.#count === 0) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

/**
 * Same-thread mutual exclusion lock. There is no OS-thread-crossing
 * equivalent yet — see README's roadmap on `Atomics`-backed cross-thread
 * locks.
 */
export class Mutex {
  #locked = false;
  #waiters: Array<() => void> = [];

  /** Acquires the lock, returning a release function. Always call it exactly once, typically in a `finally`. */
  async lock(): Promise<() => void> {
    if (this.#locked) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    } else {
      this.#locked = true;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#locked = false;
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
