# Proof Format Specification

This document defines the exact byte encoding used by `zksoroban` between `snarkjs`, the TypeScript SDK, and the Soroban verifier contract.

The goal is interoperability. Any client in any language can submit a compatible proof if it follows this format exactly.

## Contract Interface

The verifier contract entrypoint is:

```text
verify_proof(
  proof_a: Bytes,
  proof_b: Bytes,
  proof_c: Bytes,
  public_inputs: Vec<BytesN<32>>
) -> Result<bool, Error>
```

The contract expects:

- `proof_a`: 64 bytes
- `proof_b`: 128 bytes
- `proof_c`: 64 bytes
- `public_inputs`: exactly 2 entries, each exactly 32 bytes
  - `public_inputs[0]`: the circuit commitment
  - `public_inputs[1]`: `expiry_ledger` (see below)

If any proof byte length is wrong, the contract panics during parsing. If the number of public inputs is wrong, the contract returns `Ok(false)`. If the proof has expired, the contract returns `Err(ProofExpired)`.

## Field and Curve Context

The proof system is Groth16 over BN254.

- G1 points are affine points over the BN254 base field `Fq`
- G2 points are affine points over the quadratic extension field `Fq2`
- public inputs are BN254 scalar field elements `Fr`

The SDK treats all public inputs as unsigned integers encoded as 32-byte big-endian values.

## `snarkjs` Input Shape

The SDK accepts the standard `snarkjs` proof structure:

```ts
interface SnarkjsProof {
  pi_a: [string, string, string]
  pi_b: [[string, string], [string, string], [string, string]]
  pi_c: [string, string, string]
  protocol: "groth16"
}
```

For Groth16 on BN254:

- `pi_a = [ax, ay, "1"]`
- `pi_b = [[bx.c0, bx.c1], [by.c0, by.c1], ["1", "0"]]`
- `pi_c = [cx, cy, "1"]`

All coordinates are decimal strings in the `snarkjs` JSON format.

## G1 Encoding

G1 points are encoded as:

```text
x || y
```

where:

- `x` is a 32-byte big-endian encoding of the affine x-coordinate
- `y` is a 32-byte big-endian encoding of the affine y-coordinate

Total length:

```text
32 + 32 = 64 bytes
```

In the SDK this is:

```text
proofA = be32(pi_a[0]) || be32(pi_a[1])
proofC = be32(pi_c[0]) || be32(pi_c[1])
```

`proofA`'s replay-nullifier ([zksoroban#11](https://github.com/yusufadeagbo/zksoroban/issues/11))
is `sha256(proofA)` — since `proofA` already *is* `x || y` per this
encoding, that's the same thing as hashing the two coordinates
concatenated, with nothing extra to split out. See
`docs/architecture.md`'s "Nullifier Registry" section.

## G2 Encoding

The subtle part is G2.

`snarkjs` exposes an `Fq2` value as two decimal strings `[c0, c1]`. The Soroban verifier expects each `Fq2` element serialized in the order:

```text
c1 || c0
```

Each coefficient is still 32-byte big-endian.

For a G2 point `(x, y)`, the final layout is:

```text
x.c1 || x.c0 || y.c1 || y.c0
```

Total length:

```text
32 + 32 + 32 + 32 = 128 bytes
```

Given:

```text
pi_b = [
  [bx.c0, bx.c1],
  [by.c0, by.c1],
  ["1", "0"]
]
```

the SDK computes:

```text
proofB =
  be32(bx.c1) ||
  be32(bx.c0) ||
  be32(by.c1) ||
  be32(by.c0)
```

This ordering is non-negotiable. Reversing it produces an invalid proof at the contract boundary.

## Public Input Encoding

Each public input is encoded independently as a 32-byte big-endian field element:

```text
publicInputs[i] = be32(publicSignals[i])
```

The contract currently expects exactly one public input for the reference Poseidon preimage circuit.

For the reference example:

```text
commitment =
18586133768512220936620570745912940619677854269274689475585506675881198879027
```

its byte encoding is:

```text
29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133
```

## Expiry Ledger (required public input)

To limit replay, every submission carries a proof expiry as a second public input:

```text
public_inputs[1] = expiry_ledger
```

`expiry_ledger` is an unsigned 32-bit ledger sequence number, encoded as a 32-byte big-endian field element (the high 28 bytes are zero). The contract reads it and enforces:

```text
env.ledger().sequence() <= expiry_ledger
```

If the current ledger sequence is **greater than** `expiry_ledger`, the contract returns `Err(ProofExpired)`. A proof whose `expiry_ledger` equals the current sequence is still valid (the boundary is inclusive). The high 28 bytes must be zero; otherwise the contract treats the encoding as invalid and returns `Ok(false)`.

The SDK appends this field when `formatProof` is given an `expiryLedger` argument:

```ts
formatProof(proof, publicSignals, expiryLedger)
```

For example, `expiryLedger = 1000` encodes as:

```text
00000000000000000000000000000000000000000000000000000000000003e8
```

Note that `expiry_ledger` is checked by the contract but is not bound into the Groth16 circuit (the reference circuit has a single commitment public input). It limits the replay window but does not cryptographically bind the expiry to the proof; an end-to-end binding would require a circuit that commits to the expiry.

## Size Summary

The serialized calldata sizes are:

- `proofA`: 64 bytes
- `proofB`: 128 bytes
- `proofC`: 64 bytes
- `publicInputs[i]`: 32 bytes each

Total proof bytes excluding public input vector overhead:

```text
64 + 128 + 64 = 256 bytes
```

## Byte Offset Tables

### G1 point (64 bytes)

| Offset | Length | Field | Source |
| ------ | ------ | ----- | ------ |
| 0      | 32     | x     | `be32(pi[0])` |
| 32     | 32     | y     | `be32(pi[1])` |

Applies to both `proofA` (from `pi_a`) and `proofC` (from `pi_c`). The projective `"1"` coordinate is dropped.

### G2 point (128 bytes)

| Offset | Length | Field | Source |
| ------ | ------ | ----- | ------ |
| 0      | 32     | x.c1  | `be32(pi_b[0][1])` |
| 32     | 32     | x.c0  | `be32(pi_b[0][0])` |
| 64     | 32     | y.c1  | `be32(pi_b[1][1])` |
| 96     | 32     | y.c0  | `be32(pi_b[1][0])` |

Note the `c1 || c0` ordering: the second decimal string in each `snarkjs` pair is serialized first.

### Field element (32 bytes)

| Offset | Length | Field | Source |
| ------ | ------ | ----- | ------ |
| 0      | 32     | value | `be32(publicSignals[i])` |

A field element is an unsigned big-endian integer, left-zero-padded to exactly 32 bytes.

## Test Vectors

These vectors are derived from the reference Poseidon preimage circuit and are asserted byte-for-byte against `formatProof` in `sdk/test/encodingVectors.test.ts`. Any conforming encoder must reproduce the same hex.

### Vector 1 — G1 point (`pi_a` → `proofA`)

Input:

```json
"pi_a": [
  "12946189436829403618966220759719705708977906405469583648347011074291292904431",
  "17846713770550029036762679037427780901272879957385833493399084385066856475855",
  "1"
]
```

Expected `proofA` (64 bytes):

```text
1c9f4896deda7ee2355d0450495c287824c2d7a7273526cb4e379a2bb7331bef  <- bytes  0..31  x = be32(pi_a[0])
2774e1ccdf712d4b913fa2fb73a9e9d3c411325f0a606457672dde2e164feccf  <- bytes 32..63  y = be32(pi_a[1])
```

### Vector 2 — G2 point (`pi_b` → `proofB`)

Input:

```json
"pi_b": [
  [
    "4868706037346960113729884583027415258186007556306885243919406599273503594535",
    "526556730654810474824964081699165504518965096591893711302336565643976863155"
  ],
  [
    "5180825636680948260660547583298967864649885973974901129454802661259011234573",
    "16809837894866804556259265269481849644880426909145197949901144799866943307688"
  ],
  ["1", "0"]
]
```

Expected `proofB` (128 bytes):

```text
012a0542a3eb25f9dd3b1c1a1c8dde882c7d39cdaeab789ed7052598802f6db3  <- bytes   0..31  x.c1 = be32(pi_b[0][1])
0ac39707cbd15b1dd86963d88639f9263f1c3d10edb06a3b6a7f8496adf91827  <- bytes  32..63  x.c0 = be32(pi_b[0][0])
252a07f51df2b1b6aa65162f17933bfaa2245f427a024b1abc76654a2fc1ffa8  <- bytes  64..95  y.c1 = be32(pi_b[1][1])
0b743e4f2c12b5c36eff491f6343c52b1d979dd222f786261f170403314d1b0d  <- bytes  96..127 y.c0 = be32(pi_b[1][0])
```

Notice that `0x012a05...` comes from `pi_b[0][1]` (the `c1` coefficient), not `pi_b[0][0]`. This is the most common interoperability mistake.

### Vector 3 — Field element (`publicSignals[0]`)

Input:

```json
"publicSignals": [
  "18586133768512220936620570745912940619677854269274689475585506675881198879027"
]
```

Expected `publicInputs[0]` (32 bytes):

```text
29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133  <- bytes 0..31  be32(publicSignals[0])
```

`proofC` (the second G1 point) encodes identically to Vector 1 using `pi_c`:

```text
11c9db1a44293dd937839d0b271f95fbe7ac78df2331560beed6a29803aac919  <- bytes  0..31  x = be32(pi_c[0])
0c3780eb59106c3791d39969fca352f41f146690cda50d1c3c80c5def64501de  <- bytes 32..63  y = be32(pi_c[1])
```

## Gotchas

These are the encoding pitfalls that cause an off-chain-valid proof to fail at the contract boundary.

1. **Endianness.** All coordinates and field elements are **big-endian**. `snarkjs` emits decimal strings; converting them to little-endian bytes (the default for many `bigint`-to-bytes helpers) silently produces a wrong, full-length buffer that the contract will reject.
2. **Zero-padding.** Every component is fixed-width: 32 bytes per coordinate. A coordinate whose value is smaller than `2^248` has leading zero bytes that **must** be present. Trimming leading zeros (so a number serializes to fewer than 32 bytes) yields a short `proofA`/`proofB`/`proofC` and the contract panics on length.
3. **G2 coefficient order (`c1 || c0`).** `snarkjs` stores each `Fq2` value as `[c0, c1]`, but the verifier expects `c1` serialized before `c0`. You must swap the pair for both `x` and `y` of the G2 point. Emitting `c0 || c1` produces a 128-byte buffer of the right length that fails the pairing check — the hardest failure to debug because lengths look correct.
4. **Dropping the projective coordinate.** `pi_a`, `pi_b`, and `pi_c` each carry a trailing projective component (`"1"`, or `["1","0"]` for G2). Only the affine `x` and `y` are encoded; including the projective coordinate overruns the fixed widths.

## Reference Example

Reference proof bytes used by the current Testnet verifier:

```text
proofA =
1c9f4896deda7ee2355d0450495c287824c2d7a7273526cb4e379a2bb7331bef2774e1ccdf712d4b913fa2fb73a9e9d3c411325f0a606457672dde2e164feccf

proofB =
012a0542a3eb25f9dd3b1c1a1c8dde882c7d39cdaeab789ed7052598802f6db30ac39707cbd15b1dd86963d88639f9263f1c3d10edb06a3b6a7f8496adf91827252a07f51df2b1b6aa65162f17933bfaa2245f427a024b1abc76654a2fc1ffa80b743e4f2c12b5c36eff491f6343c52b1d979dd222f786261f170403314d1b0d

proofC =
11c9db1a44293dd937839d0b271f95fbe7ac78df2331560beed6a29803aac9190c3780eb59106c3791d39969fca352f41f146690cda50d1c3c80c5def64501de

publicInput[0] =
29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133
```

## Validation Rules

A conforming client should enforce:

- proof object uses protocol `"groth16"`
- `pi_a`, `pi_b`, and `pi_c` have the expected tuple lengths
- every coordinate parses as a non-negative integer
- every coordinate and public input fits in the relevant BN254 field
- encoded lengths are exact

That is what `sdk/src/proof.ts` does today.

## Soroban-Side Parsing

The contract parses:

- `proof_a` into `Bn254G1Affine`
- `proof_b` into `Bn254G2Affine`
- `proof_c` into `Bn254G1Affine`
- `public_inputs[0]` into `Fr`

It then computes:

```text
vk_x = IC[0] + IC[1] * public_input
```

and checks the Groth16 pairing equation with the hardcoded verifying key constants.

## Canonical Test Vectors

[`sdk/test/vectors.json`](../sdk/test/vectors.json) is the canonical interoperability reference for this format. It contains 12 test cases covering:

- the reference Testnet proof
- edge cases: zero coordinates, all-ones coordinates, max scalar field value (`Fr - 1`), max accepted coordinate value (`Fr - 1`)
- public input variants: zero, one, large mid-range value, `0x`-prefixed hex string, two inputs
- G2 structural variants: `c1 = 0` (element lies in base field), near-max coordinates

Each entry has the shape:

```json
{
  "id": "reference",
  "description": "reference Testnet proof",
  "snarkjsProof": { "pi_a": [...], "pi_b": [...], "pi_c": [...], "protocol": "groth16" },
  "publicSignals": ["..."],
  "expectedCalldata": {
    "proofA": "<128 hex chars>",
    "proofB": "<256 hex chars>",
    "proofC": "<128 hex chars>",
    "publicInputs": ["<64 hex chars>", ...]
  }
}
```

An SDK implementation in any language is considered compatible if it produces byte-identical `expectedCalldata` for every vector. The TypeScript SDK verifies this in `sdk/test/vectors.test.ts`.

To regenerate the vectors after changing the encoding logic:

```sh
cd sdk
node_modules/.bin/tsx test/gen-vectors.ts > test/vectors.json
```

## Interoperability Checklist

If another implementation wants to interoperate with this verifier, it must:

1. use the same circuit
2. use the same trusted setup artifacts and verifying key
3. encode G1 points as `x || y`
4. encode G2 points as `x.c1 || x.c0 || y.c1 || y.c0`
5. encode public inputs as 32-byte big-endian field elements
6. submit calldata in the exact contract argument order

If any one of those steps differs, the proof will fail on-chain even if the off-chain prover reports success.
