# @parity/product-sdk-reputation

Create, read, and revoke attestations through the AttestationService contracts.
Read Honour tallies from a connected People chain.

The caller supplies the chains, contract addresses, schema IDs, and recipient IDs.
The package does not resolve names or classify recipients as people or apps.
Attestation recipients are H160 addresses. Honour subjects are 32-byte IDs.

```ts
import { createContractRuntimeFromClient } from "@parity/product-sdk-contracts";
import { createAttestationClient, readAttestedEvents } from "@parity/product-sdk-reputation";
import { encodeAbiParameters } from "viem";

const runtime = createContractRuntimeFromClient(rawAssetHubClient, assetHubDescriptor);
const result = createAttestationClient(runtime, {
    serviceAddress,
    schemaRegistryAddress,
});
if (!result.ok) throw result.error;
const attestations = result.value;

const request = {
    schemaId,
    recipient,
    data: encodeAbiParameters([{ type: "string" }], ["Delivered as agreed"]),
    revocable: true,
    expirationTime: 0n,
    refId: 0n,
};
const submitted = await attestations.attest(request, {
    origin: productAccount.address,
    signer: productAccount.getSigner(),
    waitFor: "finalized",
});
if (!submitted.ok) throw submitted.error;
const created = readAttestedEvents(submitted.value.events, serviceAddress);
if (!created.ok) throw created.error;
```

Use a schema whose field encoding matches `data`. The package preserves opaque
bytes and all record fields, including `refId`. It does not register schemas or
apply a comment format. `attest` and `revoke` return the existing SDK transaction
result. Contract and transaction errors retain their types.

`readSchema` and `readAttestation` return `null` for missing records.
`readAttestations` reads up to 100 supplied IDs. It retains the input order,
duplicates, and missing entries. IDs from unique schemas can be hashes, so a
sequential counter cannot list every attestation. Obtain IDs from transaction
events or an application indexer. An empty event result means no matching
`Attested` event was found; it does not prove that a submitted transaction failed.

Reads default to finalized state. Writes default to best-block inclusion.
For an immediate read after a write, use `waitFor: "finalized"` or read at the
receipt's block hash. Pass the same explicit block hash to
`readAttestation` and `isActive` when comparing them. `isActive` uses the contract's
chain timestamp, including its expiration rules, rather than the device clock.
The provider must retain or serve a requested block. Host-routed reads cannot
query unpinned historical blocks through the current SDK Host provider.

`prepareAttestation` and `prepareRevocation` return calls for
`batchSubmitAndWatch`. They require the signing account's SS58 `origin` for the
dry-run and do not sign or submit. Account mapping, fees, permissions, signer
selection, and transaction approval remain with the caller. Supplying both
`gasLimit` and `storageDepositLimit` skips the contracts package's dry-run.

```ts
import { readHonourTally } from "@parity/product-sdk-reputation";

const tally = await readHonourTally(peopleChain, subjectId);
if (!tally.ok) throw tally.error;
console.log(tally.value.score, tally.value.at);
```

`peopleChain` supplies `individuality.query.Honour.Tally.getValue` and
`raw.individuality.getFinalizedBlock`. Each read pins one finalized block and
reports its hash and number. You can pass a snapshot through `options.at` and an
abort signal through `options.signal`. An absent tally has the pallet default
score of -1. `hasStoredTally` distinguishes absence from a stored -1.

Honour vote submission needs Host proof support and is outside this package.
Attestation reads do not prove the author's personhood. The package does not
provide a global vote history or a combined profile view.

The same exports are available from `@parity/product-sdk/reputation`.
Run the offline example from the workspace:

```sh
pnpm --filter @parity/product-sdk-reputation-example demo
```
