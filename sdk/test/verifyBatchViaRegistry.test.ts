/**
 * Unit tests for verifyBatchViaRegistry().
 *
 * Like verifyViaRegistry.test.ts, the RPC layer is replaced with a
 * lightweight stub — no funded account or real contract is needed, since
 * verify_batch on contracts/registry requires no auth and is
 * simulation-only.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { xdr } from "@stellar/stellar-sdk";

import { verifyBatchViaRegistry } from "../src/verify";
import {
  SorobanZkError,
  SorobanZkErrorCode,
  TESTNET,
  VerifyBatchViaRegistryOptions
} from "../src/types";
import { VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS } from "./fixtures";

import * as stellarSdk from "@stellar/stellar-sdk";

const STUB_PASSPHRASE = "Test SDF Network ; September 2015";

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

function makeSuccessSimResult(values: boolean[]): object {
  return {
    result: { retval: xdr.ScVal.scvVec(values.map((v) => xdr.ScVal.scvBool(v))) },
    minResourceFee: "100",
    transactionData: "",
    events: [],
    latestLedger: 1
  };
}

function makeErrorSimResult(msg: string): object {
  return { error: msg, latestLedger: 1 };
}

function buildStub(simResult: object, capturedArgs: { args?: xdr.ScVal[] } = {}) {
  return {
    getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
    getAccount: async (_id: string): Promise<never> => {
      throw new Error("account not found (stub)");
    },
    simulateTransaction: async (tx: any) => {
      const op = tx.operations[0];
      capturedArgs.args = op.func.invokeContract.args;
      return simResult;
    }
  };
}

const DEFAULT_OPTS: VerifyBatchViaRegistryOptions = {
  network: { ...TESTNET, contractId: "CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH" },
  items: [
    { circuitId: 1, proof: VALID_SNARKJS_PROOF, publicSignals: VALID_PUBLIC_SIGNALS },
    { circuitId: 2, proof: VALID_SNARKJS_PROOF, publicSignals: VALID_PUBLIC_SIGNALS }
  ]
};

test("verifyBatchViaRegistry returns per-item results in order", async () => {
  await withStubbedServer(
    () => buildStub(makeSuccessSimResult([true, false])),
    async () => {
      const results = await verifyBatchViaRegistry(DEFAULT_OPTS);
      assert.deepEqual(results, [true, false]);
    }
  );
});

test("verifyBatchViaRegistry passes one vec argument, one entry per item", async () => {
  const captured: { args?: xdr.ScVal[] } = {};

  await withStubbedServer(
    () => buildStub(makeSuccessSimResult([true, true]), captured),
    async () => {
      await verifyBatchViaRegistry(DEFAULT_OPTS);

      assert.ok(captured.args, "simulateTransaction should have been called");
      assert.equal(captured.args!.length, 1, "verify_batch(batch) takes 1 arg");
      assert.equal(captured.args![0].type, "scvVec");
      assert.equal(captured.args![0].vec!.length, DEFAULT_OPTS.items.length);
    }
  );
});

test("verifyBatchViaRegistry does not require a keypair", () => {
  // Compile-time check: VerifyBatchViaRegistryOptions has no `keypair`
  // field, unlike VerifyBatchOptions. Documents that intentional difference.
  const opts: VerifyBatchViaRegistryOptions = DEFAULT_OPTS;
  assert.ok(!("keypair" in opts));
});

test("verifyBatchViaRegistry throws for a simulation error", async () => {
  await withStubbedServer(
    () => buildStub(makeErrorSimResult("HostError: some failure")),
    async () => {
      await assert.rejects(
        verifyBatchViaRegistry(DEFAULT_OPTS),
        (err: unknown) => {
          assert.ok(err instanceof SorobanZkError);
          assert.equal(err.code, SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED);
          return true;
        }
      );
    }
  );
});

test("verifyBatchViaRegistry rejects an empty batch without calling the network", async () => {
  await assert.rejects(
    verifyBatchViaRegistry({ ...DEFAULT_OPTS, items: [] }),
    (err: unknown) => {
      assert.ok(err instanceof SorobanZkError);
      assert.equal(err.code, SorobanZkErrorCode.INVALID_PROOF_FORMAT);
      return true;
    }
  );
});
