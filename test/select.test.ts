import { test, expect } from "bun:test";
import { Channel } from "../src/channel.ts";
import { select } from "../src/select.ts";

test("select resolves immediately with a channel that already has a value", async () => {
  const a = new Channel<string>(1);
  const b = new Channel<string>(1);
  await b.send("from b");
  const result = await select([a, b]);
  expect(result).toEqual({ done: false, index: 1, value: "from b" });
});

test("select blocks until one of the channels becomes ready", async () => {
  const a = new Channel<string>();
  const b = new Channel<string>();
  const resultPromise = select([a, b]);
  await new Promise((r) => setTimeout(r, 5));
  await b.send("later");
  const result = await resultPromise;
  expect(result).toEqual({ done: false, index: 1, value: "later" });
});

test("select cancels its registration on the channel that didn't win", async () => {
  const a = new Channel<string>();
  const b = new Channel<string>();
  const first = select([a, b]);
  await new Promise((r) => setTimeout(r, 5));
  await b.send("first winner");
  await first;

  // `a` should have no lingering waiter from the previous select. `a` is
  // unbuffered, so send() won't resolve until select() below registers a
  // receiver — run them concurrently rather than awaiting the send first.
  const sendPromise = a.send("second value");
  const second = await select([a, b]);
  await sendPromise;
  expect(second).toEqual({ done: false, index: 0, value: "second value" });
});

test("select reports a closed channel", async () => {
  const a = new Channel<string>();
  a.close();
  const result = await select([a]);
  expect(result).toEqual({ done: true, index: -1 });
});
