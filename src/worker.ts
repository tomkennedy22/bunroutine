/// <reference lib="webworker" />

interface TaskMessage {
  id: number;
  source: string;
  args: unknown[];
}

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

self.onmessage = async (event: MessageEvent<TaskMessage>) => {
  const { id, source, args } = event.data;
  try {
    // Reconstruct the function from source in this worker's isolated global
    // scope. Indirect eval so it can't see this file's local bindings either.
    const fn = (0, eval)(`(${source})`) as (...a: unknown[]) => unknown;
    const value = await fn(...args);
    postMessage({ id, ok: true, value });
  } catch (err) {
    postMessage({ id, ok: false, error: toErrorPayload(err) });
  }
};
