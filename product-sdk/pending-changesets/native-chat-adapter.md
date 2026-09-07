---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

Add a native-backend chat adapter so chat products keep working on the legacy
native container during the truapi transition. `getChatManager()` now prefers
the truapi host and, when there is no truapi host, falls back to the native
backend when `isNativeChatHost()` detects it. The novasama wrapper is loaded via
a dynamic `import()` so truapi-only products never bundle it.
