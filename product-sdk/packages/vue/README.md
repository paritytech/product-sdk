# @parity/product-sdk-vue

**Vue 3 composables for building Polkadot apps.**

One install, one plugin, 72 composables. Wraps the entire
[@parity/product-sdk](https://github.com/paritytech/product-sdk) surface —
chain queries, wallet accounts, transactions, contracts, chat, statement
store, payments, notifications and cloud storage — built on
[TanStack Query](https://tanstack.com/query).

## Install

```sh
pnpm add @parity/product-sdk-vue @tanstack/vue-query
```

## Use

```ts
import { TruapiPlugin, defineConfig } from "@parity/product-sdk-vue";

const config = defineConfig({
  chains: { /* … */ },
  dappName: "my-app",
});

createApp(App).use(TruapiPlugin, { config }).mount("#app");
```

```ts
const { submit, phase } = useTx();
const balance = useBalance(address);
const theme = useTheme();
```

## Docs

Full composable catalog, guides and examples:
[paritytech.github.io/product-sdk](https://paritytech.github.io/product-sdk/) ·
[GitHub](https://github.com/paritytech/product-sdk)

## License

Apache-2.0
