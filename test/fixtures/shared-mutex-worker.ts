/// <reference lib="webworker" />
import { SharedMutex } from "../../src/shared-mutex.ts";

interface Payload {
  mutexBuffer: SharedArrayBuffer;
  counterBuffer: SharedArrayBuffer;
  iterations: number;
}

self.onmessage = async (event: MessageEvent<Payload>) => {
  const { mutexBuffer, counterBuffer, iterations } = event.data;
  const mutex = new SharedMutex(mutexBuffer);
  const counter = new Int32Array(counterBuffer);

  for (let i = 0; i < iterations; i++) {
    await mutex.withLock(() => {
      const current = Atomics.load(counter, 0);
      Atomics.store(counter, 0, current + 1);
    });
  }

  postMessage({ done: true });
};
