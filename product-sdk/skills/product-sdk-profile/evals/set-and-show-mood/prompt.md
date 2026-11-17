---
tags: [skill-creator]
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

In my product (TypeScript, @parity/product-sdk, paseo, inside the Polkadot host) a contact card already shows a person's profile from their dotNS name with getProfile. I want to add their mood: show the person's current mood on the card and keep it updated while the card is open, and for the signed-in person let them pick a mood or clear it. Write `mood.ts` with `showMood(profile, onMood)` returning something the card calls when it closes, and `chooseMood(profile, choice)` where choice is a mood or null, and explain what happens the first time a person sets a mood if their profile was published before our product supported moods.
