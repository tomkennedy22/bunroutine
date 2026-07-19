import { test, expect } from "bun:test";
import { WorkerPool } from "../src/pool.ts";
import { double, delayedSum, boom } from "./fixtures/tasks.ts";
import { double as renamedDouble } from "./fixtures/tasks.ts";

const tasksModule = import.meta.resolve("./fixtures/tasks.ts");

test("runModuleFn() infers Fn from the function and dispatches by fn.name", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    const result = await pool.runModuleFn(double, tasksModule, 21);
    expect(result).toBe(42);
  } finally {
    await pool.destroy();
  }
});

test("runModuleFn() awaits an async export", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    const result = await pool.runModuleFn(delayedSum, tasksModule, 2, 3);
    expect(result).toBe(5);
  } finally {
    await pool.destroy();
  }
});

test("runModuleFn() propagates a thrown error", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    await expect(pool.runModuleFn(boom, tasksModule)).rejects.toThrow("module task failure");
  } finally {
    await pool.destroy();
  }
});

test("runModuleFn() dispatches by the export's original name, even through a renamed import", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    expect(renamedDouble.name).toBe("double");
    const result = await pool.runModuleFn(renamedDouble, tasksModule, 10);
    expect(result).toBe(20);
  } finally {
    await pool.destroy();
  }
});

test("runModuleFn() fails clearly (not silently) for a bound function's mangled name", async () => {
  const pool = new WorkerPool({ size: 1 });
  try {
    const bound = double.bind(null);
    expect(bound.name).toBe("bound double"); // not a real export — should fail, not silently misdispatch
    await expect(pool.runModuleFn(bound, tasksModule, 1)).rejects.toThrow(
      /has no exported function "bound double"/,
    );
  } finally {
    await pool.destroy();
  }
});

test("runModuleFn() throws synchronously for a truly anonymous function", async () => {
  const pool = new WorkerPool({ size: 1 });
  // An array literal is one of the few contexts JS won't infer a name for —
  // no variable assignment to infer from, so .name is genuinely "".
  const [anonymous] = [
    function (n: number) {
      return n;
    },
  ];
  expect(anonymous.name).toBe("");
  expect(() => pool.runModuleFn(anonymous, tasksModule, 1)).toThrow(/requires a named function/);
  await pool.destroy();
});
