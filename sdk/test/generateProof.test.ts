/**
 * Unit tests for generateProof() (the `@zksoroban/sdk/browser` entry point).
 *
 * generateProof takes wasm/zkey bytes as Uint8Array rather than file paths.
 * The input-validation tests below don't need a real circuit — they pass
 * placeholder bytes and assert generateProof rejects before ever touching
 * snarkjs. The two tests that generate a real proof need the
 * poseidon_preimage circuit's compiled `.wasm`, which (like the demo, see
 * demo/README.md) is a gitignored build artifact produced by running
 * `circom`, not something checked into the repo or built by CI — so those
 * are skipped, the same way verify.integration.ts skips when Testnet
 * credentials aren't set, when that file isn't present locally.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { generateProof } from "../src/browser";
import { poseidon } from "../src/poseidon";
import { SorobanZkError, SorobanZkErrorCode, ZkInputError } from "../src/types";

const CIRCUIT_DIR = path.resolve(__dirname, "../../circuits/poseidon_preimage");
const WASM_PATH = path.join(CIRCUIT_DIR, "build/circuit_js/circuit.wasm");
const ZKEY_PATH = path.join(CIRCUIT_DIR, "setup/circuit.zkey");

function loadCircuitBytes(): { wasm: Uint8Array; zkey: Uint8Array } {
  return {
    wasm: new Uint8Array(fs.readFileSync(WASM_PATH)),
    zkey: new Uint8Array(fs.readFileSync(ZKEY_PATH))
  };
}

test("generateProof rejects a non-bigint secret", async () => {
  await assert.rejects(
    generateProof("12345" as unknown as bigint, 1n, new Uint8Array(), new Uint8Array()),
    (err: unknown) => err instanceof ZkInputError && err.field === "secret"
  );
});

test("generateProof rejects a non-bigint commitment", async () => {
  await assert.rejects(
    generateProof(1n, "1" as unknown as bigint, new Uint8Array(), new Uint8Array()),
    (err: unknown) => err instanceof ZkInputError && err.field === "commitment"
  );
});

test("generateProof rejects a non-Uint8Array wasm", async () => {
  await assert.rejects(
    generateProof(1n, 1n, "not-bytes" as unknown as Uint8Array, new Uint8Array()),
    (err: unknown) => err instanceof ZkInputError && err.field === "wasm"
  );
});

test("generateProof rejects a non-Uint8Array zkey", async () => {
  await assert.rejects(
    generateProof(1n, 1n, new Uint8Array(), "not-bytes" as unknown as Uint8Array),
    (err: unknown) => err instanceof ZkInputError && err.field === "zkey"
  );
});

test("the browser entry point exports generateProof and the shared error types, and nothing else Node-only", async () => {
  const browserEntry = await import("../src/browser");

  assert.ok("generateProof" in browserEntry, "generateProof exported");
  assert.ok("SorobanZkError" in browserEntry, "SorobanZkError exported");
  assert.ok("SorobanZkErrorCode" in browserEntry, "SorobanZkErrorCode exported");
  assert.ok("ZkInputError" in browserEntry, "ZkInputError exported");
  assert.ok(!("poseidon" in browserEntry), "poseidon (fs-based) is not exported from the browser entry");
  assert.ok(!("verifyOnChain" in browserEntry), "verifyOnChain (@stellar/stellar-sdk) is not exported from the browser entry");
});

if (!fs.existsSync(WASM_PATH)) {
  test.skip(
    "generateProof real-proof tests require circuits/poseidon_preimage/build/circuit_js/circuit.wasm " +
      "— run `circom circuit.circom --r1cs --wasm --sym -o build -l ../../demo/node_modules` " +
      "from circuits/poseidon_preimage first (see demo/README.md)"
  );
} else {
  test("generateProof produces a valid groth16 proof from Uint8Array wasm/zkey bytes", async () => {
    const { wasm, zkey } = loadCircuitBytes();
    const secret = 12345n;
    const commitment = poseidon([secret]);

    const { proof, publicSignals } = await generateProof(secret, commitment, wasm, zkey);

    assert.equal(proof.protocol, "groth16");
    assert.equal(proof.pi_a.length, 3);
    assert.equal(proof.pi_b.length, 3);
    assert.equal(proof.pi_c.length, 3);
    assert.deepEqual(publicSignals, [commitment.toString()]);
  });

  test("generateProof throws PROOF_GENERATION_FAILED when commitment doesn't match the secret", async () => {
    const { wasm, zkey } = loadCircuitBytes();
    const secret = 12345n;
    const wrongCommitment = poseidon([secret + 1n]);

    await assert.rejects(
      generateProof(secret, wrongCommitment, wasm, zkey),
      (err: unknown) => {
        assert.ok(err instanceof SorobanZkError);
        assert.equal(err.code, SorobanZkErrorCode.PROOF_GENERATION_FAILED);
        return true;
      }
    );
  });

  test("generateProof emits witness_start, witness_done, proof_start, proof_done in order", async () => {
    const { wasm, zkey } = loadCircuitBytes();
    const secret = 12345n;
    const commitment = poseidon([secret]);
    const stages: string[] = [];

    await generateProof(secret, commitment, wasm, zkey, (stage) => {
      stages.push(stage);
    });

    assert.deepEqual(stages, ["witness_start", "witness_done", "proof_start", "proof_done"]);
  });

  test("generateProof does not abort when onProgress itself throws", async () => {
    const { wasm, zkey } = loadCircuitBytes();
    const secret = 12345n;
    const commitment = poseidon([secret]);

    const { proof, publicSignals } = await generateProof(secret, commitment, wasm, zkey, () => {
      throw new Error("boom");
    });

    assert.equal(proof.protocol, "groth16");
    assert.deepEqual(publicSignals, [commitment.toString()]);
  });
}
