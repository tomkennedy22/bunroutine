export class PanicError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "PanicError";
  }
}

export class ChannelClosedError extends Error {
  constructor(message = "bunroutine: operation on a closed channel") {
    super(message);
    this.name = "ChannelClosedError";
  }
}
