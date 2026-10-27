---
"@parity/product-sdk-host": patch
"@parity/product-sdk": patch
---

A follow whose host connection dies while it is still starting now reports that loss, so PAPI refollows. The interrupt is held until the caller registers for it and is delivered exactly once, and the follow is recorded before that registration so the replay is not read as belonging to a superseded follow. Without this the product kept a follow id the host had already dropped, and every chain read bound to it failed until the product was restarted.
