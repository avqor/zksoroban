# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for the SDK and contracts as described in [docs/versioning.md](docs/versioning.md).

Routine dependency bumps (Dependabot) are not enumerated individually here —
see the git history for those.

## [Unreleased]

Nothing has been tagged or published yet: `sdk/package.json` and both
contracts' `Cargo.toml` are still at their initial `0.1.0`, and everything
below has only ever existed on `main`. All of it is "unreleased" in that
sense.

### Added

- **sdk**: `serializeProof`/`deserializeProof` (`sdk/src/serialize.ts`) —
  a compact, versioned binary format for storing a raw snarkjs proof and
  its public signals or sending them over a network, distinct from
  `formatProof`'s Soroban-calldata encoding. Round-trips the full proof
  shape losslessly; rejects an unrecognized version or a corrupted/
  truncated byte array with a typed error. See
  `docs/proof-format.md`'s "Storage/Transport Serialization" section (#33).
- **contracts**: timelocked verifying-key updates on `contracts/verifier`
  — `propose_vk_update`/`execute_vk_update` replace the old immediate
  `update_vk`, with a `vk_update_delay` (in ledgers, fixed at
  construction) between proposing a key and it taking effect.
  `execute_vk_update` is permissionless once the delay elapses;
  `get_pending_vk_update()` exposes the pending change and its effective
  ledger to anyone watching (#46).
- **testing**: CI regression check for `verify_proof`'s instruction cost
  (`contracts/verifier/tests/cost_regression.rs`) — fails if it exceeds
  `contracts/verifier/baseline-cost.json`'s baseline by more than 10%.
  `make verifier-cost-check` / `make update-verifier-cost-baseline` run
  it locally and refresh the baseline intentionally, respectively (#74).
- **contracts**: admin-only `pause`/`unpause` on `contracts/verifier`, an
  emergency stop that makes `verify_proof`/`verify_batch` reject every
  call with `Error::ContractPaused` until unpaused, plus a public
  `is_paused()` getter (#44).
- **contracts**: two-step admin transfer (`propose_admin`/`accept_admin`)
  and self-upgrade (`upgrade`) for `contracts/verifier` and
  `contracts/registry`, so a deployed instance's logic can be replaced
  in place without redeploying to a new contract ID (#220).
- **contracts**: per-public-input-commitment verification counter on
  `contracts/verifier` for analytics and abuse detection (#228).
- **contracts**: `verification_result` event emitted on every
  `verify_proof` outcome (#218).
- **contracts+sdk**: batch proof verification — `verify_batch` on both
  contracts, `verifyBatchOnChain`/`verifyBatchViaRegistry` in the SDK
  (#222).
- **contracts**: verifying-key registry (`contracts/registry`) for
  registering and verifying against multiple circuits from one deployed
  contract, instead of one verifier per circuit.
- **contracts**: proof expiry via an `expiry_ledger` public input,
  rejecting proofs submitted after their intended validity window (#159).
- **contracts**: per-caller rate limiting on `contracts/verifier` (#158),
  later moved to temporary storage so expired entries don't accumulate
  permanent storage cost.
- **contracts**: caller allowlist enforcement (#26) and a `get_config()`
  getter exposing admin, pause, fee, rate-limit, timelock, and allowlist
  state as one read-only call.
- **contracts**: `update_vk` to rotate a verifying key stored in contract
  storage, replacing the old build-time-constant verifying key.
- **contracts**: `version()` getter (from `CARGO_PKG_VERSION`) on both
  contracts, paired with `getContractVersion()` in the SDK.
- **sdk**: `verifyOffChain` for local proof verification without an RPC
  round-trip (#162).
- **sdk**: runtime input validation with a typed `ZkInputError`, and
  encoding errors that include the offending value and its type (#152).
- **sdk**: `ProofBundle` type plus network-passphrase validation in
  `verifyOnChain`, catching a bundle built for the wrong network before
  it's submitted.
- **sdk**: `estimateVerifyFee` for pre-submission fee estimates (#216).
- **sdk**: `formatVerifyingKey` and a `format-vk` CLI command, for
  registering a circuit's verifying key with `contracts/registry` (#219).
- **sdk**: browser-compatible proof generation bundle, and a dual
  ESM/CJS build output for `sdk/dist`.
- **sdk**: opt-in retry with exponential backoff (`RetryOptions`) for
  every RPC-touching call (#233).
- **circuits**: depth-20 Poseidon Merkle inclusion circuit (#153),
  min-max range proof circuit (#154), and 2-of-3 threshold proof circuit
  (#155).
- **demo**: a second, failing-proof scenario alongside the original
  success path, plus interactive readline prompts replacing the old
  hardcoded values (#190, #157).
- **infra**: CodeQL static analysis for TypeScript and Rust in CI (#175).
- **infra**: automated npm publishing on `v*` tag push, with
  `--provenance` attestation (#191).
- **docs**: `docs/tutorial-first-proof.md` end-to-end walkthrough (#1),
  `docs/security-model.md` threat analysis, a security audit checklist
  for the verifier contract (#179), and byte-level encoding test vectors
  with common gotchas (#156).
- Canonical test vectors for cross-language SDK/contract interoperability
  (#146).

### Changed

- **contracts**: `contracts/verifier`'s `update_vk` is removed —
  replaced by the timelocked `propose_vk_update`/`execute_vk_update`
  above. `__constructor` also gains a new required `vk_update_delay`
  argument. Breaking for any existing integration calling `update_vk`
  directly.
- **demo**: migrated off the retired single-circuit verifier flow onto
  `contracts/registry`, so the demo now registers and verifies against a
  circuit ID instead of a dedicated per-circuit contract (#215).
- **sdk**: `verifyOnChain`'s calldata encoding brought back in line with
  the current verifier contract's ABI, after the two had drifted apart.
- **contracts/registry**: circuit registrations for `merkle_inclusion`,
  `range_proof`, and `threshold_2of3` added alongside the original
  `poseidon_preimage`.

### Fixed

- **sdk**: runtime validation now accepts hex-encoded public signals,
  not only decimal (#160).
- **sdk**: an off-by-one in the public-input field-element bound check
  (#174).
- **demo**: a missing `formatProof` import left over from the
  interactive-prompts rewrite (#161).
- **docs**: tutorial and `.env.example` still describing the retired
  single-circuit verifier flow (#223).
- A same-day SDK build break caused by two independently-green dependency
  bumps (`moduleResolution` change + a major version bump) landing on
  `main` together (#177).

### Security

- Two-step admin transfer requires the *new* admin's own signature to
  accept, so a compromised or malicious current admin can't unilaterally
  hand control to an address that hasn't consented (#220).
- Per-caller rate limiting and an optional caller allowlist on
  `contracts/verifier`, to bound abuse of a public, unauthenticated
  `verify_proof` call.
