---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

Remove the legacy novasama native-chat backend from `getChatManager()`. The `@parity/product-sdk-host` chat path now resolves only through the truapi host; the fallback that loaded `@novasamatech/host-api-wrapper` when running inside the legacy iOS `__container__` WebView is gone, along with the dependency. `getChatManager()` returns `null` on a host with no truapi client instead of bridging to the native backend. Products running under a truapi host are unaffected (that branch was never reached there).
