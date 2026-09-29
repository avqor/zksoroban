#![no_std]

//! Published cross-contract interface for `contracts/verifier`.
//!
//! Another Soroban contract that wants to call `verify_proof` on a deployed
//! `contracts/verifier` instance can depend on this crate instead of
//! reimplementing the XDR invocation by hand:
//!
//! ```ignore
//! use zksoroban_verifier_interface::VerifierClient;
//!
//! let client = VerifierClient::new(&env, &verifier_contract_id);
//! let verified: bool = client.verify_proof(
//!     &caller, &proof_a, &proof_b, &proof_c, &public_inputs,
//! );
//! ```
//!
//! See `docs/architecture.md`'s "Cross-Contract Interface" section and
//! `contracts/examples/proof-gate` for a full worked example.

use soroban_sdk::{contractclient, contracterror, Address, Bytes, BytesN, Env, Vec};

/// Mirrors `contracts/verifier::Error` — kept in sync by hand rather than
/// as a dependency, since this crate deliberately doesn't depend on the
/// concrete verifier contract crate (see `docs/architecture.md`). Only the
/// numeric discriminant is ever significant on the wire: a cross-contract
/// call decodes the callee's error purely by its `#[contracterror]` code,
/// not by Rust type identity, so this independently-defined enum decodes
/// a real `contracts/verifier` rejection correctly as long as the
/// discriminants below match `contracts/verifier::Error` exactly.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    RateLimitExceeded = 2,
    InvalidWindowSize = 3,
    ProofExpired = 4,
    CallerNotAllowed = 5,
    InvalidVerifyingKey = 6,
    NoPendingAdmin = 7,
    ContractPaused = 8,
    NoPendingVkUpdate = 9,
    TimelockNotElapsed = 10,
    AlreadyUsed = 11,
}

/// Cross-contract interface for a deployed `contracts/verifier` instance.
///
/// `#[contractclient(name = "VerifierClient")]` generates a `VerifierClient`
/// type with a `new(env, contract_id)` constructor and a `verify_proof`
/// method that performs the actual cross-contract invocation — plus a
/// `try_verify_proof` method that returns the callee's `Result` instead of
/// panicking on `Err`, for a caller that wants to handle a rejection
/// (rate-limited, expired, not allowlisted, ...) itself rather than let it
/// abort the whole transaction.
///
/// The method name and argument order below must match the deployed
/// contract's real exported function exactly — cross-contract calls
/// dispatch by function-name symbol, not by any structural type match, so
/// this can't be renamed to a shorter name without breaking every call it
/// makes against the real, already-deployed `contracts/verifier`.
#[contractclient(name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_proof(
        env: Env,
        caller: Address,
        proof_a: Bytes,
        proof_b: Bytes,
        proof_c: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<bool, Error>;
}
