---
type: llm
focus: trace
weight: 1
---

The patch given to rewriteProfileRecord sets `name` and `nfts`, leaves `avatar` undefined rather than null so the existing avatar is carried, and puts the mood feed from deriveMoodFeed in `feeds`
