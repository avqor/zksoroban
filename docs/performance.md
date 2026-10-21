# SDK Performance Notes

## Contract verification cost (`contracts/verifier`)

Issue #65 asked for `verify_proof`'s point-decoding path (`read_g1`/`read_g2`
in `contracts/verifier/src/lib.rs`) to be profiled and optimized for
instruction count, with a target of at least a 5% reduction. The
methodology and full result are below — the short version: the fix is
real and correct, but decoding turned out to be under 1% of the call's
total cost, so 5% isn't reachable without changing the pairing/crypto
math itself, which was explicitly out of scope.

### Methodology

Measured against `contracts/verifier`'s own known-good fixture — the
`poseidon_preimage` verifying key and a valid proof for it, both from
`contracts/verifier/src/tests.rs` (`poseidon_vk`, `VALID_PROOF_A/B/C`,
`VALID_PUBLIC_INPUT`) — on a local Stellar network (`stellar container
start local`), not Testnet, so the numbers are reproducible and don't
depend on network conditions or an existing deployment.

This stellar-cli version's `contract invoke --cost` prints a fee-estimate
table (inclusion/resource/refundable fees), not the raw instruction count
directly. To get the exact number, build the unsigned invocation with
`--build-only` and read `resources.instructions` off the
`simulateTransaction` RPC response's `transactionData` directly:

```bash
stellar container start local
stellar keys generate --network local --fund perf-test

stellar contract deploy --wasm target/wasm32v1-none/release/zksoroban_verifier.wasm \
  --source perf-test --network local \
  -- --admin perf-test --max_calls 1000000 --window_size 100 --vk-file-path vk.json

stellar contract invoke --id <contract-id> --source perf-test --network local --build-only \
  -- verify_proof --caller perf-test \
  --proof_a <hex> --proof_b <hex> --proof_c <hex> \
  --public_inputs-file-path public_inputs.json > tx.xdr

curl -s http://localhost:8000/rpc -X POST -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"simulateTransaction\",\"params\":{\"transaction\":\"$(cat tx.xdr)\"}}" \
  | jq -r .result.transactionData > txdata.xdr

stellar xdr decode --type SorobanTransactionData --input single-base64 --output json < txdata.xdr
# → {"resources":{"instructions": <the number>, ...}}
```

`public_inputs.json` is the circuit's real public signal
(`VALID_PUBLIC_INPUT`) plus a far-future `expiry_ledger` encoded per
`docs/proof-format.md`, so the call takes the full pairing-check path
rather than short-circuiting on an expired or malformed input.

### Baseline vs. optimized

| | Instructions | Δ |
|---|---|---|
| Baseline (`main`) | 27,681,711 | — |
| Optimized (this PR) | 27,661,830 | −19,881 (−0.072%) |

### Where the instructions actually go

`contracts/verifier`'s own test suite can report a finer-grained,
per-host-function breakdown via `soroban-sdk`'s `testutils` budget
tracker (`env.cost_estimate().budget()`), run natively rather than under
wasm — the relative proportions below are what matters, not the absolute
numbers, which the SDK's own docs note run lower for native Rust than for
the real wasm target:

| Cost type | Instructions | Share |
|---|---|---|
| `Bn254Pairing` (the pairing check itself) | 17,528,691 | ~68% |
| `Bn254G2CheckPointInSubgroup` | 6,824,208 | ~26% |
| `Bn254G1Mul` (`vk_ic1 * public_input`) | 1,150,435 | ~4.5% |
| Everything else (decoding, storage, events, hashing, `Bn254G1Add`, `Bn254DecodeFp`, …) | ~264,000 | ~1% |

`Bn254G2CheckPointInSubgroup` runs once per G2 point handed to
`pairing_check` — here, `proof_b`, `vk_beta`, `vk_gamma`, and `vk_delta`,
four points, even though `vk_beta`/`vk_gamma`/`vk_delta` are the same
bytes on every single call (they only change once `execute_vk_update`
applies a proposed key). The
Soroban host has no way to know that from inside one `pairing_check`
call, so it re-validates all four every time. That's the real
instruction sink, not the byte-decoding step this issue targeted, and
recovering it would mean restructuring the verification equation itself
(e.g., precomputing `e(vk_alpha, vk_beta)` once and storing it, dropping
the check to a 3-pair pairing and 3 subgroup checks instead of 4) — a
change to the verification algorithm and to what `VerifyingKey` stores,
not to how bytes are decoded, and out of this issue's stated scope
("optimise point decoding... [not] changing the byte encoding format").

### The optimization that was made

`read_g1`/`read_g2` converted their `Bytes` argument to `BytesN<64>`/
`BytesN<128>` by first asserting `bytes.len() == N` and then calling
`BytesN::try_from_val`, whose own `TryFrom<Bytes>` impl re-checks
`bin.len() == N` a second time — the same length validated twice for the
same bytes, once explicitly and once inside the conversion it fed into.
Both call paths route through the same `Bn254G1Affine::from_bytes`/
`Bn254G2Affine::from_bytes`, which are zero-cost wraps (verified in
`soroban-sdk`'s source — no validation happens there; it's deferred to
`pairing_check`), so the double length check was pure overhead. The fix
converts via a single `bytes.try_into()` (`TryFrom<&Bytes> for
BytesN<N>`), preserving the exact same panic behavior and message for a
wrong-length input (`verify_proof_panics_on_wrong_proof_a_length` still
passes) while performing the length check once instead of twice, three
times per `verify_proof`/per proof in `verify_batch` (`proof_a`,
`proof_b`, `proof_c`).

## CI Cost Regression Check

[zksoroban#74](https://github.com/yusufadeagbo/zksoroban/issues/74) asked
for a CI check that fails if `verify_proof`'s instruction cost regresses
by more than 10% against a committed baseline — so a change that quietly
doubles the cost of every verification gets caught before it merges,
rather than being noticed later on a real network's fee bill.

### Why this doesn't run `stellar contract invoke --cost` the way the issue describes

The issue's acceptance criteria describes a script that "runs `soroban
contract invoke --cost` on a known proof, parses the instruction count
from output." Two things make that the wrong tool for a *CI* gate
specifically, on top of what the "Contract verification cost" section
above already found — that this CLI version's `--cost` output is a fee
table, not a raw instruction count:

- Getting a real number out of `stellar contract invoke` at all (see
  above) means simulating against an actual RPC endpoint, which for a
  reproducible, non-Testnet-dependent number means `stellar container
  start local` — a Docker container CI would need to pull and boot on
  every run. That's slow and adds a real flakiness surface (image pulls,
  port/network readiness) to a check that runs on every PR.
- It's also unnecessary: `soroban-sdk`'s testutils can register a
  contract from its *compiled wasm bytes* directly
  (`Env::register(wasm_bytes, args)`, not the `Env::register(ContractType,
  args)` form `contracts/verifier/src/tests.rs`'s own unit tests use) and
  run it through the real wasmi interpreter, entirely in-process — no
  network, no Docker, no RPC. `env.cost_estimate().budget()` then reports
  the same CPU-instruction cost a real invocation would, this time
  *including* wasm-interpretation overhead, which registering the native
  Rust `VerifierContract` type directly would skip entirely (confirmed
  while building this: a native-type registration reports `WasmInsnExec:
  0` — none of the compiled contract's own instructions get charged,
  because there's no wasm being interpreted, just Rust function calls).

`contracts/verifier/tests/cost_regression.rs` is exactly that: it reads
the already-built `contracts/verifier/target/wasm32v1-none/release/
zksoroban_verifier.wasm`, registers it, runs `verify_proof` against the
same `poseidon_preimage` fixture the "Contract verification cost" section
above uses, and compares `env.cost_estimate().budget().cpu_instruction_cost()`
against `contracts/verifier/baseline-cost.json`.

### Running it

```bash
make verifier-cost-check            # build the wasm, then check cost against the baseline
make update-verifier-cost-baseline  # build the wasm, re-measure, and overwrite the baseline
```

Both build the release wasm first — the test panics with a clear message
naming the missing file and the exact command to run if it isn't already
built. CI's `contract` job builds the release wasm right before
`cargo test --manifest-path contracts/verifier/Cargo.toml` — that plain
`cargo test` call runs every test target under that manifest, including
`tests/cost_regression.rs`, so the wasm has to exist *before* that step
runs, not after it. (An earlier version of this had the build step
*after* that test step, which passed locally only because a wasm from an
earlier manual build was already sitting there — CI starts from a clean
checkout every time and caught it immediately.)

### Interpreting a failure

A failing run prints the baseline, the actual measured cost, the delta in
both absolute instructions and percent, and the max allowed value:

```
verify_proof instruction cost regressed by more than 10%:
  baseline:    26720340 instructions
  actual:      29500000 instructions
  delta:       +2779660 instructions (+10.4%)
  max allowed: 29392374 instructions (baseline + 10%)
```

If the regression is a real bug, fix it and re-run
`make verifier-cost-check`. If it's an intentional tradeoff (a new
feature that genuinely costs more, a security check worth the extra
instructions), run `make update-verifier-cost-baseline`, commit the
updated `contracts/verifier/baseline-cost.json`, and explain why in the
PR — the same way the two-step admin transfer, `pause`, or the VK-update
timelock each added real, deliberate cost for a real safety property.

The check only ever fails *upward* — a cost decrease always passes, same
as this issue's stated scope (regression detection, not a cost budget in
either direction).

### What this baseline is and isn't good for

- **Good for**: catching a change to `contracts/verifier` itself (its
  code, or a `soroban-sdk`/toolchain bump) that meaningfully increases
  what a real `verify_proof` call costs.
- **Not cross-machine normalized, on purpose** (explicitly out of scope
  for #74): the absolute number in `baseline-cost.json` is specific to
  this measurement method (wasm-interpreted, in-process, via
  `soroban-sdk`'s testutils) and will differ from what
  `stellar contract invoke --cost` reports against a real network for
  the same proof (see the "Contract verification cost" section above —
  those two methodologies measured 26,720,340 and 27,661,830
  respectively for what should be equivalent calls, a ~3.5% difference
  plausibly from resource-accounting differences between simulated and
  in-process execution). That's fine for *regression detection* — the
  same methodology run twice on the same code should reproduce the same
  number — but don't treat this baseline as "the" instruction cost of
  `verify_proof`; treat the network measurement in "Contract verification
  cost" above as more representative of real on-chain cost, and this one
  as the CI tripwire for a regression *from* whatever the last-committed
  baseline was.

## Dual ESM/CJS build

`sdk/` builds to three parallel outputs from the same `src/`:

| Path | Format | Produced by |
|---|---|---|
| `dist/cjs/*.js` | CommonJS | `tsconfig.cjs.json` |
| `dist/esm/*.js` | ESM | `tsconfig.esm.json` |
| `dist/types/*.d.ts` | Type declarations (format-agnostic) | `tsconfig.types.json` |

`dist/index.cjs` and `dist/index.mjs` are thin entry points (`module.exports = require("./cjs/index.js")` and `export * from "./esm/index.js"`) that `sdk/package.json`'s `exports` map points at:

```json
"exports": {
  ".": {
    "types": "./dist/types/index.d.ts",
    "import": "./dist/index.mjs",
    "require": "./dist/index.cjs"
  }
}
```

Each of `dist/cjs/` and `dist/esm/` carries its own `package.json` (`{"type":"commonjs"}` / `{"type":"module"}`) written by `scripts/postbuild.cjs`, so Node interprets the plain `.js` files inside each correctly regardless of the package's own top-level `"type"` field. This avoids renaming individual compiled files to `.cjs`/`.mjs` (which would break Node's default extensionless `require()` resolution for the CJS build) while still satisfying `.mjs`/`.cjs` at the two paths that actually matter for consumers and tooling.

Verified directly, not just assumed:
- `const { verifyOnChain } = require('@zksoroban/sdk')` — tested against a real `npm pack` tarball installed into a fresh consumer project.
- `import { verifyOnChain } from '@zksoroban/sdk'` — tested the same way inside a real Vite project, including a full `vite build`.

## ESM bundle size and tree-shaking

Measured with `vite build` (Rollup) importing only specific named exports from a freshly-installed `@zksoroban/sdk` tarball, no other app code:

| Import | Bundle (raw) | Bundle (gzip) |
|---|---|---|
| `import { formatProof } from "@zksoroban/sdk"` | 4.93 kB | 1.96 kB |
| `import { verifyOnChain } from "@zksoroban/sdk"` | 361.56 kB | 95.35 kB |
| `import * as sdk` (every export referenced) | 811.32 kB | 199.94 kB |

`verifyOnChain`'s bundle is dominated by `@stellar/stellar-sdk`, which it genuinely needs to submit transactions — that's expected weight, not a tree-shaking failure. The `formatProof`-only case shows the SDK's own pure formatting/validation logic tree-shakes down to almost nothing when the on-chain and off-chain verification paths aren't used.

### A real tree-shaking bug found and fixed while verifying this

`verifyOffChain.ts` originally loaded snarkjs with a **module-scope** `require("snarkjs")`. A bare `require()` call at the top of a file is opaque to Rollup — it can't prove the module has no side effects, so it can't safely drop the module even when nothing imports `verifyOffChain`. Because every export is re-exported through one barrel (`index.ts`), that single top-level `require()` was pinning snarkjs (and its `ffjavascript` dependency) into *every* consumer's bundle regardless of which export they actually used:

| Import | Bundle (raw) before the fix |
|---|---|
| `formatProof` only | 451.76 kB |
| `verifyOnChain` only | 808.60 kB |

The fix: move the snarkjs load into the function body as a lazy `await import("snarkjs")`, so it only executes if `verifyOffChain` is actually called, and so the module has no top-level side effects for Rollup to worry about. A `declare module "snarkjs";` ambient shim (`src/snarkjs.d.ts`) was added alongside it — snarkjs ships no type declarations, and `import()` requires TypeScript to resolve the module (`require()`'s untyped return didn't need to). This shim carries the same trust boundary the old `require()` call had implicitly.

This is also why `require()` at module scope wasn't just a tree-shaking wart, but an outright bug waiting to happen for the ESM build specifically: plain `require()` doesn't exist in a real Node ESM module. Dynamic `import()` works correctly from both CJS and ESM contexts, which is what makes it the right fix here rather than only a tree-shaking one.

**All of these numbers are single measurements on one machine with one Vite version — expect them to drift over time and across environments.** Re-run `vite build` yourself if you need a number to depend on.

## SDK Microbenchmarks

[zksoroban#38](https://github.com/yusufadeagbo/zksoroban/issues/38) asked
for a benchmark suite so a PR changing `formatProof` or encoding logic has
some signal on whether it regressed performance, instead of no baseline
to compare against at all.

### Two deliberate deviations from the issue's literal wording

- **This file already existed** before this issue — the "Contract
  verification cost" section above predates it by a wide margin. The
  issue's acceptance criteria says "documented in `docs/performance.md`
  (new file)"; this section was added to the existing file instead of
  creating (and overwriting) a new one.
- **Not a Vitest bench suite.** This repo's test runner is Node's built-in
  `node:test` (via `tsx`) — see `sdk/README.md`'s Testing section —  not
  Vitest or Jest, and Vitest isn't a dependency anywhere in this repo.
  `sdk/scripts/bench.ts` is a plain script instead, run the same way
  `scripts/golden.ts` already is (`npm run test:golden`): a hand-rolled
  harness around `performance.now()` (`node:perf_hooks`), not a
  `node:test`/Vitest suite at all. It satisfies the same functional
  requirements the issue actually cares about — at least 3 named
  benchmarks, at least 100 iterations each, results printed, invoked via
  `npm run bench` — without introducing a second test framework alongside
  the one this repo has standardized on.

### What's benchmarked

```sh
cd sdk
npm run bench
```

Three benchmarks, each with a 20-call warm-up before the timed loop:

- **`poseidon(2 inputs)`** — `poseidon([1n, 2n])`, the same hash
  `contracts/verifier`'s reference circuit uses, called directly with no
  circuit or proof involved.
- **`formatProof(valid proof)`** — encodes `sdk/test/fixtures.ts`'s
  known-good `VALID_SNARKJS_PROOF`/`VALID_PUBLIC_SIGNALS` into
  `SorobanProofCalldata`, the same fixture `sdk/test/proofEncoding.snapshot.test.ts`
  snapshots.
- **`verifyOnChain(mocked RPC)`** — a full `verifyOnChain` call against a
  mocked `rpc.Server` (the same stubbing pattern `verify.unit.test.ts`
  uses for its own unit tests), so this measures the SDK's *own*
  transaction-building/decoding overhead, not Testnet round-trip latency,
  which would dominate the number and tell you nothing about a change to
  this repo's own code.

### Baseline numbers

**Not filled in by this PR** — these need an actual `npm run bench` run to
populate honestly, which this round of work didn't execute (see the PR
description). Whoever runs this next should paste the real output here:

```
poseidon(2 inputs)                <iterations> iters  <mean> ms/op  <ops/sec>
formatProof(valid proof)          <iterations> iters  <mean> ms/op  <ops/sec>
verifyOnChain(mocked RPC)         <iterations> iters  <mean> ms/op  <ops/sec>
```

Like every other measurement in this file, treat these as single-machine
numbers that will drift across environments and Node versions — useful
for *this PR's* regression check (same methodology, re-run on the same
machine), not as an absolute performance claim.
