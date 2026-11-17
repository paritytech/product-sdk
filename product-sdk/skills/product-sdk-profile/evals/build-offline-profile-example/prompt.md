---
tags: [skill-creator]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I'm in the product-sdk monorepo at /Users/cbh/product-sdk. Add a new Node example at product-sdk/examples/profile-example that mirrors product-sdk/examples/reputation-example: offline, no wallet, no chain, built with the fake contract runtime from @parity/product-sdk-contracts/testing and a hand-rolled preimage manager, with a `pnpm demo` script and a README. It should walk the whole public-profile publish recipe for a dotNS name: read the live record, upload an avatar, rewrite the record with a display name and the avatar, prepare the setText call, do the re-read check, and verify. Use the @parity/product-sdk/profile subpath. It must typecheck and run with `pnpm --filter @parity/product-sdk-profile-example demo` from product-sdk/. Don't commit anything.
