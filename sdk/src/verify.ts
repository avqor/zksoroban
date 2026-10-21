import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr
} from "@stellar/stellar-sdk";

import { withRetry } from "./retry.js";
import { formatProof } from "./proof.js";
import { createLogger, defaultLogger, Logger, LogHandler } from "./logger.js";
import { err, ok, ResultAsync, toZkError, ZkError } from "./result.js";
import {
  ContractConfig,
  emitProofStage,
  NetworkConfig,
  NetworkMismatchError,
  ProofBundle,
  RetryOptions,
  RegistryBatchItem,
  SorobanProofCalldata,
  SorobanZkError,
  SorobanZkErrorCode,
  VerifierBatchItem,
  VerifyBatchOptions,
  VerifyBatchResult,
  VerifyBatchViaRegistryOptions,
  VerifyOptions,
  VerifyResult,
  VerifyViaRegistryOptions
} from "./types.js";
import { validateCalldata } from "./validate.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

function makeBytesScVal(bytes: Buffer): xdr.ScVal {
  return xdr.ScVal.scvBytes(bytes);
}

function makePublicInputsScVal(publicInputs: Buffer[]): xdr.ScVal {
  return xdr.ScVal.scvVec(publicInputs.map((item) => xdr.ScVal.scvBytes(item)));
}

// contracts/verifier's `ProofItem` and contracts/registry's `BatchItem` are
// both `#[contracttype] struct`s, which Soroban encodes as a Map keyed by
// Symbol (not String) — `nativeToScVal`'s default object handling produces
// String keys, so every field needs an explicit `'symbol'` key-type hint to
// match what the contract's derived struct decoder expects.
function makeProofItemScVal(calldata: SorobanProofCalldata): xdr.ScVal {
  return nativeToScVal(
    {
      proof_a: calldata.proofA,
      proof_b: calldata.proofB,
      proof_c: calldata.proofC,
      public_inputs: calldata.publicInputs
    },
    {
      type: {
        proof_a: ["symbol", "bytes"],
        proof_b: ["symbol", "bytes"],
        proof_c: ["symbol", "bytes"],
        public_inputs: ["symbol", null]
      }
    }
  );
}

function makeRegistryBatchItemScVal(circuitId: number, calldata: SorobanProofCalldata): xdr.ScVal {
  return nativeToScVal(
    {
      id: circuitId,
      proof_a: calldata.proofA,
      proof_b: calldata.proofB,
      proof_c: calldata.proofC,
      public_inputs: calldata.publicInputs
    },
    {
      type: {
        id: ["symbol", "u32"],
        proof_a: ["symbol", "bytes"],
        proof_b: ["symbol", "bytes"],
        proof_c: ["symbol", "bytes"],
        public_inputs: ["symbol", null]
      }
    }
  );
}

function feeFromResult(result: xdr.TransactionResult): string {
  return result.feeCharged.toString();
}

// Maps contracts/verifier's `Error` enum (#[contracterror], repr(u32)) to a
// typed SorobanZkErrorCode. Soroban tooling (simulation errors, stellar-cli)
// renders a contract error as the literal substring `Error(Contract, #N)`,
// so that's what we match against rather than parsing raw XDR.
const CONTRACT_ERROR_CODES: Record<number, SorobanZkErrorCode> = {
  1: SorobanZkErrorCode.CONTRACT_NOT_INITIALIZED,
  2: SorobanZkErrorCode.RATE_LIMIT_EXCEEDED,
  3: SorobanZkErrorCode.INVALID_WINDOW_SIZE,
  4: SorobanZkErrorCode.PROOF_EXPIRED,
  5: SorobanZkErrorCode.CALLER_NOT_ALLOWED,
  11: SorobanZkErrorCode.ALREADY_USED
};

function extractContractErrorCode(message: string): SorobanZkErrorCode | undefined {
  const match = message.match(/Error\(Contract,\s*#(\d+)\)/);
  if (!match) {
    return undefined;
  }
  return CONTRACT_ERROR_CODES[Number(match[1])];
}

function classifyError(error: unknown): SorobanZkError {
  const message = error instanceof Error ? error.message : String(error);

  const contractErrorCode = extractContractErrorCode(message);
  if (contractErrorCode) {
    return new SorobanZkError(message, contractErrorCode);
  }

  const lowered = message.toLowerCase();

  if (lowered.includes("resource") || lowered.includes("instruction") || lowered.includes("limit")) {
    return new SorobanZkError(message, SorobanZkErrorCode.RESOURCE_LIMIT_EXCEEDED);
  }

  if (lowered.includes("network") || lowered.includes("fetch") || lowered.includes("timeout")) {
    return new SorobanZkError(message, SorobanZkErrorCode.NETWORK_ERROR);
  }

  return new SorobanZkError(message, SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED);
}

function decodeReturnValueFromDiagnostics(
  diagnosticEventsXdr: xdr.DiagnosticEvent[] | undefined
): boolean | undefined {
  if (!diagnosticEventsXdr) {
    return undefined;
  }

  for (const event of diagnosticEventsXdr) {
    const contractEvent = event.event;
    const topics = contractEvent.body.v0.topics;
    if (topics.length < 2) {
      continue;
    }

    const marker = scValToNative(topics[0]);
    if (marker === "fn_return") {
      return Boolean(scValToNative(contractEvent.body.v0.data));
    }
  }

  return undefined;
}

/**
 * Decode `verify_proof`'s return value from a successful transaction.
 *
 * Prefers `returnValue`, which soroban-rpc derives from the transaction's
 * result meta and is present on every successful invocation. Falls back to
 * scanning diagnostic events for the legacy `fn_return` marker, since some
 * RPC providers disable diagnostics. Returns `undefined` when neither source
 * carries a decodable value — the caller must treat that as an error rather
 * than coercing it to `false`, which would be indistinguishable from a real
 * on-chain rejection.
 */
function decodeVerifyReturnValue(result: {
  returnValue?: xdr.ScVal;
  diagnosticEventsXdr?: xdr.DiagnosticEvent[];
}): boolean | undefined {
  if (result.returnValue) {
    return Boolean(scValToNative(result.returnValue));
  }
  return decodeReturnValueFromDiagnostics(result.diagnosticEventsXdr);
}

function decodeBoolArrayFromDiagnostics(
  diagnosticEventsXdr: string[] | undefined
): boolean[] | undefined {
  if (!diagnosticEventsXdr) {
    return undefined;
  }

  for (const encoded of diagnosticEventsXdr) {
    const event = xdr.DiagnosticEvent.fromXDR(encoded, "base64");
    const contractEvent = event.event;
    const topics = contractEvent.body.v0.topics;
    if (topics.length < 2) {
      continue;
    }

    const marker = scValToNative(topics[0]);
    if (marker === "fn_return") {
      const native = scValToNative(contractEvent.body.v0.data);
      return Array.isArray(native) ? native.map(Boolean) : undefined;
    }
  }

  return undefined;
}

export function assertBundleNetwork(bundle: ProofBundle, networkPassphrase: string): void {
  if (bundle.networkPassphrase !== networkPassphrase) {
    throw new NetworkMismatchError(bundle.networkPassphrase, networkPassphrase);
  }
}

// Shared by every RPC-touching function below (zksoroban#40): build the
// retry-wrapped rpc.Server for a NetworkConfig, and confirm the RPC server's
// own reported passphrase actually matches what the NetworkConfig declared
// -- exactly the class of rpcUrl/networkPassphrase/contractId mix-up
// centralizing this config is meant to prevent, caught before a
// transaction is ever built rather than failing less obviously downstream.
function makeServer(network: NetworkConfig, retry?: RetryOptions) {
  return withRetry(
    new rpc.Server(network.rpcUrl, { allowHttp: network.rpcUrl.startsWith("http://") }),
    retry
  );
}

function assertNetworkPassphrase(network: NetworkConfig, actualPassphrase: string): void {
  if (network.networkPassphrase !== actualPassphrase) {
    throw new NetworkMismatchError(
      network.networkPassphrase,
      actualPassphrase,
      "The supplied NetworkConfig declares"
    );
  }
}

function resolveCalldata(opts: VerifyOptions): SorobanProofCalldata {
  if (opts.calldata) {
    return opts.calldata;
  }

  if (opts.bundle) {
    return formatProof(opts.bundle.proof, opts.bundle.publicSignals);
  }

  throw new SorobanZkError(
    "verifyOnChain requires either calldata or a bundle",
    SorobanZkErrorCode.INVALID_PROOF_FORMAT
  );
}

export async function verifyOnChain(opts: VerifyOptions): Promise<VerifyResult> {
  const logger: Logger = opts.logger ? createLogger("DEBUG", opts.logger) : defaultLogger;
  const calldata = resolveCalldata(opts);
  validateCalldata(calldata);

  logger.debug("verifyOnChain", "resolving calldata", { hasBundle: !!opts.bundle, hasCalldata: !!opts.calldata });

  try {
    emitProofStage(opts.onProgress, "submit_start");
    const server = makeServer(opts.network, opts.retry);
    logger.debug("verifyOnChain", "getting network info");
    const network = await server.getNetwork();
    assertNetworkPassphrase(opts.network, network.passphrase);

    if (opts.bundle) {
      assertBundleNetwork(opts.bundle, network.passphrase);
    }

    logger.debug("verifyOnChain", "getting account", { publicKey: opts.keypair.publicKey() });
    const account = await server.getAccount(opts.keypair.publicKey());
    const contract = new Contract(opts.network.contractId);
    const callerScVal = new Address(opts.keypair.publicKey()).toScVal();

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase
    })
      .addOperation(
        contract.call(
          "verify_proof",
          callerScVal,
          makeBytesScVal(calldata.proofA),
          makeBytesScVal(calldata.proofB),
          makeBytesScVal(calldata.proofC),
          makePublicInputsScVal(calldata.publicInputs)
        )
      )
      .setTimeout(30)
      .build();

    logger.debug("verifyOnChain", "preparing transaction");
    const prepared = await server.prepareTransaction(transaction);
    prepared.sign(opts.keypair);

    logger.info("verifyOnChain", "submitting transaction", { contractId: opts.network.contractId });
    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status !== "PENDING" && sendResult.status !== "DUPLICATE") {
      throw new SorobanZkError(
        `Transaction submission failed with status ${sendResult.status}`,
        SorobanZkErrorCode.TRANSACTION_REJECTED
      );
    }

    logger.debug("verifyOnChain", "transaction submitted", { txHash: sendResult.hash, status: sendResult.status });

    const started = Date.now();
    while (Date.now() - started < DEFAULT_TIMEOUT_MS) {
      logger.debug("verifyOnChain", "polling transaction status", { txHash: sendResult.hash });
      const result = await server.getTransaction(sendResult.hash);

      if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new SorobanZkError(
          `Transaction ${result.txHash} failed on ledger ${result.ledger}`,
          SorobanZkErrorCode.TRANSACTION_REJECTED
        );
      }

      if (typeof result.ledger !== "number" || !result.resultXdr) {
        throw new SorobanZkError(
          `Transaction ${result.txHash} did not include the expected success payload`,
          SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
        );
      }

      const returnValue = decodeVerifyReturnValue(result);
      if (typeof returnValue !== "boolean") {
        throw new SorobanZkError(
          `Transaction ${result.txHash} carried no decodable verify_proof return value`,
          SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
        );
      }

      const verifyResult = {
        verified: returnValue,
        txHash: result.txHash,
        ledger: result.ledger,
        fee: feeFromResult(result.resultXdr)
      };

      logger.info("verifyOnChain", "transaction confirmed", {
        txHash: verifyResult.txHash,
        ledger: verifyResult.ledger,
        fee: verifyResult.fee,
        verified: verifyResult.verified
      });

      emitProofStage(opts.onProgress, "submit_done");
      return verifyResult;
    }

    throw new SorobanZkError(
      "Timed out waiting for transaction confirmation",
      SorobanZkErrorCode.NETWORK_ERROR
    );
  } catch (error) {
    if (error instanceof SorobanZkError) {
      logger.error("verifyOnChain", "operation failed", { code: error.code, message: error.message });
      throw error;
    }

    const classified = classifyError(error);
    logger.error("verifyOnChain", "operation failed", { code: classified.code, message: classified.message });
    throw classified;
  }
}

/**
 * {@link verifyOnChain}, wrapped as a {@link ResultAsync} instead of
 * throwing (zksoroban#107) — `verifyOnChain` itself is unchanged and keeps
 * throwing; this is a new, additive alternative, not a replacement. See
 * `result.ts`'s own doc comment for why this SDK took the "new `*Result`
 * function alongside the existing one" approach rather than the issue's
 * literal ask (swap `verifyOnChain` itself to return a `Result` and
 * rename the throwing version to `verifyOnChainOrThrow`) — `verifyOnChain`
 * is called internally, from the demo, and from every test file that
 * exercises it, with no way to run a build or test suite this round to
 * verify a rename didn't break any of them.
 *
 * `verifyOnChain` already only ever throws {@link SorobanZkError} (every
 * error path in its own `catch` block normalizes to one before
 * rethrowing), so this wrapper needs no further error normalization.
 *
 * @example
 * ```ts
 * const result = await verifyOnChainResult({ network: TESTNET, keypair, bundle });
 * if (result.isErr()) {
 *   console.error(result.error.code, result.error.message);
 * } else {
 *   console.log(result.value.verified);
 * }
 * ```
 */
export async function verifyOnChainResult(opts: VerifyOptions): ResultAsync<VerifyResult, ZkError> {
  try {
    return ok(await verifyOnChain(opts));
  } catch (error) {
    return err(toZkError(error));
  }
}

// ---------------------------------------------------------------------------
// verifyBatchOnChain — verify a batch of proofs from one caller against
// contracts/verifier::verify_batch in a single transaction
// ---------------------------------------------------------------------------

/**
 * Verify a batch of proofs from one caller against `contracts/verifier`'s
 * `verify_batch(caller, proofs)` in a single Stellar transaction.
 *
 * Every item is still subject to its own allowlist/rate-limit/expiry check,
 * applied in order — an earlier item that consumes rate-limit budget affects
 * whether a later item in the *same* batch passes. Unlike a single
 * {@link verifyOnChain} call, a rejected item never fails the transaction:
 * `result.verified[i]` is simply `false` for that item, and every item (not
 * just the ones that failed) gets its own `verification_result` event.
 *
 * @example
 * ```ts
 * const result = await verifyBatchOnChain({
 *   network: TESTNET,
 *   keypair,
 *   items: [
 *     { proof: proofA, publicSignals: signalsA },
 *     { proof: proofB, publicSignals: signalsB, expiryLedger: 123456 },
 *   ],
 * });
 * console.log(result.verified); // [true, false]
 * ```
 */
export async function verifyBatchOnChain(opts: VerifyBatchOptions): Promise<VerifyBatchResult> {
  const logger: Logger = opts.logger ? createLogger("DEBUG", opts.logger) : defaultLogger;

  if (opts.items.length === 0) {
    throw new SorobanZkError(
      "verifyBatchOnChain requires at least one item",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  logger.debug("verifyBatchOnChain", "formatting calldata items", { itemCount: opts.items.length });

  const calldataItems = opts.items.map((item: VerifierBatchItem) =>
    formatProof(item.proof, item.publicSignals, item.expiryLedger)
  );
  calldataItems.forEach(validateCalldata);

  try {
    const server = makeServer(opts.network, opts.retry);
    logger.debug("verifyBatchOnChain", "getting network info");
    const network = await server.getNetwork();
    assertNetworkPassphrase(opts.network, network.passphrase);

    logger.debug("verifyBatchOnChain", "getting account", { publicKey: opts.keypair.publicKey() });
    const account = await server.getAccount(opts.keypair.publicKey());
    const contract = new Contract(opts.network.contractId);
    const callerScVal = new Address(opts.keypair.publicKey()).toScVal();
    const batchScVal = xdr.ScVal.scvVec(calldataItems.map(makeProofItemScVal));

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase
    })
      .addOperation(contract.call("verify_batch", callerScVal, batchScVal))
      .setTimeout(30)
      .build();

    logger.debug("verifyBatchOnChain", "preparing transaction");
    const prepared = await server.prepareTransaction(transaction);
    prepared.sign(opts.keypair);

    logger.info("verifyBatchOnChain", "submitting transaction", { contractId: opts.network.contractId, itemCount: opts.items.length });
    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status !== "PENDING" && sendResult.status !== "DUPLICATE") {
      throw new SorobanZkError(
        `Transaction submission failed with status ${sendResult.status}`,
        SorobanZkErrorCode.TRANSACTION_REJECTED
      );
    }

    logger.debug("verifyBatchOnChain", "transaction submitted", { txHash: sendResult.hash, status: sendResult.status });

    const started = Date.now();
    while (Date.now() - started < DEFAULT_TIMEOUT_MS) {
      logger.debug("verifyBatchOnChain", "polling transaction status", { txHash: sendResult.hash });
      const result = await server._getTransaction(sendResult.hash);

      if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new SorobanZkError(
          `Transaction ${result.txHash} failed on ledger ${result.ledger}`,
          SorobanZkErrorCode.TRANSACTION_REJECTED
        );
      }

      const returnValue = decodeBoolArrayFromDiagnostics(result.diagnosticEventsXdr);
      if (typeof result.ledger !== "number" || !result.resultXdr) {
        throw new SorobanZkError(
          `Transaction ${result.txHash} did not include the expected success payload`,
          SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
        );
      }

      const batchResult = {
        verified: returnValue ?? [],
        txHash: result.txHash,
        ledger: result.ledger,
        fee: feeFromResult(xdr.TransactionResult.fromXDR(result.resultXdr, "base64"))
      };

      logger.info("verifyBatchOnChain", "transaction confirmed", {
        txHash: batchResult.txHash,
        ledger: batchResult.ledger,
        fee: batchResult.fee,
        verifiedCount: batchResult.verified.filter(v => v).length,
        totalCount: batchResult.verified.length
      });

      return batchResult;
    }

    throw new SorobanZkError(
      "Timed out waiting for transaction confirmation",
      SorobanZkErrorCode.NETWORK_ERROR
    );
  } catch (error) {
    if (error instanceof SorobanZkError) {
      logger.error("verifyBatchOnChain", "operation failed", { code: error.code, message: error.message });
      throw error;
    }

    const classified = classifyError(error);
    logger.error("verifyBatchOnChain", "operation failed", { code: classified.code, message: classified.message });
    throw classified;
  }
}

// ---------------------------------------------------------------------------
// estimateVerifyFee — dry-run verifyOnChain's transaction via
// simulateTransaction to estimate its fee before submitting
// ---------------------------------------------------------------------------

const STROOPS_PER_XLM = 10_000_000n;

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/**
 * The estimated fee for a {@link verifyOnChain} call.
 */
export interface EstimateVerifyFeeResult {
  /** Estimated total transaction fee, in stroops. */
  stroops: bigint;
  /** The same fee, formatted as an XLM decimal string. */
  xlm: string;
}

/**
 * Dry-run the exact transaction {@link verifyOnChain} would submit, via
 * `simulateTransaction`, and return its estimated fee without signing or
 * submitting anything.
 *
 * The total fee a Soroban transaction ends up paying is the classic base fee
 * plus the resource fee simulation reports (`minResourceFee`) — the same sum
 * `prepareTransaction` assembles onto the transaction before signing. See
 * `@stellar/stellar-sdk`'s `assembleTransaction` for that derivation.
 *
 * @example
 * ```ts
 * const { stroops, xlm } = await estimateVerifyFee({
 *   network: TESTNET,
 *   keypair,
 *   bundle,
 * });
 * console.log(`estimated fee: ${xlm} XLM (${stroops} stroops)`);
 * ```
 */
export async function estimateVerifyFee(opts: VerifyOptions): Promise<EstimateVerifyFeeResult> {
  const logger: Logger = opts.logger ? createLogger("DEBUG", opts.logger) : defaultLogger;
  const calldata = resolveCalldata(opts);
  validateCalldata(calldata);

  logger.debug("estimateVerifyFee", "resolving calldata", { hasBundle: !!opts.bundle, hasCalldata: !!opts.calldata });

  try {
    const server = makeServer(opts.network, opts.retry);
    logger.debug("estimateVerifyFee", "getting network info");
    const network = await server.getNetwork();
    assertNetworkPassphrase(opts.network, network.passphrase);

    if (opts.bundle) {
      assertBundleNetwork(opts.bundle, network.passphrase);
    }

    logger.debug("estimateVerifyFee", "getting account", { publicKey: opts.keypair.publicKey() });
    const account = await server.getAccount(opts.keypair.publicKey());
    const contract = new Contract(opts.network.contractId);
    const callerScVal = new Address(opts.keypair.publicKey()).toScVal();

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase
    })
      .addOperation(
        contract.call(
          "verify_proof",
          callerScVal,
          makeBytesScVal(calldata.proofA),
          makeBytesScVal(calldata.proofB),
          makeBytesScVal(calldata.proofC),
          makePublicInputsScVal(calldata.publicInputs)
        )
      )
      .setTimeout(30)
      .build();

    logger.debug("estimateVerifyFee", "simulating transaction");
    const simResult = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simResult)) {
      throw classifyError(new Error(simResult.error));
    }

    const stroops = BigInt(BASE_FEE) + BigInt(simResult.minResourceFee);

    const result = { stroops, xlm: stroopsToXlm(stroops) };
    logger.info("estimateVerifyFee", "fee estimated", { stroops: result.stroops.toString(), xlm: result.xlm });

    return result;
  } catch (error) {
    if (error instanceof SorobanZkError) {
      logger.error("estimateVerifyFee", "operation failed", { code: error.code, message: error.message });
      throw error;
    }

    const classified = classifyError(error);
    logger.error("estimateVerifyFee", "operation failed", { code: classified.code, message: classified.message });
    throw classified;
  }
}

// ---------------------------------------------------------------------------
// verifyViaRegistry — verify a proof against a circuit registered with
// contracts/registry, keyed by circuit ID instead of a hardcoded VK
// ---------------------------------------------------------------------------

function resolveRegistryCalldata(opts: VerifyViaRegistryOptions): SorobanProofCalldata {
  if (opts.calldata) {
    return opts.calldata;
  }

  if (opts.bundle) {
    return formatProof(opts.bundle.proof, opts.bundle.publicSignals);
  }

  throw new SorobanZkError(
    "verifyViaRegistry requires either calldata or a bundle",
    SorobanZkErrorCode.INVALID_PROOF_FORMAT
  );
}

/**
 * Verify a proof against a circuit registered with `contracts/registry`'s
 * `verify_proof(id, proof_a, proof_b, proof_c, public_inputs)`.
 *
 * Unlike {@link verifyOnChain} (which targets the single-circuit
 * `contracts/verifier` and requires a signing `keypair`, since that
 * contract enforces per-caller auth and rate-limiting), the registry's
 * `verify_proof` requires no auth and mutates no storage — so this is a
 * simulation-only call, the same shape as {@link getContractConfig}. No
 * transaction is submitted, no fee is charged, and no Keypair is needed.
 *
 * @example
 * ```ts
 * const verified = await verifyViaRegistry({
 *   network: { ...TESTNET, contractId: "CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH" },
 *   circuitId: 2, // range_proof, once registered — see docs/multi-circuit.md
 *   bundle,
 * });
 * ```
 */
export async function verifyViaRegistry(opts: VerifyViaRegistryOptions): Promise<boolean> {
  const logger: Logger = opts.logger ? createLogger("DEBUG", opts.logger) : defaultLogger;
  const calldata = resolveRegistryCalldata(opts);
  validateCalldata(calldata);

  logger.debug("verifyViaRegistry", "resolving calldata", { hasBundle: !!opts.bundle, hasCalldata: !!opts.calldata, circuitId: opts.circuitId });

  try {
    const server = makeServer(opts.network, opts.retry);
    logger.debug("verifyViaRegistry", "getting network info");
    const network = await server.getNetwork();
    assertNetworkPassphrase(opts.network, network.passphrase);

    if (opts.bundle) {
      assertBundleNetwork(opts.bundle, network.passphrase);
    }

    const contract = new Contract(opts.network.contractId);

    const ephemeral = Keypair.random();
    let account: InstanceType<typeof import("@stellar/stellar-sdk").Account>;
    try {
      logger.debug("verifyViaRegistry", "getting ephemeral account");
      account = await server.getAccount(ephemeral.publicKey());
    } catch {
      account = new Account(ephemeral.publicKey(), "0");
    }

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase
    })
      .addOperation(
        contract.call(
          "verify_proof",
          xdr.ScVal.scvU32(opts.circuitId),
          makeBytesScVal(calldata.proofA),
          makeBytesScVal(calldata.proofB),
          makeBytesScVal(calldata.proofC),
          makePublicInputsScVal(calldata.publicInputs)
        )
      )
      .setTimeout(30)
      .build();

    logger.debug("verifyViaRegistry", "simulating transaction");
    const simResult = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new SorobanZkError(
        `verify_proof simulation failed: ${simResult.error}`,
        SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
      );
    }

    if (!("result" in simResult) || !simResult.result) {
      throw new SorobanZkError(
        "verify_proof simulation returned no result",
        SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
      );
    }

    const verified = Boolean(scValToNative(simResult.result.retval));
    logger.info("verifyViaRegistry", "verification complete", { circuitId: opts.circuitId, verified });

    return verified;
  } catch (error) {
    if (error instanceof SorobanZkError) {
      logger.error("verifyViaRegistry", "operation failed", { code: error.code, message: error.message });
      throw error;
    }
    const classified = classifyError(error);
    logger.error("verifyViaRegistry", "operation failed", { code: classified.code, message: classified.message });
    throw classified;
  }
}

// ---------------------------------------------------------------------------
// verifyBatchViaRegistry — verify a batch of (circuit_id, proof) pairs
// against contracts/registry::verify_batch in a single simulated call
// ---------------------------------------------------------------------------

/**
 * Verify a batch of (circuit, proof) pairs against `contracts/registry`'s
 * `verify_batch(batch)` in a single simulated call. Batching across
 * different circuit IDs in one call is the main value of batching against
 * the registry, since it's the multi-circuit contract.
 *
 * Like {@link verifyViaRegistry}, this is simulation-only — no transaction
 * is submitted, no fee is charged, and no `keypair` is needed, since
 * `verify_batch` requires no auth and mutates no storage.
 *
 * @example
 * ```ts
 * const results = await verifyBatchViaRegistry({
 *   network: { ...TESTNET, contractId: "CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH" },
 *   items: [
 *     { circuitId: 1, proof: poseidonProof, publicSignals: poseidonSignals },
 *     { circuitId: 2, proof: rangeProof, publicSignals: rangeSignals },
 *   ],
 * });
 * console.log(results); // [true, true]
 * ```
 */
export async function verifyBatchViaRegistry(
  opts: VerifyBatchViaRegistryOptions
): Promise<boolean[]> {
  const logger: Logger = opts.logger ? createLogger("DEBUG", opts.logger) : defaultLogger;

  if (opts.items.length === 0) {
    throw new SorobanZkError(
      "verifyBatchViaRegistry requires at least one item",
      SorobanZkErrorCode.INVALID_PROOF_FORMAT
    );
  }

  logger.debug("verifyBatchViaRegistry", "formatting calldata items", { itemCount: opts.items.length });

  const calldataItems = opts.items.map((item: RegistryBatchItem) => ({
    circuitId: item.circuitId,
    calldata: formatProof(item.proof, item.publicSignals)
  }));
  calldataItems.forEach(({ calldata }) => validateCalldata(calldata));

  try {
    const server = makeServer(opts.network, opts.retry);
    logger.debug("verifyBatchViaRegistry", "getting network info");
    const network = await server.getNetwork();
    assertNetworkPassphrase(opts.network, network.passphrase);

    const contract = new Contract(opts.network.contractId);

    const ephemeral = Keypair.random();
    let account: InstanceType<typeof import("@stellar/stellar-sdk").Account>;
    try {
      logger.debug("verifyBatchViaRegistry", "getting ephemeral account");
      account = await server.getAccount(ephemeral.publicKey());
    } catch {
      account = new Account(ephemeral.publicKey(), "0");
    }

    const batchScVal = xdr.ScVal.scvVec(
      calldataItems.map(({ circuitId, calldata }) =>
        makeRegistryBatchItemScVal(circuitId, calldata)
      )
    );

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase
    })
      .addOperation(contract.call("verify_batch", batchScVal))
      .setTimeout(30)
      .build();

    logger.debug("verifyBatchViaRegistry", "simulating transaction");
    const simResult = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new SorobanZkError(
        `verify_batch simulation failed: ${simResult.error}`,
        SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
      );
    }

    if (!("result" in simResult) || !simResult.result) {
      throw new SorobanZkError(
        "verify_batch simulation returned no result",
        SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
      );
    }

    const native = scValToNative(simResult.result.retval);
    const results = Array.isArray(native) ? native.map(Boolean) : [];
    logger.info("verifyBatchViaRegistry", "verification complete", { itemCount: results.length, verifiedCount: results.filter(v => v).length });

    return results;
  } catch (error) {
    if (error instanceof SorobanZkError) {
      logger.error("verifyBatchViaRegistry", "operation failed", { code: error.code, message: error.message });
      throw error;
    }
    const classified = classifyError(error);
    logger.error("verifyBatchViaRegistry", "operation failed", { code: classified.code, message: classified.message });
    throw classified;
  }
}

// ---------------------------------------------------------------------------
// getContractConfig — read-only view of all non-sensitive contract settings
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link getContractConfig}.
 */
export interface GetContractConfigOptions {
  network: NetworkConfig;
  /**
   * Optional retry policy for transient RPC failures. Omit for the
   * previous single-attempt behavior — see {@link RetryOptions}.
   */
  retry?: RetryOptions;
  /**
   * Optional logger for structured logging. Omit to use the default
   * logger (WARN level, console output) — see {@link LogHandler}.
   */
  logger?: LogHandler;
}

/**
 * Call the `get_config` view function on a deployed verifier contract and
 * return a typed {@link ContractConfig} object.
 *
 * This is a simulation-only call: no transaction is submitted, no fee is
 * charged, and no Keypair is required.
 *
 * @example
 * ```ts
 * const config = await getContractConfig({ network: TESTNET });
 * console.log(config.rateLimitMax, config.rateLimitWindow);
 * ```
 */
export async function getContractConfig(
  opts: GetContractConfigOptions
): Promise<ContractConfig> {
  const logger: Logger = opts.logger ? createLogger("DEBUG", opts.logger) : defaultLogger;

  try {
    const server = makeServer(opts.network, opts.retry);
    logger.debug("getContractConfig", "getting network info");
    const network = await server.getNetwork();
    assertNetworkPassphrase(opts.network, network.passphrase);
    const contract = new Contract(opts.network.contractId);

    // Build a transaction for simulation purposes only.  We use a throw-away
    // ephemeral keypair because no signing or fee payment happens — only
    // simulateTransaction() is called and the transaction is never submitted.
    const ephemeral = Keypair.random();
    let account: InstanceType<typeof import("@stellar/stellar-sdk").Account>;
    try {
      logger.debug("getContractConfig", "getting ephemeral account");
      account = await server.getAccount(ephemeral.publicKey());
    } catch {
      // If the ephemeral account is not funded on the network (expected), fall
      // back to a synthetic Account at sequence 0.
      account = new Account(ephemeral.publicKey(), "0");
    }

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: network.passphrase
    })
      .addOperation(contract.call("get_config"))
      .setTimeout(30)
      .build();

    logger.debug("getContractConfig", "simulating transaction");
    const simResult = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new SorobanZkError(
        `get_config simulation failed: ${simResult.error}`,
        SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
      );
    }

    if (!("result" in simResult) || !simResult.result) {
      throw new SorobanZkError(
        "get_config simulation returned no result",
        SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
      );
    }

    // The SDK auto-decodes the XDR return value into a plain JS object.
    const raw = scValToNative(simResult.result.retval) as {
      admin: string;
      paused: boolean;
      fee_amount: bigint | null | undefined;
      fee_token: string | null | undefined;
      rate_limit_max: number;
      rate_limit_window: number;
      timelock_delay: number | null | undefined;
      allowlist_enabled: boolean;
    };

    const config = {
      admin: String(raw.admin),
      paused: Boolean(raw.paused),
      feeAmount: raw.fee_amount != null ? BigInt(raw.fee_amount) : undefined,
      feeToken: raw.fee_token != null ? String(raw.fee_token) : undefined,
      rateLimitMax: Number(raw.rate_limit_max),
      rateLimitWindow: Number(raw.rate_limit_window),
      timelockDelay: raw.timelock_delay != null ? Number(raw.timelock_delay) : undefined,
      allowlistEnabled: Boolean(raw.allowlist_enabled)
    };

    logger.info("getContractConfig", "config retrieved", { contractId: opts.network.contractId, admin: config.admin, paused: config.paused });

    return config;
  } catch (error) {
    if (error instanceof SorobanZkError) {
      logger.error("getContractConfig", "operation failed", { code: error.code, message: error.message });
      throw error;
    }
    const classified = classifyError(error);
    logger.error("getContractConfig", "operation failed", { code: classified.code, message: classified.message });
    throw classified;
  }
}
