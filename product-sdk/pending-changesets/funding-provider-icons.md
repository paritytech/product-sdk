---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
---

Funding providers ship their network and token icons in their product archive, at `funding/icons/networks/<network>.png` and `funding/icons/tokens/<token>.png` (lowercase, `[a-z0-9-]`; square 96×96 PNG, transparent background). The hosts read them from there and show a monogram for a missing one. `@parity/product-sdk-host/funding-provider` gains `fundingNetworkIconPath`, `fundingTokenIconPath`, `FUNDING_ICONS_DIR` and `FUNDING_ICON_SIZE`.
