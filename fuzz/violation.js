// What the fuzz targets share. A target asserts a contract by throwing a Violation; the code under
// test refuses what it cannot read by throwing a plain Error, which a target may accept. The two
// must never be confused, or an assertion that fires inside a try block is swallowed as a refusal
// and the run reports success. `attempt` is how a target calls code that may refuse: it catches
// only the code's own refusal, and the target asserts on the outcome outside any catch.
export class Violation extends Error {}

export function fail(msg) {
  throw new Violation(msg);
}

/**
 * Whether a thrown value is a documented refusal: a plain Error, or an instance of one of the
 * `also` classes whose exact constructor the code is documented to throw. Never a Violation, and
 * never a TypeError or RangeError, which are defects in the code under test.
 */
export function isRefusal(e, also = []) {
  return e instanceof Error && (e.constructor === Error || also.includes(e.constructor));
}

/** Runs `fn`: { value } when it returns, { refused } when it throws a refusal, else rethrows. */
export function attempt(fn, also = []) {
  try {
    return { value: fn() };
  } catch (e) {
    if (!isRefusal(e, also)) throw e;
    return { refused: e };
  }
}
