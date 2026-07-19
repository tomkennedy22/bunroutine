import { test, expect } from "bun:test";
import { WaitGroup, Mutex } from "../src/sync.ts";

test("WaitGroup.wait() resolves once every done() has been called", async () => {
  const wg = new WaitGroup();
  wg.add(3);
  const order: number[] = [];
  setTimeout(() => {
    order.push(1);
    wg.done();
  }, 5);
  setTimeout(() => {
    order.push(2);
    wg.done();
  }, 10);
  setTimeout(() => {
    order.push(3);
    wg.done();
  }, 15);
  await wg.wait();
  expect(order).toEqual([1, 2, 3]);
});

test("WaitGroup.wait() resolves immediately at zero", async () => {
  const wg = new WaitGroup();
  await wg.wait();
  expect(true).toBe(true);
});

test("WaitGroup throws if the counter goes negative", () => {
  const wg = new WaitGroup();
  expect(() => wg.done()).toThrow();
});

test("Mutex enforces exclusive access across concurrent critical sections", async () => {
  const mutex = new Mutex();
  let active = 0;
  let maxActive = 0;

  async function critical() {
    return mutex.withLock(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
  }

  await Promise.all([critical(), critical(), critical()]);
  expect(maxActive).toBe(1);
});
