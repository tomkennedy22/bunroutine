export interface SerializedTask {
  source: string;
}

/**
 * Turns a function into a source string that a worker thread can reconstruct
 * with `eval`. This only works for functions that don't close over outer
 * scope (they may only reference their own parameters, globals, and — for
 * named function declarations/expressions — themselves, since a named
 * function expression's own name binding survives re-parsing).
 */
export function serializeTask<Args extends unknown[], R>(
  fn: (...args: Args) => R | Promise<R>,
): SerializedTask {
  if (typeof fn !== "function") {
    throw new TypeError("bunroutine: go() requires a function");
  }
  const source = fn.toString();
  if (source.includes("[native code]")) {
    throw new TypeError(
      "bunroutine: cannot run native or bound functions in a worker thread",
    );
  }
  if (/^class\s/.test(source)) {
    throw new TypeError("bunroutine: cannot run a class in a worker thread");
  }
  return { source };
}
