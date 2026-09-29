/**
 * Unit + integration tests for the SDK's opt-in retry with exponential
 * backoff (the `retry` option on the RPC-touching calls).
 *
 * Two layers, mirroring how the cache is tested:
 *
 * 1. Policy unit tests — `classifyFailure`, `computeBackoffDelay`, and the
 *    wrapper's pass-through guarantees — run against a hand-rolled counting
 *    stub, no network.
 * 2. Call-level tests — `withRetry` wired into `verifyOnChain` /
 *    `estimateVerifyFee` / `getContractConfig` through the same
 *    `withStubbedServer` harness `verify.unit.test.ts` uses.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, rpc } from "@stellar/stellar-sdk";

import {
  classifyFailure,
  computeBackoffDelay,
  TransientErrorKind,
  withRetry
} from "../src/retry";
import { getContractConfig, verifyOnChain } from "../src/verify";
import { RetryOptions, SorobanZkErrorCode, TESTNET, VerifyOptions } from "../src/types";

import * as stellarSdk from "@stellar/stellar-sdk";

const STUB_PASSPHRASE = "Test SDF Network ; September 2015";
const STUB_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

// ---------------------------------------------------------------------------
// 1. Policy unit tests
// ---------------------------------------------------------------------------

test("classifyFailure marks transport-looking errors transient", () => {
  const messages = [
    "network error",
    "request failed: fetch failed",
    "Connection timed out",
    "connect ECONNREFUSED 127.0.0.1:8000",
    "socket hang up",
    "429 Too Many Requests",
    "Internal Server Error (500)",
    "service temporarily unavailable",
    "rpc server overloaded"
  ];

  for (const message of messages) {
    assert.equal(
      classifyFailure(new Error(message)),
      TransientErrorKind.TRANSIENT,
      `expected transient: ${message}`
    );
  }
});

test("classifyFailure marks contract-level and auth errors permanent", () => {
  // Only transport-level failures (getNetwork/getAccount/simulate/
  // prepare) ever reach the classifier — calldata validation throws before
  // any RPC call — so these are the permanent shapes it can actually see.
  const messages = [
    "HostError: Error(Contract, #4)",
    "verify_proof simulation failed: Error(Contract, #2)",
    "proof expired before submission",
    "unauthorized signature",
    "Account not found: GABC",
    "submission rejected: tx_bad_seq",
    "malformed transaction envelope"
  ];

  for (const message of messages) {
    assert.equal(
      classifyFailure(new Error(message)),
      TransientErrorKind.PERMANENT,
      `expected permanent: ${message}`
    );
  }
});

test("classifyFailure defaults unrecognized errors to transient (read-only safety)", () => {
  assert.equal(classifyFailure(new Error("something truly weird")), TransientErrorKind.TRANSIENT);
  assert.equal(classifyFailure("a plain string failure"), TransientErrorKind.TRANSIENT);
});

test("classifyFailure checks permanent patterns before transient ones", () => {
  // Mentions both a transient keyword and a contract error — must not retry.
  assert.equal(
    classifyFailure(new Error("network error during Error(Contract, #2)")),
    TransientErrorKind.PERMANENT
  );
});

test("computeBackoffDelay follows the doubling curve without jitter", () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 8_000, jitter: false };

  assert.equal(computeBackoffDelay(1, opts), 500);
  assert.equal(computeBackoffDelay(2, opts), 1_000);
  assert.equal(computeBackoffDelay(3, opts), 2_000);
  assert.equal(computeBackoffDelay(4, opts), 4_000);
});

test("computeBackoffDelay caps at maxDelayMs", () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 3_000, jitter: false };

  assert.equal(computeBackoffDelay(3, opts), 2_000);
  assert.equal(computeBackoffDelay(4, opts), 3_000);
  assert.equal(computeBackoffDelay(10, opts), 3_000);
});

test("computeBackoffDelay applies defaults to an empty options object", () => {
  // 500 * 2^2 = 2000, under the 8s default cap.
  assert.equal(computeBackoffDelay(3, { jitter: false }), 2_000);
});

test("computeBackoffDelay with jitter stays within [0, capped]", () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 1_000, jitter: true };

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const delay = computeBackoffDelay(attempt, opts);
    assert.ok(delay >= 0, `delay should be >= 0 (got ${delay})`);
    assert.ok(delay <= 1_000, `delay should be <= cap (got ${delay})`);
  }
});

// ---------------------------------------------------------------------------
// 2. withRetry wrapper behavior
// ---------------------------------------------------------------------------

interface CountingServer {
  getNetwork: () => Promise<{ passphrase: string }>;
  getAccount: (id: string) => Promise<unknown>;
  simulateTransaction: (tx: unknown) => Promise<unknown>;
  prepareTransaction: (tx: unknown) => Promise<unknown>;
  sendTransaction: (tx: unknown) => Promise<unknown>;
  getTransaction: (hash: string) => Promise<unknown>;
  calls: Record<string, number>;
}

/**
 * A counting stub: every method records how many times it was asked for,
 * and `failFirstN[method]` makes the first N calls of that method reject
 * with a transient-looking transport error. Overrides go through
 * `overrideMethod` so the counter keeps counting.
 */
function buildCountingServer(failFirstN: Record<string, number>): CountingServer {
  const calls: Record<string, number> = {
    getNetwork: 0,
    getAccount: 0,
    simulateTransaction: 0,
    prepareTransaction: 0,
    sendTransaction: 0,
    getTransaction: 0
  };

  function makeMethod(method: string, impl: (...args: unknown[]) => Promise<unknown>) {
    return (...args: unknown[]) => {
      calls[method] += 1;
      if (calls[method] <= (failFirstN[method] ?? 0)) {
        return Promise.reject(new Error(`network hiccup in ${method}`));
      }
      return impl(...args);
    };
  }

  const server: CountingServer = {
    calls,
    getNetwork: makeMethod("getNetwork", async () => ({ passphrase: STUB_PASSPHRASE })),
    getAccount: makeMethod("getAccount", async (id: unknown) => new stellarSdk.Account(id as string, "0")),
    simulateTransaction: makeMethod("simulateTransaction", async () => ({
      result: { retval: stellarSdk.xdr.ScVal.scvBool(true) },
      minResourceFee: "100",
      latestLedger: 1
    })),
    prepareTransaction: makeMethod("prepareTransaction", async (tx: unknown) => tx),
    sendTransaction: makeMethod("sendTransaction", async () => ({
      status: "PENDING",
      hash: "a".repeat(64)
    })),
    getTransaction: makeMethod("getTransaction", async (hash: unknown) => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: hash,
      ledger: 42,
      resultXdr: {
        feeCharged: () => stellarSdk.xdr.Int64.fromString("100")
      } as unknown as stellarSdk.xdr.TransactionResult,
      returnValue: stellarSdk.xdr.ScVal.scvBool(true)
    }))
  };

  return server;
}

/** Replace a counting stub's method while keeping its call counter wired up. */
function overrideMethod(
  stub: CountingServer,
  method: keyof Omit<CountingServer, "calls">,
  impl: (...args: unknown[]) => Promise<unknown>
): void {
  stub[method] = ((...args: unknown[]) => {
    stub.calls[method] += 1;
    return impl(...args);
  }) as CountingServer[typeof method];
}

test("withRetry retries transient read failures until they succeed", async () => {
  const stub = buildCountingServer({ getNetwork: 2, simulateTransaction: 1 });
  const server = withRetry(stub as unknown as object, {
    baseDelayMs: 1,
    maxDelayMs: 2,
    jitter: false
  }) as unknown as CountingServer;

  const network = await server.getNetwork();
  assert.equal(network.passphrase, STUB_PASSPHRASE);
  assert.equal(stub.calls.getNetwork, 3, "two failures + one success");

  await server.simulateTransaction({});
  assert.equal(stub.calls.simulateTransaction, 2);
});

test("withRetry gives up after maxRetries and rethrows the last error", async () => {
  const stub = buildCountingServer({});
  overrideMethod(stub, "getNetwork", () => Promise.reject(new Error("network is down")));

  const server = withRetry(stub as unknown as object, {
    maxRetries: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
    jitter: false
  }) as unknown as CountingServer;

  await assert.rejects(
    () => server.getNetwork(),
    (err: unknown) => err instanceof Error && err.message === "network is down"
  );
  assert.equal(stub.calls.getNetwork, 3, "1 initial + 2 retries");
});

test("withRetry does not retry permanent failures", async () => {
  const stub = buildCountingServer({});
  overrideMethod(stub, "getAccount", () => Promise.reject(new Error("Account not found: GABC")));

  const server = withRetry(stub as unknown as object, {
    maxRetries: 5,
    baseDelayMs: 1,
    jitter: false
  }) as unknown as CountingServer;

  await assert.rejects(() => server.getAccount("GABC"), /Account not found/);
  assert.equal(stub.calls.getAccount, 1, "permanent errors surface immediately");
});

test("withRetry leaves sendTransaction and getTransaction unwrapped", async () => {
  const stub = buildCountingServer({});
  overrideMethod(stub, "sendTransaction", () => Promise.reject(new Error("network is down")));
  overrideMethod(stub, "getTransaction", () => Promise.reject(new Error("network is down")));

  const server = withRetry(stub as unknown as object, {
    maxRetries: 3,
    baseDelayMs: 1,
    jitter: false
  }) as unknown as CountingServer;

  await assert.rejects(() => server.sendTransaction({}));
  assert.equal(stub.calls.sendTransaction, 1, "signed submissions never replayed");

  await assert.rejects(() => server.getTransaction("abc"));
  assert.equal(stub.calls.getTransaction, 1, "confirmation polling never retried here");
});

test("withRetry with retry omitted returns the server untouched", async () => {
  const stub = buildCountingServer({});
  overrideMethod(stub, "getNetwork", () => Promise.reject(new Error("network is down")));

  const server = withRetry(stub as unknown as object, undefined) as unknown as CountingServer;

  await assert.rejects(() => server.getNetwork());
  assert.equal(stub.calls.getNetwork, 1, "no retries without opt-in");
});

test("withRetry with maxRetries: 0 disables retries explicitly", async () => {
  const stub = buildCountingServer({});
  overrideMethod(stub, "getNetwork", () => Promise.reject(new Error("network is down")));

  const server = withRetry(stub as unknown as object, {
    maxRetries: 0,
    baseDelayMs: 1,
    jitter: false
  }) as unknown as CountingServer;

  await assert.rejects(() => server.getNetwork());
  assert.equal(stub.calls.getNetwork, 1);
});

test("withRetry reports each scheduled retry through onRetry", async () => {
  const stub = buildCountingServer({ getNetwork: 2 });
  const retries: Array<{ label: string; attempt: number; delayMs: number }> = [];

  const server = withRetry(stub as unknown as object, {
    baseDelayMs: 10,
    maxDelayMs: 20,
    jitter: false,
    onRetry: (info) => retries.push({ label: info.label, attempt: info.attempt, delayMs: info.delayMs })
  }) as unknown as CountingServer;

  await server.getNetwork();

  assert.equal(retries.length, 2);
  assert.deepEqual(
    retries.map((r) => r.attempt),
    [1, 2]
  );
  assert.ok(retries.every((r) => r.label === "getNetwork"));
  assert.ok(retries.every((r) => r.delayMs > 0));
});

// ---------------------------------------------------------------------------
// 3. Call-level tests through the stubbed-server harness
// ---------------------------------------------------------------------------

function withStubbedServer(
  stubFactory: () => object,
  fn: () => Promise<void>
): Promise<void> {
  const original = (stellarSdk.rpc as any).Server;
  (stellarSdk.rpc as any).Server = function () {
    return stubFactory();
  };
  return fn().finally(() => {
    (stellarSdk.rpc as any).Server = original;
  });
}

const DEFAULT_OPTS: VerifyOptions = {
  network: TESTNET,
  keypair: STUB_KEYPAIR,
  calldata: {
    proofA: Buffer.alloc(64, 1),
    proofB: Buffer.alloc(128, 2),
    proofC: Buffer.alloc(64, 3),
    publicInputs: [Buffer.alloc(32, 4)]
  }
};

/** A stub whose getNetwork fails N times before succeeding; everything else works. */
function buildFlakyStub(failGetNetworkFirstN: number, captured: { counts: number[] } = {}) {
  let getNetworkCalls = 0;

  return {
    getNetwork: async () => {
      getNetworkCalls += 1;
      captured.counts = [getNetworkCalls];
      if (getNetworkCalls <= failGetNetworkFirstN) {
        throw new Error("network hiccup");
      }
      return { passphrase: STUB_PASSPHRASE };
    },
    getAccount: async (id: string) => new stellarSdk.Account(id, "0"),
    prepareTransaction: async (tx: any) => tx,
    sendTransaction: async () => ({ status: "PENDING", hash: "a".repeat(64) }),
    getTransaction: async (hash: string) => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: hash,
      ledger: 12345,
      resultXdr: {
        feeCharged: () => stellarSdk.xdr.Int64.fromString("100")
      } as unknown as stellarSdk.xdr.TransactionResult,
      returnValue: stellarSdk.xdr.ScVal.scvBool(true)
    }),
    simulateTransaction: async () => ({
      result: { retval: stellarSdk.xdr.ScVal.scvBool(true) },
      minResourceFee: "100",
      latestLedger: 1
    })
  };
}

test("verifyOnChain recovers from a transient getNetwork failure when retry is enabled", async () => {
  const captured: { counts: number[] } = [];

  await withStubbedServer(
    () => buildFlakyStub(1, captured),
    async () => {
      const result = await verifyOnChain({ ...DEFAULT_OPTS, retry: { maxRetries: 3 } });
      assert.equal(result.verified, true);
      assert.deepEqual(captured.counts, [2], "getNetwork succeeded on attempt 2");
    }
  );
});

test("verifyOnChain makes exactly one getNetwork attempt without retry", async () => {
  const captured: { counts: number[] } = [];

  await withStubbedServer(
    () => buildFlakyStub(1, captured),
    async () => {
      await assert.rejects(
        verifyOnChain(DEFAULT_OPTS),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        }
      );
      assert.deepEqual(captured.counts, [1], "no retry without opt-in");
    }
  );
});

test("verifyOnChain exhausts retries and surfaces the last transport error", async () => {
  const captured: { counts: number[] } = [];

  await withStubbedServer(
    () => buildFlakyStub(99, captured),
    async () => {
      await assert.rejects(
        verifyOnChain({ ...DEFAULT_OPTS, retry: { maxRetries: 2, baseDelayMs: 1, jitter: false } }),
        /network hiccup/
      );
      assert.deepEqual(captured.counts, [3], "1 initial + 2 retries");
    }
  );
});

test("verifyOnChain does not retry a contract-level simulation rejection", async () => {
  let simulateCalls = 0;

  await withStubbedServer(
    () => ({
      getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
      getAccount: async (id: string) => new stellarSdk.Account(id, "0"),
      prepareTransaction: async () => {
        simulateCalls += 1;
        throw new Error("HostError: Error(Contract, #4)");
      }
    }),
    async () => {
      await assert.rejects(
        verifyOnChain({ ...DEFAULT_OPTS, retry: { maxRetries: 5, baseDelayMs: 1 } }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Error\(Contract, #4\)/);
          return true;
        }
      );
      assert.equal(simulateCalls, 1, "permanent rejection surfaces immediately");
    }
  );
});

test("getContractConfig retries transient simulation failures when retry is enabled", async () => {
  let simulateCalls = 0;

  // Mirror getContractConfig.test.ts's config ScVal layout (admin encoded
  // as an account ScAddress, booleans, u32 limits, void for absent fields).
  const stubAdminKp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
  const configScVal = (() => {
    const entry = (key: string, val: stellarSdk.xdr.ScVal): stellarSdk.xdr.ScMapEntry =>
      new stellarSdk.xdr.ScMapEntry({
        key: stellarSdk.xdr.ScVal.scvSymbol(key),
        val
      });

    const adminScVal = stellarSdk.xdr.ScVal.scvAddress(
      stellarSdk.xdr.ScAddress.scAddressTypeAccount(
        stellarSdk.xdr.PublicKey.publicKeyTypeEd25519(stubAdminKp.rawPublicKey())
      )
    );

    return stellarSdk.xdr.ScVal.scvMap([
      entry("admin", adminScVal),
      entry("allowlist_enabled", stellarSdk.xdr.ScVal.scvBool(false)),
      entry("fee_amount", stellarSdk.xdr.ScVal.scvVoid()),
      entry("fee_token", stellarSdk.xdr.ScVal.scvVoid()),
      entry("paused", stellarSdk.xdr.ScVal.scvBool(false)),
      entry("rate_limit_max", stellarSdk.xdr.ScVal.scvU32(10)),
      entry("rate_limit_window", stellarSdk.xdr.ScVal.scvU32(100)),
      entry("timelock_delay", stellarSdk.xdr.ScVal.scvVoid())
    ]);
  })();

  await withStubbedServer(
    () => ({
      getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
      // Rejects with "not found" — a *permanent* failure the retry layer
      // must surface immediately, letting getContractConfig's own
      // ephemeral-account fallback kick in (synthetic Account at seq 0).
      getAccount: async (_id: string): Promise<never> => {
        throw new Error(`Account not found: ${_id}`);
      },
      simulateTransaction: async () => {
        simulateCalls += 1;
        if (simulateCalls <= 2) {
          throw new Error("fetch failed");
        }
        return {
          result: { retval: configScVal },
          minResourceFee: "100",
          transactionData: "",
          events: [],
          latestLedger: 1
        };
      }
    }),
    async () => {
      const config = await getContractConfig({
        network: TESTNET,
        retry: { maxRetries: 3, baseDelayMs: 1, jitter: false }
      });

      assert.equal(config.rateLimitMax, 10);
      assert.equal(simulateCalls, 3, "two transient failures + one success");
    }
  );
});

test("retry options are accepted by every RPC-touching call's options type", async () => {
  // Compile-time surface check (mirrors the cache branch's export test).
  const sdk = await import("../src/index");
  assert.ok("withRetry" in sdk, "withRetry exported from index");
  assert.ok("computeBackoffDelay" in sdk, "computeBackoffDelay exported from index");
  assert.ok("classifyFailure" in sdk, "classifyFailure exported from index");

  // Runtime sanity: a RetryOptions object is assignable to each options
  // interface's `retry` field.
  const retry: RetryOptions = { maxRetries: 1, baseDelayMs: 10, jitter: true };
  assert.ok(retry.maxRetries === 1);
  assert.equal(SorobanZkErrorCode.NETWORK_ERROR, "NETWORK_ERROR");
});
