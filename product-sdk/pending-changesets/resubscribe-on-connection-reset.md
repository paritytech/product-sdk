---
"@parity/product-sdk-host": patch
"@parity/product-sdk": patch
---

Chat and Pocket streams survive a host connection reset in native hosts, where the container reconnects to the host after the connection drops. The chat action stream, the renderer action streams for chat messages and Pocket cards, and the chat room and Pocket card lists are opened again once the host is connected again, and their listeners are not interrupted. The host holds actions while no stream is open, so presses and messages sent during the reset still arrive. Before this, a reset interrupted the chat action stream and both lists, left buttons in chat messages unresponsive until a message was rendered again, and left buttons in Pocket cards unresponsive until the product restarted. In a sandbox-hosted product, a closed connection still ends these streams and reaches `onInterrupt`. A Pocket card that subscribes after its action stream ended for another reason also opens it again.
