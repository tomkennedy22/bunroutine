import { test, expect } from "bun:test";
import { SharedMutex } from "../src/shared-mutex.ts";

test("same-thread mutual exclusion", async () => {
  const mutex = new SharedMutex();
  let active = 0;
  let maxActive = 0;

  async function critical() {
    await mutex.withLock(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
  }

  await Promise.all([critical(), critical(), critical()]);
  expect(maxActive).toBe(1);
});

test("real cross-thread mutual exclusion across two worker threads", async () => {
  const mutex = new SharedMutex();
  const counterBuffer = new SharedArrayBuffer(4);
  const iterations = 500;

  const worker1 = new Worker(import.meta.resolve("./fixtures/shared-mutex-worker.ts"));
  const worker2 = new Worker(import.meta.resolve("./fixtures/shared-mutex-worker.ts"));

  const done1 = new Promise<void>((resolve) => {
    worker1.onmessage = () => resolve();
  });
  const done2 = new Promise<void>((resolve) => {
    worker2.onmessage = () => resolve();
  });

  worker1.postMessage({ mutexBuffer: mutex.buffer, counterBuffer, iterations });
  worker2.postMessage({ mutexBuffer: mutex.buffer, counterBuffer, iterations });

  await Promise.all([done1, done2]);
  worker1.terminate();
  worker2.terminate();

  // Without real cross-thread exclusion, interleaved read-modify-write
  // races would lose increments and this would land below 1000.
  const counter = new Int32Array(counterBuffer);
  expect(counter[0]).toBe(iterations * 2);
});
