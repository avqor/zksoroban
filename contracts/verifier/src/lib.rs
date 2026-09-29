#![no_std]

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine, BN254_G1_SERIALIZED_SIZE, BN254_G2_SERIALIZED_SIZE},
    vec, Address, Bytes, BytesN, Env, String, Vec,
};
use zksoroban_verifier_interface::{Error, VerifierInterface};

const PROOF_A_LEN: usize = BN254_G1_SERIALIZED_SIZE;
const PROOF_B_LEN: usize = BN254_G2_SERIALIZED_SIZE;
const CIRCUIT_PUBLIC_INPUT_COUNT: u32 = 1;
const EXPECTED_PUBLIC_INPUT_COUNT: u32 = CIRCUIT_PUBLIC_INPUT_COUNT + 1;
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[contracttype]
#[derive(Clone)]
pub struct VerifyingKey {
    pub alpha: BytesN<64>,
    pub beta: BytesN<128>,
    pub gamma: BytesN<128>,
    pub delta: BytesN<128>,
    pub ic: Vec<BytesN<64>>,
}

#[contracttype]
#[derive(Clone)]
pub struct Limits {
    pub max_calls: u32,
    pub window_size: u32,
}

/// A read-only snapshot of all non-sensitive contract configuration fields.
/// Fields that the current contract does not implement are returned as `None`.
#[contracttype]
#[derive(Clone)]
pub struct ContractConfig {
    /// The contract administrator address.
    pub admin: Address,
    /// Whether the contract is paused — see `pause`/`unpause`.
    pub paused: bool,
    /// Optional fee amount in stroops (not implemented; always `None`).
    pub fee_amount: Option<i128>,
    /// Optional fee token contract address (not implemented; always `None`).
    pub fee_token: Option<Address>,
    /// Maximum number of `verify_proof` calls allowed per caller per window.
    pub rate_limit_max: u32,
    /// Rate-limit window size in ledgers.
    pub rate_limit_window: u32,
    /// Ledgers a proposed verifying key update must wait before
    /// `execute_vk_update` will accept it — see `propose_vk_update`.
    pub timelock_delay: Option<u32>,
    /// Whether the caller allowlist is currently enforced.
    pub allowlist_enabled: bool,
}

#[contracttype]
enum DataKey {
    Admin,
    PendingAdmin,
    Limits,
    Vk,
    CallCount(Address, u32),
    AllowlistEnabled,
    Allowlist(Address),
    VerificationCount(BytesN<32>),
    VkUpdateDelay,
    PendingVkUpdate,
    Paused,
    Nullifier(BytesN<32>),
}

/// Emitted on every `verify_proof` call, regardless of outcome.
#[contractevent(topics = ["zk", "verify"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerificationResult {
    pub success: bool,
    pub caller: Address,
    /// sha256 of the concatenated public inputs, in call order.
    pub inputs_hash: BytesN<32>,
}

/// One entry in a `verify_batch` call — the same fields `verify_proof` takes,
/// minus `caller`, since a batch shares one caller across all its proofs.
#[contracttype]
#[derive(Clone)]
pub struct ProofItem {
    pub proof_a: Bytes,
    pub proof_b: Bytes,
    pub proof_c: Bytes,
    pub public_inputs: Vec<BytesN<32>>,
}

#[contract]
pub struct VerifierContract;

#[contractimpl]
impl VerifierContract {
    pub fn __constructor(
        env: Env,
        admin: Address,
        max_calls: u32,
        window_size: u32,
        vk: VerifyingKey,
        vk_update_delay: u32,
    ) {
        assert!(window_size > 0, "window_size must be positive");
        assert!(
            vk.ic.len() == EXPECTED_PUBLIC_INPUT_COUNT,
            "verifying key ic length must equal EXPECTED_PUBLIC_INPUT_COUNT"
        );

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Limits, &Limits { max_calls, window_size });
        env.storage().instance().set(&DataKey::Vk, &vk);
        env.storage()
            .instance()
            .set(&DataKey::VkUpdateDelay, &vk_update_delay);
    }

    pub fn limits(env: Env) -> Limits {
        env.storage()
            .instance()
            .get(&DataKey::Limits)
            .expect("contract is not initialized")
    }

    pub fn version(env: Env) -> String {
        String::from_str(&env, CONTRACT_VERSION)
    }

    /// Number of times `verify_proof`/`verify_batch` has successfully
    /// verified a proof for `commitment` — the sha256 hash of the
    /// concatenated public inputs, i.e. the same value published as
    /// `inputs_hash` in `VerificationResult`. Intended for off-chain
    /// analytics and abuse detection (e.g. flagging a commitment verified
    /// far more often than legitimate usage would produce).
    ///
    /// Returns 0 for a commitment that has never been successfully
    /// verified.
    pub fn verification_count(env: Env, commitment: BytesN<32>) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::VerificationCount(commitment))
            .unwrap_or(0)
    }

    pub fn set_limits(env: Env, max_calls: u32, window_size: u32) -> Result<(), Error> {
        if window_size == 0 {
            return Err(Error::InvalidWindowSize);
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::Limits, &Limits { max_calls, window_size });
        Ok(())
    }

    /// Propose `vk` as the next verifying key. Requires the stored admin's
    /// auth. Does not take effect until `execute_vk_update` is called no
    /// earlier than `vk_update_delay` ledgers from now (the delay fixed at
    /// construction) — see [zksoroban#46](https://github.com/yusufadeagbo/zksoroban/issues/46).
    /// A second `propose_vk_update` call before the first one executes
    /// replaces it outright, resetting the delay against the new proposal.
    pub fn propose_vk_update(env: Env, vk: VerifyingKey) -> Result<(), Error> {
        if vk.ic.len() != EXPECTED_PUBLIC_INPUT_COUNT {
            return Err(Error::InvalidVerifyingKey);
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        let delay: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VkUpdateDelay)
            .ok_or(Error::NotInitialized)?;
        let effective_ledger = env.ledger().sequence() + delay;

        env.storage()
            .instance()
            .set(&DataKey::PendingVkUpdate, &(vk, effective_ledger));
        Ok(())
    }

    /// Apply the currently-proposed verifying key update. Permissionless —
    /// anyone can call this, not just the admin — because by the time the
    /// delay has elapsed the change was already publicly visible via
    /// `get_pending_vk_update`; what's actually being enforced is the
    /// admin's own timelock on itself, not a fresh authorization.
    pub fn execute_vk_update(env: Env) -> Result<(), Error> {
        let (vk, effective_ledger): (VerifyingKey, u32) = env
            .storage()
            .instance()
            .get(&DataKey::PendingVkUpdate)
            .ok_or(Error::NoPendingVkUpdate)?;

        if env.ledger().sequence() < effective_ledger {
            return Err(Error::TimelockNotElapsed);
        }

        env.storage().instance().set(&DataKey::Vk, &vk);
        env.storage().instance().remove(&DataKey::PendingVkUpdate);
        Ok(())
    }

    /// The currently-proposed verifying key update, if any: the proposed
    /// key and the ledger sequence at/after which `execute_vk_update` will
    /// succeed. `None` once executed, or if nothing has been proposed.
    pub fn get_pending_vk_update(env: Env) -> Option<(VerifyingKey, u32)> {
        env.storage().instance().get(&DataKey::PendingVkUpdate)
    }

    pub fn set_allowlist_mode(env: Env, enabled: bool) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::AllowlistEnabled, &enabled);
        Ok(())
    }

    pub fn allowlist_enabled(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::AllowlistEnabled)
            .unwrap_or(false)
    }

    /// Emergency stop: while paused, `verify_proof`/`verify_batch` reject
    /// every call with `Error::ContractPaused` before doing anything else
    /// (no auth check, no rate-limit read, no proof parsing). Requires the
    /// stored admin's auth. Does not affect any other entry point — the
    /// admin can still call `propose_vk_update`/`execute_vk_update`/
    /// `upgrade`/`unpause` etc. while paused, since those are exactly how
    /// a real incident gets resolved.
    pub fn pause(env: Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    /// Clears the pause flag `pause` set. Requires the stored admin's auth.
    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    /// Whether `pause` is currently in effect. `false` until `pause` has
    /// ever been called (the constructor doesn't set this explicitly).
    pub fn is_paused(env: Env) -> bool {
        is_contract_paused(&env)
    }

    pub fn add_to_allowlist(env: Env, addr: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::Allowlist(addr), &true);
        Ok(())
    }

    pub fn remove_from_allowlist(env: Env, addr: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .remove(&DataKey::Allowlist(addr));
        Ok(())
    }

    pub fn is_allowlisted(env: Env, addr: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Allowlist(addr))
            .unwrap_or(false)
    }

    /// Return a snapshot of all non-sensitive contract configuration fields.
    /// This is a read-only view: no auth is required and no state is mutated.
    pub fn get_config(env: Env) -> Result<ContractConfig, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        let limits: Limits = env
            .storage()
            .instance()
            .get(&DataKey::Limits)
            .ok_or(Error::NotInitialized)?;

        let allowlist_enabled: bool = env
            .storage()
            .instance()
            .get(&DataKey::AllowlistEnabled)
            .unwrap_or(false);

        let vk_update_delay: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VkUpdateDelay)
            .ok_or(Error::NotInitialized)?;

        Ok(ContractConfig {
            admin,
            paused: is_contract_paused(&env),
            fee_amount: None,
            fee_token: None,
            rate_limit_max: limits.max_calls,
            rate_limit_window: limits.window_size,
            timelock_delay: Some(vk_update_delay),
            allowlist_enabled,
        })
    }

    /// Propose `new_admin` as the next admin. Requires the *current* admin's
    /// auth. Does not take effect until `new_admin` calls `accept_admin`.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    /// The address currently proposed via `propose_admin`, if any.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// Promote the pending admin to admin. Requires the *pending* admin's
    /// own auth — the current admin cannot force this through.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::NoPendingAdmin)?;
        pending.require_auth();

        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Ok(())
    }

    /// Replace this contract's executable with `new_wasm_hash`. Requires the
    /// current admin's auth. The wasm must already be uploaded (see
    /// `env.deployer().upload_contract_wasm`) before this call.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Verify a batch of proofs from one caller in a single call. Each proof
    /// is still subject to its own allowlist/rate-limit/expiry check, applied
    /// in order — an earlier proof in the batch that consumes rate-limit
    /// budget affects whether a later one in the *same* batch passes.
    ///
    /// Unlike `verify_proof`, a per-proof rejection (allowlist, rate limit,
    /// expiry) does not fail the call — it becomes `false` in the returned
    /// vec, and `verify_batch` keeps processing the rest of the batch. This
    /// is deliberate: a batch's transaction never fails just because one
    /// proof in it was invalid, and unlike a single `verify_proof` call,
    /// there is no failed-transaction error code to fall back on to learn
    /// *why* a given entry came back `false` — so every entry, rejected or
    /// not, gets its own `verification_result` event.
    ///
    /// `Err(Error::NotInitialized)` is the one exception: that means the
    /// contract itself isn't set up, not that any particular proof is bad,
    /// so it aborts the whole batch (nothing in it could have succeeded).
    pub fn verify_batch(
        env: Env,
        caller: Address,
        proofs: Vec<ProofItem>,
    ) -> Result<Vec<bool>, Error> {
        if is_contract_paused(&env) {
            return Err(Error::ContractPaused);
        }
        caller.require_auth();

        let mut results = Vec::new(&env);
        for item in proofs.iter() {
            let success = match verify_one(&env, &caller, &item) {
                Ok(success) => success,
                Err(Error::NotInitialized) => return Err(Error::NotInitialized),
                Err(_) => false,
            };
            publish_verification_result(&env, &caller, success, &item.public_inputs);
            results.push_back(success);
        }

        Ok(results)
    }
}

/// Published as `zksoroban-verifier-interface`'s `VerifierInterface` trait
/// so another Soroban contract can call `verify_proof` through the
/// generated `VerifierClient` instead of hand-writing the cross-contract
/// invocation — see `docs/architecture.md`'s "Cross-Contract Interface"
/// section and `contracts/examples/proof-gate`.
#[contractimpl]
impl VerifierInterface for VerifierContract {
    fn verify_proof(
        env: Env,
        caller: Address,
        proof_a: Bytes,
        proof_b: Bytes,
        proof_c: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<bool, Error> {
        if is_contract_paused(&env) {
            return Err(Error::ContractPaused);
        }
        caller.require_auth();

        let item = ProofItem {
            proof_a,
            proof_b,
            proof_c,
            public_inputs,
        };
        let result = verify_one(&env, &caller, &item);

        // Same rule as before: only publish on an Ok(...) outcome. An Err(...)
        // here rolls back the whole call (see the note on publish_verification_result),
        // so publishing first would be a silent no-op.
        if let Ok(success) = result {
            publish_verification_result(&env, &caller, success, &item.public_inputs);
        }

        result
    }
}

/// The shared core of `verify_proof` and `verify_batch`: run every check for
/// one proof (allowlist, rate limit, byte parsing, input count, expiry,
/// pairing) and return its outcome. Does not publish an event itself —
/// callers decide when and whether that's meaningful for their own outcome
/// handling (see `verify_proof` and `verify_batch` above).
fn verify_one(env: &Env, caller: &Address, item: &ProofItem) -> Result<bool, Error> {
    let allowlist_enabled: bool = env
        .storage()
        .instance()
        .get(&DataKey::AllowlistEnabled)
        .unwrap_or(false);
    if allowlist_enabled {
        let allowed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Allowlist(caller.clone()))
            .unwrap_or(false);
        if !allowed {
            return Err(Error::CallerNotAllowed);
        }
    }

    let limits: Limits = env
        .storage()
        .instance()
        .get(&DataKey::Limits)
        .ok_or(Error::NotInitialized)?;

    let ledger = env.ledger().sequence();
    let window_start = ledger - (ledger % limits.window_size);
    let count_key = DataKey::CallCount(caller.clone(), window_start);
    let current: u32 = env.storage().temporary().get(&count_key).unwrap_or(0);
    let next = current + 1;
    if next > limits.max_calls {
        return Err(Error::RateLimitExceeded);
    }
    env.storage().temporary().set(&count_key, &next);
    env.storage()
        .temporary()
        .extend_ttl(&count_key, limits.window_size, limits.window_size);

    let nullifier = compute_nullifier(env, &item.proof_a);
    if env
        .storage()
        .persistent()
        .has(&DataKey::Nullifier(nullifier.clone()))
    {
        return Err(Error::AlreadyUsed);
    }

    let proof_a = read_g1(&item.proof_a, "proof_a");
    let proof_b = read_g2(&item.proof_b, "proof_b");
    let proof_c = read_g1(&item.proof_c, "proof_c");

    if item.public_inputs.len() != EXPECTED_PUBLIC_INPUT_COUNT {
        return Ok(false);
    }

    let expiry_ledger = match read_expiry_ledger(&item.public_inputs.get(1).unwrap()) {
        Some(value) => value,
        None => return Ok(false),
    };

    if ledger > expiry_ledger {
        return Err(Error::ProofExpired);
    }

    let vk: VerifyingKey = env
        .storage()
        .instance()
        .get(&DataKey::Vk)
        .ok_or(Error::NotInitialized)?;

    let vk_alpha = Bn254G1Affine::from_bytes(vk.alpha);
    let vk_beta = Bn254G2Affine::from_bytes(vk.beta);
    let vk_gamma = Bn254G2Affine::from_bytes(vk.gamma);
    let vk_delta = Bn254G2Affine::from_bytes(vk.delta);
    let vk_ic0 = Bn254G1Affine::from_bytes(vk.ic.get(0).unwrap());
    let vk_ic1 = Bn254G1Affine::from_bytes(vk.ic.get(1).unwrap());

    let public_input = Bn254Fr::from_bytes(item.public_inputs.get(0).unwrap());
    let vk_x = vk_ic0 + (vk_ic1 * public_input);

    let verified = env.crypto().bn254().pairing_check(
        vec![env, proof_a, -vk_alpha, -vk_x, -proof_c],
        vec![env, proof_b, vk_beta, vk_gamma, vk_delta],
    );

    if verified {
        let commitment = compute_inputs_hash(env, &item.public_inputs);
        record_verification_attempt(env, &commitment);
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier), &true);
    }

    Ok(verified)
}

/// Publish the `verification_result` event for an outcome that returns via
/// `Ok(...)`. Deliberately not called on the `Err(...)` paths above — Soroban
/// rolls back all events published during a call that ultimately returns
/// `Err` from a `#[contracterror]` `Result`, so publishing there would be a
/// silent no-op. Those paths are already visible to callers as a failed
/// transaction with a specific error code, which is at least as informative
/// as this event's bare `success: bool` would be.
fn publish_verification_result(
    env: &Env,
    caller: &Address,
    success: bool,
    public_inputs: &Vec<BytesN<32>>,
) {
    VerificationResult {
        success,
        caller: caller.clone(),
        inputs_hash: compute_inputs_hash(env, public_inputs),
    }
    .publish(env);
}

/// Track how many times a proof has been successfully verified for a given
/// public-input commitment, for off-chain analytics and abuse detection
/// (see `VerifierContract::verification_count`).
///
/// The counter uses `instance()` storage so it persists across calls and
/// never resets — unlike `CallCount` (finding #6), the commitment is
/// derived from the proof's public inputs which the contract author
/// controls via the circuit, so an attacker cannot mint unbounded
/// distinct commitments to grow storage. The admin can call `upgrade`
/// to redeploy from scratch if storage ever becomes a concern.
fn record_verification_attempt(env: &Env, commitment: &BytesN<32>) {
    let key = DataKey::VerificationCount(commitment.clone());
    let current: u64 = env.storage().instance().get(&key).unwrap_or(0);
    let next = current + 1;
    env.storage().instance().set(&key, &next);
}

/// Derives a proof's nullifier from `proof_a`'s raw bytes for replay
/// protection (see [zksoroban#11](https://github.com/yusufadeagbo/zksoroban/issues/11)
/// and `docs/security.md`'s nullifier finding for why this is sha256, not
/// the Poseidon the issue names). Per `docs/proof-format.md`'s G1
/// encoding, `proof_a` already *is* `x || y` (32-byte big-endian
/// coordinates, 64 bytes total) — there's nothing to split out, the raw
/// bytes are exactly the two coordinates concatenated.
fn compute_nullifier(env: &Env, proof_a: &Bytes) -> BytesN<32> {
    env.crypto().sha256(proof_a).to_bytes()
}

fn compute_inputs_hash(env: &Env, public_inputs: &Vec<BytesN<32>>) -> BytesN<32> {
    let mut bytes = Bytes::new(env);
    for input in public_inputs.iter() {
        bytes.append(&Bytes::from(&input));
    }
    env.crypto().sha256(&bytes).to_bytes()
}

fn is_contract_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn read_expiry_ledger(bytes: &BytesN<32>) -> Option<u32> {
    let arr = bytes.to_array();
    let mut i = 0;
    while i < 28 {
        if arr[i] != 0 {
            return None;
        }
        i += 1;
    }
    Some(u32::from_be_bytes([arr[28], arr[29], arr[30], arr[31]]))
}

/// Converts to `BytesN<64>` via a single length check (`Bytes::try_into`),
/// instead of a manual `assert_eq!` on `.len()` followed by
/// `BytesN::try_from_val`'s own internal length check — the latter path
/// round-trips through `Val`/`BytesObject` and validates the length twice
/// for the same bytes.
fn read_g1(bytes: &Bytes, label: &str) -> Bn254G1Affine {
    let bytesn: BytesN<PROOF_A_LEN> = bytes
        .try_into()
        .unwrap_or_else(|_| panic!("{label} must be {PROOF_A_LEN} bytes"));
    Bn254G1Affine::from_bytes(bytesn)
}

/// See `read_g1` — same single-length-check conversion, for G2 points.
fn read_g2(bytes: &Bytes, label: &str) -> Bn254G2Affine {
    let bytesn: BytesN<PROOF_B_LEN> = bytes
        .try_into()
        .unwrap_or_else(|_| panic!("{label} must be {PROOF_B_LEN} bytes"));
    Bn254G2Affine::from_bytes(bytesn)
}

#[cfg(test)]
mod tests;
