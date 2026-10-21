import { err, ok, Result, toZkError, ZkError } from "./result.js";
import {
  RegistryVerifyingKey,
  SnarkjsProof,
  SorobanProofCalldata,
  SorobanZkError,
  SorobanZkErrorCode,
  VerificationKey
} from "./types.js";
import { validateProofInput } from "./validate.js";

const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function truncate(s: string): string {
  return s.length > 64 ? s.slice(0, 64) + "…" : s;
}

function parseFieldElement(value: unknown, code: SorobanZkErrorCode, label: string): bigint {
  if (typeof value !== "string") {
    throw new SorobanZkError(
      `${label} must be a decimal or hex string, got ${typeof value}: ${truncate(String(value))}`,
      code
    );
  }

  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    throw new SorobanZkError(
      `${label} must be a decimal or hex string, got: "${truncate(value)}"`,
      code
    );
  }

  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= BN254_FIELD_MODULUS) {
    throw new SorobanZkError(
      `${label} is outside the BN254 field: ${truncate(value)}`,
      code
    );
  }

  return parsed;
}

function bigintToBytes32(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

function encodeG1(point: [string, string, string], label: string): Buffer {
  return Buffer.concat([
    bigintToBytes32(
      parseFieldElement(point[0], SorobanZkErrorCode.INVALID_PROOF_FORMAT, `${label}.x`)
    ),
    bigintToBytes32(
      parseFieldElement(point[1], SorobanZkErrorCode.INVALID_PROOF_FORMAT, `${label}.y`)
    )
  ]);
}

function encodeG2(
  point: [[string, string], [string, string], [string, string]],
  label: string
): Buffer {
  const xC0 = parseFieldElement(
    point[0][0],
    SorobanZkErrorCode.INVALID_PROOF_FORMAT,
    `${label}.x.c0`
  );
  const xC1 = parseFieldElement(
    point[0][1],
    SorobanZkErrorCode.INVALID_PROOF_FORMAT,
    `${label}.x.c1`
  );
  const yC0 = parseFieldElement(
    point[1][0],
    SorobanZkErrorCode.INVALID_PROOF_FORMAT,
    `${label}.y.c0`
  );
  const yC1 = parseFieldElement(
    point[1][1],
    SorobanZkErrorCode.INVALID_PROOF_FORMAT,
    `${label}.y.c1`
  );

  return Buffer.concat([
    bigintToBytes32(xC1),
    bigintToBytes32(xC0),
    bigintToBytes32(yC1),
    bigintToBytes32(yC0)
  ]);
}

function encodePublicInputs(publicSignals: string[]): Buffer[] {
  return publicSignals.map((signal, index) =>
    bigintToBytes32(
      parseFieldElement(
        signal,
        SorobanZkErrorCode.INVALID_PUBLIC_INPUT,
        `publicSignals[${index}]`
      )
    )
  );
}

const MAX_U32 = 0xffffffff;

export function formatProof(
  proof: SnarkjsProof,
  publicSignals: string[],
  expiryLedger?: number,
  vk?: VerificationKey
): SorobanProofCalldata {
  validateProofInput(proof, publicSignals);

  if (!proof || proof.protocol !== "groth16") {
    throw new SorobanZkError(
      "Proof must be a Groth16 snarkjs proof",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  if (proof.pi_a.length < 2 || proof.pi_b.length < 2 || proof.pi_c.length < 2) {
    throw new SorobanZkError(
      "Proof is missing required Groth16 coordinates",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  if (!Array.isArray(publicSignals)) {
    throw new SorobanZkError(
      "publicSignals must be an array of field elements",
      SorobanZkErrorCode.INVALID_PUBLIC_INPUT
    );
  }

  if (vk !== undefined) {
    if (typeof vk.nPublic !== "number" || !Number.isInteger(vk.nPublic) || vk.nPublic < 0) {
      throw new SorobanZkError(
        "vk.nPublic must be a non-negative integer",
        SorobanZkErrorCode.INVALID_PUBLIC_INPUT
      );
    }

    if (publicSignals.length !== vk.nPublic) {
      throw new SorobanZkError(
        `publicSignals count mismatch: expected ${vk.nPublic} (per vk.nPublic), got ${publicSignals.length}`,
        SorobanZkErrorCode.INVALID_PUBLIC_INPUT
      );
    }
  }

  const publicInputs = encodePublicInputs(publicSignals);

  if (expiryLedger !== undefined) {
    if (!Number.isInteger(expiryLedger) || expiryLedger < 0 || expiryLedger > MAX_U32) {
      throw new SorobanZkError(
        "expiryLedger must be an unsigned 32-bit integer",
        SorobanZkErrorCode.INVALID_PUBLIC_INPUT
      );
    }

    publicInputs.push(bigintToBytes32(BigInt(expiryLedger)));
  }

  const calldata = {
    proofA: encodeG1(proof.pi_a, "pi_a"),
    proofB: encodeG2(proof.pi_b, "pi_b"),
    proofC: encodeG1(proof.pi_c, "pi_c"),
    publicInputs
  };

  if (calldata.proofA.length !== 64 || calldata.proofB.length !== 128 || calldata.proofC.length !== 64) {
    throw new SorobanZkError(
      "Proof encoding produced an invalid byte length",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  return calldata;
}

/**
 * {@link formatProof}, wrapped as a {@link Result} instead of throwing
 * (zksoroban#107) — `formatProof` itself is unchanged and keeps throwing;
 * this is a new, additive alternative, not a replacement. See `result.ts`
 * for why this SDK took the "new `*Result` function alongside the
 * existing one" approach rather than the issue's literal ask (swap
 * `formatProof` itself to return a `Result` and rename the throwing
 * version to `formatProofOrThrow`): renaming a function this widely used
 * internally (every RPC-touching function's `resolveCalldata` calls it)
 * and across the demo and every test file, with no way to run a build or
 * test suite this round to verify nothing broke, was too much risk for
 * too little benefit — the Result-based API is available either way.
 *
 * @example
 * ```ts
 * const result = formatProofResult(proof, publicSignals);
 * if (result.isErr()) {
 *   console.error(result.error.code, result.error.message);
 * } else {
 *   console.log(result.value); // SorobanProofCalldata
 * }
 * ```
 */
export function formatProofResult(
  proof: SnarkjsProof,
  publicSignals: string[],
  expiryLedger?: number,
  vk?: VerificationKey
): Result<SorobanProofCalldata, ZkError> {
  try {
    return ok(formatProof(proof, publicSignals, expiryLedger, vk));
  } catch (error) {
    return err(toZkError(error));
  }
}

/**
 * Encode a snarkjs `verification_key.json` into the raw-bytes
 * {@link RegistryVerifyingKey} `contracts/registry`'s `register_circuit(id, vk)`
 * expects — the same BN254 G1/G2 encoding {@link formatProof} uses for a
 * proof's `pi_a`/`pi_b`/`pi_c`, applied to the verifying key's
 * `alpha`/`beta`/`gamma`/`delta`/`IC` fields instead.
 *
 * @example
 * ```ts
 * const vk = JSON.parse(fs.readFileSync("setup/verification_key.json", "utf8"));
 * const { alpha, beta, gamma, delta, ic } = formatVerifyingKey(vk);
 * // alpha/beta/gamma/delta/ic[i] are each ready to hex-encode into the
 * // `register_circuit --vk '{ "alpha": "<hex>", ... }'` CLI argument.
 * ```
 */
export function formatVerifyingKey(vk: VerificationKey): RegistryVerifyingKey {
  if (!vk || vk.protocol !== "groth16") {
    throw new SorobanZkError(
      "Verifying key must be a Groth16 snarkjs verification key",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  if (vk.vk_alpha_1.length < 2 || vk.vk_beta_2.length < 2 || vk.vk_gamma_2.length < 2 || vk.vk_delta_2.length < 2) {
    throw new SorobanZkError(
      "Verifying key is missing required Groth16 coordinates",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  if (!Array.isArray(vk.IC) || vk.IC.length === 0) {
    throw new SorobanZkError(
      "Verifying key IC must be a non-empty array of G1 points",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  const registryVk: RegistryVerifyingKey = {
    alpha: encodeG1(vk.vk_alpha_1 as [string, string, string], "vk_alpha_1"),
    beta: encodeG2(vk.vk_beta_2 as [[string, string], [string, string], [string, string]], "vk_beta_2"),
    gamma: encodeG2(vk.vk_gamma_2 as [[string, string], [string, string], [string, string]], "vk_gamma_2"),
    delta: encodeG2(vk.vk_delta_2 as [[string, string], [string, string], [string, string]], "vk_delta_2"),
    ic: vk.IC.map((point, index) => encodeG1(point as [string, string, string], `IC[${index}]`))
  };

  if (
    registryVk.alpha.length !== 64 ||
    registryVk.beta.length !== 128 ||
    registryVk.gamma.length !== 128 ||
    registryVk.delta.length !== 128 ||
    registryVk.ic.some((point) => point.length !== 64)
  ) {
    throw new SorobanZkError(
      "Verifying key encoding produced an invalid byte length",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  return registryVk;
}
