/**
 * Unit tests for the three Result-returning wrappers (zksoroban#107):
 * formatProofResult, generateProofResult, verifyOnChainResult. Each wraps
 * an existing, already-tested throwing function, so these tests focus on
 * the wrapping behavior itself (Ok on success, Err with the right error on
 * failure) rather than re-deriving coverage the throwing versions'
 * own test files already have.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { generateProofResult } from "../src/browser";
import { formatProof, formatProofResult } from "../src/proof";
import { SorobanZkError, SorobanZkErrorCode, TESTNET } from "../src/types";
import { verifyOnChainResult } from "../src/verify";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { VALID_PUBLIC_SIGNALS, VALID_SNARKJS_PROOF } from "./fixtures";

import * as stellarSdk from "@stellar/stellar-sdk";

// --- formatProofResult ---------------------------------------------------

test("formatProofResult returns Ok with the same calldata formatProof would return", () => {
  const result = formatProofResult(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);
  assert.ok(result.isOk());
  if (result.isOk()) {
    assert.equal(result.value.proofA.length, 64);
    assert.equal(result.value.proofB.length, 128);
    assert.equal(result.value.proofC.length, 64);
  }
});

test("formatProofResult returns Err instead of throwing for an invalid proof", () => {
  const result = formatProofResult({ ...VALID_SNARKJS_PROOF, protocol: "groth15" as "groth16" }, VALID_PUBLIC_SIGNALS);
  assert.ok(result.isErr());
  if (result.isErr()) {
    assert.ok(result.error instanceof SorobanZkError);
    assert.equal(result.error.code, SorobanZkErrorCode.INVALID_PROOF_FORMAT);
  }
});

// --- generateProofResult --------------------------------------------------

test("generateProofResult returns Err instead of throwing for a non-bigint secret", async () => {
  const result = await generateProofResult(
    "not-a-bigint" as unknown as bigint,
    1n,
    new Uint8Array(),
    new Uint8Array()
  );
  assert.ok(result.isErr());
  if (result.isErr()) {
    assert.ok(result.error instanceof SorobanZkError);
  }
});

test("generateProofResult and generateProof are both exported from the browser entry point", async () => {
  const browserEntry = await import("../src/browser");
  assert.ok("generateProof" in browserEntry, "generateProof (throwing) still exported, unchanged");
  assert.ok("generateProofResult" in browserEntry, "generateProofResult (new, additive) exported");
});

// --- verifyOnChainResult ---------------------------------------------------

const STUB_PASSPHRASE = "Test SDF Network ; September 2015";
const STUB_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21));

function withStubbedServer(stubFactory: () => object, fn: () => Promise<void>): Promise<void> {
  const original = (stellarSdk.rpc as any).Server;
  (stellarSdk.rpc as any).Server = function () {
    return stubFactory();
  };
  return fn().finally(() => {
    (stellarSdk.rpc as any).Server = original;
  });
}

function buildTransactionResult(): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: xdr.TransactionResultExt.v0()
  });
}

test("verifyOnChainResult returns Ok with the VerifyResult on success", async () => {
  await withStubbedServer(
    () => ({
      getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
      getAccount: async (id: string) => new stellarSdk.Account(id, "0"),
      prepareTransaction: async (tx: any) => tx,
      sendTransaction: async () => ({ status: "PENDING", hash: "a".repeat(64) }),
      getTransaction: async () => ({
        status: stellarSdk.rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: "b".repeat(64),
        ledger: 12345,
        resultXdr: buildTransactionResult(),
        returnValue: xdr.ScVal.scvBool(true)
      })
    }),
    async () => {
      const result = await verifyOnChainResult({
        network: TESTNET,
        keypair: STUB_KEYPAIR,
        calldata: formatProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS)
      });

      assert.ok(result.isOk());
      if (result.isOk()) {
        assert.equal(result.value.verified, true);
      }
    }
  );
});

test("verifyOnChainResult returns Err instead of throwing on a simulation failure", async () => {
  await withStubbedServer(
    () => ({
      getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
      getAccount: async (id: string) => new stellarSdk.Account(id, "0"),
      prepareTransaction: async () => {
        throw new Error("HostError: Error(Contract, #1)");
      }
    }),
    async () => {
      const result = await verifyOnChainResult({
        network: TESTNET,
        keypair: STUB_KEYPAIR,
        calldata: formatProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS)
      });

      assert.ok(result.isErr());
      if (result.isErr()) {
        assert.ok(result.error instanceof SorobanZkError);
        assert.equal(result.error.code, SorobanZkErrorCode.CONTRACT_NOT_INITIALIZED);
      }
    }
  );
});

test("verifyOnChainResult and verifyOnChain are both exported from the SDK entry point", async () => {
  const sdk = await import("../src/index");
  assert.ok("verifyOnChain" in sdk, "verifyOnChain (throwing) still exported, unchanged");
  assert.ok("verifyOnChainResult" in sdk, "verifyOnChainResult (new, additive) exported");
});
