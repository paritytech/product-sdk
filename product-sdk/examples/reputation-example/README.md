# Reputation example

This Node example runs offline. It uses a Revive API fixture with the SDK contracts runtime and contract ABIs.
The addresses, schema, attestation, and Honour tally are fixtures. It requires no wallet and submits no transaction.

Run from `product-sdk/`:

```sh
pnpm --filter @parity/product-sdk-reputation-example... build
pnpm --filter @parity/product-sdk-reputation-example demo
```

The example encodes a rating schema, reads an attestation by its hashed ID, and preserves `refId`.
It prepares attestation and revocation calls with a chosen SS58 origin. It also reads a Honour tally at one block.

For a live app, create a runtime with `createContractRuntimeFromClient` from the contracts package.
Supply your Asset Hub client, descriptor, and deployed contract addresses to `createAttestationClient`.
Use your signing account as the origin. A prepared call requires a signer and submission through the transaction package.
Contract transactions require a Revive account mapping. The contracts package provides `ensureContractAccountMapped`.
For Honour reads, supply a chain client with the People chain `Honour.Tally` storage entry.

The app chooses the recipient, schema, and payload encoding. This example does not resolve dotNS names or create Honour votes.
