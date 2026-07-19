// Same-thread producer/consumer coordination via a channel.
// Run with: bun run examples/pipeline.ts
import { Channel } from "../src/index.ts";

async function producer(ch: Channel<number>) {
  for (let i = 0; i < 5; i++) {
    console.log("send", i);
    await ch.send(i);
  }
  ch.close();
}

async function consumer(ch: Channel<number>) {
  for await (const value of ch) {
    console.log("recv", value);
  }
}

const ch = new Channel<number>(2);
await Promise.all([producer(ch), consumer(ch)]);
