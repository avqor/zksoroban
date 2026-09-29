import { Keypair } from "@stellar/stellar-sdk";

export interface SnarkjsProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: "groth16";
}

export interface SorobanProofCalldata {
  proofA: Buffer;
  proofB: Buffer;
  proofC: Buffer;
  publicInputs: Buffer[];
}

/**
 * A Groth16 verifying key encoded into the raw-bytes layout
 * `contracts/registry`'s `register_circuit(id, vk)` expects — the same
 * BN254 G1/G2 point encoding {@link SorobanProofCalldata} uses for a proof,
 * applied to a verifying key's `alpha`/`beta`/`gamma`/`delta`/`IC` instead.
 */
export interface RegistryVerifyingKey {
  alpha: Buffer;
  beta: Buffer;
  gamma: Buffer;
  delta: Buffer;
  ic: Buffer[];
}

export interface VerificationKey {
  protocol: string;
  curve: string;
  nPublic: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  vk_alphabeta_12: string[][][];
  IC: string[][];
}

export interface ProofBundle {
  proof: SnarkjsProof;
  publicSignals: string[];
  circuit: string;
  generatedAt: string;
  networkPassphrase: string;
}

/**
 * Options for the SDK's opt-in retry behavior.
 *
 * Passing a `retry` object to any RPC-touching call (`verifyOnChain`,
 * `verifyBatchOnChain`, `verifyViaRegistry`, `verifyBatchViaRegistry`,
 * `estimateVerifyFee`, `getContractConfig`) turns on per-request retries
 * with exponential backoff for transient failures. Omitting it keeps the
 * previous behavior — a single attempt, no retries.
 *
 * See `docs/architecture.md` ("Retry & Exponential Backoff") for exactly
 * which requests are retried and which are deliberately not.
 */
export interface RetryOptions {
  /**
   * How many times to retry after the initial attempt fails. Defaults to
   * `3`; `0` disables retries explicitly.
   */
  maxRetries?: number;
  /**
   * Base of the exponential backoff curve in milliseconds: the delay after
   * the first failed attempt, doubling each time. Defaults to `500`.
   */
  baseDelayMs?: number;
  /**
   * Ceiling for any single backoff delay in milliseconds. Defaults to
   * `8000`.
   */
  maxDelayMs?: number;
  /**
   * Full jitter — spread each delay uniformly over `[0, delay]` so many
   * concurrent callers don't retry in lockstep. Defaults to `true`.
   */
  jitter?: boolean;
  /**
   * Called once per scheduled retry, just before the backoff sleep.
   * Never called for a failure that exhausts the retries or isn't
   * transient — those throw to the caller instead.
   */
  onRetry?: (info: RetryAttemptInfo) => void;
}

/**
 * Details of one scheduled retry, passed to {@link RetryOptions.onRetry}.
 */
export interface RetryAttemptInfo {
  /** Human-readable label for the request that failed (e.g. `"getAccount"`). */
  label: string;
  /** 1-based attempt number of the attempt that just failed. */
  attempt: number;
  /** Milliseconds the SDK will wait before the next attempt. */
  delayMs: number;
  /** The error that triggered this retry. */
  error: unknown;
}

export interface VerifyOptions {
  rpcUrl: string;
  contractId: string;
  keypair: Keypair;
  calldata?: SorobanProofCalldata;
  bundle?: ProofBundle;
  /**
   * Optional retry policy for transient RPC failures. Omit for the
   * previous single-attempt behavior — see {@link RetryOptions}.
   */
  retry?: RetryOptions;
}

export interface VerifyResult {
  verified: boolean;
  txHash: string;
  ledger: number;
  fee: string;
}

/**
 * Options accepted by {@link verifyViaRegistry}.
 *
 * Unlike {@link VerifyOptions}, no `keypair` is needed: `contracts/registry`'s
 * `verify_proof(id, ...)` requires no auth and mutates no storage, so this
 * call is simulation-only, exactly like {@link GetContractConfigOptions}.
 */
export interface VerifyViaRegistryOptions {
  rpcUrl: string;
  /** Bech32m address of the deployed `contracts/registry` instance. */
  registryContractId: string;
  /** The `id` a circuit was registered under via `register_circuit`. */
  circuitId: number;
  calldata?: SorobanProofCalldata;
  bundle?: ProofBundle;
  /**
   * Optional retry policy for transient RPC failures. Omit for the
   * previous single-attempt behavior — see {@link RetryOptions}.
   */
  retry?: RetryOptions;
}

/**
 * One proof in a {@link verifyBatchOnChain} call, targeting
 * `contracts/verifier`'s `verify_batch`. Same shape as a single
 * {@link VerifyOptions}'s proof inputs, minus the fields that are shared
 * across the whole batch (`rpcUrl`, `contractId`, `keypair`).
 */
export interface VerifierBatchItem {
  proof: SnarkjsProof;
  publicSignals: string[];
  expiryLedger?: number;
}

/**
 * Options accepted by {@link verifyBatchOnChain}.
 *
 * Like {@link VerifyOptions}, this targets `contracts/verifier`, which
 * requires the caller's own Soroban auth and mutates rate-limit state — so a
 * `keypair` is required and this submits a real transaction. All items in
 * `items` are verified in one transaction under that single `keypair`'s
 * identity, and are each still subject to their own allowlist/rate-limit/
 * expiry check.
 */
export interface VerifyBatchOptions {
  rpcUrl: string;
  contractId: string;
  keypair: Keypair;
  items: VerifierBatchItem[];
  /**
   * Optional retry policy for transient RPC failures. Omit for the
   * previous single-attempt behavior — see {@link RetryOptions}.
   */
  retry?: RetryOptions;
}

/**
 * Result of a {@link verifyBatchOnChain} call — `verified[i]` corresponds to
 * `items[i]` from the request, in order.
 */
export interface VerifyBatchResult {
  verified: boolean[];
  txHash: string;
  ledger: number;
  fee: string;
}

/**
 * One (circuit, proof) pair in a {@link verifyBatchViaRegistry} call,
 * targeting `contracts/registry`'s `verify_batch`.
 */
export interface RegistryBatchItem {
  /** The `id` a circuit was registered under via `register_circuit`. */
  circuitId: number;
  proof: SnarkjsProof;
  publicSignals: string[];
}

/**
 * Options accepted by {@link verifyBatchViaRegistry}.
 *
 * Like {@link VerifyViaRegistryOptions}, no `keypair` is needed: the
 * registry's `verify_batch` requires no auth and mutates no storage, so this
 * call is simulation-only.
 */
export interface VerifyBatchViaRegistryOptions {
  rpcUrl: string;
  /** Bech32m address of the deployed `contracts/registry` instance. */
  registryContractId: string;
  items: RegistryBatchItem[];
  /**
   * Optional retry policy for transient RPC failures. Omit for the
   * previous single-attempt behavior — see {@link RetryOptions}.
   */
  retry?: RetryOptions;
}

export enum SorobanZkErrorCode {
  INVALID_PROOF_FORMAT = "INVALID_PROOF_FORMAT",
  INVALID_PUBLIC_INPUT = "INVALID_PUBLIC_INPUT",
  CONTRACT_INVOCATION_FAILED = "CONTRACT_INVOCATION_FAILED",
  TRANSACTION_REJECTED = "TRANSACTION_REJECTED",
  NETWORK_ERROR = "NETWORK_ERROR",
  RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED",
  NETWORK_MISMATCH = "NETWORK_MISMATCH",
  // Mirror contracts/verifier's `Error` enum (contracterror, repr(u32)) so a
  // caller can distinguish these from each other and from generic failures,
  // instead of every contract-level rejection collapsing into `false`.
  CONTRACT_NOT_INITIALIZED = "CONTRACT_NOT_INITIALIZED",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  INVALID_WINDOW_SIZE = "INVALID_WINDOW_SIZE",
  PROOF_EXPIRED = "PROOF_EXPIRED",
  CALLER_NOT_ALLOWED = "CALLER_NOT_ALLOWED",
  // Replay protection (zksoroban#11): this exact proof has already been
  // accepted once and can never be accepted again, regardless of caller.
  ALREADY_USED = "ALREADY_USED",
  // Witness/proof computation itself failed (e.g. a wasm/zkey mismatch, or an
  // input that doesn't satisfy the circuit's constraints) — distinct from
  // INVALID_PROOF_FORMAT, which is about a proof's on-the-wire shape.
  PROOF_GENERATION_FAILED = "PROOF_GENERATION_FAILED",
  // deserializeProof (zksoroban#33) errors. Split from INVALID_PROOF_FORMAT
  // so a caller can tell "this came from an incompatible SDK version" apart
  // from "this data is just garbage/truncated" — a real, actionable
  // difference for an application deciding how to react.
  SERIALIZED_PROOF_VERSION_MISMATCH = "SERIALIZED_PROOF_VERSION_MISMATCH",
  CORRUPTED_SERIALIZED_PROOF = "CORRUPTED_SERIALIZED_PROOF"
}

export class SorobanZkError extends Error {
  constructor(message: string, public code: SorobanZkErrorCode) {
    super(message);
    this.name = "SorobanZkError";
  }
}

export class ZkInputError extends SorobanZkError {
  constructor(
    public field: string,
    public reason: string,
    code: SorobanZkErrorCode = SorobanZkErrorCode.INVALID_PROOF_FORMAT,
    detail?: string
  ) {
    super(`${field} ${reason}${detail ? ` (${detail})` : ""}`, code);
    this.name = "ZkInputError";
  }
}

export class NetworkMismatchError extends SorobanZkError {
  constructor(public expected: string, public actual: string) {
    super(
      `ProofBundle targets network "${expected}" but the configured network is "${actual}"`,
      SorobanZkErrorCode.NETWORK_MISMATCH
    );
    this.name = "NetworkMismatchError";
  }
}

/**
 * A read-only snapshot of all non-sensitive verifier contract configuration
 * fields, as returned by the `get_config` contract function.
 *
 * Fields that the current contract does not implement (fee, timelock, etc.)
 * are returned as `undefined` / `false` so callers can detect at runtime
 * whether a feature is active without needing to know the contract version.
 */
export interface ContractConfig {
  /** Contract administrator Stellar address (G… or C…). */
  admin: string;
  /** Whether the contract is paused. Always `false` in the current version. */
  paused: boolean;
  /** Optional fee amount in stroops. `undefined` when not configured. */
  feeAmount: bigint | undefined;
  /** Optional fee token contract address. `undefined` when not configured. */
  feeToken: string | undefined;
  /** Maximum `verify_proof` calls allowed per caller per rate-limit window. */
  rateLimitMax: number;
  /** Rate-limit window size in ledgers. */
  rateLimitWindow: number;
  /** Timelock delay in ledgers. `undefined` when not configured. */
  timelockDelay: number | undefined;
  /** Whether an allowlist is enforced. Always `false` in the current version. */
  allowlistEnabled: boolean;
}

