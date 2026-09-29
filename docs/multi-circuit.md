# Multi-Circuit Support via `contracts/registry`

`contracts/verifier` hardcodes exactly one verifying key: the reference
`poseidon_preimage` circuit. `contracts/registry` generalizes that — it
stores a verifying key per numeric circuit ID and dispatches
`verify_proof(id, ...)` to the matching key, so a new circuit can be
supported without redeploying or forking the contract. See
[`docs/architecture.md`](architecture.md#verifying-key-registry) for the
registry's on-chain design.

This document is the pattern for taking one of the repo's existing
reference circuits (`merkle_inclusion`, `range_proof`, `threshold_2of3`)
all the way from its `.circom` source to an on-chain verification via the
registry — and what to change to add a fourth circuit later.

## Circuit ID assignments

| Circuit ID | Circuit | Public inputs |
|---|---|---|
| `1` | `poseidon_preimage` (reference) | 1 (`commitment`) |
| `2` | `range_proof` | 3 (`min`, `max`, `commitment`) |
| `3` | `threshold_2of3` | 4 (`messageHash`, `commitment0`, `commitment1`, `commitment2`) |
| `4` | `merkle_inclusion` | 1 (`root`) |

These IDs are a convention, not something the registry contract enforces —
`register_circuit(id, vk)` accepts any `u32` an admin chooses. Keeping a
single source of truth for which ID maps to which circuit (this table)
matters once more than one circuit is registered, so SDK callers and
on-chain callers agree on what `circuitId: 2` means.

## The end-to-end flow, per circuit

Each of `circuits/range_proof/` and `circuits/threshold_2of3/` already has:

- `circuit.circom` — the circuit source
- `setup/circuit.zkey`, `setup/verification_key.json` — a completed
  (testnet-only) trusted setup, following the same process documented in
  [`circuits/poseidon_preimage/README.md`](../circuits/poseidon_preimage/README.md)
- `fixtures/proof.json`, `fixtures/public.json` — a real Groth16 proof
  generated from that circuit's own `input_example.json`, produced by
  `snarkjs groth16 fullprove`

`contracts/registry/src/tests.rs` takes each circuit's
`verification_key.json` and `fixtures/{proof,public}.json`, encodes them
into the same BN254 byte layout `contracts/verifier` uses (`formatProof`'s
encoding — alpha/beta/gamma/delta as raw G1/G2 point bytes, IC as a list of
G1 points, proof and public inputs the same way), and exercises the full
loop in a test `Env`:

1. `register_circuit(id, vk)` — admin registers the circuit's real
   verifying key
2. `verify_proof(id, proof_a, proof_b, proof_c, public_inputs)` — a real
   proof from that circuit's fixtures verifies as `true`
3. a proof with a negated `proof_a` (the same tamper `contracts/verifier`'s
   own tests use) verifies as `false`

Run these locally with `cargo test --manifest-path
contracts/registry/Cargo.toml`. This is the "one passing end-to-end
example per circuit" from #183's acceptance criteria — it runs entirely
against a local test `Env`, no live network or registered on-chain state
needed.

## What's not automated here: registering against the live registry

The commands above prove the encoding is correct end-to-end. They do
**not** call `register_circuit` against the actual deployed registry
(`CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH` on Testnet,
per [`docs/architecture.md`](architecture.md#testnet-deployment)) — that
call requires `admin.require_auth()`, i.e. the registry's actual admin
signing key, which only the maintainer holds.

Deriving that command's `--vk` argument by hand from a `verification_key.json`
(the byte encoding `contracts/registry/src/tests.rs`'s constants use) is
error-prone to do manually, so the SDK's `format-vk` CLI command does it:

```bash
node sdk/dist/cjs/cli.js format-vk \
  --vk circuits/range_proof/setup/verification_key.json \
  --id 2
```

This runs the exact same `formatVerifyingKey` encoding
`sdk/test/formatVerifyingKey.test.ts` checks byte-for-byte against
`contracts/registry/src/tests.rs`'s constants, and prints a ready-to-run
command:

```bash
stellar contract invoke \
  --id CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH \
  --network testnet \
  --source-account <registry-admin> \
  -- register_circuit --id 2 --vk '{"alpha":"...","beta":"...","gamma":"...","delta":"...","ic":["...","...","...","..."]}'
```

Once a PR's encoding is reviewed and merged, the maintainer runs this for
each of `range_proof` (id 2), `threshold_2of3` (id 3), and
`merkle_inclusion` (id 4), swapping in the registry admin's own
`--source-account`.

## SDK: `verifyViaRegistry`

`sdk/src/verify.ts` exports `verifyViaRegistry`, a distinct function from
`verifyOnChain` — not a variant of it, per #184's scoping. The two exist
because the underlying contracts have genuinely different call shapes:

| | `verifyOnChain` | `verifyViaRegistry` |
|---|---|---|
| Target contract | `contracts/verifier` | `contracts/registry` |
| Auth | Requires a signing `keypair` (`caller.require_auth()`) | None — `verify_proof` has no auth check |
| State | Mutates rate-limit counters | Read-only, nothing written |
| Call type | Signed transaction, submitted and polled for confirmation | Simulation only, like `getContractConfig` |
| Return | `VerifyResult` (`verified`, `txHash`, `ledger`, `fee`) | Plain `boolean` |

```ts
import { TESTNET, verifyViaRegistry, formatProof } from "@zksoroban/sdk";

const calldata = formatProof(snarkjsProof, publicSignals);

const verified = await verifyViaRegistry({
  network: { ...TESTNET, contractId: "CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH" },
  circuitId: 2, // range_proof
  calldata,
});
```

`verifyOnChain` still targets `contracts/verifier` the same way it
always has (see "Network Configuration" in `docs/architecture.md` for
its own, separate `network: NetworkConfig` signature) — adding
`verifyViaRegistry` alongside it didn't change what `verifyOnChain`
does, only what else is now available.

## Adding a fifth circuit

1. Write `circuits/<name>/circuit.circom`, following an existing circuit's
   structure as a template.
2. Run the trusted setup (`circuits/poseidon_preimage/README.md` has the
   full `snarkjs powersoftau` / `groth16 setup` sequence) and commit the
   resulting `setup/circuit.zkey` and `setup/verification_key.json`.
3. Generate a real proof from the circuit's own input and commit it as
   `fixtures/proof.json` / `fixtures/public.json`.
4. Pick the next unused circuit ID and add a row to the table above.
5. In `contracts/registry/src/tests.rs`, add that circuit's VK/proof/public
   input constants (encoded via the same `formatProof`-equivalent byte
   layout — `node sdk/dist/cjs/cli.js format-vk --vk <path> --id <n>`
   prints the VK's byte encoding as hex if you want to cross-check the
   constants you add) and a `round_trip_register_and_verify_<name>` /
   `round_trip_rejects_tampered_<name>` test pair, mirroring the existing
   `range_proof`/`threshold_2of3` tests.
6. Once merged, the maintainer registers the real VK against the live
   registry as shown above.
