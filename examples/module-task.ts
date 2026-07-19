// Closure-free task dispatch: the worker imports the module itself instead
// of reconstructing a function from source, so there's no free-variable
// landmine — at the cost of the task living in its own file.
// Run with: bun run examples/module-task.ts
import { goModule, shutdown } from "../src/index.ts";

const result = await goModule<[number], number>(
  new URL("./fixtures/double.ts", import.meta.url),
  "double",
  21,
);
console.log("double(21) computed in a worker via goModule():", result);

await shutdown();
