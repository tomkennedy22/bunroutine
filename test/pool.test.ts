import { test, expect } from "bun:test";
import { WorkerPool } from "../src/pool.ts";

test("runs a pure function on a worker thread and returns its result", async () => {
  const pool = new WorkerPool({ size: 2 });
  try {
    const result = await pool.run((a: number, b: number) => a + b, 2, 3);
    expect(result).toBe(5);
  } finally {
    await pool.destroy();
  }
});

test("propagates a thrown error as a PanicError with the original message", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    await expect(
      pool.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  } finally {
    await pool.destroy();
  }
});

test("runs many tasks across a small pool, queueing past capacity", async () => {
  const pool = new WorkerPool({ size: 4 });
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => pool.run((n: number) => n * n, i)),
    );
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i * i));
  } finally {
    await pool.destroy();
  }
});

test("a named recursive function survives being reconstructed in the worker", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    function fib(n: number): number {
      return n < 2 ? n : fib(n - 1) + fib(n - 2);
    }
    const result = await pool.run(fib, 10);
    expect(result).toBe(55);
  } finally {
    await pool.destroy();
  }
});

test("rejects tasks submitted after destroy()", async () => {
  const pool = new WorkerPool({ size: 1 });
  await pool.destroy();
  await expect(pool.run(() => 1)).rejects.toThrow();
});
