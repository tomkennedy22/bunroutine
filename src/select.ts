import type { Channel } from "./channel.ts";

export type SelectResult<T> =
  | { done: false; index: number; value: T }
  | { done: true; index: -1 };

/**
 * Waits on multiple channels at once and resolves with whichever one
 * produces a value first — like Go's `select {}` over receive cases.
 *
 * Unlike Go's select, this cannot atomically commit to one case among
 * several that are *simultaneously* ready without first checking each
 * channel in order, so ties are broken by array order rather than
 * randomly. See README for why a fully fair select is hard to build on
 * top of promises.
 */
export async function select<T>(channels: readonly Channel<T>[]): Promise<SelectResult<T>> {
  if (channels.length === 0) {
    throw new RangeError("bunroutine: select() requires at least one channel");
  }

  // Fast path: don't register any waiters if something is already ready.
  for (let i = 0; i < channels.length; i++) {
    const result = channels[i]!.tryReceive();
    if (result) {
      return result.done
        ? { done: true, index: -1 }
        : { done: false, index: i, value: result.value };
    }
  }

  const waits = channels.map((channel) => channel._waitReceive());
  try {
    const { index, result } = await Promise.race(
      waits.map((wait, index) => wait.promise.then((result) => ({ index, result }))),
    );
    return result.done
      ? { done: true, index: -1 }
      : { done: false, index, value: result.value };
  } finally {
    for (const wait of waits) wait.cancel();
  }
}
