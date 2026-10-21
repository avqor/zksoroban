// sdk/src/result.ts
//
// A minimal, dependency-free Result<T, E> (zksoroban#107) — chosen over
// adopting `neverthrow` (the issue's other explicitly-sanctioned option)
// specifically because this round of work can't run `npm install` to add
// and verify a new dependency resolves correctly. See the doc comment on
// `formatProofResult`/`generateProofResult`/`verifyOnChainResult` (in
// proof.ts/browser.ts/verify.ts respectively) for why those are new,
// additive functions rather than the existing `formatProof`/
// `generateProof`/`verifyOnChain` renamed — the issue's literal scope.
import { SorobanZkError, SorobanZkErrorCode } from "./types.js";

export type Result<T, E> = Ok<T, E> | Err<T, E>;

/**
 * `Result<T, E>` wrapped in a `Promise` — the async counterpart the issue
 * calls `ResultAsync`. There's no separate class here (unlike neverthrow's
 * own `ResultAsync`, which is chainable while still pending); a plain
 * `Promise<Result<T, E>>` is resolved to a concrete `Ok`/`Err` by the time
 * anything inspects it, which is all `verifyOnChainResult`/
 * `generateProofResult` need.
 */
export type ResultAsync<T, E> = Promise<Result<T, E>>;

/**
 * The error type every `*Result` function in this SDK uses — an alias for
 * {@link SorobanZkError}, named to match zksoroban#107's own
 * `Result<T, ZkError>` wording. Every SDK function already throws
 * `SorobanZkError` (or a subclass) on every error path, so this is purely
 * a naming convenience, not a new error hierarchy.
 */
export type ZkError = SorobanZkError;

interface ResultMethods<T, E> {
  isOk(): this is Ok<T, E>;
  isErr(): this is Err<T, E>;
  /** Transform the success value. A no-op passthrough on `Err`. */
  map<U>(fn: (value: T) => U): Result<U, E>;
  /** Transform the error value. A no-op passthrough on `Ok`. */
  mapErr<F>(fn: (error: E) => F): Result<T, F>;
  /** The success value, or `fallback` if this is an `Err`. */
  unwrapOr(fallback: T): T;
  /** Handle both cases at once, returning whichever branch runs. */
  match<U>(onOk: (value: T) => U, onErr: (error: E) => U): U;
}

export class Ok<T, E> implements ResultMethods<T, E> {
  constructor(public readonly value: T) {}

  isOk(): this is Ok<T, E> {
    return true;
  }

  isErr(): this is Err<T, E> {
    return false;
  }

  map<U>(fn: (value: T) => U): Result<U, E> {
    return ok(fn(this.value));
  }

  mapErr<F>(_fn: (error: E) => F): Result<T, F> {
    return ok(this.value);
  }

  unwrapOr(_fallback: T): T {
    return this.value;
  }

  match<U>(onOk: (value: T) => U, _onErr: (error: E) => U): U {
    return onOk(this.value);
  }
}

export class Err<T, E> implements ResultMethods<T, E> {
  constructor(public readonly error: E) {}

  isOk(): this is Ok<T, E> {
    return false;
  }

  isErr(): this is Err<T, E> {
    return true;
  }

  map<U>(_fn: (value: T) => U): Result<U, E> {
    return err(this.error);
  }

  mapErr<F>(fn: (error: E) => F): Result<T, F> {
    return err(fn(this.error));
  }

  unwrapOr(fallback: T): T {
    return fallback;
  }

  match<U>(_onOk: (value: T) => U, onErr: (error: E) => U): U {
    return onErr(this.error);
  }
}

export function ok<T, E = never>(value: T): Result<T, E> {
  return new Ok(value);
}

export function err<E, T = never>(error: E): Result<T, E> {
  return new Err(error);
}

/**
 * Normalizes whatever a wrapped throwing call threw into a
 * {@link SorobanZkError} — every SDK function already only ever throws one
 * of these, but this is a defensive fallback for the theoretical case of
 * something else escaping (e.g. a bug, or a non-SDK error from a
 * dependency).
 */
export function toZkError(error: unknown): ZkError {
  if (error instanceof SorobanZkError) {
    return error;
  }
  return new SorobanZkError(
    error instanceof Error ? error.message : String(error),
    SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
  );
}
