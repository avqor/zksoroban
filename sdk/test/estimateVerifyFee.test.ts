/**
 * Unit tests for estimateVerifyFee().
 *
 * Like verify.unit.test.ts, the RPC layer is replaced with a lightweight
 * stub — no funded account or real contract is needed, since
 * estimateVerifyFee only ever calls simulateTransaction, never submits.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BASE_FEE, Keypair, xdr } from "@stellar/stellar-sdk";

import { estimateVerifyFee } from "../src/verify";
import { SorobanZkError, SorobanZkErrorCode, TESTNET, VerifyOptions } from "../src/types";

import * as stellarSdk from "@stellar/stellar-sdk";

const STUB_PASSPHRASE = "Test SDF Network ; September 2015";
const STUB_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

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

function makeSuccessSimResult(minResourceFee: string): object {
  return {
    result: { retval: xdr.ScVal.scvBool(true) },
    minResourceFee,
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
    getAccount: async (id: string) => new stellarSdk.Account(id, "0"),
    simulateTransaction: async (tx: any) => {
      const op = tx.operations[0];
      capturedArgs.args = op.func.invokeContract.args;
      return simResult;
    }
  };
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

test("estimateVerifyFee parses the fee as base fee + minResourceFee", async () => {
  await withStubbedServer(
    () => buildStub(makeSuccessSimResult("12345")),
    async () => {
      const { stroops, xlm } = await estimateVerifyFee(DEFAULT_OPTS);

      const expected = BigInt(BASE_FEE) + 12345n;
      assert.equal(stroops, expected);
      assert.equal(xlm, "0.0012445");
    }
  );
});

test("estimateVerifyFee formats a whole-XLM fee without a trailing decimal", async () => {
  await withStubbedServer(
    () => buildStub(makeSuccessSimResult((10_000_000n - BigInt(BASE_FEE)).toString())),
    async () => {
      const { stroops, xlm } = await estimateVerifyFee(DEFAULT_OPTS);

      assert.equal(stroops, 10_000_000n);
      assert.equal(xlm, "1");
    }
  );
});

test("estimateVerifyFee never signs or submits — no sendTransaction on the stub", async () => {
  const captured: { args?: xdr.ScVal[] } = {};

  await withStubbedServer(
    () => buildStub(makeSuccessSimResult("100"), captured),
    async () => {
      await estimateVerifyFee(DEFAULT_OPTS);

      assert.ok(captured.args, "simulateTransaction should have been called");
      assert.equal(captured.args!.length, 5, "verify_proof takes 5 args");

      const callerAddress = stellarSdk.Address.fromScVal(captured.args![0]);
      assert.equal(callerAddress.toString(), STUB_KEYPAIR.publicKey());
    }
  );
});

test("estimateVerifyFee throws a typed SorobanZkError for a simulation failure", async () => {
  await withStubbedServer(
    () => buildStub(makeErrorSimResult("HostError: Error(Contract, #4)")),
    async () => {
      await assert.rejects(
        estimateVerifyFee(DEFAULT_OPTS),
        (err: unknown) => {
          assert.ok(err instanceof SorobanZkError);
          assert.equal(err.code, SorobanZkErrorCode.PROOF_EXPIRED);
          return true;
        }
      );
    }
  );
});

test("estimateVerifyFee throws INVALID_PROOF_FORMAT when neither calldata nor bundle is given", async () => {
  const { calldata, ...withoutCalldata } = DEFAULT_OPTS;

  await assert.rejects(
    estimateVerifyFee(withoutCalldata as VerifyOptions),
    (err: unknown) => {
      assert.ok(err instanceof SorobanZkError);
      assert.equal(err.code, SorobanZkErrorCode.INVALID_PROOF_FORMAT);
      return true;
    }
  );
});

test("estimateVerifyFee and EstimateVerifyFeeResult are exported from the SDK entry point", async () => {
  const sdk = await import("../src/index");
  assert.ok("estimateVerifyFee" in sdk, "estimateVerifyFee exported from index");
});
