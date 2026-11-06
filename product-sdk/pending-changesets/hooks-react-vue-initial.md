---
"@parity/product-sdk-hooks-core": minor
"@parity/product-sdk-react": minor
"@parity/product-sdk-vue": minor
---

**Add `@parity/product-sdk-react`, `@parity/product-sdk-vue` and `@parity/product-sdk-hooks-core`.**

React hooks and Vue composables on TanStack Query v5 over the whole SDK surface — chain queries,
accounts, transactions, contracts, host features, chat, statements, payments, cloud storage and
Pocket cards — with `@parity/product-sdk-hooks-core` as the framework-agnostic runtime both bind
to. Ported from `use-truapi` v0.1.2 (justraman/use-truapi@9c7d9a7).

Relative to `@use-truapi/*`: the `Register` augmentation target is `@parity/product-sdk-react` /
`@parity/product-sdk-vue`; query keys start with `"product-sdk"` instead of `"truapi"`; error
messages are prefixed `product-sdk:`; the `dappName` fallback is `"product-sdk"`; and
`useSigner()` returns the PAPI 3 `Signer` (`CommonSignerTxCreator`) that `SignerManager` builds.
