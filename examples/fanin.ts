// Combines both concurrency models: go() farms CPU-bound work out to real
// worker threads, while a Channel + select() coordinate the results back on
// the main thread — mirroring how Go code mixes goroutines and channels.
// Run with: bun run examples/fanin.ts
import { go, shutdown, Channel, select, WaitGroup } from "../src/index.ts";

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}

const candidates = Array.from({ length: 12 }, (_, i) => 1_000_003 + i * 2);

const primes = new Channel<number>(4);
const done = new Channel<number>();
const wg = new WaitGroup();

for (const n of candidates) {
  wg.add(1);
  void go(isPrime, n).then((prime) => {
    if (prime) void primes.send(n);
    wg.done();
  });
}

void wg.wait().then(() => done.send(-1));

while (true) {
  const result = await select([primes, done]);
  if (result.done || result.index === 1) break;
  console.log("prime:", result.value);
}

await shutdown();
