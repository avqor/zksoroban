/**
 * Unit tests for getContractConfig() / ContractConfig.
 *
 * getContractConfig() calls the Soroban RPC `simulateTransaction` endpoint,
 * so the RPC layer is replaced with a lightweight stub that returns a
 * pre-built simResult containing known ContractConfig values.
 *
 * Network calls are never made; no funded account or real contract is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { xdr, scValToNative, Keypair } from "@stellar/stellar-sdk";

import { getContractConfig, GetContractConfigOptions } from "../src/verify";
import { ContractConfig, SorobanZkError, SorobanZkErrorCode, TESTNET } from "../src/types";

// ---------------------------------------------------------------------------
// A stable deterministic admin address used in simulated results
// ---------------------------------------------------------------------------

// Derive a stable address from a fixed seed so the test is reproducible.
const STUB_ADMIN_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
const STUB_ADMIN_ADDRESS = STUB_ADMIN_KP.publicKey(); // GAMX62ZD4FWIKMWGVPEDR6…
const STUB_PASSPHRASE = "Test SDF Network ; September 2015";

// ---------------------------------------------------------------------------
// Build a ContractConfig ScVal — mirrors the Soroban contracttype layout
// ---------------------------------------------------------------------------

function buildConfigScVal(fields: {
  rate_limit_max: number;
  rate_limit_window: number;
  paused?: boolean;
  allowlist_enabled?: boolean;
}): xdr.ScVal {
  const entry = (key: string, val: xdr.ScVal): xdr.ScMapEntry =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

  // Encode admin as an account address ScVal.
  const adminBytes = STUB_ADMIN_KP.rawPublicKey();
  const adminScVal = xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(adminBytes)
    )
  );

  return xdr.ScVal.scvMap([
    entry("admin", adminScVal),
    entry("allowlist_enabled", xdr.ScVal.scvBool(fields.allowlist_enabled ?? false)),
    entry("fee_amount", xdr.ScVal.scvVoid()),
    entry("fee_token", xdr.ScVal.scvVoid()),
    entry("paused", xdr.ScVal.scvBool(fields.paused ?? false)),
    entry("rate_limit_max", xdr.ScVal.scvU32(fields.rate_limit_max)),
    entry("rate_limit_window", xdr.ScVal.scvU32(fields.rate_limit_window)),
    entry("timelock_delay", xdr.ScVal.scvVoid()),
  ]);
}

function makeSuccessSimResult(retval: xdr.ScVal): object {
  return {
    result: { retval },
    minResourceFee: "100",
    transactionData: "",
    events: [],
    latestLedger: 1
  };
}

function makeErrorSimResult(msg: string): object {
  return { error: msg, latestLedger: 1 };
}

// ---------------------------------------------------------------------------
// Stub the rpc.Server constructor used inside getContractConfig
// ---------------------------------------------------------------------------

import * as stellarSdk from "@stellar/stellar-sdk";

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

const DEFAULT_OPTS: GetContractConfigOptions = {
  network: TESTNET
};

/**
 * Build a stub whose getAccount() rejects, triggering the synthetic-account
 * fallback inside getContractConfig — which is the expected path for any
 * ephemeral address that is not funded on the network.
 */
function buildStub(simResult: object) {
  return {
    getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
    getAccount: async (_id: string): Promise<never> => {
      throw new Error("account not found (stub)");
    },
    simulateTransaction: async (_tx: unknown) => simResult
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("getContractConfig maps rate-limit fields correctly", async () => {
  const retval = buildConfigScVal({ rate_limit_max: 7, rate_limit_window: 42 });

  await withStubbedServer(() => buildStub(makeSuccessSimResult(retval)), async () => {
    const config = await getContractConfig(DEFAULT_OPTS);

    assert.equal(config.rateLimitMax, 7, "rateLimitMax");
    assert.equal(config.rateLimitWindow, 42, "rateLimitWindow");
  });
});

test("getContractConfig maps unimplemented feature flags to absent/false", async () => {
  const retval = buildConfigScVal({ rate_limit_max: 7, rate_limit_window: 42 });

  await withStubbedServer(() => buildStub(makeSuccessSimResult(retval)), async () => {
    const config = await getContractConfig(DEFAULT_OPTS);

    assert.equal(config.paused, false, "paused should default to false");
    assert.equal(config.feeAmount, undefined, "feeAmount should be undefined");
    assert.equal(config.feeToken, undefined, "feeToken should be undefined");
    assert.equal(config.timelockDelay, undefined, "timelockDelay should be undefined");
    assert.equal(config.allowlistEnabled, false, "allowlistEnabled should default to false");
  });
});

test("getContractConfig reflects updated limits (set_limits equivalent)", async () => {
  const retval = buildConfigScVal({ rate_limit_max: 20, rate_limit_window: 200 });

  await withStubbedServer(() => buildStub(makeSuccessSimResult(retval)), async () => {
    const config = await getContractConfig(DEFAULT_OPTS);
    assert.equal(config.rateLimitMax, 20);
    assert.equal(config.rateLimitWindow, 200);
  });
});

test("getContractConfig returns admin as a non-empty string", async () => {
  const retval = buildConfigScVal({ rate_limit_max: 1, rate_limit_window: 10 });

  await withStubbedServer(() => buildStub(makeSuccessSimResult(retval)), async () => {
    const config = await getContractConfig(DEFAULT_OPTS);

    assert.equal(typeof config.admin, "string", "admin is a string");
    assert.ok(config.admin.length > 0, "admin is non-empty");
  });
});

test("getContractConfig throws SorobanZkError on simulation error", async () => {
  const errResult = makeErrorSimResult("contract trap: NotInitialized");

  await withStubbedServer(() => buildStub(errResult), async () => {
    await assert.rejects(
      () => getContractConfig(DEFAULT_OPTS),
      (err: unknown) => err instanceof SorobanZkError
    );
  });
});

test("getContractConfig throws CONTRACT_INVOCATION_FAILED when result is missing", async () => {
  const noResultSim = { minResourceFee: "100", latestLedger: 1, events: [] };

  await withStubbedServer(() => buildStub(noResultSim), async () => {
    await assert.rejects(
      () => getContractConfig(DEFAULT_OPTS),
      (err: unknown) =>
        err instanceof SorobanZkError &&
        err.code === SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
    );
  });
});

test("getContractConfig wraps unexpected errors as SorobanZkError", async () => {
  const crashStub = {
    getNetwork: async () => { throw new Error("fetch failed"); },
    getAccount: async () => { throw new Error("unreachable"); },
    simulateTransaction: async () => { throw new Error("unreachable"); }
  };

  await withStubbedServer(() => crashStub, async () => {
    await assert.rejects(
      () => getContractConfig(DEFAULT_OPTS),
      (err: unknown) => err instanceof SorobanZkError
    );
  });
});

test("getContractConfig and GetContractConfigOptions are exported from the SDK entry point", async () => {
  const sdk = await import("../src/index");
  assert.ok("getContractConfig" in sdk, "getContractConfig exported from index");
  // ContractConfig is a TS interface (erased at runtime), but its presence in
  // types is confirmed by the TypeScript build step passing (tsc --noEmit).
});
