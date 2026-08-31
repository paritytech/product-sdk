---
"@parity/product-sdk": minor
---

**Remove `localStorage.clear()` — it was a silent no-op in a host container.**

`createApp().localStorage.clear()` resolved successfully but did nothing in production (only logging at debug), while the `createFakeApp` test fake actually emptied — so a test asserting `clear()` wipes storage passed against code that no-ops for real users (#344).

It can't be implemented: the host localStorage protocol exposes no key enumeration — only per-key `read` / `write` / `clear(key)` (a single-key remove) through `@parity/truapi` → `HostLocalStorage` → `LocalKvStore` — so there is nothing to iterate for a clear-all. Rather than keep a method that lies (or one that always throws), `clear()` is removed from `LocalStorageApi` and from the fake; the two now build through one shared `createLocalStorageApi` adapter, so they can no longer drift.

**Migration.** Use `remove(key)` — supported at every layer — to delete keys individually. There is no clear-all; if you need one, track the keys your app writes and remove them.

**Breaking for callers.** `app.localStorage.clear()` no longer exists: an untyped call throws `TypeError: app.localStorage.clear is not a function` where it used to resolve.

**Breaking for implementors.** `clear` is gone from the exported `LocalStorageApi` interface, so anyone writing one inline — for example the `localStorage` override passed to `createFakeApp` — must delete their `clear` to keep compiling.
