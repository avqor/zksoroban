/**
 * Unit tests for the NetworkConfig type and its presets (zksoroban#40).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL, MAINNET, NetworkConfig, TESTNET } from "../src/types";

function assertIsNetworkConfig(value: NetworkConfig): void {
  assert.equal(typeof value.rpcUrl, "string");
  assert.equal(typeof value.networkPassphrase, "string");
  assert.equal(typeof value.contractId, "string");
}

test("TESTNET is a fully-populated NetworkConfig for the live Testnet deployment", () => {
  assertIsNetworkConfig(TESTNET);
  assert.equal(TESTNET.rpcUrl, "https://soroban-testnet.stellar.org");
  assert.equal(TESTNET.networkPassphrase, "Test SDF Network ; September 2015");
  assert.equal(TESTNET.contractId, "CBL6MAWJALQP25LYKUUOC34K464XPSF6BLKUW6MXZDEXEDXMQUSP7HNN");
});

test("MAINNET has the real Mainnet passphrase, and a deliberately empty rpcUrl/contractId", () => {
  assertIsNetworkConfig(MAINNET);
  assert.equal(MAINNET.networkPassphrase, "Public Global Stellar Network ; September 2015");
  assert.equal(MAINNET.rpcUrl, "", "no free public Mainnet Soroban RPC endpoint to default to");
  assert.equal(MAINNET.contractId, "", "no zksoroban contract is deployed to Mainnet");
});

test("LOCAL targets a local quickstart node's RPC endpoint, with a deliberately empty contractId", () => {
  assertIsNetworkConfig(LOCAL);
  assert.equal(LOCAL.rpcUrl, "http://localhost:8000/rpc");
  assert.equal(LOCAL.networkPassphrase, "Standalone Network ; February 2017");
  assert.equal(LOCAL.contractId, "", "a local deployment's contract ID has no universal default");
});

test("spreading a preset with a different contractId targets a different contract on the same network", () => {
  const registryOnTestnet: NetworkConfig = {
    ...TESTNET,
    contractId: "CDTPNARKKZCZ36PL4BNKBXZTT2BLVR373S2K5NCFAOKCPPY62ESRHSXH"
  };

  assert.equal(registryOnTestnet.rpcUrl, TESTNET.rpcUrl);
  assert.equal(registryOnTestnet.networkPassphrase, TESTNET.networkPassphrase);
  assert.notEqual(registryOnTestnet.contractId, TESTNET.contractId);
});
