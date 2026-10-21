/**
 * Unit tests for Result<T, E>/Ok/Err (zksoroban#107).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Err, err, Ok, ok, toZkError } from "../src/result";
import { SorobanZkError, SorobanZkErrorCode } from "../src/types";

test("ok() produces an Ok whose isOk()/isErr() report correctly", () => {
  const result = ok(42);
  assert.ok(result instanceof Ok);
  assert.equal(result.isOk(), true);
  assert.equal(result.isErr(), false);
  if (result.isOk()) {
    assert.equal(result.value, 42);
  }
});

test("err() produces an Err whose isOk()/isErr() report correctly", () => {
  const error = new SorobanZkError("boom", SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED);
  const result = err(error);
  assert.ok(result instanceof Err);
  assert.equal(result.isOk(), false);
  assert.equal(result.isErr(), true);
  if (result.isErr()) {
    assert.equal(result.error, error);
  }
});

test("map transforms an Ok's value and passes an Err through unchanged", () => {
  const okResult = ok(2).map((n) => n * 10);
  assert.ok(okResult.isOk());
  assert.equal((okResult as Ok<number, never>).value, 20);

  const error = new SorobanZkError("boom", SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED);
  const errResult = err<SorobanZkError, number>(error).map((n) => n * 10);
  assert.ok(errResult.isErr());
  assert.equal((errResult as Err<number, SorobanZkError>).error, error);
});

test("mapErr transforms an Err's error and passes an Ok through unchanged", () => {
  const error = new SorobanZkError("boom", SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED);
  const errResult = err<SorobanZkError, number>(error).mapErr((e) => e.message);
  assert.ok(errResult.isErr());
  assert.equal((errResult as Err<number, string>).error, "boom");

  const okResult = ok<number, SorobanZkError>(5).mapErr((e) => e.message);
  assert.ok(okResult.isOk());
  assert.equal((okResult as Ok<number, string>).value, 5);
});

test("unwrapOr returns the value for Ok and the fallback for Err", () => {
  assert.equal(ok(1).unwrapOr(99), 1);
  assert.equal(err(new Error("x")).unwrapOr(99), 99);
});

test("match dispatches to the right branch", () => {
  const okOutcome = ok(1).match(
    (v) => `ok:${v}`,
    (e) => `err:${e}`
  );
  assert.equal(okOutcome, "ok:1");

  const errOutcome = err("bad").match(
    (v) => `ok:${v}`,
    (e) => `err:${e}`
  );
  assert.equal(errOutcome, "err:bad");
});

test("toZkError passes a SorobanZkError through unchanged", () => {
  const error = new SorobanZkError("boom", SorobanZkErrorCode.PROOF_GENERATION_FAILED);
  assert.equal(toZkError(error), error);
});

test("toZkError wraps a plain Error as a SorobanZkError", () => {
  const wrapped = toZkError(new Error("plain failure"));
  assert.ok(wrapped instanceof SorobanZkError);
  assert.equal(wrapped.message, "plain failure");
});

test("toZkError wraps a non-Error throw as a SorobanZkError", () => {
  const wrapped = toZkError("a string was thrown");
  assert.ok(wrapped instanceof SorobanZkError);
  assert.match(wrapped.message, /a string was thrown/);
});
