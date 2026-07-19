// Closure-free task dispatch: the worker imports the module itself instead
// of reconstructing a function from source, so there's no free-variable
// landmine — at the cost of the task living in its own file.
//
// goModule()'s type argument `typeof import("./fixtures/double.ts")` is a
// type-only import (erased at runtime, zero cost) that checks "double"
// against the module's real exports and derives the argument/return types
// from its actual signature — try renaming `double` in fixtures/double.ts
// or typo-ing the export name below and this won't compile.
//
// Run with: bun run examples/module-task.ts
import { goModule, moduleTasks, goModuleFn, shutdown } from "../src/index.ts";
import { double } from "./fixtures/double.ts";

const single = await goModule<typeof import("./fixtures/double.ts"), "double">(
  import.meta.resolve("./fixtures/double.ts"),
  "double",
  21,
);
console.log("double(21) via goModule():", single);

// moduleTasks() binds the module type + specifier once, so calling multiple
// exports doesn't repeat either — just the export name, inferred per call.
const tasks = moduleTasks<typeof import("./fixtures/double.ts")>(
  import.meta.resolve("./fixtures/double.ts"),
);
console.log("double(21) via moduleTasks():", await tasks.run("double", 21));
console.log("triple(21) via moduleTasks():", await tasks.run("triple", 21));

// goModuleFn() goes further: pass the already-imported function itself.
// No type arguments at all (Fn is inferred from `double`), and no string to
// typo — the export name dispatched to the worker is double.name. The
// tradeoff: `double` is a real import here, so fixtures/double.ts loads on
// this thread too, not just inside the worker (goModule/moduleTasks above
// use a type-only import, so they never load it here at all).
const viaFn = await goModuleFn(double, import.meta.resolve("./fixtures/double.ts"), 21);
console.log("double(21) via goModuleFn():", viaFn);

await shutdown();
