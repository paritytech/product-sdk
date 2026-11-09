---
tags: [skill-creator]
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

In my product (TypeScript, @parity/product-sdk, paseo, inside the Polkadot host) a signed-in person already has their identity account's address and a signer from the host accounts provider. I want a "save profile" function: they type a display name and we publish that to their dotNS name without touching their existing avatar. Write `saveProfile({ label, displayName, owner, signer })` and tell me what can go wrong at each step. I don't want to change their avatar.
