---
"@parity/product-sdk-host": patch
"@parity/product-sdk": patch
---

**The host package logs at warn when its link to the host drops and when it comes back, names each host call that a reset of the link rejected, and follows the life of each PAPI chainHead follow subscription.**

- `[host] host link lost`
- `[host] host link back after <ms> ms`
- `[host] <call>: the host link was reset mid-call (<close reason>)`
- `[host:papi] chainHead follow <id> interrupted (<cause>): up <ms> ms, <n> events, the last <ms> ms ago, <n> operations in flight, stop in <ms> ms`
- `[host:papi] chainHead follow <id> stopped by the host: up <ms> ms, <n> events, the last <ms> ms ago, <n> operations in flight`
- `[host:papi] chainHead follow <id> restarted <ms> ms after the stop`
- `[host:papi] chainHead follow <id> unfollowed: up <ms> ms, <n> events, the last <ms> ms ago, <n> operations in flight`

The first follow of a provider logs `chainHead follow <id> started` at info.
