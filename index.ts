// Quick smoke test — run with `bun run index.ts`.
// For real usage, import from "./src/index.ts" (or the package name once published).
import { go, Channel, WaitGroup, shutdown } from "./src/index.ts";

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}

const wg = new WaitGroup();
const results = new Channel<number>(4);

const candidates = [1_299_709, 1_299_721, 1_299_743, 15_485_863];
for (const n of candidates) {
  wg.add(1);
  go(isPrime, n).then((prime) => {
    if (prime) results.send(n);
    wg.done();
  });
}

wg.wait().then(() => results.close());

console.log("primes found on worker threads:");
for await (const prime of results) {
  console.log(" -", prime);
}

// Worker threads keep the process alive until terminated.
await shutdown();
