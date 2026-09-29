import { SnarkjsProof, SorobanZkError, SorobanZkErrorCode } from "./types.js";
import { validateProofInput } from "./validate.js";

/**
 * Compact, versioned binary encoding of a raw snarkjs Groth16 proof plus
 * its public signals — for storing a proof in a database or sending it
 * over the network, as opposed to {@link formatProof}'s Soroban-specific
 * contract-calldata encoding (see zksoroban#33). Every field element
 * (including the projective `"1"`/`"0"` components `formatProof` drops,
 * since those aren't needed to call the contract) is preserved exactly,
 * so `deserializeProof(serializeProof(proof, publicSignals))` round-trips
 * without any loss — this is a generic storage format, not a
 * contract-specific one, so it doesn't get to assume anything about a
 * value it doesn't strictly need is safe to discard.
 *
 * Wire format (big-endian throughout):
 *
 * ```text
 * [2 bytes]  format version (currently 1)
 * [4 bytes]  public signal count N
 * [32 bytes] pi_a[0]
 * [32 bytes] pi_a[1]
 * [32 bytes] pi_a[2]
 * [32 bytes] pi_b[0][0]
 * [32 bytes] pi_b[0][1]
 * [32 bytes] pi_b[1][0]
 * [32 bytes] pi_b[1][1]
 * [32 bytes] pi_b[2][0]
 * [32 bytes] pi_b[2][1]
 * [32 bytes] pi_c[0]
 * [32 bytes] pi_c[1]
 * [32 bytes] pi_c[2]
 * [32 bytes * N] publicSignals[0..N]
 * ```
 *
 * Fixed overhead is 390 bytes (2 + 4 + 12×32) plus 32 bytes per public
 * signal — see docs/proof-format.md for a worked size comparison against
 * the plain JSON snarkjs normally produces.
 */
export const SERIALIZED_PROOF_FORMAT_VERSION = 1;

const VERSION_BYTES = 2;
const LENGTH_PREFIX_BYTES = 4;
const FIELD_ELEMENT_BYTES = 32;
// pi_a (3) + pi_b (3 rows * 2) + pi_c (3) = 12 field elements, always
// present regardless of how many public signals there are.
const FIXED_FIELD_ELEMENT_COUNT = 12;
const FIXED_HEADER_BYTES = VERSION_BYTES + LENGTH_PREFIX_BYTES + FIXED_FIELD_ELEMENT_COUNT * FIELD_ELEMENT_BYTES;

const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DECIMAL_OR_HEX_PATTERN = /^(0x[0-9a-fA-F]+|[0-9]+)$/;

// validateProofInput (validate.ts) already checks pi_a[0..1]/pi_b[0..1][0..1]/
// pi_c[0..1] and publicSignals thoroughly -- reused below. It doesn't check
// index 2 (the projective "1"/"0" components), since formatProof never reads
// them; this format does need them, for lossless round-tripping, so they get
// their own check here.
function assertFieldElementString(value: unknown, label: string): string {
  if (typeof value !== "string" || !DECIMAL_OR_HEX_PATTERN.test(value)) {
    throw new SorobanZkError(
      `${label} must be a decimal or hex string`,
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  if (BigInt(value) >= BN254_FIELD_MODULUS) {
    throw new SorobanZkError(
      `${label} exceeds the BN254 field size`,
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  return value;
}

function writeFieldElement(value: string): Buffer {
  return Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");
}

function readFieldElement(bytes: Buffer, offset: number): string {
  return BigInt(`0x${bytes.subarray(offset, offset + FIELD_ELEMENT_BYTES).toString("hex")}`).toString();
}

export function serializeProof(proof: SnarkjsProof, publicSignals: string[]): Uint8Array {
  validateProofInput(proof, publicSignals);

  if (proof.pi_a.length < 3 || proof.pi_b.length < 3 || proof.pi_c.length < 3) {
    throw new SorobanZkError(
      "Proof is missing its projective z-coordinate (pi_a/pi_b/pi_c[2]) — serializeProof needs the full snarkjs proof shape, not just the x/y coordinates formatProof uses",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  const fieldElements = [
    proof.pi_a[0],
    proof.pi_a[1],
    assertFieldElementString(proof.pi_a[2], "pi_a[2]"),
    proof.pi_b[0][0],
    proof.pi_b[0][1],
    proof.pi_b[1][0],
    proof.pi_b[1][1],
    assertFieldElementString(proof.pi_b[2][0], "pi_b[2][0]"),
    assertFieldElementString(proof.pi_b[2][1], "pi_b[2][1]"),
    proof.pi_c[0],
    proof.pi_c[1],
    assertFieldElementString(proof.pi_c[2], "pi_c[2]")
  ];

  const header = Buffer.alloc(VERSION_BYTES + LENGTH_PREFIX_BYTES);
  header.writeUInt16BE(SERIALIZED_PROOF_FORMAT_VERSION, 0);
  header.writeUInt32BE(publicSignals.length, VERSION_BYTES);

  return Buffer.concat([
    header,
    ...fieldElements.map(writeFieldElement),
    ...publicSignals.map(writeFieldElement)
  ]);
}

export function deserializeProof(bytes: Uint8Array): { proof: SnarkjsProof; publicSignals: string[] } {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (buf.length < VERSION_BYTES + LENGTH_PREFIX_BYTES) {
    throw new SorobanZkError(
      `Serialized proof is too short to contain a header: got ${buf.length} byte(s), need at least ${
        VERSION_BYTES + LENGTH_PREFIX_BYTES
      }`,
      SorobanZkErrorCode.CORRUPTED_SERIALIZED_PROOF
    );
  }

  const version = buf.readUInt16BE(0);
  if (version !== SERIALIZED_PROOF_FORMAT_VERSION) {
    throw new SorobanZkError(
      `Serialized proof format version ${version} is not supported by this SDK (expected ${SERIALIZED_PROOF_FORMAT_VERSION})`,
      SorobanZkErrorCode.SERIALIZED_PROOF_VERSION_MISMATCH
    );
  }

  const publicSignalCount = buf.readUInt32BE(VERSION_BYTES);
  const expectedLength = FIXED_HEADER_BYTES + publicSignalCount * FIELD_ELEMENT_BYTES;

  if (buf.length !== expectedLength) {
    throw new SorobanZkError(
      `Serialized proof is corrupted: expected ${expectedLength} byte(s) for ${publicSignalCount} public signal(s), got ${buf.length}`,
      SorobanZkErrorCode.CORRUPTED_SERIALIZED_PROOF
    );
  }

  let offset = VERSION_BYTES + LENGTH_PREFIX_BYTES;
  const next = (): string => {
    const value = readFieldElement(buf, offset);
    offset += FIELD_ELEMENT_BYTES;
    return value;
  };

  const proof: SnarkjsProof = {
    protocol: "groth16",
    pi_a: [next(), next(), next()],
    pi_b: [
      [next(), next()],
      [next(), next()],
      [next(), next()]
    ],
    pi_c: [next(), next(), next()]
  };

  const publicSignals: string[] = [];
  for (let i = 0; i < publicSignalCount; i += 1) {
    publicSignals.push(next());
  }

  return { proof, publicSignals };
}
