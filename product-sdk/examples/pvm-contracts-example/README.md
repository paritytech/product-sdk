# pvm-contracts-example

Minimal Node example showing how to consume the artefacts produced by
`cargo pvm-contract build` from `@parity/product-sdk-contracts` **without** going
through CDM.

## What it demonstrates

| Path | API | When to use |
| --- | --- | --- |
| In-memory parse | `parsePvmContractAbi(json)` | ABI is bundled / fetched / already in memory (browser-safe) |
| Filesystem load | `loadPvmContractAbi(path)` | Reading directly from `cargo pvm-contract build` output (Node only) |
| Full artefact pair | `loadPvmContractArtifacts(basePath)` | You also want the `.polkavm` bytecode (e.g. for deployment) |

All three paths return shapes that drop straight into `createContract`,
`createContractFromClient`, or `ContractManager`.

## Layout

```
fixtures/
  counter.release.abi.json   # mirrors what cargo-pvm-contract emits
src/
  main.ts                    # walks through all three loader paths
```

## Run

```sh
pnpm install
pnpm --filter @parity/product-sdk-pvm-contracts-example demo
```

## Going live

The example stops at the loader boundary because driving an actual contract
needs a live deployment. The next step is identical to the existing
`contracts-demo`:

```ts
import { createContractFromClient } from "@parity/product-sdk-contracts";
import { loadPvmContractAbi } from "@parity/product-sdk-contracts/pvm";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const abi = await loadPvmContractAbi("./target/counter.release.abi.json");
const counter = createContractFromClient(client, paseo_asset_hub, "0xC472...", abi);

const { value } = await counter.get.query();
await counter.increment.tx(1, { signer });
```
