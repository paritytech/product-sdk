---
"@parity/product-sdk-host": patch
"@parity/product-sdk": patch
---

Chain reads made while the host link drops no longer fail with `unknown follow subscription id` or `TrUAPI host connection interrupted`. The host-routed PAPI provider holds a read whose follow has ended until polkadot-api has seen the stop, and polkadot-api then sends it again on its new follow. A read answered with a lost follow now also starts that stop, so a follow the host has dropped recovers without a reload. When the host keeps losing each new follow, the read waits while the provider follows again more slowly, up to once every 4 s.
