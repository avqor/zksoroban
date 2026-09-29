/**
 * Standalone example: estimate the fee of a verify_proof call before
 * submitting it.
 *
 * Unlike run.ts (which now only exercises success/failure scenarios), this
 * script signs and submits a real transaction, so it needs a funded Testnet
 * account. It generates one proof and shows both steps of the fee-aware
 * flow this SDK enables:
 *
 *   1. estimateVerifyFee — a dry-run via simulateTransaction. No signing,
 *      no submission, no cost.
 *   2. verifyOnChain — the real signed-and-submitted call, so you can
 *      compare the estimate against the fee actually charged.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";

import { Keypair } from "@stellar/stellar-sdk";

import { ProofBundle, TESTNET, estimateVerifyFee, poseidon, verifyOnChain } from "@zksoroban/sdk";

const snarkjs: any = require("snarkjs");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function randomSecret(): bigint {
  return BigInt(`0x${randomBytes(31).toString("hex")}`);
}

async function main(): Promise<void> {
  const secretKey = requireEnv("SOROBAN_SECRET_KEY");
  const keypair = Keypair.fromSecret(secretKey);

  const circuitDir = path.resolve(__dirname, "../../circuits/poseidon_preimage");
  const wasmPath = path.join(circuitDir, "build/circuit_js/circuit.wasm");
  const zkeyPath = path.join(circuitDir, "setup/circuit.zkey");

  const secret = randomSecret();
  const commitment = poseidon([secret]);

  console.log(`secret: ${secret.toString()}`);
  console.log(`commitment: ${commitment.toString()}`);
  console.log("generating proof...");

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { secret: secret.toString(), commitment: commitment.toString() },
    wasmPath,
    zkeyPath
  );

  const bundle: ProofBundle = {
    proof,
    publicSignals,
    circuit: "poseidon_preimage",
    generatedAt: new Date().toISOString(),
    networkPassphrase: TESTNET.networkPassphrase
  };

  const opts = { network: TESTNET, keypair, bundle };

  console.log("\n=== Step 1: estimate the fee (simulateTransaction — nothing submitted) ===");
  const { stroops, xlm } = await estimateVerifyFee(opts);
  console.log(`estimated fee: ${xlm} XLM (${stroops} stroops)`);

  console.log("\n=== Step 2: submit the real transaction ===");
  const result = await verifyOnChain(opts);
  console.log(`txHash: ${result.txHash}`);
  console.log(`actual fee charged: ${result.fee} stroops`);
  console.log(`✓ Proof verified on-chain: ${result.verified}`);
}

void main().catch((error) => {
  // CodeQL's js/clear-text-logging flags this: a NetworkMismatchError's
  // message can include a network passphrase (e.g. "Test SDF Network ;
  // September 2015"). That's a public network identifier shipped in every
  // Stellar SDK release, not a credential, so the alert is a false
  // positive — dismissed on the relevant PR rather than suppressed inline,
  // since CodeQL doesn't honor `codeql[rule-id]` comments for this query.
  console.error(error);
  process.exit(1);
});
