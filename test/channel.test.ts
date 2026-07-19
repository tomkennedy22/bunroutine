import { describe, test, expect } from "bun:test";
import { Channel } from "../src/channel.ts";

describe("Channel", () => {
  test("buffered channel does not block sends until full", async () => {
    const ch = new Channel<number>(2);
    await ch.send(1);
    await ch.send(2);
    expect(await ch.receive()).toEqual({ value: 1, done: false });
    expect(await ch.receive()).toEqual({ value: 2, done: false });
  });

  test("unbuffered channel rendezvous", async () => {
    const ch = new Channel<string>();
    const received: string[] = [];
    const recvPromise = ch.receive().then((r) => {
      if (!r.done) received.push(r.value);
    });
    await ch.send("hello");
    await recvPromise;
    expect(received).toEqual(["hello"]);
  });

  test("close lets buffered values drain, then ends iteration", async () => {
    const ch = new Channel<number>(2);
    await ch.send(1);
    await ch.send(2);
    ch.close();
    const values: number[] = [];
    for await (const v of ch) values.push(v);
    expect(values).toEqual([1, 2]);
  });

  test("send after close rejects", async () => {
    const ch = new Channel<number>();
    ch.close();
    await expect(ch.send(1)).rejects.toThrow();
  });

  test("tryReceive is non-blocking", async () => {
    const ch = new Channel<number>(1);
    expect(ch.tryReceive()).toBeUndefined();
    await ch.send(42);
    expect(ch.tryReceive()).toEqual({ value: 42, done: false });
    expect(ch.tryReceive()).toBeUndefined();
  });

  test("a pending send on an unbuffered channel is fulfilled by a later receive", async () => {
    const ch = new Channel<number>();
    let sent = false;
    const sendPromise = ch.send(7).then(() => {
      sent = true;
    });
    expect(sent).toBe(false);
    const result = await ch.receive();
    await sendPromise;
    expect(result).toEqual({ value: 7, done: false });
    expect(sent).toBe(true);
  });
});
