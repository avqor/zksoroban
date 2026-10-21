// sdk/scripts/bench.ts
//
// Performance benchmarks for the SDK (zksoroban#38): poseidon hashing,
// formatProof encoding, and verifyOnChain's own overhead against a mocked
// RPC server (no real network — Testnet latency would dominate and tell
// you nothing about the SDK's own code).
//
// Run via `npm run bench` (see sdk/package.json). This is a plain script,
// not a node:test suite — this repo's test runner is Node's built-in
// `node:test` (via `tsx`), not Vitest, so "Vitest bench suite" from the
// issue's literal wording is replaced here with a hand-rolled harness
// using the same `performance.now()` timing Vitest's own bench mode uses
// internally, invoked the same way `scripts/golden.ts` already is
// (`npm run test:golden`) rather than introducing a second test framework
// alongside `node:test` for this one feature.
import { performance } from "node:perf_hooks";

import { Account, Keypair, rpc, xdr } from "@stellar/stellar-sdk";

import { formatProof } from "../src/proof";
import { poseidon } from "../src/poseidon";
import { TESTNET, VerifyOptions } from "../src/types";
import { verifyOnChain } from "../src/verify";
import { VALID_PUBLIC_SIGNALS, VALID_SNARKJS_PROOF } from "../test/fixtures";

interface BenchResult {
  name: string;
  iterations: number;
  totalMs: number;
}

const DEFAULT_ITERATIONS = 500;
const WARMUP_ITERATIONS = 20;

async function runBenchmark(
  name: string,
  iterations: number,
  fn: () => void | Promise<void>
): Promise<BenchResult> {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
    await fn();
  }

  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    await fn();
  }
  const totalMs = performance.now() - started;

  return { name, iterations, totalMs };
}

function printResult(result: BenchResult): void {
  const meanMs = result.totalMs / result.iterations;
  const opsPerSec = 1000 / meanMs;
  console.log(
    `${result.name.padEnd(32)} ${String(result.iterations).padStart(5)} iters  ` +
      `${meanMs.toFixed(4).padStart(10)} ms/op  ${opsPerSec.toFixed(1).padStart(10)} ops/sec`
  );
}

// --- verifyOnChain(mocked RPC) setup -----------------------------------

const STUB_PASSPHRASE = TESTNET.networkPassphrase;
const BENCH_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13));

function buildTransactionResult(): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: xdr.TransactionResultExt.v0()
  });
}

function installMockedRpcServer(): () => void {
  const original = (rpc as unknown as { Server: unknown }).Server;

  (rpc as unknown as { Server: unknown }).Server = function MockedServer() {
    return {
      getNetwork: async () => ({ passphrase: STUB_PASSPHRASE }),
      getAccount: async (id: string) => new Account(id, "0"),
      prepareTransaction: async (tx: unknown) => tx,
      sendTransaction: async () => ({ status: "PENDING", hash: "a".repeat(64) }),
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: "b".repeat(64),
        ledger: 12345,
        resultXdr: buildTransactionResult(),
        returnValue: xdr.ScVal.scvBool(true)
      })
    };
  };

  return () => {
    (rpc as unknown as { Server: unknown }).Server = original;
  };
}

const VERIFY_OPTS: VerifyOptions = {
  network: TESTNET,
  keypair: BENCH_KEYPAIR,
  calldata: formatProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS)
};

async function main(): Promise<void> {
  console.log(`zksoroban SDK benchmarks (${DEFAULT_ITERATIONS} iterations each, ${WARMUP_ITERATIONS} warm-up)\n`);

  const results: BenchResult[] = [];

  results.push(
    await runBenchmark("poseidon(2 inputs)", DEFAULT_ITERATIONS, () => {
      poseidon([1n, 2n]);
    })
  );

  results.push(
    await runBenchmark("formatProof(valid proof)", DEFAULT_ITERATIONS, () => {
      formatProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);
    })
  );

  const uninstall = installMockedRpcServer();
  try {
    results.push(
      await runBenchmark("verifyOnChain(mocked RPC)", DEFAULT_ITERATIONS, async () => {
        await verifyOnChain(VERIFY_OPTS);
      })
    );
  } finally {
    uninstall();
  }

  for (const result of results) {
    printResult(result);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
