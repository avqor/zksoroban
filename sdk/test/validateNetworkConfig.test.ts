/**
 * Unit tests for validateNetworkConfig()/ConfigValidationError (zksoroban#109).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigValidationError,
  LOCAL,
  MAINNET,
  NetworkConfig,
  TESTNET,
  validateNetworkConfig
} from "../src/types";
import { getContractVersion } from "../src/version";

const VALID: NetworkConfig = TESTNET;

test("validateNetworkConfig returns [] for a fully valid config", () => {
  assert.deepEqual(validateNetworkConfig(VALID), []);
});

test("invalid shape 1: rpcUrl is an empty string", () => {
  const errors = validateNetworkConfig({ ...VALID, rpcUrl: "" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "rpcUrl");
  assert.equal(errors[0].value, "");
});

test("invalid shape 2: rpcUrl is not a valid URL at all", () => {
  const errors = validateNetworkConfig({ ...VALID, rpcUrl: "not a url" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "rpcUrl");
  assert.match(errors[0].reason, /not a valid URL/);
});

test("invalid shape 3: rpcUrl uses an unsupported scheme", () => {
  const errors = validateNetworkConfig({ ...VALID, rpcUrl: "ftp://example.com/rpc" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "rpcUrl");
  assert.match(errors[0].reason, /http or https/);
});

test("invalid shape 4: networkPassphrase is an empty string", () => {
  const errors = validateNetworkConfig({ ...VALID, networkPassphrase: "" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "networkPassphrase");
});

test("invalid shape 5: networkPassphrase is only whitespace", () => {
  const errors = validateNetworkConfig({ ...VALID, networkPassphrase: "   " });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "networkPassphrase");
});

test("invalid shape 6: contractId is an empty string", () => {
  const errors = validateNetworkConfig({ ...VALID, contractId: "" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "contractId");
});

test("invalid shape 7: contractId is the wrong length", () => {
  const errors = validateNetworkConfig({ ...VALID, contractId: "CTOOSHORT" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "contractId");
});

test("invalid shape 8: contractId does not start with 'C'", () => {
  const errors = validateNetworkConfig({
    ...VALID,
    contractId: "G" + "A".repeat(55)
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "contractId");
});

test("multiple problems are all reported, not just the first", () => {
  const errors = validateNetworkConfig({
    rpcUrl: "",
    networkPassphrase: "",
    contractId: ""
  });
  assert.equal(errors.length, 3);
  assert.deepEqual(
    errors.map((e) => e.field).sort(),
    ["contractId", "networkPassphrase", "rpcUrl"]
  );
});

test("the LOCAL preset's http:// rpcUrl is not flagged (deliberately not HTTPS-only)", () => {
  const errors = validateNetworkConfig(LOCAL);
  assert.ok(
    !errors.some((e) => e.field === "rpcUrl"),
    "LOCAL's http://localhost rpcUrl must not be rejected for using http instead of https"
  );
});

test("the LOCAL and MAINNET presets' empty contractId IS flagged (not a real contract target yet)", () => {
  assert.ok(validateNetworkConfig(LOCAL).some((e) => e.field === "contractId"));
  assert.ok(validateNetworkConfig(MAINNET).some((e) => e.field === "contractId"));
});

test("getContractVersion throws ConfigValidationError for an invalid network, before any RPC call", async () => {
  await assert.rejects(
    getContractVersion({ ...VALID, contractId: "" }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.equal(err.errors.length, 1);
      assert.equal(err.errors[0].field, "contractId");
      return true;
    }
  );
});

test("validateNetworkConfig is exported from the SDK entry point", async () => {
  const sdk = await import("../src/index");
  assert.ok("validateNetworkConfig" in sdk, "validateNetworkConfig exported from index");
  assert.ok("ConfigValidationError" in sdk, "ConfigValidationError exported from index");
});
