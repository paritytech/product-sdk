---
tags: [skill-creator]
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I'm building a small contacts screen for a Polkadot product with @parity/product-sdk (paseo, running inside the host). I have a list of dotNS usernames like "alice", "bob.07". For each one I want to show a card: avatar image if they have one, their display name or the username as fallback, and the NFTs they've pinned that they still actually hold. Write me a TypeScript module `contact-card.ts` exporting `loadContactCard(label)` that returns the data the card needs, plus a short note on how I should handle errors and refreshes. Don't scaffold a whole app.
