# Slide snippets

The code to put on each slide. Each beat is self-contained — the ones that use the
SDK open with `createApp` so the example reads on its own.

> Note: the running demo (`src/`) shares **one** `createApp` instance across all
> beats (see `src/sdk.ts`) — one host session, one connection set. The snippets
> below inline `createApp` purely so each slide stands alone.

---

## Beat 1 · Connect to a chain

```ts
import { createApp } from "@parity/product-sdk";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const app = await createApp({ name: "demo-app" });

const { assetHub } = await app.chain.connect({ assetHub: paseo_asset_hub });

// Watch blocks live — each emits the number and the block hash.
assetHub.query.System.Number.watchValue({ at: "best" })
  .subscribe(({ block, value }) => console.log(`#${value}  ${block.hash}`));
```

## Beat 2 · Account & signing

> Connect once, then the selected account signs. `signMessage` is `signRaw` under
> the hood — signs bytes with the host-held key, no chain submission, so no funded
> product account is needed.

```ts
import { createApp } from "@parity/product-sdk";

const app = await createApp({ name: "demo-app" });

// Connect once — keys never leave the host.
const { accounts } = await app.wallet.connect();
app.wallet.selectAccount(accounts[0].address); // { address, name, source }

// The same account signs — the host prompts the user on their phone.
const signature = await app.wallet.signMessage("gm from Web3Summit");
```

## Beat 3 · Ask permission

> Not on the `app` surface — permissions come from the host package, in two families.
> Chain/network: `ChainSubmit`, `StatementSubmit`, `PreimageSubmit`, `WebRtc`, `Remote`.
> Device: `Notifications`, `Camera`, `Microphone`, `Bluetooth`, `NFC`, `Location`, `Clipboard`, `OpenUrl`, `Biometrics`.

```ts
import { requestDevicePermission } from "@parity/product-sdk-host";

// Device — camera, microphone, location, … (a separate host call)
await requestDevicePermission("Camera");
```

## Beat 4 · Store something

```ts
import { createApp } from "@parity/product-sdk";

const app = await createApp({ name: "demo-app" });

// LOCAL — on-device, instant
await app.localStorage.set("greeting", "hello Berlin");
const value = await app.localStorage.get("greeting");

// CLOUD — same idea, persisted on-chain (Bulletin)

const cid = await app.cloudStorage.upload("hello Berlin");
const back = await app.cloudStorage.fetch(cid);
```
