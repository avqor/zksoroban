import { randomBytes } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

import {
  MAINNET,
  NetworkConfig,
  SnarkjsProof,
  TESTNET,
  ZkInputError,
  diffProofs,
  formatProof,
  poseidon,
  verifyViaRegistry
} from "@zksoroban/sdk";

const snarkjs: any = require("snarkjs");

// contracts/registry, not the old single-circuit contracts/verifier — see
// docs/architecture.md#verifying-key-registry. poseidon_preimage is
// registered under circuit ID 1 there.
const TESTNET_REGISTRY_CONTRACT_ID = "CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH";
const POSEIDON_PREIMAGE_CIRCUIT_ID = 1;
// TESTNET/MAINNET (zksoroban#40) supply rpcUrl + networkPassphrase; this demo
// still lets the user pick which network and which registry contract ID at
// runtime, so contractId gets filled in from their answer below rather than
// baked into these two entries.
const NETWORKS: Record<string, NetworkConfig> = {
  testnet: TESTNET,
  mainnet: MAINNET
};
const CONTRACT_PATTERN = /^C[A-Z2-7]{55}$/;

// A syntactically valid field element that is nonetheless rejected: it's
// exactly the BN254 scalar field modulus, so it's "out of range" the same
// way sdk/src/validate.ts's own tests exercise this boundary.
const OUT_OF_FIELD_PUBLIC_INPUT =
  "21888242871839275222246405745257275088548364400416034343698204186575808495617";

interface Answers {
  secret: bigint;
  networkName: string;
  network: NetworkConfig;
  verbosity: "quiet" | "normal" | "verbose";
}

function randomSecret(): bigint {
  return BigInt(`0x${randomBytes(31).toString("hex")}`);
}

function ask(
  rl: readline.Interface,
  label: string,
  def: string | undefined,
  validate: (raw: string) => string | undefined
): Promise<string> {
  const suffix = def !== undefined ? ` [${def}]` : "";

  return new Promise((resolve) => {
    const prompt = (): void => {
      rl.question(`${label}${suffix}: `, (input) => {
        const trimmed = input.trim();
        const value = trimmed === "" && def !== undefined ? def : trimmed;
        const error = validate(value);

        if (error) {
          console.log(`  ${error}`);
          prompt();
          return;
        }

        resolve(value);
      });
    };

    prompt();
  });
}

async function collectAnswers(rl: readline.Interface): Promise<Answers> {
  const secretRaw = await ask(rl, "Secret value (decimal, or 'random')", undefined, (value) => {
    if (value === "") {
      return "Secret cannot be empty.";
    }
    if (value === "random") {
      return undefined;
    }
    if (!/^[0-9]+$/.test(value)) {
      return "Secret must be a decimal number or 'random'.";
    }
    return undefined;
  });

  const network = await ask(rl, "Network (testnet/mainnet)", "testnet", (value) => {
    if (!NETWORKS[value.toLowerCase()]) {
      return "Unknown network. Choose 'testnet' or 'mainnet'.";
    }
    return undefined;
  });

  const contractId = await ask(rl, "Registry contract address", TESTNET_REGISTRY_CONTRACT_ID, (value) => {
    if (!CONTRACT_PATTERN.test(value)) {
      return "Invalid contract address. Expected a 56-character Soroban contract ID starting with 'C'.";
    }
    return undefined;
  });

  const verbosity = await ask(rl, "Verbosity (quiet/normal/verbose)", "normal", (value) => {
    if (!["quiet", "normal", "verbose"].includes(value.toLowerCase())) {
      return "Choose 'quiet', 'normal', or 'verbose'.";
    }
    return undefined;
  });

  const networkName = network.toLowerCase();

  return {
    secret: secretRaw === "random" ? randomSecret() : BigInt(secretRaw),
    networkName,
    network: { ...NETWORKS[networkName], contractId },
    verbosity: verbosity.toLowerCase() as Answers["verbosity"]
  };
}

async function verifyAndReport(opts: {
  proof: SnarkjsProof;
  publicSignals: string[];
  network: NetworkConfig;
  log: (line: string, level?: Answers["verbosity"]) => void;
}): Promise<void> {
  opts.log("simulating verify_proof against the registry...", "verbose");

  const verified = await verifyViaRegistry({
    network: opts.network,
    circuitId: POSEIDON_PREIMAGE_CIRCUIT_ID,
    calldata: formatProof(opts.proof, opts.publicSignals)
  });

  console.log(`✓ Proof verified on-chain: ${verified}`);
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    rl.close();
    console.log("\nAborted.");
    process.exit(0);
  });

  let answers: Answers;
  try {
    answers = await collectAnswers(rl);
  } finally {
    rl.close();
  }

  const log = (line: string, level: Answers["verbosity"] = "normal"): void => {
    const order = { quiet: 0, normal: 1, verbose: 2 };
    if (order[answers.verbosity] >= order[level]) {
      console.log(line);
    }
  };

  const circuitDir = path.resolve(__dirname, "../../circuits/poseidon_preimage");
  const wasmPath = path.join(circuitDir, "build/circuit_js/circuit.wasm");
  const zkeyPath = path.join(circuitDir, "setup/circuit.zkey");

  const commitment = poseidon([answers.secret]);

  log(`secret: ${answers.secret.toString()}`, "verbose");
  log(`network: ${answers.networkName} (${answers.network.rpcUrl})`, "verbose");
  log(`commitment: ${commitment.toString()}`, "normal");
  log("generating proof...", "verbose");

  const input = {
    secret: answers.secret.toString(),
    commitment: commitment.toString()
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);

  console.log("\n=== Scenario 1: success — valid proof ===");
  await verifyAndReport({
    proof,
    publicSignals,
    network: answers.network,
    log
  });

  console.log("\n=== Scenario 2: failure — valid proof, wrong public input ===");
  log(
    "using the same proof, but a different commitment than the one it actually proves",
    "normal"
  );
  log("expected: verified = false (the pairing check rejects it, nothing throws)", "verbose");
  const wrongCommitment = poseidon([answers.secret + 1n]);
  const wrongPublicSignals = [wrongCommitment.toString()];
  await verifyAndReport({
    proof,
    publicSignals: wrongPublicSignals,
    network: answers.network,
    log
  });

  log("diffProofs: comparing the valid calldata against the wrong-public-input calldata", "normal");
  const diff = diffProofs(formatProof(proof, publicSignals), formatProof(proof, wrongPublicSignals));
  if (diff.equal) {
    console.log("  (unexpected: no differences found)");
  } else {
    for (const d of diff.differences) {
      console.log(`  ${d.field}: expected ${d.expectedHex}`);
      console.log(`  ${" ".repeat(d.field.length)}  actual   ${d.actualHex} (first differing byte: ${d.firstDifferentByte})`);
    }
  }

  console.log("\n=== Scenario 3: failure — malformed public input ===");
  log("a public input at or beyond the BN254 field modulus is rejected before any network call", "normal");
  try {
    formatProof(proof, [OUT_OF_FIELD_PUBLIC_INPUT]);
    console.log("(unexpected: formatProof did not throw)");
  } catch (error) {
    if (!(error instanceof ZkInputError)) {
      throw error;
    }
    console.log("✗ formatProof threw ZkInputError, as expected:");
    console.log(`  code: ${error.code}`);
    console.log(`  message: ${error.message}`);
  }
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
