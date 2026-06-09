---
"@parity/product-sdk-cloud-storage": patch
---

**`checkAuthorization` no longer logs at `error` level before throwing.**

`checkAuthorization` previously emitted `log.error("checkAuthorization: query failed", …)` from its catch block before throwing `CloudStorageAuthorizationError`. That doubled the failure report: once to the logger (stderr by default) and once as the thrown error. Callers handling the throw — e.g. a pre-flight quota check wrapped in `.catch(() => null)` — still got a scary stderr line they had no way to suppress.

The thrown `CloudStorageAuthorizationError` already carries the `address` and the underlying error as `cause`, so the log line was strictly redundant. Removed. Callers that want a log on the failure path can attach their own handler — the SDK now stays quiet on a throw, matching the convention used by the rest of the cloud-storage error paths.

Added a regression test asserting that no `cloudStorage`-namespace error-level entry is emitted on the query-failure path.
