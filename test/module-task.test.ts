import { test, expect } from "bun:test";
import { WorkerPool } from "../src/pool.ts";

const tasksModule = new URL("./fixtures/tasks.ts", import.meta.url);

test("runModule() imports a module in the worker and calls the named export", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    const result = await pool.runModule<[number], number>(tasksModule, "double", 21);
    expect(result).toBe(42);
  } finally {
    await pool.destroy();
  }
});

test("runModule() awaits an async export", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    const result = await pool.runModule<[number, number], number>(
      tasksModule,
      "delayedSum",
      2,
      3,
    );
    expect(result).toBe(5);
  } finally {
    await pool.destroy();
  }
});

test("runModule() propagates a thrown error as a PanicError", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    await expect(pool.runModule(tasksModule, "boom")).rejects.toThrow("module task failure");
  } finally {
    await pool.destroy();
  }
});

test("runModule() rejects when the named export doesn't exist", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    await expect(pool.runModule(tasksModule, "doesNotExist")).rejects.toThrow();
  } finally {
    await pool.destroy();
  }
});
