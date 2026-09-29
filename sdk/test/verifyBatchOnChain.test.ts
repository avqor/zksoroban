/**
 * Unit tests for verifyBatchOnChain()'s contract call shape and result
 * decoding.
 *
 * The RPC layer is replaced with a lightweight stub, the same way
 * verify.unit.test.ts does it for verifyOnChain — no funded account or real
 * network call is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";

import { verifyBatchOnChain } from "../src/verify";
import { SorobanZkError, SorobanZkErrorCode, TESTNET, VerifyBatchOptions } from "../src/types";
import { VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS } from "./fixtures";

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

function buildFnReturnDiagnosticEvent(values: boolean[]): string {
  const v0 = new xdr.ContractEventV0({
    topics: [xdr.ScVal.scvSymbol("fn_return"), xdr.ScVal.scvSymbol("verify_batch")],
    data: xdr.ScVal.scvVec(values.map((v) => xdr.ScVal.scvBool(v)))
  });
  const body = xdr.ContractEventBody.v0(v0);
  const event = new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: null,
    type: xdr.ContractEventType.contract,
    body
  });
  const diagnostic = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event
  });
  return diagnostic.toXDR("base64");
}

function buildTransactionResultXdr(feeCharged = "100"): string {
  const result = xdr.TransactionResultResult.txSuccess([]);
  const ext = xdr.TransactionResultExt.v0();
  const tr = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString(feeCharged),
    result,
    ext
  });
  return tr.toXDR("base64");
}

const DEFAULT_OPTS: VerifyBatchOptions = {
  network: TESTNET,
  keypair: STUB_KEYPAIR,
  items: [
    { proof: VALID_SNARKJS_PROOF, publicSignals: VALID_PUBLIC_SIGNALS },
    { proof: VALID_SNARKJS_PROOF, publicSignals: VALID_PUBLIC_SIGNALS, expiryLedger: 123456 }
  ]
};

function buildSuccessStub(returnValues: boolean[], capturedArgs: { args?: xdr.ScVal[] } = {}) {
  return {
    getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
    getAccount: async (id: string) => new stellarSdk.Account(id, "0"),
    prepareTransaction: async (tx: any) => {
      const op = tx.operations[0];
      capturedArgs.args = op.func.invokeContract.args;
      return tx;
    },
    sendTransaction: async () => ({ status: "PENDING", hash: "a".repeat(64) }),
    _getTransaction: async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 12345,
      resultXdr: buildTransactionResultXdr(),
      diagnosticEventsXdr: [buildFnReturnDiagnosticEvent(returnValues)]
    })
  };
}

function buildSimulationErrorStub(message: string) {
  return {
    getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
    getAccount: async (id: string) => new stellarSdk.Account(id, "0"),
    prepareTransaction: async () => {
      throw new Error(message);
    }
  };
}

test("verifyBatchOnChain returns per-item results in order", async () => {
  await withStubbedServer(
    () => buildSuccessStub([true, false]),
    async () => {
      const result = await verifyBatchOnChain(DEFAULT_OPTS);
      assert.deepEqual(result.verified, [true, false]);
      assert.equal(result.ledger, 12345);
    }
  );
});

test("verifyBatchOnChain passes caller and one vec argument to verify_batch", async () => {
  const captured: { args?: xdr.ScVal[] } = {};

  await withStubbedServer(
    () => buildSuccessStub([true, true], captured),
    async () => {
      await verifyBatchOnChain(DEFAULT_OPTS);

      assert.ok(captured.args, "prepareTransaction should have been called");
      assert.equal(captured.args!.length, 2, "verify_batch(caller, proofs) takes 2 args");

      const callerAddress = stellarSdk.Address.fromScVal(captured.args![0]);
      assert.equal(callerAddress.toString(), STUB_KEYPAIR.publicKey());

      assert.equal(captured.args![1].type, "scvVec");
      assert.equal(captured.args![1].vec!.length, DEFAULT_OPTS.items.length);
    }
  );
});

test("verifyBatchOnChain rejects an empty batch without calling the network", async () => {
  await assert.rejects(
    verifyBatchOnChain({ ...DEFAULT_OPTS, items: [] }),
    (err: unknown) => {
      assert.ok(err instanceof SorobanZkError);
      assert.equal(err.code, SorobanZkErrorCode.INVALID_PROOF_FORMAT);
      return true;
    }
  );
});

test("verifyBatchOnChain maps Error(Contract, #2) to RATE_LIMIT_EXCEEDED", async () => {
  await withStubbedServer(
    () => buildSimulationErrorStub("HostError: Error(Contract, #2)"),
    async () => {
      await assert.rejects(
        verifyBatchOnChain(DEFAULT_OPTS),
        (err: unknown) => {
          assert.ok(err instanceof SorobanZkError);
          assert.equal(err.code, SorobanZkErrorCode.RATE_LIMIT_EXCEEDED);
          return true;
        }
      );
    }
  );
});
