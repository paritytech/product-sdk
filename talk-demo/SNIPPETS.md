# Slide snippets

The code to put on each slide. Each maps 1:1 to a file in `src/snippets/` and to a
button in the running demo. Keep these in sync with the source.

Everything runs off one shared app — the SDK's unified entry point:

```ts
import { createApp } from "@parity/product-sdk";

const app = await createApp({ name: "talk-demo" });
```

---

## Beat 1 · Ask permission

> Not on the `app` surface — permissions come from the host package.

```ts
import { requestPermission } from "@parity/product-sdk-host";

// The product can't grant this itself — the host asks the user.
const granted = await requestPermission({ tag: "ChainSubmit", value: undefined });
```

## Beat 2 · Connect to a chain

```ts
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const { assetHub } = await app.chain.connect({ assetHub: paseo_asset_hub });

// Watch blocks live — updates on every new block.
assetHub.query.System.Number.watchValue({ at: "best" })
  .subscribe(({ value }) => console.log(`block #${value}`));
```

## Beat 3 · Get my account

```ts
const { accounts } = await app.wallet.connect(); // keys never leave the host
app.wallet.selectAccount(accounts[0].address);   // { address, name, source }
```

## Beat 4 · Store something

```ts
// LOCAL — on-device, instant
await app.localStorage.set("greeting", "hello Berlin");
const value = await app.localStorage.get("greeting");

// CLOUD — same idea, persisted on-chain (Bulletin)
const cid = await app.cloudStorage.upload("hello Berlin");
const back = await app.cloudStorage.fetch(cid);
```

## Beat 5 · Sign a transaction

> The App wallet doesn't submit product-account transactions, so this beat uses
> `SignerManager` directly. The App still provides the chain client.

```ts
import { SignerManager } from "@parity/product-sdk";
import { submitAndWatch } from "@parity/product-sdk-tx";
import { Binary } from "polkadot-api";

const account = await signer.getProductAccount("talk-demo.dot", 0);
const { assetHub } = await app.chain.connect({ assetHub: paseo_asset_hub });
const tx = assetHub.tx.System.remark({ remark: Binary.fromText(text) });

// The host prompts the user on their phone.
const result = await submitAndWatch(tx, account.value.getSigner(), { onStatus });
```
