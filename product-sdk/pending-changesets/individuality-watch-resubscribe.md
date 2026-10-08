---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

`watchCurrentGame`, `watchPlayer` and `watchParticipant` now subscribe again
after a failed subscription instead of ending. PAPI ends a `watchValue` on its
first failed query, so one lost or failed host answer used to silence the watch
for good. The failure still goes to `onError`, and the watch subscribes again
after a wait that doubles from one second to thirty and drops back to one second
once a value arrives. A value that matches the last one delivered is not
delivered again after the watch resubscribes.
