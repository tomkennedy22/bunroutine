// Parallel CPU-bound work across real OS threads.
// Run with: bun run examples/fibonacci.ts
import { go, shutdown } from "../src/index.ts";

// A named function declaration: it can recurse by its own name even after
// being reconstructed from source in the worker, because a named function's
// self-binding doesn't depend on the outer closure. Arrow functions can't do
// this — see README.
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

// const inputs = [44,43,42,41,40,39,38, 37, 36, 35,34,33,32,31,30,29,28,27,26,25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3];
const inputs = [44,44,44,44,44,44,44,44];


console.time("parallel (worker pool)");
const parallel = await Promise.all(inputs.map((n) => go(fib, n)));
console.timeEnd("parallel (worker pool)");
console.log(parallel);

console.time("sequential (main thread)");
const sequential = inputs.map(fib);
console.timeEnd("sequential (main thread)");
console.log(sequential);

await shutdown();
