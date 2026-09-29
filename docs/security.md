# Security

## Audit Checklist

A manual security checklist run against `contracts/verifier/src/lib.rs`
(the deployed verifier contract). Re-run this checklist — updating verdicts
and adding new items where relevant — whenever `verify_proof`, its storage
layout, or its auth model changes.

| # | Threat | Mitigation Pattern | Verdict |
|---|--------|---------------------|---------|
| 1 | Integer overflow in the rate-limit counter (`current + 1`) | `overflow-checks = true` in `Cargo.toml`'s release profile turns overflow into a hard panic (transaction abort) rather than a silent wraparound. The `max_calls` check itself also rejects long before a counter could approach `u32::MAX` under any admin-configured limit reachable in practice. | **Pass** |
| 2 | Storage key collisions between `Admin`, `Limits`, and `CallCount(Address, u32)` | `DataKey` is a tagged `#[contracttype]` enum; Soroban encodes the variant tag plus all associated fields, so no two distinct keys — including two different `(caller, window)` pairs — can collide. | **Pass** |
| 3 | Authentication bypass on `verify_proof`, `set_limits`, or `propose_vk_update` | All three require the *stored* admin address's auth (or, for `verify_proof`, the `caller` argument's own auth) — not a caller-supplied address. An attacker cannot attribute rate-limit usage, a verification call, or a verifying-key proposal to an address that did not itself authorize the invocation. `execute_vk_update` is the one exception, and deliberately so — see finding #12. | **Pass** |
| 4 | Reentrancy | `verify_proof` and `set_limits` never call another contract (no `env.invoke_contract`) — there is no callback surface for a malicious contract to re-enter through. Not applicable to the current contract. | **N/A** |
| 5 | Event spoofing | `verify_proof` now publishes a `verification_result` event (topics `["zk", "verify"]`; data `success`, `caller`, `inputs_hash`) — but only on the outcome paths that return via `Ok(...)`: wrong public-input count, malformed `expiry_ledger` encoding, and the pairing-check result. The allowlist/rate-limit/expiry rejections still return `Err(...)` and never publish — Soroban rolls back any event published during a call that ultimately returns `Err` from a `#[contracterror]` `Result` (see `docs/architecture.md`'s Events section). Soroban events are always scoped to the publishing contract's own address at the host level, so nothing else can forge a `verification_result` that appears to come from this contract. | **Pass** — see [zksoroban#10](https://github.com/yusufadeagbo/zksoroban/issues/10) |
| 6 | DoS via unbounded storage growth | `CallCount(caller, window_start)` entries now live in **temporary** storage with a TTL covering the rate-limit window, so each entry naturally expires once its window closes instead of accumulating forever. See below. | **Pass** — fixed in [#178](https://github.com/yusufadeagbo/zksoroban/issues/178) |
| 7 | Panic-driven storage rollback | `read_g1`/`read_g2` panic (via `assert_eq!`) on malformed byte lengths. Since Soroban transactions are atomic, a panic reverts *all* state changes in the same invocation — including the rate-limit counter increment that ran earlier in `verify_proof`. Net effect: malformed submissions do not consume rate-limit budget. This is arguably correct behavior, but was not documented anywhere before this checklist. | **Pass**, now documented |
| 8 | Proof replay | As of [zksoroban#11](https://github.com/yusufadeagbo/zksoroban/issues/11), a nullifier `n = sha256(proof_a)` — see finding #14's note on why sha256, not the Poseidon that issue names — is stored in persistent storage on every successful verification, and `verify_one` rejects a repeat of that exact `proof_a` with `Error::AlreadyUsed`, checked before the (expensive) pairing check even runs. This is per-*proof*, not per-*statement*: Groth16 proving is randomized, so a second, independently-generated proof of the same underlying secret has a different `proof_a` and a different nullifier, and verifies again successfully. Applications that need "the same secret can only ever be proven once" (stronger than "the same proof bytes can only be submitted once") still need their own commitment-level tracking on top — this closes the literal "resubmit the same calldata" attack, not every notion of single-use. See Guarantees below. | **Fixed** — see Guarantees below for the exact scope |
| 9 | Malicious verifying key via `propose_vk_update`/`execute_vk_update` | The verifying key moved from compile-time constants to admin-updatable storage. A compromised admin key can propose an arbitrary VK, making the contract eventually accept a proof for a false statement — a genuine escalation from what a compromised admin could do before this existed (previously availability-only). `propose_vk_update` does validate the new key's shape (`ic.len()` must match the expected public-input count) but has no way to validate that the key came from a legitimate trusted setup — that's a property of the key itself, not something on-chain code can check. As of [#46](https://github.com/yusufadeagbo/zksoroban/issues/46), this is no longer immediate: `propose_vk_update` only stores the change, and `execute_vk_update` refuses to apply it until `vk_update_delay` ledgers have passed, giving `get_pending_vk_update()`-watching integrators a visible window to react to a suspicious proposal before it takes effect. | **By design, escalated risk, now timelocked** — see `docs/security-model.md`'s Trust Assumptions and Recommendations for how applications should treat the admin key now |
| 10 | Contract takeover via `upgrade`, or admin handoff to an unintended address via `propose_admin`/`accept_admin` | Both contracts (`contracts/verifier` and `contracts/registry`) gate `propose_admin` and `upgrade` behind the *stored* admin's own auth, and `accept_admin` behind the *pending* admin's own auth — same pattern as finding #3. The two-step handoff means a compromised or careless current admin cannot unilaterally hand control to an attacker address; the recipient must itself authorize `accept_admin`. It does **not** limit what an already-compromised, still-current admin key can do on its own: `upgrade(new_wasm_hash)` replaces the entire contract executable, which is strictly more powerful than `propose_vk_update` — arbitrary code, not just an arbitrary verifying key, and with no timelock of its own. | **By design, escalated risk** — see `docs/security-model.md`'s Trust Assumptions |
| 11 | DoS via unbounded storage growth from `VerificationCount(BytesN<32>)` | The per-public-input-commitment counter added for analytics/abuse detection (`verification_count`, [#41](https://github.com/yusufadeagbo/zksoroban/issues/41)) is keyed by a commitment derived from the proof's public inputs which the circuit author controls — unlike `CallCount` (finding #6), an attacker cannot mint unbounded distinct commitments. The counter lives in `instance()` storage as a `u64` per issue #41's specification, increments only on successful verification, and never resets. The admin can call `upgrade` to redeploy from scratch if storage becomes a concern. | **Pass** — see Note |
| 12 | Denial of service via `pause()` | `pause`/`unpause` (added for [zksoroban#44](https://github.com/yusufadeagbo/zksoroban/issues/44)) require the *stored* admin's own auth — same pattern as finding #3 — so an arbitrary caller cannot pause the contract. A compromised or malicious admin key *can* halt `verify_proof`/`verify_batch` indefinitely (no timelock, no auto-unpause, no way to override it without the admin key): this is a real, deliberate escalation in what that key can do to availability, and it is the whole point of an emergency-stop mechanism — see `docs/security-model.md`'s Trust Assumptions for how integrators should weigh the admin key here alongside `propose_vk_update`/`execute_vk_update` and `upgrade`. | **By design, escalated risk** |
| 13 | Permissionless `execute_vk_update` being callable by an attacker | Deliberate, not a gap: `execute_vk_update` takes no caller argument and calls no `require_auth`, so *anyone* can trigger it — but all it does is apply a verifying key the admin already proposed, no earlier than the admin's own configured delay. An attacker calling it doesn't let them install their own key or execute early; at most they apply the pending change on someone else's behalf once it's already due, which changes nothing about *what* takes effect, only that it isn't left waiting on the admin's own follow-up transaction. Requiring the admin to also execute would let a compromised key delay a proposal it no longer wants scrutinized indefinitely, which is the exact failure mode this issue's timelock exists to prevent. | **By design** — see [zksoroban#46](https://github.com/yusufadeagbo/zksoroban/issues/46) |
| 14 | DoS via unbounded storage growth from `Nullifier(BytesN<32>)`, and why sha256 instead of the Poseidon [zksoroban#11](https://github.com/yusufadeagbo/zksoroban/issues/11) names | Two things worth separating. **Growth**: like `VerificationCount` (finding #11) and unlike `CallCount` (finding #6), a `Nullifier` entry can only be created by an actual successful pairing check on a real Groth16 proof — an attacker cannot mint them for free, only by submitting real, fee-paying transactions with real proofs (which, for a known secret, is cheap to generate via re-randomization, but still requires a transaction each time — the same economic bound `VerificationCount` already accepts). [#11](https://github.com/yusufadeagbo/zksoroban/issues/11)'s own scope explicitly excludes nullifier expiry, so — like `VerificationCount` — these entries are permanent by design; `upgrade` remains the fallback if storage ever becomes a real concern. **Why sha256, not Poseidon**: the issue names `Poseidon(proofA_x, proofA_y)`. Soroban's host has no ready-to-use Poseidon hash — only a low-level `poseidon_permutation` primitive gated behind the `hazmat-crypto` feature that needs the caller to supply its own MDS matrix and round constants, explicitly documented as something to avoid misusing, and the crate its own docs point to for a safe wrapper (`rs-soroban-poseidon`) isn't published on crates.io. A previous attempt at this issue ([PR #227](https://github.com/yusufadeagbo/zksoroban/pull/227)) called `env.poseidon().hash(...)`, a method that has never existed on `Env`, and was closed unmerged for exactly that reason. `sha256` is already a native host function this contract already uses elsewhere (`compute_inputs_hash`); Poseidon's actual advantage — being cheap to prove statements about *inside a circuit* — doesn't apply here, since the nullifier is computed and checked entirely on-chain, never inside a circuit. | **By design** |

### Finding #6 in detail: unbounded instance storage growth (fixed)

`env.storage().instance()` is the right choice for `Admin` and `Limits` —
small, always-loaded, rarely-changing config. It was the wrong choice for
`CallCount(Address, u32)`, which grew by one entry per `(caller, window)`
pair for the contract's entire lifetime, with no expiry or cleanup.

Fixed in [#178](https://github.com/yusufadeagbo/zksoroban/issues/178):
`CallCount` entries now live in `env.storage().temporary()`, with
`extend_ttl` called on every write so each entry survives at least the
remainder of its own rate-limit window and is then naturally evicted by
the ledger instead of persisting forever.

**Migration note:** this fix only changes where *new* `CallCount` writes
go. Instance storage entries written by a contract instance deployed
before this fix stay exactly where they are — a contract upgrade
replaces code, not existing storage — so any already-deployed instance
still carries its old, unbounded instance-storage entries. Those stale
entries are dead weight (the new code never reads or writes
`DataKey::CallCount` under `instance()` again) but are not
automatically cleaned up; a fresh deployment is the only way to start
with a clean slate.

## Guarantees and Non-Guarantees

What `contracts/verifier` actually provides:

- **Soundness of the pairing check**: `verify_proof` returns `true` only
  if the supplied Groth16 proof is valid against the currently-stored
  verifying key and the given public inputs — assuming that key is a
  legitimate one (see finding #9: the admin can replace it).
- **Caller authentication**: every `verify_proof` and `set_limits` call
  requires real Soroban auth from the relevant address — not spoofable
  by supplying a different address in the call arguments.
- **Expiry enforcement**: a proof whose `expiry_ledger` public input has
  already passed is rejected with `Error::ProofExpired`, not silently
  accepted.
- **Per-proof replay protection**: as of [#11](https://github.com/yusufadeagbo/zksoroban/issues/11),
  the exact same `proof_a`/`proof_b`/`proof_c` bytes can never be
  accepted twice — a second submission of identical calldata fails with
  `Error::AlreadyUsed`, regardless of who submits it or what public
  inputs (including `expiry_ledger`) accompany it the second time. See
  finding #8 for the precise scope.

What it explicitly does **not** provide:

- **Per-statement (single-use-secret) replay protection.** Nullifiers
  here are derived from the proof itself, not the underlying secret.
  Groth16 proving is randomized, so a fresh, independently-generated
  proof of the *same* secret has a different `proof_a` and passes the
  nullifier check again — the contract has no way to tell "a new proof
  of a secret it's seen before" from "a proof of a genuinely new
  secret." An application needing "this secret/commitment can only ever
  be proven once" (e.g. "one vote," "claim once") — a stronger property
  than "this exact calldata can only be submitted once" — still needs
  its own commitment-level tracking on top (`verification_count` is
  analytics, not access control; it doesn't reject anything).
- **Multi-circuit support.** This contract hardcodes exactly one
  verifying key. (`contracts/registry` is the separate contract that
  supports multiple named verifying keys; it is out of scope for this
  checklist.)

## CodeQL

`.github/workflows/codeql.yml` runs CodeQL analysis on every PR to `main`,
every push to `main`, and weekly, covering:

- TypeScript (`sdk/src/`, `demo/src/`)
- Rust (`contracts/verifier/src/`, `contracts/registry/src/`)

Results appear under the repository's Security > Code scanning tab.

The Rust analysis uses `build-mode: none` (buildless/standalone
extraction) — CodeQL's Rust extractor does not support `manual` build
mode at all, only `none`. GitHub's own docs note this yields less
accurate results than a fully-traced build. Treat a clean Rust CodeQL
run as a weak signal, not a strong guarantee; the manual audit (#57)
and the property-based tests (#56) carry more weight for the contract.

### Accepted Findings

None yet. Any finding that is a false positive or an accepted risk
(rather than something to fix) will be listed here with a justification,
so the reasoning survives even after the finding is dismissed on GitHub.
