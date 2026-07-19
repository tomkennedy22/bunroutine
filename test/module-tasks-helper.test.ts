import { test, expect, afterAll } from "bun:test";
import { moduleTasks, shutdown } from "../src/index.ts";

type TasksModule = typeof import("./fixtures/tasks.ts");

const tasks = moduleTasks<TasksModule>(import.meta.resolve("./fixtures/tasks.ts"));

test("moduleTasks() binds the module + specifier once and infers exportName per call", async () => {
  expect(await tasks.run("double", 21)).toBe(42);
  expect(await tasks.run("delayedSum", 2, 3)).toBe(5);
});

test("moduleTasks() still propagates a thrown error", async () => {
  await expect(tasks.run("boom")).rejects.toThrow("module task failure");
});

afterAll(async () => {
  await shutdown();
});
