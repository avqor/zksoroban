// sdk/test/validate.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import { formatProof } from "../src/proof";
import { verifyOnChain } from "../src/verify";
import { SorobanZkError, SorobanZkErrorCode, ZkInputError } from "../src/types";
import { validateCalldata, validateProofInput } from "../src/validate";
import { Keypair } from "@stellar/stellar-sdk";
import { VALID_PUBLIC_SIGNALS, VALID_SNARKJS_PROOF, calldataBuffersFromHex } from "./fixtures";

const OVER_FIELD =
  "21888242871839275222246405745257275088548364400416034343698204186575808495617";
const OVER_32_BYTES =
  "115792089237316195423570985008687907853269984665640564039457584007913129639936";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("formatProof throws ZkInputError with field and reason on invalid input", () => {
  const proof = clone(VALID_SNARKJS_PROOF);
  proof.pi_a[0] = "not-a-number";

  assert.throws(
    () => formatProof(proof, VALID_PUBLIC_SIGNALS),
    (error: unknown) =>
      error instanceof ZkInputError &&
      error.field === "pi_a[0]" &&
      error.reason === "is not a decimal string"
  );
});

test("ZkInputError is also a SorobanZkError so existing callers keep working", () => {
  const proof = clone(VALID_SNARKJS_PROOF);
  proof.pi_a[0] = "not-a-number";

  assert.throws(
    () => formatProof(proof, VALID_PUBLIC_SIGNALS),
    (error: unknown) =>
      error instanceof SorobanZkError &&
      error.code === SorobanZkErrorCode.INVALID_PROOF_FORMAT
  );
});

test("invalid shape 1: pi_a wrong array length", () => {
  const proof = clone(VALID_SNARKJS_PROOF) as any;
  proof.pi_a = ["1"];

  assert.throws(
    () => validateProofInput(proof, VALID_PUBLIC_SIGNALS),
    (error: unknown) =>
      error instanceof ZkInputError &&
      error.field === "pi_a" &&
      error.reason.includes("at least 2 elements")
  );
});

test("invalid shape 2: pi_a element is not a string", () => {
  const proof = clone(VALID_SNARKJS_PROOF) as any;
  proof.pi_a[0] = 42;

  assert.throws(
    () => validateProofInput(proof, VALID_PUBLIC_SIGNALS),
    (error: unknown) =>
      error instanceof ZkInputError &&
      error.field === "pi_a[0]" &&
      error.reason === "is not a string (received number)"
  );
});

test("invalid shape 3: pi_b[1][0] is not a decimal string (exact field path)", () => {
  const proof = clone(VALID_SNARKJS_PROOF);
  proof.pi_b[1][0] = "0xdeadbeef";

  assert.throws(
    () => validateProofInput(proof, VALID_PUBLIC_SIGNALS),
    (error: unknown) =>
      error instanceof ZkInputError &&
      error.field === "pi_b[1][0]" &&
      error.message === "pi_b[1][0] is not a decimal string"
  );
});

test("invalid shape 4: pi_c element exceeds the BN254 field size", () => {
  const proof = clone(VALID_SNARKJS_PROOF);
  proof.pi_c[1] = OVER_FIELD;

  assert.throws(
    () => validateProofInput(proof, VALID_PUBLIC_SIGNALS),
    (error: unknown) =>
      error instanceof ZkInputError &&
      error.field === "pi_c[1]" &&
      error.reason === "exceeds the BN254 field size"
  );
});

test("invalid shape 5: publicSignals is not an array", () => {
  assert.throws(
    () => validateProofInput(VALID_SNARKJS_PROOF, "nope" as unknown as string[]),
    (error: unknown) =>
      error instanceof ZkInputError &&
      error.field === "publicSignals" &&
      error.code === SorobanZkErrorCode.INVALID_PUBLIC_INPUT
  );
});

test("invalid shape 6: public input does not fit in 32 bytes", () => {
  assert.throws(
    () => validateProofInput(VALID_SNARKJS_PROOF, [OVER_32_BYTES]),
    (error: unknown) =>
      error instanceof ZkInputError &&
      error.field === "publicSignals[0]" &&
      error.reason === "does not fit in 32 bytes"
  );
});

test("invalid shape 7: pi_b row is not an array", () => {
  const proof = clone(VALID_SNARKJS_PROOF) as any;
  proof.pi_b[1] = "not-a-row";

  assert.throws(
    () => validateProofInput(proof, VALID_PUBLIC_SIGNALS),
    (error: unknown) =>
      error instanceof ZkInputError && error.field === "pi_b[1]"
  );
});

test("verifyOnChain validates calldata before any network call", async () => {
  const calldata = calldataBuffersFromHex();
  calldata.proofA = Buffer.alloc(10);

  await assert.rejects(
    () =>
      verifyOnChain({
        network: {
          rpcUrl: "http://127.0.0.1:1",
          networkPassphrase: "Test SDF Network ; September 2015",
          contractId: "CBL6MAWJALQP25LYKUUOC34K464XPSF6BLKUW6MXZDEXEDXMQUSP7HNN"
        },
        keypair: Keypair.random(),
        calldata
      }),
    (error: unknown) =>
      error instanceof ZkInputError &&
      error.field === "calldata.proofA" &&
      error.reason === "must be 64 bytes (received 10)"
  );
});

test("validateCalldata accepts well-formed calldata", () => {
  assert.doesNotThrow(() => validateCalldata(calldataBuffersFromHex()));
});
