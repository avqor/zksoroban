extern crate std;

use super::*;
use soroban_sdk::testutils::storage::Instance as _;
use soroban_sdk::testutils::storage::Temporary as _;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{vec, Address, Bytes, BytesN, Env, Event as _, IntoVal, String, Vec};
use zksoroban_verifier_interface::VerifierClient;

const VK_ALPHA_G1: [u8; 64] = [
    37, 174, 162, 190, 147, 137, 161, 46, 208, 40, 205, 226, 35, 65, 40, 44, 27, 28, 154, 20, 14,
    58, 206, 243, 150, 37, 97, 176, 235, 29, 70, 139, 31, 142, 73, 125, 220, 208, 55, 78, 173, 173,
    137, 157, 225, 191, 157, 158, 114, 100, 108, 79, 210, 25, 48, 31, 197, 192, 156, 46, 171, 152,
    229, 95,
];

const VK_BETA_G2: [u8; 128] = [
    16, 192, 41, 89, 225, 138, 98, 99, 126, 10, 17, 115, 189, 205, 208, 100, 144, 178, 104, 213,
    204, 186, 176, 7, 121, 123, 72, 37, 204, 63, 176, 252, 3, 140, 21, 18, 253, 163, 204, 42, 212,
    230, 81, 138, 188, 135, 93, 67, 90, 44, 33, 135, 25, 165, 93, 183, 212, 179, 30, 8, 8, 211,
    163, 195, 41, 211, 246, 214, 39, 241, 146, 1, 159, 19, 227, 209, 71, 86, 208, 245, 123, 226,
    249, 207, 175, 129, 207, 140, 152, 64, 207, 168, 184, 182, 65, 48, 36, 103, 94, 218, 64, 127,
    63, 69, 90, 209, 120, 139, 128, 240, 117, 187, 108, 187, 250, 62, 162, 205, 134, 52, 210, 194,
    91, 79, 139, 106, 240, 246,
];

const VK_GAMMA_G2: [u8; 128] = [
    25, 142, 147, 147, 146, 13, 72, 58, 114, 96, 191, 183, 49, 251, 93, 37, 241, 170, 73, 51, 53,
    169, 231, 18, 151, 228, 133, 183, 174, 243, 18, 194, 24, 0, 222, 239, 18, 31, 30, 118, 66, 106,
    0, 102, 94, 92, 68, 121, 103, 67, 34, 212, 247, 94, 218, 221, 70, 222, 189, 92, 217, 146, 246,
    237, 9, 6, 137, 208, 88, 95, 240, 117, 236, 158, 153, 173, 105, 12, 51, 149, 188, 75, 49, 51,
    112, 179, 142, 243, 85, 172, 218, 220, 209, 34, 151, 91, 18, 200, 94, 165, 219, 140, 109, 235,
    74, 171, 113, 128, 141, 203, 64, 143, 227, 209, 231, 105, 12, 67, 211, 123, 76, 230, 204, 1,
    102, 250, 125, 170,
];

const VK_DELTA_G2: [u8; 128] = [
    30, 191, 14, 99, 80, 96, 169, 248, 115, 42, 4, 232, 241, 172, 231, 11, 209, 255, 181, 66, 226,
    81, 114, 203, 9, 17, 245, 14, 21, 47, 108, 131, 15, 248, 194, 120, 215, 200, 221, 17, 228, 29,
    179, 208, 106, 116, 75, 141, 105, 71, 58, 219, 87, 21, 148, 114, 143, 19, 198, 219, 143, 144,
    108, 56, 15, 37, 69, 95, 78, 156, 17, 210, 113, 53, 223, 118, 131, 56, 26, 36, 122, 22, 151,
    118, 241, 78, 236, 218, 93, 11, 9, 244, 103, 165, 60, 68, 32, 134, 231, 54, 45, 60, 153, 212,
    159, 226, 92, 108, 13, 26, 210, 168, 196, 162, 240, 251, 27, 28, 214, 57, 40, 193, 243, 211,
    56, 95, 104, 255,
];

const VK_IC0_G1: [u8; 64] = [
    26, 87, 61, 103, 214, 216, 157, 137, 212, 69, 128, 237, 186, 96, 209, 103, 5, 192, 250, 53,
    143, 250, 58, 172, 43, 103, 8, 35, 102, 252, 118, 220, 34, 5, 29, 156, 107, 195, 217, 202, 19,
    76, 0, 7, 57, 7, 69, 159, 147, 101, 66, 84, 42, 223, 15, 201, 229, 15, 76, 155, 15, 63, 153,
    23,
];

const VK_IC1_G1: [u8; 64] = [
    14, 175, 26, 53, 220, 82, 18, 65, 43, 24, 73, 28, 169, 83, 160, 86, 59, 171, 175, 121, 78, 151,
    209, 220, 243, 234, 179, 65, 226, 63, 53, 247, 14, 78, 72, 228, 67, 167, 115, 92, 178, 191, 32,
    181, 102, 213, 116, 121, 173, 179, 91, 210, 78, 87, 214, 86, 119, 251, 37, 166, 188, 55, 49,
    89,
];

const VALID_PROOF_A: [u8; PROOF_A_LEN] = [
    28, 159, 72, 150, 222, 218, 126, 226, 53, 93, 4, 80, 73, 92, 40, 120, 36, 194, 215, 167, 39,
    53, 38, 203, 78, 55, 154, 43, 183, 51, 27, 239, 39, 116, 225, 204, 223, 113, 45, 75, 145, 63,
    162, 251, 115, 169, 233, 211, 196, 17, 50, 95, 10, 96, 100, 87, 103, 45, 222, 46, 22, 79, 236,
    207,
];

const VALID_PROOF_B: [u8; PROOF_B_LEN] = [
    1, 42, 5, 66, 163, 235, 37, 249, 221, 59, 28, 26, 28, 141, 222, 136, 44, 125, 57, 205, 174,
    171, 120, 158, 215, 5, 37, 152, 128, 47, 109, 179, 10, 195, 151, 7, 203, 209, 91, 29, 216, 105,
    99, 216, 134, 57, 249, 38, 63, 28, 61, 16, 237, 176, 106, 59, 106, 127, 132, 150, 173, 249, 24,
    39, 37, 42, 7, 245, 29, 242, 177, 182, 170, 101, 22, 47, 23, 147, 59, 250, 162, 36, 95, 66,
    122, 2, 75, 26, 188, 118, 101, 74, 47, 193, 255, 168, 11, 116, 62, 79, 44, 18, 181, 195, 110,
    255, 73, 31, 99, 67, 197, 43, 29, 151, 157, 210, 34, 247, 134, 38, 31, 23, 4, 3, 49, 77, 27,
    13,
];

const VALID_PROOF_C: [u8; PROOF_A_LEN] = [
    17, 201, 219, 26, 68, 41, 61, 217, 55, 131, 157, 11, 39, 31, 149, 251, 231, 172, 120, 223, 35,
    49, 86, 11, 238, 214, 162, 152, 3, 170, 201, 25, 12, 55, 128, 235, 89, 16, 108, 55, 145, 211,
    153, 105, 252, 163, 82, 244, 31, 20, 102, 144, 205, 165, 13, 28, 60, 128, 197, 222, 246, 69, 1,
    222,
];

const VALID_PUBLIC_INPUT: [u8; 32] = [
    41, 23, 97, 0, 234, 169, 98, 189, 193, 254, 108, 101, 77, 106, 60, 19, 14, 150, 164, 209, 22,
    139, 51, 132, 139, 137, 125, 197, 2, 130, 1, 51,
];

// A second, independently-generated valid proof for the same
// poseidon_preimage circuit/VK (secret = 2, not the secret = 1 the
// VALID_PROOF_* constants above prove) -- used by the nullifier tests to
// confirm two distinct proofs are both accepted independently, not just
// that the same proof once accepted stays accepted.
const VALID_PROOF_A_2: [u8; PROOF_A_LEN] = [
    26, 157, 98, 51, 46, 33, 183, 229, 88, 16, 86, 10, 226, 186, 4, 232, 183, 202, 12, 168, 194,
    78, 115, 232, 218, 219, 155, 155, 212, 3, 30, 100, 24, 146, 139, 206, 15, 21, 186, 236, 74,
    228, 89, 146, 184, 104, 10, 157, 122, 163, 174, 7, 226, 206, 245, 52, 146, 49, 172, 217, 6,
    164, 99, 23,
];

const VALID_PROOF_B_2: [u8; PROOF_B_LEN] = [
    1, 116, 173, 122, 99, 70, 61, 49, 7, 175, 150, 255, 135, 160, 84, 250, 130, 70, 156, 234, 154,
    137, 55, 147, 25, 229, 249, 32, 135, 206, 118, 114, 4, 109, 21, 157, 227, 253, 128, 178, 52,
    239, 135, 163, 32, 170, 46, 245, 222, 142, 120, 3, 253, 250, 49, 10, 67, 37, 7, 43, 24, 32, 86,
    178, 15, 234, 193, 19, 242, 80, 79, 52, 213, 140, 42, 119, 69, 96, 64, 79, 137, 15, 57, 98, 49,
    191, 125, 88, 155, 136, 73, 161, 204, 91, 216, 247, 4, 246, 13, 21, 4, 172, 30, 237, 238, 191,
    0, 230, 200, 46, 112, 62, 148, 8, 77, 118, 116, 34, 249, 229, 179, 126, 102, 105, 147, 206,
    235, 124,
];

const VALID_PROOF_C_2: [u8; PROOF_A_LEN] = [
    38, 128, 146, 117, 160, 237, 10, 249, 15, 141, 182, 3, 194, 59, 127, 215, 177, 229, 146, 199,
    110, 57, 100, 217, 188, 74, 221, 252, 153, 190, 6, 185, 31, 66, 12, 64, 180, 5, 49, 119, 64,
    215, 174, 74, 92, 55, 63, 182, 223, 236, 27, 89, 104, 102, 239, 54, 148, 177, 29, 106, 181, 63,
    243, 1,
];

const VALID_PUBLIC_INPUT_2: [u8; 32] = [
    19, 29, 115, 207, 107, 48, 7, 154, 202, 13, 255, 106, 86, 28, 208, 238, 80, 181, 64, 135, 154,
    190, 55, 154, 37, 160, 107, 36, 189, 226, 190, 189,
];

// A third valid proof: same secret (and so the same commitment / public
// input) as VALID_PROOF_A/B/C, but independently generated -- Groth16
// proving is randomized, so this has different proof bytes and therefore
// a different nullifier, even though it proves the identical statement.
// For tests that need two *different* successful verifications sharing
// one commitment (verification_count), where VALID_PROOF_A_2 (a
// different commitment entirely) wouldn't do.
const VALID_PROOF_A_1B: [u8; PROOF_A_LEN] = [
    40, 102, 72, 226, 209, 247, 125, 70, 182, 78, 158, 207, 203, 183, 178, 229, 196, 160, 254, 166,
    253, 219, 189, 168, 10, 76, 246, 105, 69, 236, 206, 29, 26, 243, 244, 32, 202, 203, 124, 68,
    63, 127, 117, 56, 206, 224, 193, 61, 26, 14, 178, 236, 116, 30, 179, 248, 147, 219, 45, 51,
    129, 250, 150, 96,
];

const VALID_PROOF_B_1B: [u8; PROOF_B_LEN] = [
    22, 157, 146, 161, 247, 13, 77, 96, 60, 220, 212, 81, 223, 62, 75, 95, 134, 171, 116, 236, 224,
    151, 76, 110, 209, 150, 117, 160, 188, 52, 139, 34, 30, 185, 4, 255, 33, 240, 168, 13, 128,
    216, 50, 166, 231, 178, 92, 44, 251, 4, 215, 180, 22, 66, 7, 56, 76, 189, 155, 61, 37, 122, 90,
    165, 3, 90, 25, 79, 129, 142, 212, 209, 110, 92, 210, 70, 18, 131, 6, 121, 24, 235, 57, 255,
    68, 183, 50, 45, 107, 54, 206, 12, 158, 75, 169, 230, 31, 89, 57, 68, 5, 186, 55, 117, 158,
    120, 227, 149, 30, 223, 167, 207, 229, 197, 117, 135, 146, 21, 214, 207, 224, 84, 188, 255,
    177, 194, 161, 62,
];

const VALID_PROOF_C_1B: [u8; PROOF_A_LEN] = [
    2, 10, 240, 255, 192, 58, 209, 110, 224, 242, 79, 52, 127, 105, 100, 155, 23, 86, 67, 11, 111,
    232, 139, 238, 150, 50, 156, 5, 0, 29, 230, 71, 16, 39, 217, 18, 158, 251, 197, 62, 53, 211,
    121, 55, 118, 63, 120, 188, 1, 149, 5, 46, 194, 53, 60, 96, 122, 57, 235, 129, 145, 61, 123,
    68,
];

fn poseidon_vk(env: &Env) -> VerifyingKey {
    VerifyingKey {
        alpha: BytesN::from_array(env, &VK_ALPHA_G1),
        beta: BytesN::from_array(env, &VK_BETA_G2),
        gamma: BytesN::from_array(env, &VK_GAMMA_G2),
        delta: BytesN::from_array(env, &VK_DELTA_G2),
        ic: vec![
            env,
            BytesN::from_array(env, &VK_IC0_G1),
            BytesN::from_array(env, &VK_IC1_G1),
        ],
    }
}

/// Used by every test below that doesn't care about the exact
/// `vk_update_delay` value — the propose/execute-timing tests further
/// down set their own delay explicitly instead of using `setup`.
const DEFAULT_VK_UPDATE_DELAY: u32 = 50;

fn setup(max_calls: u32, window_size: u32) -> (Env, Address, VerifierContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin.clone(), max_calls, window_size, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);
    (env, admin, client)
}

fn expiry_bytes(env: &Env, expiry_ledger: u32) -> BytesN<32> {
    let mut arr = [0u8; 32];
    let be = expiry_ledger.to_be_bytes();
    arr[28] = be[0];
    arr[29] = be[1];
    arr[30] = be[2];
    arr[31] = be[3];
    BytesN::from_array(env, &arr)
}

fn public_inputs_with_expiry(env: &Env, expiry_ledger: u32) -> Vec<BytesN<32>> {
    vec![
        env,
        BytesN::from_array(env, &VALID_PUBLIC_INPUT),
        expiry_bytes(env, expiry_ledger),
    ]
}

fn call_with_expiry(
    env: &Env,
    client: &VerifierContractClient,
    caller: &Address,
    expiry_ledger: u32,
) -> bool {
    client.verify_proof(
        caller,
        &Bytes::from_array(env, &VALID_PROOF_A),
        &Bytes::from_array(env, &VALID_PROOF_B),
        &Bytes::from_array(env, &VALID_PROOF_C),
        &public_inputs_with_expiry(env, expiry_ledger),
    )
}

fn call_valid(env: &Env, client: &VerifierContractClient, caller: &Address) -> bool {
    call_with_expiry(env, client, caller, u32::MAX)
}

/// Same statement/commitment as `call_valid`, but a distinct, independently
/// generated proof (VALID_PROOF_*_1B) -- so it has its own nullifier and
/// isn't rejected as a replay of `call_valid`'s proof.
fn call_valid_1b(env: &Env, client: &VerifierContractClient, caller: &Address) -> bool {
    client.verify_proof(
        caller,
        &Bytes::from_array(env, &VALID_PROOF_A_1B),
        &Bytes::from_array(env, &VALID_PROOF_B_1B),
        &Bytes::from_array(env, &VALID_PROOF_C_1B),
        &public_inputs_with_expiry(env, u32::MAX),
    )
}

/// A different statement/commitment entirely (VALID_PROOF_*_2, secret =
/// 2) from `call_valid`'s.
fn call_valid_2(env: &Env, client: &VerifierContractClient, caller: &Address) -> bool {
    client.verify_proof(
        caller,
        &Bytes::from_array(env, &VALID_PROOF_A_2),
        &Bytes::from_array(env, &VALID_PROOF_B_2),
        &Bytes::from_array(env, &VALID_PROOF_C_2),
        &vec![
            env,
            BytesN::from_array(env, &VALID_PUBLIC_INPUT_2),
            expiry_bytes(env, u32::MAX),
        ],
    )
}

#[test]
fn version_returns_the_crate_version() {
    let (env, _admin, client) = setup(10, 100);
    assert_eq!(client.version(), String::from_str(&env, env!("CARGO_PKG_VERSION")));
}

#[test]
fn verify_proof_returns_true_for_valid_unexpired_proof() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    assert!(call_with_expiry(&env, &client, &caller, 1000));
}

/// Proves `zksoroban-verifier-interface`'s published `VerifierClient` — the
/// cross-contract interface published for zksoroban#64, generated from
/// `VerifierInterface` rather than from `VerifierContractClient`'s own
/// `#[contractimpl]`-generated client above — actually interoperates with
/// this real, deployed-shape contract and a real proof, not just a
/// structurally-matching stand-in. This is the same setup and fixture
/// `verify_proof_returns_true_for_valid_unexpired_proof` above uses, just
/// invoked through the published interface's client instead.
#[test]
fn published_verifier_client_interoperates_with_the_real_contract() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    let interface_client = VerifierClient::new(&env, &client.address);
    let verified = interface_client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, 1000),
    );

    assert!(verified);
}

#[test]
fn verify_proof_rejects_expired_proof() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    let result = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, 50),
    );

    assert_eq!(result, Err(Ok(Error::ProofExpired)));
}

#[test]
fn verify_proof_accepts_expiry_at_exactly_current_ledger() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    assert!(call_with_expiry(&env, &client, &caller, 100));
}

#[test]
fn verify_proof_returns_false_for_tampered_proof_a() {
    let (env, _admin, client) = setup(10, 100);
    let caller = Address::generate(&env);
    let tampered = (-Bn254G1Affine::from_array(&env, &VALID_PROOF_A)).to_array();

    let result = client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &tampered),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );

    assert!(!result);
}

#[test]
fn verify_proof_returns_false_for_wrong_public_input_count() {
    let (env, _admin, client) = setup(10, 100);
    let caller = Address::generate(&env);
    let only_commitment = vec![&env, BytesN::from_array(&env, &VALID_PUBLIC_INPUT)];

    let result = client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &only_commitment,
    );

    assert!(!result);
}

#[test]
#[should_panic(expected = "proof_a must be 64 bytes")]
fn verify_proof_panics_on_wrong_proof_a_length() {
    let (env, _admin, client) = setup(10, 100);
    let caller = Address::generate(&env);

    client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &[0; 63]),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );
}

#[test]
fn first_call_succeeds() {
    let (env, _admin, client) = setup(1, 100);
    let caller = Address::generate(&env);
    assert!(call_valid(&env, &client, &caller));
}

#[test]
fn limit_hit_returns_error() {
    let (env, _admin, client) = setup(2, 100);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));
    assert!(call_valid_1b(&env, &client, &caller));

    // The over-limit call is rejected on the rate limit before the
    // nullifier check runs, so reusing an already-used proof here is
    // fine -- it never reaches AlreadyUsed.
    let third = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );

    assert_eq!(third, Err(Ok(Error::RateLimitExceeded)));
}

#[test]
fn window_expiry_resets_counter() {
    let (env, _admin, client) = setup(1, 10);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    // Rejected on the rate limit before the nullifier check, so reusing
    // the already-used proof here doesn't matter.
    let exceeded = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );
    assert_eq!(exceeded, Err(Ok(Error::RateLimitExceeded)));

    env.ledger().with_mut(|li| {
        li.sequence_number += 11;
    });

    // A fresh proof, not the now-used VALID_PROOF_A -- this call needs to
    // actually succeed to prove the window reset the rate limit.
    assert!(call_valid_1b(&env, &client, &caller));
}

#[test]
fn verification_count_starts_at_zero_for_an_unseen_commitment() {
    let (env, _admin, client) = setup(10, 100);
    let commitment = compute_inputs_hash(&env, &public_inputs_with_expiry(&env, u32::MAX));

    assert_eq!(client.verification_count(&commitment), 0u64);
}

#[test]
fn verify_proof_increments_the_verification_count_for_its_commitment() {
    let (env, _admin, client) = setup(10, 100);
    let caller = Address::generate(&env);
    let commitment = compute_inputs_hash(&env, &public_inputs_with_expiry(&env, u32::MAX));

    assert!(call_valid(&env, &client, &caller));
    assert_eq!(client.verification_count(&commitment), 1u64);

    // A second, distinct proof of the same statement -- not a replay --
    // shares the same commitment and increments the same counter.
    assert!(call_valid_1b(&env, &client, &caller));
    assert_eq!(client.verification_count(&commitment), 2u64);
}

#[test]
fn verification_count_is_shared_across_different_callers_submitting_the_same_commitment() {
    let (env, _admin, client) = setup(10, 100);
    let caller_a = Address::generate(&env);
    let caller_b = Address::generate(&env);
    let commitment = compute_inputs_hash(&env, &public_inputs_with_expiry(&env, u32::MAX));

    // Two distinct proofs of the same statement, one per caller -- not
    // the same caller/proof pair replayed.
    assert!(call_valid(&env, &client, &caller_a));
    assert!(call_valid_1b(&env, &client, &caller_b));

    assert_eq!(client.verification_count(&commitment), 2u64);
}

#[test]
fn verification_count_does_not_leak_across_distinct_commitments() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    // Two genuinely distinct proofs (not the same proof replayed with a
    // different expiry -- expiry isn't bound into the proof itself, so
    // that would just be the same nullifier twice) for two different
    // commitments.
    let public_inputs_1 = vec![
        &env,
        BytesN::from_array(&env, &VALID_PUBLIC_INPUT),
        expiry_bytes(&env, 1000),
    ];
    let public_inputs_2 = vec![
        &env,
        BytesN::from_array(&env, &VALID_PUBLIC_INPUT_2),
        expiry_bytes(&env, 2000),
    ];

    assert!(client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_1,
    ));
    assert!(client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A_2),
        &Bytes::from_array(&env, &VALID_PROOF_B_2),
        &Bytes::from_array(&env, &VALID_PROOF_C_2),
        &public_inputs_2,
    ));

    let commitment_1 = compute_inputs_hash(&env, &public_inputs_1);
    let commitment_2 = compute_inputs_hash(&env, &public_inputs_2);

    assert_eq!(client.verification_count(&commitment_1), 1u64);
    assert_eq!(client.verification_count(&commitment_2), 1u64);
}

#[test]
fn verification_count_does_not_increment_on_a_failed_verification() {
    let (env, _admin, client) = setup(10, 100);
    let caller = Address::generate(&env);
    let tampered = (-Bn254G1Affine::from_array(&env, &VALID_PROOF_A)).to_array();

    let result = client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &tampered),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );
    assert!(!result);

    let commitment = compute_inputs_hash(&env, &public_inputs_with_expiry(&env, u32::MAX));
    assert_eq!(client.verification_count(&commitment), 0u64);
}

#[test]
fn verify_batch_increments_the_verification_count_for_each_item() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    // Two distinct proofs of the same statement -- not the same item
    // cloned, which would replay-reject on the second occurrence.
    let item = ProofItem {
        proof_a: Bytes::from_array(&env, &VALID_PROOF_A),
        proof_b: Bytes::from_array(&env, &VALID_PROOF_B),
        proof_c: Bytes::from_array(&env, &VALID_PROOF_C),
        public_inputs: public_inputs_with_expiry(&env, 1000),
    };
    let item_1b = ProofItem {
        proof_a: Bytes::from_array(&env, &VALID_PROOF_A_1B),
        proof_b: Bytes::from_array(&env, &VALID_PROOF_B_1B),
        proof_c: Bytes::from_array(&env, &VALID_PROOF_C_1B),
        public_inputs: public_inputs_with_expiry(&env, 1000),
    };

    client.verify_batch(&caller, &vec![&env, item, item_1b]);

    let commitment = compute_inputs_hash(&env, &public_inputs_with_expiry(&env, 1000));
    assert_eq!(client.verification_count(&commitment), 2u64);
}

#[test]
fn verification_count_lives_in_instance_storage() {
    let (env, _admin, client) = setup(10, 50);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let commitment = compute_inputs_hash(&env, &public_inputs_with_expiry(&env, u32::MAX));
    let count_key = DataKey::VerificationCount(commitment);

    env.as_contract(&client.address, || {
        assert!(env.storage().instance().has(&count_key));
        assert!(!env.storage().temporary().has(&count_key));
    });
}

#[test]
fn verification_count_persists_across_ledger_advances() {
    let (env, _admin, client) = setup(10, 50);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let commitment = compute_inputs_hash(&env, &public_inputs_with_expiry(&env, u32::MAX));

    env.ledger().with_mut(|li| {
        li.sequence_number += 100;
    });

    assert_eq!(client.verification_count(&commitment), 1u64);
}

#[test]
fn verification_count_is_not_refreshed_by_a_second_call() {
    let (env, _admin, client) = setup(10, 50);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let commitment = compute_inputs_hash(&env, &public_inputs_with_expiry(&env, u32::MAX));

    env.ledger().with_mut(|li| {
        li.sequence_number += 10;
    });
    // A second, distinct proof of the same statement, not a replay --
    // the counter keeps accumulating across ledger advances rather than
    // resetting, which is what this test actually checks.
    assert!(call_valid_1b(&env, &client, &caller));

    assert_eq!(client.verification_count(&commitment), 2u64);
}

fn call_count_key(env: &Env, caller: &Address, window_size: u32) -> DataKey {
    let ledger = env.ledger().sequence();
    let window_start = ledger - (ledger % window_size);
    DataKey::CallCount(caller.clone(), window_start)
}

#[test]
fn call_count_lives_in_temporary_storage_with_window_ttl() {
    let (env, _admin, client) = setup(10, 50);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let count_key = call_count_key(&env, &caller, 50);

    env.as_contract(&client.address, || {
        assert!(!env.storage().instance().has(&count_key));
        assert!(env.storage().temporary().has(&count_key));
        assert!(env.storage().temporary().get_ttl(&count_key) >= 50u32);
    });
}

#[test]
fn call_count_entry_is_evicted_once_its_ttl_expires() {
    let (env, _admin, client) = setup(10, 50);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let count_key = call_count_key(&env, &caller, 50);

    env.as_contract(&client.address, || {
        assert!(env.storage().temporary().has(&count_key));
    });

    // This is the actual DoS-prevention property #178 fixes: once an
    // entry's window is well behind the current ledger, the ledger
    // evicts it on its own — nothing keeps it around, unlike the old
    // instance-storage behavior this replaced.
    env.ledger().with_mut(|li| {
        li.sequence_number += 51;
    });

    env.as_contract(&client.address, || {
        assert!(!env.storage().temporary().has(&count_key));
    });
}

#[test]
fn call_count_entry_survives_exactly_through_its_own_window() {
    let (env, _admin, client) = setup(10, 50);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let count_key = call_count_key(&env, &caller, 50);

    // The acceptance criterion is a TTL covering "at least" the
    // rate-limit window — so at ledger +50 (still inside the window
    // the entry was extended to cover) the entry must not have been
    // evicted early. Only +51, tested above, actually crosses it.
    env.ledger().with_mut(|li| {
        li.sequence_number += 50;
    });

    env.as_contract(&client.address, || {
        assert!(
            env.storage().temporary().has(&count_key),
            "TTL must cover at least the full rate-limit window"
        );
    });
}

#[test]
fn call_count_ttl_is_refreshed_by_a_second_call_in_the_same_window() {
    let (env, _admin, client) = setup(10, 50);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let count_key = call_count_key(&env, &caller, 50);
    let ttl_after_first_call = env.as_contract(&client.address, || {
        env.storage().temporary().get_ttl(&count_key)
    });

    // Burn a few ledgers within the same window, then call again — the
    // second call's extend_ttl should push the TTL back out from the
    // new, later ledger, not leave it decaying from the first call.
    env.ledger().with_mut(|li| {
        li.sequence_number += 10;
    });
    // A distinct proof, not a replay of the first call's.
    assert!(call_valid_1b(&env, &client, &caller));

    let ttl_after_second_call = env.as_contract(&client.address, || {
        env.storage().temporary().get_ttl(&count_key)
    });

    assert!(
        ttl_after_second_call >= ttl_after_first_call,
        "a second call in the same window must not shorten the entry's remaining TTL"
    );
}

#[test]
fn stale_instance_storage_call_count_entries_are_ignored() {
    // Simulates exactly the scenario docs/architecture.md's migration note
    // describes: a contract instance deployed before #178's fix has old
    // CallCount(caller, window) entries sitting in instance() storage.
    // Upgrading to this code doesn't rewrite existing storage, so that
    // stale entry is still there — the migration note's claim is that the
    // new code simply never reads or writes it again. This test is that
    // claim, made concrete: a stale instance-storage entry already at the
    // rate limit must not block a call the (correct) temporary-storage
    // counter would otherwise allow.
    let (env, _admin, client) = setup(1, 50);
    let caller = Address::generate(&env);
    let count_key = call_count_key(&env, &caller, 50);

    env.as_contract(&client.address, || {
        // max_calls is 1, so a stale count of 1 here would incorrectly
        // block the caller's very next call if the contract still read
        // this location.
        env.storage().instance().set(&count_key, &1u32);
    });

    assert!(
        call_valid(&env, &client, &caller),
        "a stale instance-storage CallCount entry must not affect rate limiting"
    );

    env.as_contract(&client.address, || {
        // The stale entry is untouched, not migrated or cleaned up —
        // exactly as the migration note describes.
        let stale: u32 = env.storage().instance().get(&count_key).unwrap();
        assert_eq!(stale, 1);

        let live: u32 = env.storage().temporary().get(&count_key).unwrap();
        assert_eq!(live, 1);
    });
}

#[test]
fn call_count_storage_does_not_grow_unbounded_across_many_callers_and_windows() {
    // This is #178's actual scenario, at scale: under the old code, every
    // one of these (caller, window) pairs would be a permanent instance-
    // storage entry, making every future call to the contract — from
    // anyone — a little more expensive forever. Under the fix, none of
    // them ever touch instance storage at all.
    const CALLERS: u32 = 20;
    const WINDOWS: u32 = 5;
    const WINDOW_SIZE: u32 = 10;

    let (env, _admin, client) = setup(1000, WINDOW_SIZE);
    let mut keys = std::vec::Vec::new();

    for w in 0..WINDOWS {
        env.ledger().with_mut(|li| {
            li.sequence_number = w * WINDOW_SIZE;
        });

        for _ in 0..CALLERS {
            let caller = Address::generate(&env);
            // This test is purely about CallCount storage, not about
            // verification succeeding -- rate-limit accounting happens
            // before the nullifier check regardless of outcome, so
            // reusing the same proof across all 100 calls (which the
            // nullifier check rejects after the first) doesn't affect
            // what's being asserted below.
            let _ = client.try_verify_proof(
                &caller,
                &Bytes::from_array(&env, &VALID_PROOF_A),
                &Bytes::from_array(&env, &VALID_PROOF_B),
                &Bytes::from_array(&env, &VALID_PROOF_C),
                &public_inputs_with_expiry(&env, u32::MAX),
            );
            keys.push(call_count_key(&env, &caller, WINDOW_SIZE));
        }
    }

    assert_eq!(keys.len(), (CALLERS * WINDOWS) as usize);
    env.as_contract(&client.address, || {
        for key in &keys {
            assert!(
                !env.storage().instance().has(key),
                "a CallCount entry leaked into instance storage"
            );
        }
    });
}

#[test]
fn separate_callers_have_independent_counters() {
    let (env, _admin, client) = setup(1, 100);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Two distinct proofs -- each caller's own call must succeed
    // independently, not just avoid a rate-limit collision.
    assert!(call_valid(&env, &client, &alice));
    assert!(call_valid_1b(&env, &client, &bob));
}

#[test]
fn admin_can_update_limits() {
    let (env, _admin, client) = setup(1, 100);

    client.set_limits(&5, &50);

    let limits = client.limits();
    assert_eq!(limits.max_calls, 5);
    assert_eq!(limits.window_size, 50);

    let caller = Address::generate(&env);
    assert!(call_valid(&env, &client, &caller));
    assert!(call_valid_1b(&env, &client, &caller));
}

#[test]
fn get_config_returns_initialized_values() {
    let (env, admin, client) = setup(7, 42);

    let config = client.get_config();

    // Admin matches what was passed to __constructor.
    assert_eq!(config.admin, admin);
    // Rate-limit fields reflect the constructor arguments.
    assert_eq!(config.rate_limit_max, 7);
    assert_eq!(config.rate_limit_window, 42);
    // Reflects the constructor's vk_update_delay argument.
    assert_eq!(config.timelock_delay, Some(DEFAULT_VK_UPDATE_DELAY));
    // Not paused by default; still-unimplemented features are zero-valued / absent.
    assert!(!config.paused);
    assert!(config.fee_amount.is_none());
    assert!(config.fee_token.is_none());
    // Allowlisting is implemented but off by default until enabled.
    assert!(!config.allowlist_enabled);
}

#[test]
fn get_config_reflects_updated_limits() {
    let (_env, _admin, client) = setup(1, 10);

    client.set_limits(&20, &200);

    let config = client.get_config();
    assert_eq!(config.rate_limit_max, 20);
    assert_eq!(config.rate_limit_window, 200);
}

#[test]
fn get_config_reflects_allowlist_mode() {
    let (_env, _admin, client) = setup(1, 10);

    assert!(!client.get_config().allowlist_enabled);

    client.set_allowlist_mode(&true);
    assert!(client.get_config().allowlist_enabled);

    client.set_allowlist_mode(&false);
    assert!(!client.get_config().allowlist_enabled);
}

// The tests above all use setup(), which calls env.mock_all_auths() —
// meaning require_auth() succeeds for every address unconditionally,
// including these two negative cases if run through that helper. These
// use a bare Env with no auth mocked at all, so require_auth() genuinely
// has nothing to authorize against and traps.

#[test]
#[should_panic]
fn verify_proof_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);
    let caller = Address::generate(&env);

    call_valid(&env, &client, &caller);
}

#[test]
#[should_panic]
fn set_limits_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);

    client.set_limits(&5, &50);
}

#[test]
fn disabled_mode_allows_anyone() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    assert!(!client.allowlist_enabled());
    assert!(call_valid(&env, &client, &caller));
}

#[test]
fn enabled_mode_blocks_unlisted_caller() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    client.set_allowlist_mode(&true);
    assert!(client.allowlist_enabled());
    assert!(!client.is_allowlisted(&caller));

    let result = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );

    assert_eq!(result, Err(Ok(Error::CallerNotAllowed)));
}

#[test]
fn listed_caller_succeeds_when_allowlist_enabled() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    client.set_allowlist_mode(&true);
    client.add_to_allowlist(&caller);
    assert!(client.is_allowlisted(&caller));

    assert!(call_valid(&env, &client, &caller));

    client.remove_from_allowlist(&caller);
    assert!(!client.is_allowlisted(&caller));

    let result = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );

    assert_eq!(result, Err(Ok(Error::CallerNotAllowed)));
}

#[test]
#[should_panic]
fn set_allowlist_mode_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);

    client.set_allowlist_mode(&true);
}

#[test]
#[should_panic]
fn add_to_allowlist_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);
    let user = Address::generate(&env);

    client.add_to_allowlist(&user);
}

#[test]
#[should_panic]
fn remove_from_allowlist_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);
    let user = Address::generate(&env);

    client.remove_from_allowlist(&user);
}

#[test]
fn is_paused_defaults_to_false() {
    let (_env, _admin, client) = setup(10, 100);

    assert!(!client.is_paused());
}

#[test]
fn verify_proof_blocked_when_paused() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    client.pause();
    assert!(client.is_paused());

    let result = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );

    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn verify_batch_blocked_when_paused() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);
    let item = ProofItem {
        proof_a: Bytes::from_array(&env, &VALID_PROOF_A),
        proof_b: Bytes::from_array(&env, &VALID_PROOF_B),
        proof_c: Bytes::from_array(&env, &VALID_PROOF_C),
        public_inputs: public_inputs_with_expiry(&env, u32::MAX),
    };

    client.pause();

    let result = client.try_verify_batch(&caller, &vec![&env, item]);

    assert_eq!(result, Err(Ok(Error::ContractPaused)));
}

#[test]
fn verify_proof_works_after_unpause() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    client.pause();
    client.unpause();
    assert!(!client.is_paused());

    assert!(call_with_expiry(&env, &client, &caller, 1000));
}

#[test]
fn get_config_reflects_paused_state() {
    let (_env, _admin, client) = setup(10, 100);

    assert!(!client.get_config().paused);

    client.pause();
    assert!(client.get_config().paused);

    client.unpause();
    assert!(!client.get_config().paused);
}

#[test]
#[should_panic]
fn pause_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);

    client.pause();
}

#[test]
#[should_panic]
fn unpause_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);

    client.unpause();
}

// The verify_proof tests above already exercise the storage-backed VK
// path implicitly (there are no more compile-time VK constants to fall
// back to). The tests below exercise the propose_vk_update/
// execute_vk_update timelock directly (zksoroban#46): that a proposal
// is stored with the right effective ledger, that execution is rejected
// before that ledger and permitted at/after it, and that only the admin
// can propose while execution itself is permissionless.

#[test]
fn propose_vk_update_stores_pending_update_with_effective_ledger() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);

    assert!(client.get_pending_vk_update().is_none());

    client.propose_vk_update(&poseidon_vk(&env));

    let (_vk, effective_ledger) = client.get_pending_vk_update().unwrap();
    assert_eq!(effective_ledger, 100 + DEFAULT_VK_UPDATE_DELAY);
}

#[test]
fn execute_vk_update_rejects_before_the_effective_ledger() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    client.propose_vk_update(&poseidon_vk(&env));

    env.ledger()
        .with_mut(|li| li.sequence_number = 100 + DEFAULT_VK_UPDATE_DELAY - 1);
    let result = client.try_execute_vk_update();

    assert_eq!(result, Err(Ok(Error::TimelockNotElapsed)));
    // Rejected execution leaves the proposal in place, still pending.
    assert!(client.get_pending_vk_update().is_some());
}

#[test]
fn execute_vk_update_succeeds_at_exactly_the_effective_ledger() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    client.propose_vk_update(&poseidon_vk(&env));

    env.ledger()
        .with_mut(|li| li.sequence_number = 100 + DEFAULT_VK_UPDATE_DELAY);
    client.execute_vk_update();

    assert!(client.get_pending_vk_update().is_none());
    let caller = Address::generate(&env);
    assert!(call_with_expiry(&env, &client, &caller, u32::MAX));
}

#[test]
fn execute_vk_update_succeeds_after_the_effective_ledger() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    client.propose_vk_update(&poseidon_vk(&env));

    env.ledger()
        .with_mut(|li| li.sequence_number = 100 + DEFAULT_VK_UPDATE_DELAY + 10);
    client.execute_vk_update();

    assert!(client.get_pending_vk_update().is_none());
    let caller = Address::generate(&env);
    assert!(call_with_expiry(&env, &client, &caller, u32::MAX));
}

#[test]
fn execute_vk_update_rejects_when_nothing_is_pending() {
    let (_env, _admin, client) = setup(10, 100);

    let result = client.try_execute_vk_update();

    assert_eq!(result, Err(Ok(Error::NoPendingVkUpdate)));
}

#[test]
fn execute_vk_update_is_permissionless() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    client.propose_vk_update(&poseidon_vk(&env));
    env.ledger()
        .with_mut(|li| li.sequence_number = 100 + DEFAULT_VK_UPDATE_DELAY);

    // .mock_auths(&[]) scopes to just this one call, declaring *zero*
    // authorized addresses for it -- overriding setup()'s blanket
    // mock_all_auths() for this invocation only. If execute_vk_update
    // called require_auth() on anything, this call would fail the same
    // way the *_rejects_call_with_no_authorization tests elsewhere do.
    // It doesn't, because execute_vk_update takes no caller argument and
    // never calls require_auth at all.
    client.mock_auths(&[]).execute_vk_update();

    assert!(client.get_pending_vk_update().is_none());
}

#[test]
fn propose_vk_update_rejects_wrong_ic_length() {
    let (env, _admin, client) = setup(10, 100);

    let bad_vk = VerifyingKey {
        alpha: BytesN::from_array(&env, &VK_ALPHA_G1),
        beta: BytesN::from_array(&env, &VK_BETA_G2),
        gamma: BytesN::from_array(&env, &VK_GAMMA_G2),
        delta: BytesN::from_array(&env, &VK_DELTA_G2),
        ic: vec![&env, BytesN::from_array(&env, &VK_IC0_G1)],
    };

    let result = client.try_propose_vk_update(&bad_vk);
    assert_eq!(result, Err(Ok(Error::InvalidVerifyingKey)));
    assert!(client.get_pending_vk_update().is_none());
}

#[test]
#[should_panic]
fn propose_vk_update_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);

    client.propose_vk_update(&poseidon_vk(&env));
}

// Nullifier / replay-protection tests (zksoroban#11). VALID_PROOF_* and
// VALID_PROOF_*_2 are two independently-generated, genuinely distinct
// valid proofs for the same poseidon_preimage circuit and VK (secret = 1
// and secret = 2 respectively) -- not the same proof submitted twice with
// different framing.

#[test]
fn fresh_proof_is_accepted_and_replay_is_rejected() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let result = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );

    assert_eq!(result, Err(Ok(Error::AlreadyUsed)));
}

#[test]
fn replay_is_rejected_even_from_a_different_caller() {
    // The nullifier is derived from the proof itself, not the caller --
    // it isn't a per-caller allowance, it's "this proof, once, ever."
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let first_caller = Address::generate(&env);
    let second_caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &first_caller));

    let result = client.try_verify_proof(
        &second_caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );

    assert_eq!(result, Err(Ok(Error::AlreadyUsed)));
}

#[test]
fn two_different_valid_proofs_both_succeed_independently() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    // Two proofs of two entirely different statements (different
    // secrets, different commitments), not just different randomness
    // over the same one.
    assert!(call_valid(&env, &client, &caller));
    assert!(call_valid_2(&env, &client, &caller));
}

#[test]
fn nullifier_check_runs_before_the_pairing_check_so_a_replay_does_not_re_verify() {
    // Same intent as fresh_proof_is_accepted_and_replay_is_rejected, but
    // makes the *ordering* explicit: replaying a real, otherwise-valid
    // proof is rejected as AlreadyUsed, not silently re-accepted as
    // Ok(true) a second time.
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    let first = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );
    let second = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );

    assert_eq!(first, Ok(Ok(true)));
    assert_eq!(second, Err(Ok(Error::AlreadyUsed)));
}

#[test]
fn replay_via_verify_batch_is_also_rejected() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    assert!(call_valid(&env, &client, &caller));

    let item = ProofItem {
        proof_a: Bytes::from_array(&env, &VALID_PROOF_A),
        proof_b: Bytes::from_array(&env, &VALID_PROOF_B),
        proof_c: Bytes::from_array(&env, &VALID_PROOF_C),
        public_inputs: public_inputs_with_expiry(&env, u32::MAX),
    };
    let results = client.verify_batch(&caller, &vec![&env, item]);

    // Unlike verify_proof, verify_batch never fails the whole call for a
    // per-proof rejection (see its doc comment) -- AlreadyUsed collapses
    // to false in the returned vec, same as any other per-proof Err.
    assert_eq!(results, vec![&env, false]);
}

// verification_result event coverage: one test per outcome path that
// actually returns via Ok(...) — wrong input count, malformed expiry
// encoding (folded into the tampered/wrong-input tests below since there's
// no dedicated helper to construct that byte pattern), and the pairing
// check result itself. The allowlist/rate-limit/expiry rejections return
// Err(...) and are deliberately NOT covered here: Soroban rolls back any
// event published during a call that returns Err from a #[contracterror]
// Result, so publishing on those paths would be dead code. See
// verify_proof_emits_no_event_on_err_rejection below for the negative case,
// and docs/architecture.md for the full writeup.

fn expected_inputs_hash(env: &Env, public_inputs: &Vec<BytesN<32>>) -> BytesN<32> {
    let mut bytes = Bytes::new(env);
    for input in public_inputs.iter() {
        bytes.append(&Bytes::from(&input));
    }
    env.crypto().sha256(&bytes).to_bytes()
}

fn assert_single_verification_event(
    env: &Env,
    contract_id: &Address,
    caller: &Address,
    success: bool,
    public_inputs: &Vec<BytesN<32>>,
) {
    let expected = VerificationResult {
        success,
        caller: caller.clone(),
        inputs_hash: expected_inputs_hash(env, public_inputs),
    };
    assert_eq!(
        env.events().all(),
        vec![
            env,
            (contract_id.clone(), expected.topics(env), expected.data(env)),
        ]
    );
}

#[test]
fn verify_proof_emits_event_on_pairing_success() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);
    let public_inputs = public_inputs_with_expiry(&env, 1000);

    let result = client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs,
    );
    assert!(result);

    assert_single_verification_event(&env, &client.address, &caller, true, &public_inputs);
}

#[test]
fn verify_proof_emits_event_on_pairing_failure() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);
    let tampered = (-Bn254G1Affine::from_array(&env, &VALID_PROOF_A)).to_array();
    let public_inputs = public_inputs_with_expiry(&env, 1000);

    let result = client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &tampered),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs,
    );
    assert!(!result);

    assert_single_verification_event(&env, &client.address, &caller, false, &public_inputs);
}

#[test]
fn verify_proof_emits_event_on_wrong_public_input_count() {
    let (env, _admin, client) = setup(10, 100);
    let caller = Address::generate(&env);
    let only_commitment = vec![&env, BytesN::from_array(&env, &VALID_PUBLIC_INPUT)];

    let result = client.verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &only_commitment,
    );
    assert!(!result);

    assert_single_verification_event(&env, &client.address, &caller, false, &only_commitment);
}

#[test]
fn verify_proof_emits_no_event_on_err_rejection() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);

    client.set_allowlist_mode(&true);

    let result = client.try_verify_proof(
        &caller,
        &Bytes::from_array(&env, &VALID_PROOF_A),
        &Bytes::from_array(&env, &VALID_PROOF_B),
        &Bytes::from_array(&env, &VALID_PROOF_C),
        &public_inputs_with_expiry(&env, u32::MAX),
    );
    assert_eq!(result, Err(Ok(Error::CallerNotAllowed)));

    assert!(env.events().all().events().is_empty());
}

// Two-step admin transfer and upgrade (#12).

#[test]
fn admin_ownership_handoff_succeeds() {
    let (env, _admin, client) = setup(10, 100);
    let new_admin = Address::generate(&env);

    client.propose_admin(&new_admin);
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));

    client.accept_admin();
    assert_eq!(client.pending_admin(), None);
    assert_eq!(client.get_config().admin, new_admin);
}

#[test]
fn propose_admin_rejects_non_admin_caller() {
    let (env, _admin, client) = setup(10, 100);
    let attacker = Address::generate(&env);
    let new_admin = Address::generate(&env);

    let result = client
        .mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "propose_admin",
                args: (&new_admin,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_propose_admin(&new_admin);

    assert!(result.is_err());
    assert_eq!(client.pending_admin(), None);
}

#[test]
fn accept_admin_rejects_non_pending_admin_caller() {
    let (env, _admin, client) = setup(10, 100);
    let new_admin = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.propose_admin(&new_admin);

    let result = client
        .mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();

    assert!(result.is_err());
    assert_eq!(client.pending_admin(), Some(new_admin));
}

#[test]
fn accept_admin_fails_without_pending_admin() {
    let (_env, _admin, client) = setup(10, 100);

    let result = client.try_accept_admin();
    assert_eq!(result, Err(Ok(Error::NoPendingAdmin)));
}

#[test]
fn upgrade_succeeds_for_admin() {
    let (env, _admin, client) = setup(10, 100);
    let wasm_hash = env.deployer().upload_contract_wasm(Bytes::new(&env));

    client.upgrade(&wasm_hash);
}

#[test]
fn upgrade_rejects_non_admin_caller() {
    let (env, _admin, client) = setup(10, 100);
    let attacker = Address::generate(&env);
    let wasm_hash = env.deployer().upload_contract_wasm(Bytes::new(&env));

    let result = client
        .mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "upgrade",
                args: (&wasm_hash,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&wasm_hash);

    assert!(result.is_err());
}

// Batch verification (#13).

fn valid_batch_item(env: &Env) -> ProofItem {
    ProofItem {
        proof_a: Bytes::from_array(env, &VALID_PROOF_A),
        proof_b: Bytes::from_array(env, &VALID_PROOF_B),
        proof_c: Bytes::from_array(env, &VALID_PROOF_C),
        public_inputs: public_inputs_with_expiry(env, u32::MAX),
    }
}

/// Same commitment as `valid_batch_item`, but VALID_PROOF_*_1B's distinct
/// proof bytes -- its own nullifier, not a replay of `valid_batch_item`'s.
fn valid_batch_item_1b(env: &Env) -> ProofItem {
    ProofItem {
        proof_a: Bytes::from_array(env, &VALID_PROOF_A_1B),
        proof_b: Bytes::from_array(env, &VALID_PROOF_B_1B),
        proof_c: Bytes::from_array(env, &VALID_PROOF_C_1B),
        public_inputs: public_inputs_with_expiry(env, u32::MAX),
    }
}

#[test]
fn verify_batch_returns_results_in_order() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);
    let tampered = (-Bn254G1Affine::from_array(&env, &VALID_PROOF_A)).to_array();

    let valid = valid_batch_item(&env);
    let tampered_item = ProofItem {
        proof_a: Bytes::from_array(&env, &tampered),
        ..valid.clone()
    };
    // A distinct proof, not a replay of `valid` -- the third slot needs
    // its own nullifier to succeed rather than being rejected as reuse.
    let valid_1b = valid_batch_item_1b(&env);

    let results = client.verify_batch(&caller, &vec![&env, valid, tampered_item, valid_1b]);

    assert_eq!(results, vec![&env, true, false, true]);
}

#[test]
fn verify_batch_applies_rate_limit_within_batch() {
    let (env, _admin, client) = setup(2, 100);
    let caller = Address::generate(&env);
    let item = valid_batch_item(&env);
    let item_1b = valid_batch_item_1b(&env);

    // Two distinct proofs succeed (consuming the max_calls=2 budget),
    // then a third call -- reusing the first proof is fine here, since
    // it's rejected on the rate limit before the nullifier check ever
    // runs -- hits RateLimitExceeded, which collapses to false.
    let results = client.verify_batch(&caller, &vec![&env, item.clone(), item_1b, item]);

    assert_eq!(results, vec![&env, true, true, false]);
}

#[test]
fn verify_batch_applies_allowlist_per_proof() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);
    client.set_allowlist_mode(&true);
    let item = valid_batch_item(&env);

    let results = client.verify_batch(&caller, &vec![&env, item.clone(), item]);

    assert_eq!(results, vec![&env, false, false]);
}

#[test]
fn verify_batch_emits_one_event_per_item_in_order() {
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);
    let tampered = (-Bn254G1Affine::from_array(&env, &VALID_PROOF_A)).to_array();

    let valid = valid_batch_item(&env);
    let tampered_item = ProofItem {
        proof_a: Bytes::from_array(&env, &tampered),
        ..valid.clone()
    };

    let results = client.verify_batch(&caller, &vec![&env, valid.clone(), tampered_item]);
    assert_eq!(results, vec![&env, true, false]);

    let expected_success = VerificationResult {
        success: true,
        caller: caller.clone(),
        inputs_hash: expected_inputs_hash(&env, &valid.public_inputs),
    };
    let expected_failure = VerificationResult {
        success: false,
        caller: caller.clone(),
        inputs_hash: expected_inputs_hash(&env, &valid.public_inputs),
    };
    assert_eq!(
        env.events().all(),
        vec![
            &env,
            (
                client.address.clone(),
                expected_success.topics(&env),
                expected_success.data(&env),
            ),
            (
                client.address.clone(),
                expected_failure.topics(&env),
                expected_failure.data(&env),
            ),
        ]
    );
}

#[test]
fn verify_batch_emits_event_even_on_err_rejection() {
    // Unlike a single verify_proof call, a per-item Err(...) rejection
    // inside a batch does NOT roll back the batch call itself — verify_batch
    // never returns Err for a per-item reason — so its event survives here,
    // unlike verify_proof_emits_no_event_on_err_rejection above.
    let (env, _admin, client) = setup(10, 100);
    env.ledger().with_mut(|li| li.sequence_number = 100);
    let caller = Address::generate(&env);
    client.set_allowlist_mode(&true);
    let item = valid_batch_item(&env);

    let results = client.verify_batch(&caller, &vec![&env, item.clone()]);
    assert_eq!(results, vec![&env, false]);

    assert_single_verification_event(&env, &client.address, &caller, false, &item.public_inputs);
}

#[test]
fn verify_batch_empty_returns_empty() {
    let (env, _admin, client) = setup(10, 100);
    let caller = Address::generate(&env);

    let results = client.verify_batch(&caller, &Vec::new(&env));
    assert!(results.is_empty());
}

#[test]
#[should_panic]
fn verify_batch_rejects_call_with_no_authorization() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let vk = poseidon_vk(&env);
    let contract_id = env.register(
        VerifierContract,
        (admin, 10u32, 100u32, vk, DEFAULT_VK_UPDATE_DELAY),
    );
    let client = VerifierContractClient::new(&env, &contract_id);
    let caller = Address::generate(&env);

    client.verify_batch(&caller, &Vec::new(&env));
}
