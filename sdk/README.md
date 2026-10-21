# @zksoroban/sdk

TypeScript SDK for Poseidon hashing, snarkjs proof formatting, and on-chain
verification against `contracts/verifier`/`contracts/registry`. See the
[repo root README](../README.md) for the project overview and
[docs/architecture.md](../docs/architecture.md) for how this fits together
with the contracts and circuits.

## Testing

```sh
npm test         # build + run the full suite (sdk/test/**/*.ts)
npm run test:unit  # same thing, by its more conventional name
npm run test:golden # golden-file CLI output check (see scripts/golden.ts)
npm run bench     # microbenchmarks — see docs/performance.md#sdk-microbenchmarks
```

Tests run on Node's built-in test runner (`node:test`, via `tsx`) — not
Vitest or Jest. `test/verify.integration.ts` needs `SOROBAN_SECRET_KEY` and
`SOROBAN_VERIFIER_CONTRACT_ID` to do anything; without them it skips itself
rather than failing.

### Snapshot tests

`test/proofEncoding.snapshot.test.ts` snapshots `formatProof`'s and
`poseidon`'s output for known, fixed inputs (see
[zksoroban#90](https://github.com/yusufadeagbo/zksoroban/issues/90)) — the
point is to catch an encoding regression the moment it happens in CI,
rather than only discovering it after a proof that used to verify starts
failing against a real deployed contract.

Snapshots live in `test/__snapshots__/*.snapshot` and are committed to the
repo, using Node's built-in snapshot testing
([`t.assert.snapshot()`](https://nodejs.org/api/test.html#snapshot-testing)).
`test/snapshot-setup.ts`, preloaded via `--require` in the `test` script,
just tells Node to put those files in `test/__snapshots__/` next to the
test that owns them, instead of its default of one flat `<test-file>.snapshot`
sitting directly in `test/`.

**If `npm test` fails on a snapshot mismatch**, that's the test suite
doing exactly its job: something changed what `formatProof` or `poseidon`
produce for a fixed input. Figure out why before doing anything else — an
unintended change here breaks proofs, calldata, and every already-deployed
contract expecting the old encoding.

**If the change was actually intentional** (a deliberate encoding change,
a new field, a genuine bug fix), refresh the snapshots and review the diff
like any other code change:

```sh
npx tsx --test --require ./test/snapshot-setup.ts --test-update-snapshots test/proofEncoding.snapshot.test.ts
git diff test/__snapshots__/
```

Commit the updated `.snapshot` file alongside whatever source change caused
it, and say why in the PR — the same way a deliberate contract-cost
increase gets explained when updating
[`contracts/verifier/baseline-cost.json`](../contracts/verifier/baseline-cost.json)
(see [`docs/performance.md`](../docs/performance.md)).
