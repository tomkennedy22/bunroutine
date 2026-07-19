export interface SerializedTask {
  source: string;
}

const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ANONYMOUS_FUNCTION_HEAD = /^(async\s+)?function(\s*\*)?\s*\(/;

/**
 * Turns a function into a source string that a worker thread can reconstruct
 * with `eval`. This only works for functions that don't close over outer
 * scope (they may only reference their own parameters, globals, and — for
 * named functions — themselves, since a named function's own binding
 * survives re-parsing).
 *
 * One subtlety this repairs: a `function` declared inside a block (e.g.
 * inside `try { }`) gets compiled to something like `var fib; { fib =
 * function(n) { ... } }`, so `fn.toString()` returns the *anonymous*
 * `function(n) { ... }` literal — the name lives on the outer binding, not
 * in the source text. Reconstructing that in a worker would silently break
 * self-recursion (`fib is not defined`), so if `fn.name` is missing from the
 * source we splice it back in.
 */
export function serializeTask<Args extends unknown[], R>(
  fn: (...args: Args) => R | Promise<R>,
): SerializedTask {
  if (typeof fn !== "function") {
    throw new TypeError("bunroutine: go() requires a function");
  }
  let source = fn.toString();
  if (source.includes("[native code]")) {
    throw new TypeError(
      "bunroutine: cannot run native or bound functions in a worker thread",
    );
  }
  if (/^class\s/.test(source)) {
    throw new TypeError("bunroutine: cannot run a class in a worker thread");
  }
  if (fn.name && VALID_IDENTIFIER.test(fn.name) && ANONYMOUS_FUNCTION_HEAD.test(source)) {
    source = source.replace(ANONYMOUS_FUNCTION_HEAD, (_match, isAsync = "", isGenerator = "") => {
      return `${isAsync}function${isGenerator} ${fn.name}(`;
    });
  }
  return { source };
}
