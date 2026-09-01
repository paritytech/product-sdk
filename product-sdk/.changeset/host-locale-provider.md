---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Add `getLocaleProvider` for the host's selected language.**

A product can now render in the language the user picked inside the host, rather than
inferring one from `navigator.language` — which reports the operating system's preference
and is wrong whenever the two differ.

```ts
import { getLocaleProvider } from "@parity/product-sdk-host";

const provider = await getLocaleProvider();
const sub = provider?.subscribeLocale((locale) => {
  i18n.activate(SUPPORTED.has(locale.languageTag) ? locale.languageTag : "en");
});
```

`subscribeLocale` fires with the current locale and again on every change; the returned
`HostSubscription` carries `unsubscribe` and `onInterrupt`. `getLocaleProvider` resolves to
`null` outside a host container.

`languageTag` is a BCP 47 tag such as `"en"`, `"pt-BR"` or `"zh-Hans"`. The set is open — a
host adds languages without an SDK release — so a product that ships no catalog entry for
the tag it receives picks its own fallback.

The `locale` domain arrived in `@parity/truapi` 0.12.0, already on the catalog.
