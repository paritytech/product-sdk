# @parity/product-sdk-react

**React hooks for building Polkadot apps.**

One install, one provider, 72 hooks. Wraps the entire
[@parity/product-sdk](https://github.com/paritytech/product-sdk) surface —
chain queries, wallet accounts, transactions, contracts, chat, statement
store, payments, notifications and cloud storage — built on
[TanStack Query](https://tanstack.com/query).

## Install

```sh
pnpm add @parity/product-sdk-react @tanstack/react-query
```

## Use

```tsx
import { TruapiProvider, defineConfig } from "@parity/product-sdk-react";

const config = defineConfig({
  chains: { /* … */ },
  dappName: "my-app",
});

createRoot(root).render(
  <TruapiProvider config={config}>
    <App />
  </TruapiProvider>,
);
```

```tsx
const { submit, phase } = useTx();
const balance = useBalance(account?.address);
const theme = useTheme();
```

## Docs

Full hook catalog, guides and examples:
[paritytech.github.io/product-sdk](https://paritytech.github.io/product-sdk/) ·
[GitHub](https://github.com/paritytech/product-sdk)

## License

Apache-2.0
