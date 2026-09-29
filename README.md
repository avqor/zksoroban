# zksoroban

[![ci](https://github.com/yusufadeagbo/zksoroban/actions/workflows/ci.yml/badge.svg)](https://github.com/yusufadeagbo/zksoroban/actions/workflows/ci.yml)
[![CodeQL](https://github.com/yusufadeagbo/zksoroban/actions/workflows/codeql.yml/badge.svg)](https://github.com/yusufadeagbo/zksoroban/actions/workflows/codeql.yml)

The first developer SDK and reference verifier contract for zero-knowledge proofs on Stellar, built on Protocol 25's native BN254 and Poseidon host functions.

Testnet registry contract (targeted by `demo/`):
`CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH`

## New to ZK proofs?

Follow the step-by-step tutorial: [docs/tutorial-first-proof.md](docs/tutorial-first-proof.md)

It covers prerequisites, Testnet account funding, exact commands, expected output, and a troubleshooting section.

## Quick Start

1. Install prerequisites: Node.js 22+, Rust, Stellar CLI, `make`, and `circom`.
2. Install the workspace dependencies from the repository root:
   `make install`
3. Build the verifier contract and SDK:
   `make build`
4. Run the full local check suite:
   `make test`
5. Run the end-to-end demo:
   `make demo`

The demo verifies against `contracts/registry` via a read-only simulation
call — no funded Testnet account or secret key needed. Accept the
interactive prompts' defaults to run against the deployed registry
directly.

Hitting flaky or rate-limited RPC endpoints? Pass a `retry` policy to
`verifyViaRegistry` (or any of the other RPC-touching calls) to retry
transient failures with exponential backoff (see
[docs/architecture.md](docs/architecture.md#retry--exponential-backoff)):

```ts
import { TESTNET, verifyViaRegistry } from "@zksoroban/sdk";

const verified = await verifyViaRegistry({
  network: { ...TESTNET, contractId: registryContractId },
  circuitId,
  bundle,
  retry: { maxRetries: 3, baseDelayMs: 500 },
});
```

Signed transaction submissions are never replayed; only the safe-to-
repeat read-only requests are.

Useful maintenance commands:

- `make lint`: run Rust formatting, clippy, and TypeScript checks.
- `make verifier-cost-check`: fail if `verify_proof`'s instruction cost regressed more than 10% — see [docs/performance.md](docs/performance.md#ci-cost-regression-check).
- `make circuits`: compile and verify the reference Poseidon preimage circuit.
- `make clean`: remove generated Rust, SDK, demo, and circuit build artifacts.

Expected result:
`✓ Proof verified on-chain: true`

## What This Repo Contains

- `contracts/verifier/`: a Soroban verifier contract for a Groth16 proof over BN254, gated by caller auth, per-caller rate limiting, and proof expiry.
- `contracts/registry/`: a multi-circuit verifying-key registry, deployed to Testnet — see [docs/architecture.md](docs/architecture.md#verifying-key-registry).
- `contracts/verifier-interface/`: the published `VerifierClient` cross-contract interface for `contracts/verifier` — see [docs/architecture.md](docs/architecture.md#cross-contract-interface).
- `contracts/examples/proof-gate/`: a minimal example contract calling `contracts/verifier` cross-contract via `VerifierClient`.
- `sdk/`: a TypeScript SDK for Poseidon hashing, snarkjs proof formatting, and on-chain verification — with opt-in retry-with-backoff for transient RPC failures (see [docs/architecture.md](docs/architecture.md#retry--exponential-backoff)). See [sdk/README.md](sdk/README.md) for testing, including the snapshot tests that catch proof-encoding regressions.
- `circuits/`: the reference Poseidon preimage circuit (wired to both contracts above) plus three additional circuits — `merkle_inclusion`, `range_proof`, `threshold_2of3` — registered with `contracts/registry` and tested there, but not yet on the live Testnet deployment (see docs/multi-circuit.md).
- `demo/`: an end-to-end script that generates a fresh secret, proves knowledge of its Poseidon commitment, and verifies it on Stellar Testnet.
- `docs/`: architecture notes, ZK primer, proof format specification, security audit checklist, and Poseidon parameter notes.

## Architecture

```text
User secret
   |
   v
Poseidon(secret) -> commitment
   |
   v
circom + snarkjs
generate Groth16 proof
   |
   v
SDK formatProof()
encodes proofA / proofB / proofC / publicInputs
   |
   v
SDK verifyOnChain()
submits Soroban transaction
   |
   v
Verifier contract
reconstructs vk_x and runs BN254 pairing check
   |
   v
bool result on-chain
```

## Reference Flow

The reference circuit exposes one public input, `commitment`, and one private input, `secret`. The prover shows that `Poseidon(secret) == commitment` without revealing `secret`. The contract keeps state to a minimum — an admin address and per-caller rate-limit counters, nothing proof- or nullifier-related — and returns a boolean, which keeps the MVP easy to audit and inexpensive to call. See [docs/security.md](docs/security.md) for exactly what this contract does and does not guarantee.

## Repository Status

- Phase 0: foundation complete
- Phase 1: verifier contract deployed and resource-gated
- Phase 2: SDK complete with Testnet integration tests
- Phase 3: reference circuit, setup artifacts, and demo complete
- Phase 4: documentation and submission polish complete

Known gaps, tracked as open issues rather than left implicit:

- No replay protection — the same valid proof can be verified more than once (#11).
- `merkle_inclusion`, `range_proof`, and `threshold_2of3` circuits are registered with `contracts/registry` in a local test environment, but not yet on the live Testnet deployment — that needs the registry's admin key (#183).

## Testnet Proof

- `contracts/registry` contract address (deployed, targeted by `demo/`, `poseidon_preimage` registered under circuit ID `1`):
  `CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH`
- Verified directly against the live deployment via `demo/`: a correct proof returns `true`, and a proof paired with the wrong public input returns `false`.
- `contracts/verifier` (the original single-circuit contract) is still live at
  `CBL6MAWJALQP25LYKUUOC34K464XPSF6BLKUW6MXZDEXEDXMQUSP7HNN`, but predates rate-limiting, caller auth, and expiry, and is no longer what `demo/` targets.

## Notes

- The setup artifacts in `circuits/poseidon_preimage/setup/` are testnet-only and non-production.
- `contracts/verifier` still hardcodes one circuit's verifying key; `contracts/registry` supports multiple, and is deployed, but only `poseidon_preimage` is registered under it so far.
- This contract provides no replay protection — see [docs/security.md](docs/security.md) for what it does and does not guarantee.

Building an application on top of `zksoroban`? Read
[docs/security-model.md](docs/security-model.md) first — it covers the
full stack's guarantees, trust assumptions, and threat model, including
what this stack explicitly does **not** protect against.

See [docs/zk-primer.md](https://github.com/yusufadeagbo/zksoroban/blob/main/docs/zk-primer.md) and [docs/proof-format.md](https://github.com/yusufadeagbo/zksoroban/blob/main/docs/proof-format.md) for the detailed background and byte-level interoperability spec.
