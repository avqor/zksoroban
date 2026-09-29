# Security Model

This document describes the security guarantees `zksoroban` provides across
its full stack — circuit, SDK, and on-chain contract — and, just as
importantly, what it does not. It is written for developers building
applications on top of `zksoroban`, so they do not carry over false
assumptions from other ZK stacks or from the phrase "zero-knowledge" alone.

For a threat-by-threat audit of the deployed verifier contract's code, see
[`docs/security.md`](security.md). This document is broader: it covers the
whole pipeline (circuit → SDK → contract) and is written for application
developers, not contract auditors.

## Guarantees

What `zksoroban` actually provides, end to end:

- **Soundness of the pairing check.** `contracts/verifier`'s `verify_proof`
  returns `true` only if the supplied Groth16 proof is valid against the
  hardcoded verifying key and the given public inputs — assuming the
  trusted setup was honest (see Trust Assumptions below). No proof can make
  it return `true` for a false statement without either breaking the
  underlying elliptic-curve assumptions or compromising the trusted setup.
- **Zero-knowledge of the private witness.** The `secret` input to the
  reference circuit (`circuits/poseidon_preimage`) is never transmitted,
  logged, or reconstructible from the proof, the public `commitment`, or
  anything the contract stores. Only `Poseidon(secret) == commitment` is
  proven — the value of `secret` itself stays private.
- **Caller authentication on-chain.** Every `verify_proof` and
  `set_limits` call to `contracts/verifier` requires real Soroban auth
  from the relevant address. An attacker cannot attribute a rate-limit
  hit, or a verification, to an address that never authorized that
  specific invocation.
- **Expiry enforcement.** A proof whose `expiry_ledger` public input has
  already passed is rejected with `Error::ProofExpired`, not silently
  accepted, once past its intended validity window.
- **SDK-side input validation.** `sdk/src/validate.ts` rejects malformed
  proof coordinates, out-of-field-range values, and malformed public
  inputs *before* they reach the network — see `validateProofInput` and
  `validateCalldata`. This catches encoding mistakes early; it is not a
  cryptographic guarantee about what the contract will do (the contract
  performs its own independent validation of anything it receives).

## Trust Assumptions

`zksoroban` is not trustless in every dimension. Concretely:

- **The trusted setup is not a production ceremony.** The proving/verifying
  key pair in `circuits/poseidon_preimage/setup/` is explicitly documented
  as testnet-only (see that circuit's README: "not production ceremony
  outputs"). Whoever generated this setup could, in principle, have
  retained the toxic waste and forged proofs for statements that are
  false. **Do not treat a testnet deployment of this reference circuit as
  trustworthy for anything of real value.** A real deployment needs its
  own multi-party ceremony with the toxic waste provably destroyed.
- **The admin key can now break soundness, not just availability.**
  `contracts/verifier`'s admin can call `set_limits` (rate-limiting
  window/cap) and, as of the storage-backed verifying key,
  `propose_vk_update`. A compromised admin key can still starve callers
  or remove rate limiting entirely — but it can **also propose an
  arbitrary verifying key**, which will eventually make the contract
  accept a proof for a statement that isn't true once
  `execute_vk_update` applies it. This is a real escalation from the
  rate-limiting-only blast radius this document previously described:
  the admin key is now a full trust anchor for soundness, not just
  availability. It still cannot read any private witness — nothing
  about `propose_vk_update` exposes what any prover's `secret` was. As
  of [zksoroban#46](https://github.com/yusufadeagbo/zksoroban/issues/46),
  this escalation is no longer *instant* — see the timelock bullet
  below — but it is not prevented, only delayed and made visible.
- **A verifying-key change now has a mandatory, visible delay before it
  takes effect, but the delay itself is only as trustworthy as whoever
  is watching it.** `propose_vk_update` stores the change and a fixed
  `vk_update_delay` (set once, at construction); `execute_vk_update`
  refuses to apply it before that many ledgers pass, and
  `get_pending_vk_update()` is public and unauthenticated, so anyone can
  see a pending change before it lands. This buys real reaction time
  against a compromised admin key — but only for whoever is actually
  watching `get_pending_vk_update()`. `zksoroban` does not run any
  off-chain monitoring or alerting of its own; an integrator who never
  checks gets no benefit from the delay existing. The delay also
  protects against nothing once it elapses: `execute_vk_update` is
  permissionless specifically so a legitimate change can't be stalled by
  withholding a second admin transaction, but that means an *attacker*
  can apply an admin's own malicious proposal the instant it's due, too
  — the timelock's value is entirely in the reaction window it creates,
  not in adding a second gate on execution itself.
- **The admin key can now replace the contract's code entirely, on both
  `contracts/verifier` and `contracts/registry`.** As of the two-step
  admin transfer and `upgrade` mechanism (see
  [zksoroban#12](https://github.com/yusufadeagbo/zksoroban/issues/12)
  and [`docs/architecture.md`](architecture.md#admin-ownership--contract-upgrades)),
  a compromised admin key is no longer limited to what `propose_vk_update`
  and `set_limits` can express — `upgrade(new_wasm_hash)` swaps the running
  wasm for anything already uploaded to the network, so a compromised
  admin can make the contract do literally anything: accept invalid
  proofs unconditionally, drain any balances it holds, or brick itself.
  The two-step `propose_admin`/`accept_admin` handoff limits how an
  admin key can be *transferred* (the recipient must itself authorize
  accepting it, so a compromised key can't silently hand control to an
  attacker-controlled address the real admin never agreed to) but does
  nothing to limit what an *already-compromised, still-current* admin
  key can do — that key alone is sufficient to upgrade the contract.
- **The admin key can now halt verification entirely, on demand.** As of
  `pause`/`unpause` (see
  [zksoroban#44](https://github.com/yusufadeagbo/zksoroban/issues/44)),
  the admin can make every `verify_proof`/`verify_batch` call fail with
  `Error::ContractPaused`, with no timelock and no automatic unpause.
  Unlike `update_vk`/`upgrade` above, this is an availability-only
  escalation, not a soundness one — a paused contract rejects valid
  proofs, it never accepts invalid ones — but it means a compromised or
  malicious admin key can deny service to every legitimate caller
  indefinitely, which this document didn't need to account for before
  this existed.
- **The BN254 pairing and Poseidon hash are assumed secure.** Like any
  Groth16/BN254 system, this stack inherits the standard cryptographic
  assumptions of that curve and hash function. `zksoroban` does not
  introduce new cryptographic primitives or attempt to justify them —
  it relies on the same assumptions the broader Groth16/BN254 ecosystem
  does.
- **The SDK's encoder is trusted to be correct, not verified independently
  on-chain.** `formatProof` converts snarkjs JSON into the exact byte
  layout the contract expects. If the SDK's encoding has a bug, it could
  produce calldata that mismatches the prover's actual proof — the
  contract has no way to know the SDK "meant" something different from
  what it received. This is why `sdk/test/vectors.json` and the
  property-based tests (`sdk/test/proof.property.test.ts`) exist: to
  catch encoding regressions before they reach production, not because
  the contract can catch them itself.

## Threat Model

| Threat | Attacker Capability | Impact | Mitigation / Accepted Risk |
|---|---|---|---|
| Forged proof for a false statement | Controls the trusted setup's toxic waste (only realistic if they generated it, or the ceremony was compromised) | Complete break — contract accepts a proof for a statement that isn't true | **Accepted risk on testnet** (setup is explicitly not production-grade); **mitigation for production** is a real multi-party ceremony with provable toxic-waste destruction |
| Proof replay | None beyond ability to resubmit previously-seen, still-valid transaction data | As of [#11](https://github.com/yusufadeagbo/zksoroban/issues/11), submitting the exact same proof bytes a second time fails with `Error::AlreadyUsed` — no impact. A fresh, independently re-randomized proof of the *same underlying secret* still verifies again, since Groth16 proving is randomized and the nullifier is derived from the proof, not the secret | **Mitigated for exact-calldata replay** — see Known Limitations for what's still an application-level responsibility |
| Rate-limit storage growth (DoS via cost inflation) | Any address that can submit transactions (no special privilege) | Each new `(caller, window)` pair permanently occupies instance storage, which is loaded on every future invocation — this makes every future call incrementally more expensive over time, for everyone | **Tracked, unresolved** — filed as [zksoroban#178](https://github.com/yusufadeagbo/zksoroban/issues/178); the fix is moving this storage to Soroban's `temporary()` storage class |
| Admin key compromise | Controls the private key configured as `admin` at contract construction | Can disable or misconfigure rate limiting; can also call `propose_vk_update` to queue an arbitrary verifying key, which `execute_vk_update` will apply after `vk_update_delay` ledgers — a full soundness break, not just availability, once it lands. Cannot read any private witness, and (as of [#46](https://github.com/yusufadeagbo/zksoroban/issues/46)) cannot make the change take effect immediately. | **Accepted risk inherent to having an admin role at all**, now a materially bigger one than before this existed, though the delay gives a real reaction window — standard key-management practices (cold storage, multi-sig) still apply; not something this contract's code can mitigate beyond the timelock it already provides |
| Malformed/adversarial proof bytes | Any address that can submit transactions | Attempting to trigger a panic or unexpected contract behavior with malformed byte lengths | **Mitigated** — `read_g1`/`read_g2` panic cleanly on wrong lengths, and Soroban's atomic transaction semantics roll back *all* state changes (including any rate-limit counter increment) on panic, so malformed submissions cannot even be used to grief the rate limit |
| SDK encoding bug | None (this is a correctness risk, not an adversarial one) | A bug in `formatProof` could silently produce calldata that doesn't match what the prover actually proved, causing the contract to correctly reject a proof the application believed was valid (or, in the worst case, misencode in a way that happens to still parse) | **Mitigated** — property-based tests and fixed test vectors (`sdk/test/vectors.json`, `sdk/test/proof.property.test.ts`) assert the encoding against known-correct byte layouts across randomized and adversarial inputs |

## Known Limitations

Stated plainly, so applications don't have to discover these by
experimentation:

- **`zksoroban` does not hide the fact that a verification occurred.**
  Calling `verify_proof` is a normal Soroban transaction — it is publicly
  visible on-chain, in the same way any contract call is. What stays
  private is the witness (`secret`); the *act* of verifying, the calling
  address, and the timing are all public, exactly like any other Soroban
  transaction.
- **Replay protection is per-proof, not per-secret.** Covered above —
  resubmitting the exact same proof bytes fails, but a fresh proof of
  the same underlying secret does not. An application needing "this
  secret can only ever be proven once" (not just "this exact calldata
  can only be submitted once") still needs its own commitment-level
  tracking.
- **No privacy for public inputs.** The `commitment` (and any other public
  input) is, by definition, public — it's an argument to `verify_proof`
  and appears in the transaction. Only values the circuit marks `private`
  are hidden.
- **Single-circuit verifier, unless using the registry.**
  `contracts/verifier` hardcodes exactly one verifying key.
  `contracts/registry` supports multiple named circuits, but as of this
  writing only `poseidon_preimage` is registered under it (see
  [zksoroban#183](https://github.com/yusufadeagbo/zksoroban/issues/183)
  for wiring up the other reference circuits).
- **No trusted-setup ceremony has been run for production use.** Repeated
  from Trust Assumptions because it is the single most consequential
  limitation for anyone considering a real (non-testnet) deployment.

## Recommendations for Applications

If you are building on top of `zksoroban`:

1. **Do not deploy the reference circuit's testnet setup artifacts to
   mainnet or anywhere real value is at stake.** Run your own trusted
   setup ceremony for your circuit, with toxic waste destruction you can
   verify or attest to.
2. **Add your own commitment-level replay protection if your application
   needs true single-use-secret semantics** (voting, one-time claims,
   airdrops). The contract's own nullifier ([#11](https://github.com/yusufadeagbo/zksoroban/issues/11))
   stops the exact same proof from being resubmitted, but a fresh,
   re-randomized proof of the same secret still verifies — don't assume
   it enforces "this secret, once, ever" for you.
3. **Treat the admin key as a full cryptographic trust anchor, not just
   a privileged operational key.** Since it can call `propose_vk_update`,
   compromising it means an attacker can eventually make the contract
   accept forged proofs — this is now equivalent in severity to
   compromising the trusted setup itself. Secure it accordingly:
   multi-sig at minimum. The contract itself now enforces a timelock on
   `propose_vk_update`/`execute_vk_update` (see [#46](https://github.com/yusufadeagbo/zksoroban/issues/46)),
   so a compromise is visible and delayable before it takes effect
   without your application needing to build that itself — but the
   delay only helps if something is actually watching
   `get_pending_vk_update()` and can react before it elapses. **Set up
   monitoring on it**; the contract cannot alert you on its own.
4. **Don't rely on `verify_proof` alone for privacy of the fact that a
   verification happened.** If your application needs to hide *who*
   verified *when*, you need additional design beyond what this stack
   provides — e.g. relayers, mixers, or batching, none of which
   `zksoroban` implements.
5. **Pin your SDK version to a verifying key / circuit version.** If you
   change your circuit, its verifying key and the SDK's encoding
   assumptions must change together — see
   [`docs/proof-format.md`](proof-format.md)'s Interoperability Checklist
   for the exact list of things that must all agree.
