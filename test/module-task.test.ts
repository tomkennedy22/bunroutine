import { test, expect } from "bun:test";
import { WorkerPool } from "../src/pool.ts";

const tasksModule = import.meta.resolve("./fixtures/tasks.ts");
type TasksModule = typeof import("./fixtures/tasks.ts");

test("runModule() imports a module in the worker and calls the named export", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    const result = await pool.runModule<TasksModule, "double">(tasksModule, "double", 21);
    expect(result).toBe(42);
  } finally {
    await pool.destroy();
  }
});

test("runModule() awaits an async export", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    const result = await pool.runModule<TasksModule, "delayedSum">(
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
    await expect(pool.runModule<TasksModule, "boom">(tasksModule, "boom")).rejects.toThrow(
      "module task failure",
    );
  } finally {
    await pool.destroy();
  }
});

test("runModule() rejects at runtime for a nonexistent export (bypassing the type check to exercise the runtime safety net)", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    await expect(
      // @ts-expect-error — "doesNotExist" isn't a real export; a correctly-typed call
      // can't reach this state, so we bypass the check to verify the worker still
      // fails clearly at runtime rather than hanging or crashing silently.
      pool.runModule<TasksModule, "doesNotExist">(tasksModule, "doesNotExist"),
    ).rejects.toThrow();
  } finally {
    await pool.destroy();
  }
});
