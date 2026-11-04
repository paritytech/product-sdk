---
type: llm
focus: trace
weight: 1
---

A failed read (an err from readMood, or a Host/Timeout error) is treated as unknown and the previous mood is kept, not as no mood; only ok(null) clears the display
