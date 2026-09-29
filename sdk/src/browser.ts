// sdk/src/browser.ts
//
// Browser-safe entry point (published as `@zksoroban/sdk/browser`). Only
// code that can run without Node's fs/path/process — generateProof and the
// plain data types/errors needed to work with its result — is exported here.
// verify.ts, poseidon.ts and cli.ts stay out: they read files or shell out
// via Node-only APIs and don't belong in a browser bundle.
import {
  emitProofStage,
  OnProofProgress,
  SnarkjsProof,
  SorobanZkError,
  SorobanZkErrorCode,
  ZkInputError
} from "./types.js";

// A "mem"-type snarkjs witness handle: wtns.calculate mutates this object
// in place to attach the computed witness bytes, and groth16.prove reads
// it back out — the same in-memory handoff groth16.fullProve uses
// internally between its own two stages. See generateProof below.
interface SnarkjsMemWitness {
  type: "mem";
  data?: Uint8Array;
}

interface SnarkjsModule {
  wtns: {
    calculate(input: Record<string, unknown>, wasm: Uint8Array, wtns: SnarkjsMemWitness): Promise<void>;
  };
  groth16: {
    prove(
      zkey: Uint8Array,
      wtns: SnarkjsMemWitness
    ): Promise<{ proof: SnarkjsProof; publicSignals: string[] }>;
  };
}

export interface GenerateProofResult {
  proof: SnarkjsProof;
  publicSignals: string[];
}

/**
 * Generate a Groth16 proof for the `poseidon_preimage` circuit entirely
 * in-memory, from `.wasm`/`.zkey` bytes supplied as `Uint8Array` — no
 * filesystem access, so this runs the same way in a browser as it does in
 * Node.
 *
 * snarkjs is loaded via a lazy dynamic `import()` (the same pattern
 * {@link verifyOffChain} uses) so bundlers can tree-shake it out of code
 * paths that never call `generateProof`, and so that when this module is
 * bundled for the web (see `sdk/vite.config.mts`), snarkjs's own `browser`
 * package export condition resolves automatically.
 *
 * `onProgress`, if given, is called around the two stages this function
 * actually performs separately under the hood — `witness_start`/
 * `witness_done` around WASM witness computation, then `proof_start`/
 * `proof_done` around Groth16 proving itself (zksoroban#29). These are
 * genuinely the two slow, separately-timed steps `snarkjs.groth16.fullProve`
 * normally combines into one opaque call; this function calls
 * `snarkjs.wtns.calculate` and `snarkjs.groth16.prove` directly instead,
 * the same two calls `fullProve` makes internally, to get real hook points
 * between them rather than fabricated timing. Any error `onProgress` itself
 * throws is caught and ignored — a broken progress callback must never
 * abort proof generation.
 *
 * @example
 * ```ts
 * const wasm = new Uint8Array(await (await fetch("/circuit.wasm")).arrayBuffer());
 * const zkey = new Uint8Array(await (await fetch("/circuit.zkey")).arrayBuffer());
 * const { proof, publicSignals } = await generateProof(secret, commitment, wasm, zkey, (stage) => {
 *   console.log(stage); // "witness_start", "witness_done", "proof_start", "proof_done"
 * });
 * ```
 */
export async function generateProof(
  secret: bigint,
  commitment: bigint,
  wasm: Uint8Array,
  zkey: Uint8Array,
  onProgress?: OnProofProgress
): Promise<GenerateProofResult> {
  if (typeof secret !== "bigint") {
    throw new ZkInputError("secret", `must be a bigint (received ${typeof secret})`);
  }

  if (typeof commitment !== "bigint") {
    throw new ZkInputError("commitment", `must be a bigint (received ${typeof commitment})`);
  }

  if (!(wasm instanceof Uint8Array)) {
    throw new ZkInputError("wasm", `must be a Uint8Array (received ${typeof wasm})`);
  }

  if (!(zkey instanceof Uint8Array)) {
    throw new ZkInputError("zkey", `must be a Uint8Array (received ${typeof zkey})`);
  }

  const snarkjs: SnarkjsModule = await import("snarkjs");

  try {
    const input = { secret: secret.toString(), commitment: commitment.toString() };
    const wtns: SnarkjsMemWitness = { type: "mem" };

    emitProofStage(onProgress, "witness_start");
    await snarkjs.wtns.calculate(input, wasm, wtns);
    emitProofStage(onProgress, "witness_done");

    emitProofStage(onProgress, "proof_start");
    const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, wtns);
    emitProofStage(onProgress, "proof_done");

    return { proof, publicSignals };
  } catch (error) {
    throw new SorobanZkError(
      error instanceof Error ? error.message : String(error),
      SorobanZkErrorCode.PROOF_GENERATION_FAILED
    );
  }
}

export { emitProofStage, SorobanZkError, SorobanZkErrorCode, ZkInputError };
export type { OnProofProgress, ProofStage, SnarkjsProof } from "./types.js";
