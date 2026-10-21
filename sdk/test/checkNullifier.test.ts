/**
 * Unit tests for computeNullifier()/checkNullifier() (zksoroban#27).
 *
 * Like getContractConfig.test.ts, the RPC layer is replaced with a
 * lightweight stub — no funded account or real contract is needed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { scValToNative, xdr } from "@stellar/stellar-sdk";

import { checkNullifier, GetContractConfigOptions } from "../src/verify";
import { computeNullifier, formatProof } from "../src/proof";
import { SorobanZkError, SorobanZkErrorCode, TESTNET } from "../src/types";
import { VALID_PUBLIC_SIGNALS, VALID_SNARKJS_PROOF } from "./fixtures";

import * as stellarSdk from "@stellar/stellar-sdk";

const STUB_PASSPHRASE = "Test SDF Network ; September 2015";

function withStubbedServer(stubFactory: () => object, fn: () => Promise<void>): Promise<void> {
  const original = (stellarSdk.rpc as any).Server;
  (stellarSdk.rpc as any).Server = function () {
    return stubFactory();
  };
  return fn().finally(() => {
    (stellarSdk.rpc as any).Server = original;
  });
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

function buildStub(simResult: object, capturedArgs?: { args?: xdr.ScVal[] }) {
  return {
    getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
    getAccount: async (_id: string): Promise<never> => {
      throw new Error("account not found (stub)");
    },
    simulateTransaction: async (tx: any) => {
      if (capturedArgs) {
        capturedArgs.args = tx.operations[0].func.invokeContract.args;
      }
      return simResult;
    }
  };
}

const DEFAULT_OPTS: GetContractConfigOptions = { network: TESTNET };

// --- computeNullifier -----------------------------------------------------

test("computeNullifier is sha256 of the same proofA encoding formatProof produces", () => {
  const calldata = formatProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);
  const expected = createHash("sha256").update(calldata.proofA).digest();

  assert.deepEqual(computeNullifier(VALID_SNARKJS_PROOF), expected);
});

test("computeNullifier is deterministic for the same proof", () => {
  assert.deepEqual(computeNullifier(VALID_SNARKJS_PROOF), computeNullifier(VALID_SNARKJS_PROOF));
});

test("computeNullifier only depends on pi_a, not pi_b/pi_c/protocol", () => {
  const altered = { ...VALID_SNARKJS_PROOF, pi_c: VALID_SNARKJS_PROOF.pi_a };
  assert.deepEqual(computeNullifier(altered), computeNullifier(VALID_SNARKJS_PROOF));
});

// --- checkNullifier ---------------------------------------------------------

test("checkNullifier returns false for an unused nullifier", async () => {
  await withStubbedServer(() => buildStub(makeSuccessSimResult(xdr.ScVal.scvBool(false))), async () => {
    const used = await checkNullifier(VALID_SNARKJS_PROOF, DEFAULT_OPTS);
    assert.equal(used, false);
  });
});

test("checkNullifier returns true for an already-used nullifier", async () => {
  await withStubbedServer(() => buildStub(makeSuccessSimResult(xdr.ScVal.scvBool(true))), async () => {
    const used = await checkNullifier(VALID_SNARKJS_PROOF, DEFAULT_OPTS);
    assert.equal(used, true);
  });
});

test("checkNullifier sends the same nullifier computeNullifier derives", async () => {
  const captured: { args?: xdr.ScVal[] } = {};
  const expectedNullifier = computeNullifier(VALID_SNARKJS_PROOF);

  await withStubbedServer(
    () => buildStub(makeSuccessSimResult(xdr.ScVal.scvBool(false)), captured),
    async () => {
      await checkNullifier(VALID_SNARKJS_PROOF, DEFAULT_OPTS);
    }
  );

  assert.ok(captured.args, "is_nullifier_used should have been called with an argument");
  const sentNullifier = scValToNative(captured.args![0]);
  assert.deepEqual(Buffer.from(sentNullifier), expectedNullifier);
});

test("checkNullifier throws SorobanZkError on simulation error", async () => {
  await withStubbedServer(
    () => buildStub({ error: "contract trap: NotInitialized", latestLedger: 1 }),
    async () => {
      await assert.rejects(
        () => checkNullifier(VALID_SNARKJS_PROOF, DEFAULT_OPTS),
        (err: unknown) => err instanceof SorobanZkError
      );
    }
  );
});

test("checkNullifier throws CONTRACT_INVOCATION_FAILED when result is missing", async () => {
  const noResultSim = { minResourceFee: "100", latestLedger: 1, events: [] };

  await withStubbedServer(() => buildStub(noResultSim), async () => {
    await assert.rejects(
      () => checkNullifier(VALID_SNARKJS_PROOF, DEFAULT_OPTS),
      (err: unknown) =>
        err instanceof SorobanZkError && err.code === SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
    );
  });
});

test("checkNullifier and computeNullifier are exported from the SDK entry point", async () => {
  const sdk = await import("../src/index");
  assert.ok("checkNullifier" in sdk, "checkNullifier exported from index");
  assert.ok("computeNullifier" in sdk, "computeNullifier exported from index");
});
