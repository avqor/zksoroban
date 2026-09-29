import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, rpc } from "@stellar/stellar-sdk";

import { formatProof } from "../src/proof";
import { getContractConfig, verifyOnChain } from "../src/verify";
import { SorobanZkError, SorobanZkErrorCode, TESTNET } from "../src/types";
import {
  TESTNET_RPC_URL,
  VALID_PUBLIC_SIGNALS,
  VALID_SNARKJS_PROOF,
  tamperedProofAHex
} from "./fixtures";

const secretKey = process.env.SOROBAN_SECRET_KEY;
// contracts/verifier on main (5-arg verify_proof with caller + rate-limit +
// expiry) has not been redeployed to Testnet yet — see #184. Point this at
// that deployment once it exists; TESTNET_CONTRACT_ID in fixtures.ts still
// targets the old, pre-rate-limit contract these tests can no longer run
// against.
const verifierContractId = process.env.SOROBAN_VERIFIER_CONTRACT_ID;

if (!secretKey || !verifierContractId) {
  test.skip(
    "verifyOnChain integration tests require SOROBAN_SECRET_KEY and " +
      "SOROBAN_VERIFIER_CONTRACT_ID (a Testnet deployment of the current, " +
      "rate-limited contracts/verifier)"
  );
} else {
  const keypair = Keypair.fromSecret(secretKey);
  const server = new rpc.Server(TESTNET_RPC_URL);
  const network = { ...TESTNET, contractId: verifierContractId };

  async function futureExpiryLedger(margin = 10_000): Promise<number> {
    const { sequence } = await server.getLatestLedger();
    return sequence + margin;
  }

  test("verifyOnChain returns true for a valid, unexpired proof", async () => {
    const calldata = formatProof(
      VALID_SNARKJS_PROOF,
      VALID_PUBLIC_SIGNALS,
      await futureExpiryLedger()
    );

    const result = await verifyOnChain({
      network,
      keypair,
      calldata
    });

    assert.equal(result.verified, true);
    assert.match(result.txHash, /^[0-9a-f]{64}$/);
    assert.ok(result.ledger > 0);
    assert.match(result.fee, /^[1-9][0-9]*$/);
  });

  test("verifyOnChain returns false for a tampered proof", async () => {
    const calldata = formatProof(
      VALID_SNARKJS_PROOF,
      VALID_PUBLIC_SIGNALS,
      await futureExpiryLedger()
    );

    const result = await verifyOnChain({
      network,
      keypair,
      calldata: {
        ...calldata,
        proofA: Buffer.from(tamperedProofAHex(), "hex")
      }
    });

    assert.equal(result.verified, false);
    assert.match(result.txHash, /^[0-9a-f]{64}$/);
  });

  test("verifyOnChain returns false for a single public input (missing expiry)", async () => {
    const calldata = formatProof(VALID_SNARKJS_PROOF, VALID_PUBLIC_SIGNALS);
    assert.equal(calldata.publicInputs.length, 1);

    const result = await verifyOnChain({
      network,
      keypair,
      calldata
    });

    assert.equal(result.verified, false);
  });

  test("verifyOnChain returns false for a wrong public input value", async () => {
    const wrongSignal = (BigInt(VALID_PUBLIC_SIGNALS[0]) + 1n).toString();
    const calldata = formatProof(
      VALID_SNARKJS_PROOF,
      [wrongSignal],
      await futureExpiryLedger()
    );

    const result = await verifyOnChain({
      network,
      keypair,
      calldata
    });

    assert.equal(result.verified, false);
  });

  test("verifyOnChain throws PROOF_EXPIRED for a proof whose expiry has passed", async () => {
    const { sequence } = await server.getLatestLedger();
    const calldata = formatProof(
      VALID_SNARKJS_PROOF,
      VALID_PUBLIC_SIGNALS,
      Math.max(sequence - 1000, 1)
    );

    await assert.rejects(
      verifyOnChain({
        network,
        keypair,
        calldata
      }),
      (error: unknown) =>
        error instanceof SorobanZkError &&
        error.code === SorobanZkErrorCode.PROOF_EXPIRED
    );
  });

  test("verifyOnChain throws RATE_LIMIT_EXCEEDED once the caller's window budget is used up", async () => {
    // Assumes the test completes within a single rate-limit window — true
    // for any window_size that isn't unusually small relative to a few
    // sequential RPC round-trips (typically hundreds of ledgers or more).
    const config = await getContractConfig({ network });

    for (let i = 0; i < config.rateLimitMax; i++) {
      const calldata = formatProof(
        VALID_SNARKJS_PROOF,
        VALID_PUBLIC_SIGNALS,
        await futureExpiryLedger()
      );
      await verifyOnChain({
        network,
        keypair,
        calldata
      });
    }

    const overBudgetCalldata = formatProof(
      VALID_SNARKJS_PROOF,
      VALID_PUBLIC_SIGNALS,
      await futureExpiryLedger()
    );

    await assert.rejects(
      verifyOnChain({
        network,
        keypair,
        calldata: overBudgetCalldata
      }),
      (error: unknown) =>
        error instanceof SorobanZkError &&
        error.code === SorobanZkErrorCode.RATE_LIMIT_EXCEEDED
    );
  });
}
