---
"@parity/product-sdk-host": patch
---

**A chain connection no longer loops on follows the node refuses, or that a broken client abandons** (#543).

- **One follow per connection.** A second `chainHead_v1_follow` on a provider connection means its polkadot-api client abandoned the follow it had without unfollowing it, which polkadot-api's observable client does once its pinned blocks break. The old follow is released at the host and nothing more is sent for it: a stop would make the abandoned follower follow again, and error answers can reach a retry polkadot-api shares with the live follower. The follow replacing it waits 250 ms, doubling to 4 s, so a broken client cannot open a follow per read. A raw substrate-client holding two follows on one connection is not supported.
- **Every refollow is paced.** `Initialized` alone no longer shows the host is steady: a follow does once a read on it succeeds, or once it has stayed up 10 s. Until then a Stop from the host is paced like an interrupt instead of forwarded at once, and the backoff keeps growing.
- **Refused follows back off further.** A follow that ends before any event, and not because the host link was lost, is how a node refusing follows (`-32800`) reaches a product, and also how a chain socket being redialled looks. After 8 in a row, about 20 s, the wait grows past 4 s up to 30 s. A lost host link still waits at most 4 s, and the first follow the node accepts brings the cap back to 4 s.
- **A loop costs a bounded number of warn lines.** The first interrupt and restart of a run stay warn lines, the rest are debug, with at most one warn summary a minute while the run lasts, and one line once a follow is steady again.
