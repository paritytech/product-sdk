---
"@parity/product-sdk-host": patch
---

Pace the stop the PAPI provider synthesizes when a host follow stream is
interrupted. polkadot-api refollows on a stop at once, so while the host's
chain connection is down every interrupt used to turn into an immediate new
follow, in a tight loop. The synthetic stop now waits 250 ms, doubling to a
4 s cap, and the delay resets when a follow delivers `Initialized`. A genuine
`Stop` item from the host is still forwarded at once. Unfollow and disconnect
cancel a pending stop, and a disconnected provider ignores further requests.
