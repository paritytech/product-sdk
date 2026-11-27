---
"@parity/product-sdk-host": patch
---

**A chain connection no longer loops on follows the node refuses, or that a broken client abandons** (#543).

- **One follow per connection.** A second `chainHead_v1_follow` on a provider connection means its polkadot-api client abandoned the follow it had without unfollowing it, which polkadot-api 0.19 does once its pinned blocks break. The old follow is released at the host and nothing more is sent for it: no stop, which would make the abandoned follower follow again, and no error answers, which reach a retry polkadot-api shares with the live follower. A follow that replaces one is paced, 250 ms doubling to 4 s, so a broken client cannot open a follow per read.
- **Refused follows back off further.** A follow that ends before any event, and not because the host link was lost, is how a node refusing follows (`-32800`) reaches a product. Those back off past 4 s, up to 30 s, and the first follow the node accepts brings the cap back to 4 s. A Stop from the host on a follow that never initialized is paced like an interrupt instead of forwarded at once.
- **A loop costs a bounded number of warn lines.** The first interrupt and restart of a run stay warn lines, the rest are debug, and the connection writes one warn summary a minute while the run lasts, then one line when a follow is steady again.
