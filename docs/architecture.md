# Architecture

`zksoroban` is split into four layers:

- `circuits/`: the zk statement definition
- `sdk/`: the client bridge from `circom` / `snarkjs` output into Soroban calldata
- `contracts/`: the on-chain verifier
- `demo/`: the end-to-end proof generation and verification flow

## Reference Statement

The reference circuit proves knowledge of a private `secret` such that:

```text
Poseidon(secret) == commitment
```

Inputs:

- private: `secret`
- public: `commitment`

The circuit lives in [circuit.circom](/home/amuda/sorobanzk/circuits/poseidon_preimage/circuit.circom).

## Data Flow

```text
secret
  |
  v
Poseidon hash off-chain
  |
  v
commitment
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
reconstructs vk_x and runs pairing check
  |
  v
bool result
```

## Circuit Layer

The circuit is intentionally minimal. It demonstrates the complete zk integration path on Stellar without introducing application-specific logic like nullifiers, Merkle proofs, or registries.

Artifacts:

- `circuit.circom`
- `input_example.json`
- `setup/circuit.zkey`
- `setup/verification_key.json`

The setup artifacts are testnet-only and tied to this exact circuit. If the circuit changes, the proving key, verification key, proof vectors, and contract constants must all change with it.

## SDK Layer

The SDK has three responsibilities:

- `poseidon.ts`: compute the same Poseidon hash used by the reference circuit
- `proof.ts`: convert `snarkjs` proof JSON into the exact BN254 byte layout expected by the contract
- `verify.ts`: build, submit, and decode the Soroban verifier transaction

Public API:

- `poseidon(inputs: bigint[]): bigint`
- `formatProof(proof, publicSignals): SorobanProofCalldata`
- `formatVerifyingKey(vk): RegistryVerifyingKey`
- `verifyOnChain(opts): Promise<VerifyResult>` — `contracts/verifier`, signed transaction
- `verifyViaRegistry(opts): Promise<boolean>` — `contracts/registry`, simulation-only
- `verifyBatchOnChain(opts): Promise<VerifyBatchResult>` — `contracts/verifier`, batched, signed transaction
- `verifyBatchViaRegistry(opts): Promise<boolean[]>` — `contracts/registry`, batched, simulation-only
- `estimateVerifyFee(opts): Promise<EstimateVerifyFeeResult>`
- `getContractConfig(opts): Promise<ContractConfig>`
- `withRetry` / `RetryOptions` — opt-in exponential-backoff retries for transient RPC failures (see below)

See [Batch Verification](#batch-verification) below for the two batch functions.

The SDK is stateless. RPC URL, contract ID, and source keypair are passed in at call time.

### Retry & Exponential Backoff

Every RPC-touching call (`verifyOnChain`, `verifyBatchOnChain`,
`verifyViaRegistry`, `verifyBatchViaRegistry`, `estimateVerifyFee`,
`getContractConfig`, `getContractVersion`) can hit a flaky endpoint: a
public Testnet RPC that rate-limits, a load balancer that drops idle
connections, a node restart mid-request. Pass an optional `retry` policy
to turn on per-request retries with exponential backoff:

```ts
import { verifyViaRegistry } from "@zksoroban/sdk";

const verified = await verifyViaRegistry({
  rpcUrl,
  registryContractId,
  circuitId,
  bundle,
  retry: {
    maxRetries: 3,      // attempts after the initial one
    baseDelayMs: 500,   // first backoff step, doubles each retry
    maxDelayMs: 8_000,  // hard ceiling on any single delay
    jitter: true,       // spread delays over [0, delay] to avoid stampedes
    onRetry: (info) => console.warn(`retrying ${info.label} #${info.attempt} in ${info.delayMs}ms`),
  },
});
```

Omitting `retry` keeps the historical behavior — exactly one attempt —
so enabling it is always an explicit choice.

Key properties:

- **What is retried**: only the *read-only* transport requests —
  `getNetwork`, `getAccount`, `simulateTransaction`, and
  `prepareTransaction` — are individually wrapped. These are safe to
  replay: they mutate nothing on-chain and cost nothing.
- **What is never retried**: `sendTransaction` is deliberately left
  unwrapped, because a signed submission is not idempotent — if the first
  attempt actually reached the network, replaying the same signed
  transaction could charge its fee and apply its effects twice. (Soroban
  does treat a resubmitted identical transaction as DUPLICATE for a while,
  but we don't rely on that window being present or long enough.) The
  transaction-confirmation loop (`getTransaction` polling) is likewise
  never retried by this layer; it already handles NOT_FOUND by polling.
- **What counts as transient**: error-message classification, mirroring
  the SDK's typed-error mapping — network/fetch/timeout strings, node
  error codes (ECONNREFUSED, ETIMEDOUT, …), HTTP 429/5xx, and rate-limit
  responses. Contract-level rejections (`Error(Contract, #N)`),
  malformed-input errors, auth failures, and `Account not found` are
  *permanent*: retrying cannot change the outcome, so they surface
  immediately. An unrecognized failure on a read-only request defaults to
  transient — replaying a pure read can only delay an answer, never
  duplicate one.
- **`Account not found` is permanent on purpose**: `verifyViaRegistry`,
  `verifyBatchViaRegistry`, and `getContractConfig` look up a throw-away
  ephemeral account and fall back to a synthetic `Account` at sequence 0
  when it isn't funded (the expected path). Retrying that lookup would
  stall every registry call for the full backoff curve before falling
  back anyway, so the classifier surfaces it immediately and the fallback
  stays latency-free.
- **Backoff curve**: `baseDelayMs * 2^(attempt-1)` capped at
  `maxDelayMs`. With `jitter: true` (the default) each delay is drawn
  uniformly from `[0, capped]` — full jitter — so many concurrent callers
  failing on the same endpoint don't retry in lockstep and stampede it
  again. Defaults: 3 retries, 500ms base, 8s cap, jitter on.
- **Observability**: `onRetry` fires once per *scheduled* retry, just
  before the sleep — never for permanent failures or exhausted retries,
  which throw to the caller instead.
- **Scope**: transport-only. The retry layer mediates individual RPC
  requests; it never re-runs a call's own logic (calldata validation,
  result decoding, typed-error mapping all happen exactly once).

## Contract Layer

The Soroban verifier contract stores no proofs or nullifiers, but it is
no longer fully stateless: it holds an admin address, per-caller
rate-limit state (see Auth Model below), and — as of the storage-backed
verifying key — the verifying key itself.

The contract:

1. requires the caller's own Soroban auth
2. enforces a per-caller, per-window rate limit
3. parses `proof_a`, `proof_b`, `proof_c`
4. parses the public input field element and the `expiry_ledger` field,
   rejecting proofs whose expiry has already passed
5. reads the currently-stored verifying key and reconstructs
   `vk_x = IC[0] + IC[1] * public_input`
6. runs the Groth16 BN254 pairing equation
7. returns `true` or `false`

The verifying key is set at construction time (`__constructor` takes a
`VerifyingKey` argument alongside `admin`) and can be replaced later —
this means a circuit's verifying key can now be rotated without a full
contract redeploy, the original motivation for this design (see
[zksoroban#9](https://github.com/yusufadeagbo/zksoroban/issues/9)) — at
the cost of a real trust-model change: see
[`docs/security-model.md`](security-model.md)'s Trust Assumptions for
what a compromised admin key can now do that it couldn't before. As of
[zksoroban#46](https://github.com/yusufadeagbo/zksoroban/issues/46),
that replacement is timelocked rather than immediate — see "Timelocked
Verifying-Key Updates" below.

Current Testnet deployment:
`CBL6MAWJALQP25LYKUUOC34K464XPSF6BLKUW6MXZDEXEDXMQUSP7HNN`

### Auth Model

`verify_proof` calls `caller.require_auth()` unconditionally — every
call must be authorized by the address passed as `caller`, not merely
submitted by it. This means:

- An attacker cannot attribute rate-limit usage, or a successful
  verification, to an address that did not itself sign off on this
  specific invocation.
- Authorization is separate from *who pays for and submits* the
  transaction — Soroban's auth framework is meta-transaction friendly,
  so a relayer can submit on a caller's behalf as long as the caller
  supplied a valid auth entry.

`set_limits` similarly requires the *stored* admin address's auth,
looked up from contract storage — not whatever address happens to be
passed as an argument.

There is no allowlist/permission-tiering above this: any address that
can produce a valid Soroban auth entry for itself can call
`verify_proof`, subject only to the rate limit. See
[`docs/security.md`](security.md) for the full threat checklist this
auth model was evaluated against, and
[`docs/security-model.md`](security-model.md) for the full-stack
security model (guarantees, trust assumptions, and threat model)
that application developers building on `zksoroban` should read before
relying on any of this.

### Rate-Limit Storage

`Admin` and `Limits` live in `env.storage().instance()` — small,
rarely-changing config that should always be loaded with the contract.
Per-caller `CallCount(Address, u32)` entries live in
`env.storage().temporary()` instead, with `extend_ttl` called on every
write so an entry survives at least the rest of its own rate-limit
window before the ledger evicts it. This keeps instance storage from
growing by one entry per `(caller, window)` pair for the contract's
entire lifetime (see [`docs/security.md`](security.md) finding #6).

Migrating an already-deployed contract instance to this scheme does
not retroactively clean up anything: a code upgrade replaces the
contract's logic, not its existing storage, so any `CallCount` entries
an older deployment already wrote under `instance()` stay there,
unread and unused by the new code, until that instance is redeployed
from scratch.

### Verification-Count Storage

`VerificationCount(BytesN<32>)` tracks how many times `verify_proof`/
`verify_batch` has *successfully* verified a proof for a given
public-input commitment (the same sha256 hash published as `inputs_hash`
in `VerificationResult`), for off-chain analytics and abuse detection —
queryable via `verification_count`.

This uses `env.storage().instance()` with a `u64` counter, per issue
#41's specification. Unlike `CallCount` (finding #6), the commitment is
derived from the proof's public inputs which the circuit author controls,
so an attacker cannot mint unbounded distinct commitments to grow
storage. The counter increments only on a successful pairing check —
failed proof attempts do not affect the count. The admin can call
`upgrade` to redeploy from scratch if storage ever becomes a concern.

### Timelocked Verifying-Key Updates

Per [zksoroban#46](https://github.com/yusufadeagbo/zksoroban/issues/46),
replacing the verifying key is no longer a single immediate call — the
old `update_vk` is gone, replaced by a two-step propose/execute flow with
a mandatory delay in between:

1. `propose_vk_update(vk)` — requires the stored admin's auth, validates
   `vk.ic.len()` the same way `update_vk` used to, and stores `(vk,
   effective_ledger)` where `effective_ledger = env.ledger().sequence() +
   vk_update_delay`. `vk_update_delay` is fixed at construction (a new
   `__constructor` argument) — there's no way to shorten a delay already
   in effect for a pending proposal, only for the *next* one, since the
   delay isn't itself timelocked.
2. `execute_vk_update()` — applies the pending proposal once
   `env.ledger().sequence() >= effective_ledger`, `Err(TimelockNotElapsed)`
   before that, `Err(NoPendingVkUpdate)` if nothing is proposed.
   **Deliberately permissionless** — it takes no caller argument and
   calls no `require_auth` at all. The thing actually being enforced is
   the admin's own prior commitment (the delay it can't retroactively
   shorten), not a fresh authorization; requiring the admin to also
   execute would let a compromised key simply delay execution
   indefinitely instead of ever completing a proposal it no longer
   wants scrutinized, defeating the "give users time to detect and
   react" goal outright.
3. `get_pending_vk_update() -> Option<(VerifyingKey, u32)>` — read-only,
   no auth, so anyone (including off-chain monitoring) can see a pending
   change and its effective ledger before it lands. Also surfaced as
   `get_config().timelock_delay` (the fixed delay itself, not any
   pending proposal's specific effective ledger).

A second `propose_vk_update` before the first executes replaces it
outright — there is only ever one pending update, not a queue, and the
delay restarts against the new proposal's ledger.

Nothing else on this contract is timelocked — `set_limits`, allowlist
management, `upgrade`, and the admin-transfer flow (see "Admin Ownership
& Contract Upgrades" below) all still take effect immediately. Only the
verifying key gets this treatment, because installing a malicious VK is
the one admin action that breaks *soundness* rather than just
availability or rate-limiting (see `docs/security-model.md`'s Trust
Assumptions) — exactly the escalation this issue's timelock exists to
put a visible, delayable window in front of.

### Nullifier Registry

Per [zksoroban#11](https://github.com/yusufadeagbo/zksoroban/issues/11),
`verify_one` (the shared core of `verify_proof` and `verify_batch`)
derives a nullifier from each proof and rejects one it has already
accepted:

```rust
let nullifier = compute_nullifier(env, &item.proof_a); // sha256(proof_a)
if env.storage().persistent().has(&DataKey::Nullifier(nullifier.clone())) {
    return Err(Error::AlreadyUsed);
}
// ... byte parsing, expiry check, pairing check ...
if verified {
    env.storage().persistent().set(&DataKey::Nullifier(nullifier), &true);
}
```

The check runs right after the rate-limit counter is updated and before
`proof_a`/`proof_b`/`proof_c` are even parsed into curve points — a
replay is rejected as cheaply as this contract can reject anything,
well before the pairing check (the expensive part) ever runs. The
nullifier is only *stored* on a successful verification, so a rejected
or malformed proof never occupies storage.

**Nullifier derivation is `sha256(proof_a)`, not the `Poseidon(proofA_x,
proofA_y)` the issue names** — see `docs/security.md`'s finding #14 for
the full reasoning (short version: Soroban has no ready-to-use Poseidon
hash, only a low-level hazmat primitive that needs hand-supplied round
constants, and a previous attempt at this issue was closed for calling
an `env.poseidon()` method that doesn't exist). Per
`docs/proof-format.md`'s G1 encoding, `proof_a`'s raw bytes already
*are* `x || y` — the two 32-byte coordinates concatenated — so hashing
`proof_a` directly is equivalent to hashing the two coordinates, no
byte-splitting needed.

**This is per-proof, not per-statement.** Groth16 proofs are
randomized: a second, independently-generated proof of the exact same
secret has different proof bytes, a different nullifier, and verifies
successfully again. This closes "resubmit the same calldata" — the
literal replay attack — not "prove knowledge of this secret more than
once," which needs its own commitment-level tracking in the
application if that stronger property is what it actually needs (a
one-time claim or vote, for instance). See `docs/security.md`'s
Guarantees and Non-Guarantees section for the precise boundary.

`Nullifier(BytesN<32>)` entries live in **persistent** storage and are
never cleaned up — [#11](https://github.com/yusufadeagbo/zksoroban/issues/11)'s
own scope explicitly excludes nullifier expiry. Unlike the old
`CallCount` bug (finding #6), an attacker cannot mint these for free:
each one requires an actual successful pairing check against a real
proof, submitted in a real, fee-paying transaction — the same bound
`VerificationCount` (finding #11) already relies on.

## Events

Both `contracts/verifier::verify_proof` and `contracts/registry::verify_proof`
publish a `verification_result` event on the outcome paths that return via
`Ok(...)` — see [zksoroban#10](https://github.com/yusufadeagbo/zksoroban/issues/10).

Topics: `["zk", "verify"]` (fixed, via `#[contractevent(topics = ["zk", "verify"])]`).

Data (a map, one entry per field):

| Field         | Type         | Verifier | Registry |
|---------------|--------------|----------|----------|
| `success`     | `bool`       | yes      | yes      |
| `caller`      | `Address`    | yes      | no — registry's `verify_proof(id, ...)` takes no caller/auth argument |
| `inputs_hash` | `BytesN<32>` | yes      | yes      |

`inputs_hash` is **sha256** of the concatenated `public_inputs` bytes, in
call order — not Poseidon. Poseidon is not available as a host primitive
in this Soroban SDK version (only `sha256`/`keccak256` and the BN254/BLS12-381
pairing operations are); the only existing Poseidon implementation in this
repo (`sdk/src/poseidon.ts`) is a variable-arity implementation whose round
constants are loaded at runtime from `circomlibjs`'s JS data tables, with no
practical `no_std` Rust port. Since this hash only feeds off-chain indexers
and monitoring — it is never re-consumed by a circuit or checked
in-contract — Poseidon's SNARK-friendliness has no benefit here, so sha256
was used instead.

### Why the allowlist/rate-limit/expiry rejections in `contracts/verifier` don't emit an event

Soroban rolls back **all** events published during a contract call whose
top-level return is `Err(code)` from a `#[contracterror]`-typed `Result`
(confirmed empirically against this repo's `soroban-sdk` version — the
WASM ABI encodes a contract-level `Err` return as a failed invocation, and
the host rolls back both storage and events to the state the call started
with). `verify_proof` still returns `Err(Error::CallerNotAllowed)`,
`Err(Error::RateLimitExceeded)`, and `Err(Error::ProofExpired)` for those
three rejections, exactly as before this event was added — so publishing on
those paths would be dead code; the event would never actually reach an
indexer.

Those three cases don't need the event to be observable, though: a failed
`verify_proof` transaction already carries its specific `Error` variant
(decoded by the SDK's typed-error mapping — see #184), which is at least as
informative as this event's bare `success: bool` would have been. The event
only adds real value on the paths that were genuinely silent before it
existed and still return `Ok(...)`: wrong public input count, a malformed
`expiry_ledger` encoding, and the pairing-check result itself. Those are
the only three paths `contracts/verifier::verify_proof` publishes on.

`contracts/registry::verify_proof` was never affected by this — it always
returned a bare `bool`, never `Result`, so every one of its outcomes
(unknown circuit ID, wrong input count, pairing result) publishes the
event.

## Demo Layer

The demo script proves the full stack works on Testnet:

1. generate a fresh random secret
2. compute its Poseidon commitment
3. generate a Groth16 proof with `snarkjs`
4. format the proof through the SDK
5. invoke the Soroban verifier
6. print the transaction hash and verification result

This is the strongest practical test in the repo because it exercises:

- the circuit
- the setup artifacts
- the SDK encoding
- Soroban transaction submission
- the deployed verifier contract

## Verifying Key Registry

The single-circuit verifier hardcodes one verifying key. The registry contract in `contracts/registry/` generalizes this so multiple circuits can be supported without redeploying.

The registry stores a verifying key per circuit ID and dispatches verification to the matching key:

```text
register_circuit(id, vk)         verify_proof(id, proof, public_inputs)
        |                                   |
        v                                   v
  admin.require_auth()              lookup vk by circuit id
        |                                   |
        v                          +--------+--------+
  store vk under                   |                 |
  Circuit(id)                  found vk         unknown id
        |                          |                 |
        v                          v                 v
  persistent storage      reconstruct vk_x      return false
                          + BN254 pairing        (no panic)
                                   |
                                   v
                            bool result
```

Key properties:

- `register_circuit(id, vk)` is gated by the admin address configured at construction.
- `verify_proof(id, ...)` returns `false` for unknown circuit IDs instead of panicking.
- The verifying key is variable-length: it carries `alpha`, `beta`, `gamma`, `delta`, and an `ic` vector whose length is one greater than the circuit's public input count.

### Testnet Deployment

The registry is deployed and live on Stellar Testnet:

- Contract address: `CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH`
- `poseidon_preimage` is registered under circuit ID `1`, using the same
  verifying key as `contracts/verifier`'s hardcoded constants (encoded
  identically — verified byte-for-byte against
  `contracts/registry/src/tests.rs`'s known-correct test constants
  before registering).
- Verified against real, previously-proven-valid proof bytes (the same
  ones `sdk/test/fixtures.ts` uses): a correct proof returns `true`, and
  a deliberately tampered proof (negated `proof_a` y-coordinate) returns
  `false`. Both checked directly on-chain via `stellar contract invoke`,
  not simulated.

**What is not yet done**: `merkle_inclusion`, `range_proof`, and
`threshold_2of3` are registered with the registry and verified end to
end in a local test environment (`contracts/registry/src/tests.rs`),
but not yet registered on the *live* Testnet deployment — that
`register_circuit` call needs the registry's admin key, which is a
maintainer action, not something a contributor's PR can do on its own.
See docs/multi-circuit.md for the full pattern. `demo/` itself now
targets the live registry (circuit ID `1`, `poseidon_preimage`) via
`sdk/src/verify.ts`'s `verifyViaRegistry`, and `contracts/verifier`'s
own `verify_proof(caller, ...)` signature is what `verifyOnChain`
speaks.

## Batch Verification

Both contracts have a `verify_batch` entry point alongside `verify_proof`,
so an application that needs to check many proofs pays one transaction's
overhead instead of one per proof — see
[zksoroban#13](https://github.com/yusufadeagbo/zksoroban/issues/13).

### `contracts/verifier::verify_batch`

```rust
verify_batch(caller: Address, proofs: Vec<ProofItem>) -> Result<Vec<bool>, Error>
```

One caller, many proofs — `caller.require_auth()` happens once for the
whole batch, not once per item. Each `ProofItem` (`proof_a`, `proof_b`,
`proof_c`, `public_inputs` — the same fields `verify_proof` takes, minus
`caller`) is still run through the *exact* allowlist/rate-limit/expiry/
pairing logic `verify_proof` uses (both now call a shared internal
`verify_one`), in order, against the same rate-limit counter — so an
earlier proof in the batch consuming budget can cause a later one in the
*same* batch to come back `false` for exceeding the limit.

The one behavior batch deliberately does **not** share with
`verify_proof`: a per-item allowlist/rate-limit/expiry rejection never
fails the call. `verify_batch` only returns `Err(...)` for
`Error::NotInitialized` — a genuinely batch-invalidating condition (the
contract itself isn't set up) — never for an individual bad proof, which
just becomes `false` in the result vec. This is why batch can also do
something `verify_proof` can't: publish a `verification_result` event for
*every* item, rejected or not. `verify_proof`'s own event is deliberately
skipped on its `Err(...)` paths (see [Events](#events) above) because
that `Err` rolls back the whole call, making publishing there a silent
no-op — but a per-item rejection inside `verify_batch` never rolls back
the batch call itself, so its event survives, unlike a standalone
`verify_proof` call for the same rejected proof would.

### `contracts/registry::verify_batch`

```rust
verify_batch(batch: Vec<BatchItem>) -> Vec<bool>
```

Each `BatchItem` adds a `circuit_id: u32` field on top of the same proof
fields, so one call can batch proofs against *different* circuits —
the main reason batching is more valuable against the registry than the
single-circuit verifier (see the issue's scoping note). No auth, no
`Result` — same as `verify_proof(id, ...)`, every outcome (including an
unknown circuit ID) is just `true`/`false`, and every item gets its own
event unconditionally, with no `Err`-rollback subtlety to work around at
all.

### SDK

- `verifyBatchOnChain(opts): Promise<VerifyBatchResult>` — targets
  `contracts/verifier`, mirrors `verifyOnChain`: requires a `keypair`
  (real auth, real rate-limit mutation) and submits one signed
  transaction.
- `verifyBatchViaRegistry(opts): Promise<boolean[]>` — targets
  `contracts/registry`, mirrors `verifyViaRegistry`: no `keypair`,
  simulation-only, since the registry's `verify_batch` requires no auth
  and mutates no storage.

Both encode their `items` array as a single `Vec<ProofItem>` /
`Vec<BatchItem>` contract argument — one Soroban operation, one
transaction, regardless of batch size. Each item is a `#[contracttype]
struct`, which Soroban encodes as a Map keyed by `Symbol`, not `String` —
the SDK builds these with `nativeToScVal`'s per-field `'symbol'` key-type
hint rather than its object default (which produces `String` keys and
would fail to decode on the contract side).

### Demo

`demo/src/batchVerify.ts` is a non-interactive integration script:
it batch-verifies 3 real proofs — loaded directly from
`circuits/{range_proof,threshold_2of3,merkle_inclusion}/fixtures/
{proof,public}.json`, no `circom` toolchain needed — across those 3
circuit IDs, in one `verifyBatchViaRegistry` call. Run against the live
Testnet registry (this script's default), every result comes back `false`
today, for the same reason noted above: only `poseidon_preimage` is
registered there. Pointed at a registry instance that has the other three
circuits registered (`SOROBAN_TEST_REGISTRY_CONTRACT_ID`), it asserts
every result is `true` instead.

## Cross-Contract Interface

Before this, an application contract that wanted to call `verify_proof`
from its own Soroban code had to hand-write the cross-contract invocation
itself — the argument encoding, the function-name symbol, and typing the
return value — with nothing to check any of that against the real
deployed contract at compile time.
[`contracts/verifier-interface`](../contracts/verifier-interface) is a
small, dependency-light crate published for exactly this: it defines a
`VerifierInterface` trait with one method,
`verify_proof(caller, proof_a, proof_b, proof_c, public_inputs) ->
Result<bool, Error>`, matching `contracts/verifier`'s real exported
function name and signature exactly — cross-contract calls dispatch by
function-name symbol, so this can't be a shorter/friendlier name without
breaking every call it makes against the actually-deployed contract.

`#[contractclient(name = "VerifierClient")]` on that trait generates a
`VerifierClient` type: `VerifierClient::new(&env, &verifier_contract_id)`,
then `.verify_proof(&caller, &proof_a, &proof_b, &proof_c,
&public_inputs)` to invoke it, and `.try_verify_proof(...)` if the caller
wants the callee's `Result` instead of a panic on `Err`. This is the same
codegen path `#[contractimpl]` already uses to build every contract's own
auto-generated client (e.g. `VerifierContractClient` in
`contracts/verifier`'s own tests) — `verifier-interface` just publishes
that generated client under a name and version anyone can depend on,
without depending on `contracts/verifier`'s whole implementation crate
(which is `cdylib`-only and not meant to be linked as a library anyway).

`contracts/verifier` itself now implements this trait —
`impl VerifierInterface for VerifierContract` replaces what used to be a
plain inherent `pub fn verify_proof`, with an identical body and, per
`stellar contract info interface`, an identical exported spec entry. This
was checked, not assumed: every existing unit test in
`contracts/verifier/src/tests.rs` (58 of them, including the ones calling
`verify_proof` directly through its own auto-generated client) passed
unmodified after the change.

`verifier-interface` mirrors `contracts/verifier`'s `Error` enum's
variants and discriminants rather than depending on that crate for it (a
downstream contract that only wants the interface, not the whole
implementation, still gets a correctly-decoding error type) — a
cross-contract call decodes the callee's error purely by its numeric
`#[contracterror]` code, not by Rust type identity, so an independently
defined enum with matching discriminants decodes a real rejection
correctly. `contracts/verifier` itself, however, has a real dependency
edge on `verifier-interface` already, so it reuses that same `Error` type
directly rather than keeping its own copy in sync by hand.

### Example: `contracts/examples/proof-gate`

[`contracts/examples/proof-gate`](../contracts/examples/proof-gate) is a
minimal contract built entirely around this pattern — its one function,
`check(verifier, caller, proof_a, proof_b, proof_c, public_inputs) ->
bool`, does nothing but:

```rust
VerifierClient::new(&env, &verifier).verify_proof(
    &caller, &proof_a, &proof_b, &proof_c, &public_inputs,
)
```

Two things worth knowing before writing your own version of this:

- **`caller` still has to be authorized for the *nested* call, not just
  the outer one.** `check`'s own caller doesn't automatically inherit
  authorization for `verify_proof`'s `caller.require_auth()` one level
  down — a real signed transaction's authorization tree has to cover both
  invocations (this is exactly what
  `cross_contract_call_still_requires_the_callers_auth` in this crate's
  test suite asserts: calling `check` with no authorization set up at all
  panics, the same way calling `verify_proof` directly would).
- **In tests, `env.mock_all_auths()` alone isn't enough.** It only
  auto-authorizes `require_auth()` calls made by the directly-invoked
  (root) contract; `verify_proof`'s `require_auth()` runs one level
  deeper, inside the cross-contract call `check` makes, so it needs
  `env.mock_all_auths_allowing_non_root_auth()` instead — otherwise the
  whole call fails with `Error(Auth, InvalidAction)` even for a
  perfectly-valid `caller`. This tripped up this example's own first
  draft; see the comment above it in
  `contracts/examples/proof-gate/src/tests.rs`.

The example's own tests run against a trivial in-crate `FakeVerifier` (an
independent `impl VerifierInterface for FakeVerifier` with a fixed rule
instead of real Groth16 verification), not the real
`contracts/verifier` — proving the cross-contract dispatch, argument
encoding, and auth propagation work, without needing real proof/circuit
fixtures duplicated into yet another crate. What proves the published
`VerifierClient` actually interoperates with the *real* contract and a
*real* proof is a separate test back in
`contracts/verifier/src/tests.rs`:
`published_verifier_client_interoperates_with_the_real_contract` deploys
the real `VerifierContract`, then calls it through
`zksoroban_verifier_interface::VerifierClient` (rather than through
`VerifierContractClient`, the crate's own `#[contractimpl]`-generated
client used everywhere else in that file) with the same
`poseidon_preimage` fixture the rest of the suite uses, and asserts it
comes back `true`.

## Admin Ownership & Contract Upgrades

Both `contracts/verifier` and `contracts/registry` share the same
two-step admin transfer and self-upgrade mechanism — see
[zksoroban#12](https://github.com/yusufadeagbo/zksoroban/issues/12).

### Two-step admin transfer

Rotating the admin address is a two-call handshake, not a single
"set new admin" call, so a mistyped or unreachable address can never
strand the contract without a working admin:

1. `propose_admin(new_admin)` — requires the **current** admin's auth.
   Stores `new_admin` as pending; the current admin is unchanged until
   step 2 completes.
2. `accept_admin()` — requires the **pending** admin's own auth, not the
   current admin's. Promotes the pending admin to admin and clears the
   pending slot.

`pending_admin()` is a read-only getter for whatever is currently
proposed (`None` if nothing is pending). Calling `accept_admin` with
nothing pending fails — `Err(Error::NoPendingAdmin)` on
`contracts/verifier`, a panic on `contracts/registry` (matching that
contract's existing panic-based error handling; it has no
`#[contracterror]` type today).

`propose_admin` and `accept_admin` never touch the contract's wasm or any
other state — they only ever change who the admin address is.

### Upgrade

`upgrade(new_wasm_hash)` — requires the current admin's auth — calls
`env.deployer().update_current_contract_wasm(new_wasm_hash)`, replacing
the contract's executable in place. The contract's address and storage
are untouched; only the code behind them changes. The new wasm must
already be uploaded to the network
(`env.deployer().upload_contract_wasm`) before calling `upgrade` — the
host rejects a hash that isn't already-uploaded code. The swap doesn't
take effect until the current invocation finishes, so a contract can't
upgrade itself mid-call and then keep running as the new code.

### Emergency Pause

`contracts/verifier` (only — `contracts/registry` doesn't have this)
adds a `pause()`/`unpause()` admin-only toggle, per
[zksoroban#44](https://github.com/yusufadeagbo/zksoroban/issues/44).
While paused, `verify_proof` and `verify_batch` both reject every call
with `Err(Error::ContractPaused)` as the very first thing they do —
before `caller.require_auth()`, before touching rate-limit storage,
before parsing anything. `is_paused()` (also surfaced on
`get_config().paused`) is a public read-only getter, so monitoring
doesn't need the admin's key to check current state.

Nothing else is gated by this — `update_vk`, `upgrade`, `set_limits`,
allowlist management, and the admin-transfer flow above all still work
while paused, deliberately: those are exactly how a real incident
actually gets fixed, and a pause that locked out its own remedy would
turn an emergency stop into a permanent one.

### Out of scope (per #12)

No timelock on either the handoff or the upgrade, no governance/voting,
and no proxy pattern — both contracts upgrade their own executable in
place rather than sitting behind a separate, swappable proxy address. A
compromised admin key can immediately upgrade either contract to
arbitrary code, and can propose an ownership handoff (though not force
one through — `accept_admin` still needs the *recipient's* own auth).
See [`docs/security-model.md`](security-model.md)'s Trust Assumptions for
what a compromised admin key can do.

## Design Choices

Why the verifier keeps its state minimal (admin + rate-limit counters,
nothing proof- or nullifier-related):

- simpler to audit
- cheaper to invoke
- enough for an MVP reference implementation

Why the verifying key is storage-backed rather than hardcoded:

- a circuit's key can be rotated (new trusted setup, fixed a bug in the
  original ceremony, etc.) without a full contract redeploy, which
  would otherwise break every existing integration's contract address
- this is still a single-circuit verifier — `ic` length is validated
  against this circuit's fixed public-input count, not made fully
  generic; `contracts/registry` is the separate contract for genuinely
  multi-circuit support

Why Groth16:

- proofs are compact
- verification is efficient
- the Soroban BN254 host support makes it practical on-chain

## Non-Goals for This MVP

Out of scope for the current architecture:

- nullifier tracking
- multi-circuit verifier registries
- privacy-preserving application logic
- production trusted setup ceremonies
- wallet UX

Those are downstream systems that can be built on top of this foundation.
