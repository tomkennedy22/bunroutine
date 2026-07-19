import { ChannelClosedError } from "./errors.ts";

interface SendWaiter<T> {
  value: T;
  resolve: () => void;
  reject: (err: unknown) => void;
}

type Receiver<T> = (result: IteratorResult<T>) => void;

/**
 * A Go-style channel for coordinating async work *within a single thread*.
 * This is not a cross-thread primitive — values live in this JS heap, so a
 * Channel cannot be shared with a worker spawned via `go()`. Use it to
 * coordinate concurrently-running promises/async functions on one thread,
 * the same way Go code coordinates goroutines that happen to share an OS
 * thread.
 */
export class Channel<T> {
  readonly #capacity: number;
  #buffer: T[] = [];
  #closed = false;
  #sendWaiters: SendWaiter<T>[] = [];
  #recvWaiters: Receiver<T>[] = [];

  constructor(capacity = 0) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError("bunroutine: channel capacity must be >= 0");
    }
    this.#capacity = capacity;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Number of buffered values not yet received. */
  get length(): number {
    return this.#buffer.length;
  }

  /**
   * Sends a value. Resolves once the value has been buffered or handed to a
   * waiting receiver. For an unbuffered channel (capacity 0) this only
   * resolves once a receiver actually takes the value (rendezvous).
   */
  send(value: T): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new ChannelClosedError("bunroutine: send on closed channel"));
    }
    const receiver = this.#recvWaiters.shift();
    if (receiver) {
      receiver({ value, done: false });
      return Promise.resolve();
    }
    if (this.#buffer.length < this.#capacity) {
      this.#buffer.push(value);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.#sendWaiters.push({ value, resolve, reject });
    });
  }

  /** Receives a value, waiting if none is available. Resolves `{done: true}` once closed and drained. */
  receive(): Promise<IteratorResult<T>> {
    const ready = this.tryReceive();
    if (ready) return Promise.resolve(ready);
    if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise<IteratorResult<T>>((resolve) => {
      this.#recvWaiters.push(resolve);
    });
  }

  /** Non-blocking receive. Returns `undefined` if nothing is available right now. */
  tryReceive(): IteratorResult<T> | undefined {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift()!;
      const waiter = this.#sendWaiters.shift();
      if (waiter) {
        this.#buffer.push(waiter.value);
        waiter.resolve();
      }
      return { value, done: false };
    }
    const waiter = this.#sendWaiters.shift();
    if (waiter) {
      waiter.resolve();
      return { value: waiter.value, done: false };
    }
    if (this.#closed) {
      return { value: undefined as never, done: true };
    }
    return undefined;
  }

  /**
   * Closes the channel. Buffered values already sent may still be received;
   * any goroutine blocked on `send()` is rejected, and blocked receivers
   * resolve with `{done: true}`.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const recvWaiters = this.#recvWaiters.splice(0);
    for (const resolve of recvWaiters) {
      resolve({ value: undefined as never, done: true });
    }
    const sendWaiters = this.#sendWaiters.splice(0);
    for (const waiter of sendWaiters) {
      waiter.reject(new ChannelClosedError("bunroutine: channel closed while send was pending"));
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const result = await this.receive();
      if (result.done) return;
      yield result.value;
    }
  }

  /**
   * @internal Registers a cancellable receive used by `select()`. Not part
   * of the public API — prefer `receive()`/`tryReceive()`.
   */
  _waitReceive(): { promise: Promise<IteratorResult<T>>; cancel: () => void } {
    let deliver!: Receiver<T>;
    const promise = new Promise<IteratorResult<T>>((resolve) => {
      deliver = resolve;
    });
    this.#recvWaiters.push(deliver);
    const cancel = () => {
      const idx = this.#recvWaiters.indexOf(deliver);
      if (idx !== -1) this.#recvWaiters.splice(idx, 1);
    };
    return { promise, cancel };
  }
}
