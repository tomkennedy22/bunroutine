/// <reference lib="webworker" />

interface ClosureTaskMessage {
  id: number;
  kind: "closure";
  source: string;
  args: unknown[];
}

interface ModuleTaskMessage {
  id: number;
  kind: "module";
  specifier: string;
  exportName: string;
  args: unknown[];
}

type TaskMessage = ClosureTaskMessage | ModuleTaskMessage;

interface ErrorPayload {
  name: string;
  message: string;
  stack?: string;
}

function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "Error", message: String(err) };
}

async function resolveTaskFn(message: TaskMessage): Promise<(...args: unknown[]) => unknown> {
  if (message.kind === "module") {
    const mod = await import(message.specifier);
    const fn = mod[message.exportName];
    if (typeof fn !== "function") {
      throw new TypeError(
        `bunroutine: module "${message.specifier}" has no exported function "${message.exportName}"`,
      );
    }
    return fn as (...args: unknown[]) => unknown;
  }
  // Reconstruct the function from source in this worker's isolated global
  // scope. Indirect eval so it can't see this file's local bindings either.
  return (0, eval)(`(${message.source})`) as (...args: unknown[]) => unknown;
}

self.onmessage = async (event: MessageEvent<TaskMessage>) => {
  const message = event.data;
  try {
    const fn = await resolveTaskFn(message);
    const value = await fn(...message.args);
    postMessage({ id: message.id, ok: true, value });
  } catch (err) {
    postMessage({ id: message.id, ok: false, error: toErrorPayload(err) });
  }
};
