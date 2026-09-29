import fs from "node:fs";
import path from "node:path";

import { MAINNET, NetworkConfig, SnarkjsProof, TESTNET, verifyBatchViaRegistry } from "@zksoroban/sdk";

// Same live deployment demo/src/run.ts targets — see
// docs/architecture.md#verifying-key-registry. Only poseidon_preimage
// (circuit ID 1) is registered there today; the other three circuits are
// registered in contracts/registry/src/tests.rs's in-process test env, but
// not yet on the shared live deployment (registering there needs the
// registry's admin key, a maintainer action — see docs/multi-circuit.md).
const TESTNET_REGISTRY_CONTRACT_ID = "CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH";
const NETWORKS: Record<string, NetworkConfig> = {
  testnet: TESTNET,
  mainnet: MAINNET
};

// Matches contracts/registry/src/tests.rs's own circuit ID scheme, so a
// registry set up by registering those same fixtures the same way "just
// works" against this script's defaults.
const RANGE_PROOF_CIRCUIT_ID = Number(process.env.SOROBAN_RANGE_PROOF_CIRCUIT_ID ?? 2);
const THRESHOLD_2OF3_CIRCUIT_ID = Number(process.env.SOROBAN_THRESHOLD_2OF3_CIRCUIT_ID ?? 3);
const MERKLE_INCLUSION_CIRCUIT_ID = Number(process.env.SOROBAN_MERKLE_INCLUSION_CIRCUIT_ID ?? 4);

interface FixtureProof {
  proof: SnarkjsProof;
  publicSignals: string[];
}

// range_proof, threshold_2of3, and merkle_inclusion all ship a
// circuits/<name>/fixtures/{proof,public}.json pair — a real, previously
// generated Groth16 proof and its public signals, produced by circom +
// snarkjs against that circuit's own trusted setup. Loading these directly
// means this script needs no circom toolchain and no witness generation,
// unlike demo/src/run.ts's poseidon_preimage flow, which proves fresh from a
// user-supplied secret every run.
function loadFixture(circuit: string): FixtureProof {
  const dir = path.resolve(__dirname, `../../circuits/${circuit}/fixtures`);
  const proof = JSON.parse(fs.readFileSync(path.join(dir, "proof.json"), "utf8")) as SnarkjsProof;
  const publicSignals = JSON.parse(
    fs.readFileSync(path.join(dir, "public.json"), "utf8")
  ) as string[];
  return { proof, publicSignals };
}

async function main(): Promise<void> {
  const networkName = (process.env.SOROBAN_NETWORK ?? "testnet").toLowerCase();
  const networkPreset = NETWORKS[networkName];
  if (!networkPreset) {
    throw new Error(`Unknown SOROBAN_NETWORK "${networkName}". Expected "testnet" or "mainnet".`);
  }

  const registryContractId =
    process.env.SOROBAN_TEST_REGISTRY_CONTRACT_ID ?? TESTNET_REGISTRY_CONTRACT_ID;
  const targetsTestRegistry = Boolean(process.env.SOROBAN_TEST_REGISTRY_CONTRACT_ID);

  if (!targetsTestRegistry) {
    console.log(
      "SOROBAN_TEST_REGISTRY_CONTRACT_ID is not set, so this run targets the live " +
        `Testnet registry (${TESTNET_REGISTRY_CONTRACT_ID}), which today only has ` +
        "poseidon_preimage (circuit ID 1) registered — not range_proof/" +
        "threshold_2of3/merkle_inclusion (IDs 2/3/4), which is what this batch " +
        "asks about. Every result below is expected to come back `false` against " +
        "that deployment; that's the registry correctly reporting 'unknown " +
        "circuit', not a bug in verify_batch.\n" +
        "To see real `true` results, register those three circuits' verifying " +
        "keys (see docs/multi-circuit.md and sdk/src/proof.ts's " +
        "formatVerifyingKey) with a registry instance of your own, and point " +
        "SOROBAN_TEST_REGISTRY_CONTRACT_ID at it.\n"
    );
  }

  const rangeProof = loadFixture("range_proof");
  const threshold2of3 = loadFixture("threshold_2of3");
  const merkleInclusion = loadFixture("merkle_inclusion");

  console.log(
    `Batch-verifying 3 proofs across 3 circuit IDs (${RANGE_PROOF_CIRCUIT_ID}, ` +
      `${THRESHOLD_2OF3_CIRCUIT_ID}, ${MERKLE_INCLUSION_CIRCUIT_ID}) against ` +
      `${registryContractId} in one call...`
  );

  const results = await verifyBatchViaRegistry({
    network: { ...networkPreset, contractId: registryContractId },
    items: [
      { circuitId: RANGE_PROOF_CIRCUIT_ID, ...rangeProof },
      { circuitId: THRESHOLD_2OF3_CIRCUIT_ID, ...threshold2of3 },
      { circuitId: MERKLE_INCLUSION_CIRCUIT_ID, ...merkleInclusion }
    ]
  });

  console.log("Results (in order):", results);

  if (targetsTestRegistry) {
    const allVerified = results.every(Boolean);
    if (!allVerified) {
      console.error(
        "✗ Expected all 3 proofs to verify true against the configured test " +
          "registry — check that range_proof/threshold_2of3/merkle_inclusion " +
          "are registered there under the circuit IDs this script used."
      );
      process.exit(1);
    }
    console.log("✓ All 3 proofs verified true, across 3 circuit IDs, in a single batch call.");
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
