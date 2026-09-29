import assert from "node:assert/strict";
import test from "node:test";

import {
  deserializeProof,
  serializeProof,
  SERIALIZED_PROOF_FORMAT_VERSION
} from "../src/serialize";
import { SorobanZkError, SorobanZkErrorCode } from "../src/types";
import { VALID_PUBLIC_SIGNALS, VALID_SNARKJS_PROOF } from "./fixtures";

test("serializeProof produces a deterministic byte array for the same inputs", () => {
  const first = serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);
  const second = serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);

  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});

test("serializeProof's first two bytes are the format version", () => {
  const bytes = Buffer.from(serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS));

  assert.equal(bytes.readUInt16BE(0), SERIALIZED_PROOF_FORMAT_VERSION);
});

test("deserializeProof(serializeProof(p, s)) round-trips without data loss", () => {
  const bytes = serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);
  const { proof, publicSignals } = deserializeProof(bytes);

  assert.deepEqual(proof, VALID_SNARKJS_PROOF);
  assert.deepEqual(publicSignals, VALID_PUBLIC_SIGNALS);
});

test("round-trip preserves multiple public signals, including zero of them", () => {
  const manySignals = ["1", "2", "3", "4"];
  const roundTrippedMany = deserializeProof(serializeProof(VALID_SNARKJS_PROOF, manySignals));
  assert.deepEqual(roundTrippedMany.publicSignals, manySignals);

  const roundTrippedNone = deserializeProof(serializeProof(VALID_SNARKJS_PROOF, []));
  assert.deepEqual(roundTrippedNone.publicSignals, []);
});

test("serialized size matches the documented fixed-overhead-plus-per-signal formula", () => {
  const bytes = serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);

  // 2 (version) + 4 (length prefix) + 12 * 32 (pi_a/pi_b/pi_c) + 32 per signal
  const expected = 2 + 4 + 12 * 32 + VALID_PUBLIC_SIGNALS.length * 32;
  assert.equal(bytes.length, expected);
});

test("deserializeProof rejects a version it doesn't recognize", () => {
  const bytes = Buffer.from(serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS));
  bytes.writeUInt16BE(SERIALIZED_PROOF_FORMAT_VERSION + 1, 0);

  assert.throws(
    () => deserializeProof(bytes),
    (err: unknown) => {
      assert.ok(err instanceof SorobanZkError);
      assert.equal(err.code, SorobanZkErrorCode.SERIALIZED_PROOF_VERSION_MISMATCH);
      return true;
    }
  );
});

test("deserializeProof rejects bytes too short to hold a header", () => {
  assert.throws(
    () => deserializeProof(new Uint8Array([0, 1, 0])),
    (err: unknown) => {
      assert.ok(err instanceof SorobanZkError);
      assert.equal(err.code, SorobanZkErrorCode.CORRUPTED_SERIALIZED_PROOF);
      return true;
    }
  );
});

test("deserializeProof rejects a truncated body", () => {
  const bytes = Buffer.from(serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS));
  const truncated = bytes.subarray(0, bytes.length - 10);

  assert.throws(
    () => deserializeProof(truncated),
    (err: unknown) => {
      assert.ok(err instanceof SorobanZkError);
      assert.equal(err.code, SorobanZkErrorCode.CORRUPTED_SERIALIZED_PROOF);
      return true;
    }
  );
});

test("deserializeProof rejects extra trailing bytes appended after a valid body", () => {
  const bytes = Buffer.from(serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS));
  const padded = Buffer.concat([bytes, Buffer.from([0xde, 0xad])]);

  assert.throws(
    () => deserializeProof(padded),
    (err: unknown) => {
      assert.ok(err instanceof SorobanZkError);
      assert.equal(err.code, SorobanZkErrorCode.CORRUPTED_SERIALIZED_PROOF);
      return true;
    }
  );
});

test("deserializeProof accepts a plain Uint8Array, not just a Buffer", () => {
  const bytes = serializeProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);
  const plain = new Uint8Array(bytes);

  assert.ok(!Buffer.isBuffer(plain));
  const { proof, publicSignals } = deserializeProof(plain);
  assert.deepEqual(proof, VALID_SNARKJS_PROOF);
  assert.deepEqual(publicSignals, VALID_PUBLIC_SIGNALS);
});

test("serializeProof rejects a proof missing its projective z-coordinate", () => {
  const twoElementProof = {
    ...VALID_SNARKJS_PROOF,
    pi_a: [VALID_SNARKJS_PROOF.pi_a[0], VALID_SNARKJS_PROOF.pi_a[1]] as unknown as [
      string,
      string,
      string
    ]
  };

  assert.throws(
    () => serializeProof(twoElementProof, VALID_PUBLIC_SIGNALS),
    (err: unknown) => {
      assert.ok(err instanceof SorobanZkError);
      assert.equal(err.code, SorobanZkErrorCode.INVALID_PROOF_FORMAT);
      return true;
    }
  );
});

test("serializeProof rejects a non-groth16 proof", () => {
  const badProtocol = { ...VALID_SNARKJS_PROOF, protocol: "plonk" as "groth16" };

  assert.throws(() => serializeProof(badProtocol, VALID_PUBLIC_SIGNALS), SorobanZkError);
});
