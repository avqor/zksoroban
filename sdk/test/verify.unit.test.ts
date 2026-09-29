/**
 * Unit tests for verifyOnChain()'s contract call shape and error decoding.
 *
 * The RPC layer is replaced with a lightweight stub, the same way
 * getContractConfig.test.ts does it — no funded account or real network
 * call is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";

import { verifyOnChain } from "../src/verify";
import {
  NetworkMismatchError,
  SorobanZkError,
  SorobanZkErrorCode,
  TESTNET,
  VerifyOptions
} from "../src/types";

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

function buildFnReturnDiagnosticEvent(value: boolean): xdr.DiagnosticEvent {
  const v0 = new xdr.ContractEventV0({
    topics: [xdr.ScVal.scvSymbol("fn_return"), xdr.ScVal.scvSymbol("verify_proof")],
    data: xdr.ScVal.scvBool(value)
  });
  const body = xdr.ContractEventBody.v0(v0);
  const event = new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: null,
    type: xdr.ContractEventType.contract,
    body
  });
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event
  });
}

function buildTransactionResult(feeCharged = "100"): xdr.TransactionResult {
  const result = xdr.TransactionResultResult.txSuccess([]);
  const ext = xdr.TransactionResultExt.v0();
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString(feeCharged),
    result,
    ext
  });
}

// Matches rpc.Api.GetSuccessfulTransactionResponse: resultXdr is already a
// parsed object, returnValue comes from result meta, diagnosticEventsXdr is
// an array of parsed DiagnosticEvent.
interface StubSuccessTx {
  status: typeof rpc.Api.GetTransactionStatus.SUCCESS;
  txHash: string;
  ledger: number;
  resultXdr: xdr.TransactionResult;
  returnValue?: xdr.ScVal;
  diagnosticEventsXdr?: xdr.DiagnosticEvent[];
}

function buildSuccessStub(
  capturedArgs: { args?: xdr.ScVal[] },
  txOverrides: Partial<StubSuccessTx> = {}
) {
  return {
    getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
    getAccount: async (id: string) => new stellarSdk.Account(id, "0"),
    prepareTransaction: async (tx: any) => {
      const op = tx.operations[0];
      capturedArgs.args = op.func.invokeContract.args;
      return tx;
    },
    sendTransaction: async () => ({ status: "PENDING", hash: "a".repeat(64) }),
    getTransaction: async (): Promise<StubSuccessTx> => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: "b".repeat(64),
      ledger: 12345,
      resultXdr: buildTransactionResult(),
      ...txOverrides
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

test("verifyOnChain passes caller as the first verify_proof argument", async () => {
  const captured: { args?: xdr.ScVal[] } = {};

  await withStubbedServer(
    () =>
      buildSuccessStub(captured, {
        // Canonical path: returnValue present, no diagnostics needed.
        returnValue: xdr.ScVal.scvBool(true)
      }),
    async () => {
      const result = await verifyOnChain(DEFAULT_OPTS);
      assert.equal(result.verified, true);

      assert.ok(captured.args, "prepareTransaction should have been called");
      assert.equal(captured.args!.length, 5, "verify_proof now takes 5 args");

      const callerAddress = stellarSdk.Address.fromScVal(captured.args![0]);
      assert.equal(callerAddress.toString(), STUB_KEYPAIR.publicKey());
    }
  );
});

test("verifyOnChain decodes returnValue=false without diagnostic events", async () => {
  await withStubbedServer(
    () =>
      buildSuccessStub({}, { returnValue: xdr.ScVal.scvBool(false) }),
    async () => {
      const result = await verifyOnChain(DEFAULT_OPTS);
      assert.equal(result.verified, false);
    }
  );
});

test("verifyOnChain falls back to fn_return diagnostics when returnValue is absent", async () => {
  await withStubbedServer(
    () =>
      buildSuccessStub({}, {
        diagnosticEventsXdr: [buildFnReturnDiagnosticEvent(true)]
      }),
    async () => {
      const result = await verifyOnChain(DEFAULT_OPTS);
      assert.equal(result.verified, true);
    }
  );
});

test("verifyOnChain falls back to fn_return=false diagnostics", async () => {
  await withStubbedServer(
    () =>
      buildSuccessStub({}, {
        diagnosticEventsXdr: [buildFnReturnDiagnosticEvent(false)]
      }),
    async () => {
      const result = await verifyOnChain(DEFAULT_OPTS);
      assert.equal(result.verified, false);
    }
  );
});

test("verifyOnChain prefers returnValue over a contradicting diagnostic event", async () => {
  await withStubbedServer(
    () =>
      buildSuccessStub({}, {
        returnValue: xdr.ScVal.scvBool(false),
        diagnosticEventsXdr: [buildFnReturnDiagnosticEvent(true)]
      }),
    async () => {
      const result = await verifyOnChain(DEFAULT_OPTS);
      assert.equal(result.verified, false);
    }
  );
});

test("verifyOnChain throws instead of reporting false when no return value is decodable", async () => {
  await withStubbedServer(
    () => buildSuccessStub({}),
    async () => {
      await assert.rejects(
        verifyOnChain(DEFAULT_OPTS),
        (err: unknown) => {
          assert.ok(err instanceof SorobanZkError);
          assert.equal(err.code, SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED);
          assert.match(err.message, /no decodable verify_proof return value/);
          return true;
        }
      );
    }
  );
});

test("verifyOnChain reports the fee from the transaction result", async () => {
  await withStubbedServer(
    () =>
      buildSuccessStub({}, {
        returnValue: xdr.ScVal.scvBool(true),
        resultXdr: buildTransactionResult("12345")
      }),
    async () => {
      const result = await verifyOnChain(DEFAULT_OPTS);
      assert.equal(result.fee, "12345");
    }
  );
});

test("verifyOnChain emits submit_start then submit_done, in order, for a successful call", async () => {
  const stages: string[] = [];

  await withStubbedServer(
    () => buildSuccessStub({}, { returnValue: xdr.ScVal.scvBool(true) }),
    async () => {
      await verifyOnChain({
        ...DEFAULT_OPTS,
        onProgress: (stage) => {
          stages.push(stage);
        }
      });
    }
  );

  assert.deepEqual(stages, ["submit_start", "submit_done"]);
});

test("verifyOnChain does not abort when onProgress itself throws", async () => {
  await withStubbedServer(
    () => buildSuccessStub({}, { returnValue: xdr.ScVal.scvBool(true) }),
    async () => {
      const result = await verifyOnChain({
        ...DEFAULT_OPTS,
        onProgress: () => {
          throw new Error("boom");
        }
      });

      assert.equal(result.verified, true);
    }
  );
});

test("verifyOnChain rejects a NetworkConfig whose passphrase doesn't match the RPC server's, before building a transaction", async () => {
  const captured: { args?: xdr.ScVal[] } = {};

  await withStubbedServer(
    () => buildSuccessStub(captured, { returnValue: xdr.ScVal.scvBool(true) }),
    async () => {
      await assert.rejects(
        verifyOnChain({
          ...DEFAULT_OPTS,
          network: { ...TESTNET, networkPassphrase: "Public Global Stellar Network ; September 2015" }
        }),
        (error: unknown) => {
          assert.ok(error instanceof NetworkMismatchError);
          assert.ok(error instanceof SorobanZkError);
          assert.equal(error.code, SorobanZkErrorCode.NETWORK_MISMATCH);
          assert.equal(error.expected, "Public Global Stellar Network ; September 2015");
          assert.equal(error.actual, STUB_PASSPHRASE);
          return true;
        }
      );
    }
  );

  assert.equal(captured.args, undefined, "no transaction should be built after a network mismatch");
});

const CONTRACT_ERROR_CASES: Array<[number, SorobanZkErrorCode]> = [
  [1, SorobanZkErrorCode.CONTRACT_NOT_INITIALIZED],
  [2, SorobanZkErrorCode.RATE_LIMIT_EXCEEDED],
  [3, SorobanZkErrorCode.INVALID_WINDOW_SIZE],
  [4, SorobanZkErrorCode.PROOF_EXPIRED],
  [5, SorobanZkErrorCode.CALLER_NOT_ALLOWED],
  [11, SorobanZkErrorCode.ALREADY_USED]
];

for (const [code, expected] of CONTRACT_ERROR_CASES) {
  test(`verifyOnChain maps Error(Contract, #${code}) to ${expected}`, async () => {
    await withStubbedServer(
      () => buildSimulationErrorStub(`HostError: Error(Contract, #${code})`),
      async () => {
        await assert.rejects(
          verifyOnChain(DEFAULT_OPTS),
          (err: unknown) => {
            assert.ok(err instanceof SorobanZkError);
            assert.equal(err.code, expected);
            return true;
          }
        );
      }
    );
  });
}

test("verifyOnChain falls back to a generic error for an unrecognized failure", async () => {
  await withStubbedServer(
    () => buildSimulationErrorStub("some unrelated RPC failure"),
    async () => {
      await assert.rejects(
        verifyOnChain(DEFAULT_OPTS),
        (err: unknown) => {
          assert.ok(err instanceof SorobanZkError);
          assert.equal(err.code, SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED);
          return true;
        }
      );
    }
  );
});
