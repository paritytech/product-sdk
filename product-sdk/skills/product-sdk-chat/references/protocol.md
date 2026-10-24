# The person-to-person protocol (`@parity/product-sdk-chat-protocol`)

Experimental. The protocol the iOS and Android apps and the person chat product run over the statement store
(chat-spec `base-spec.md`): codecs, derivations, lanes, the session state machine (`transition`, pure) and runtime
(`CommunicationSession`), `TopicSubscriptions`, `ContactSession`, chat requests, HOP compaction, push payloads, and
the call relay (`callMessagesOf`, `hostSignalOf`).

| Subpath | What |
| --- | --- |
| `.` | everything above, behind ports: `StatementsPort`, `StatementProver`, `DirectoryPort`, `ChatKeysPort`, `HopPort`, `PushPort`, `DeliveryPort` |
| `./host` | `hostStatementsPort(client)`, `heldStatements(port, hold)`, `hostDirectory(reader)`, `statementToHost`, `statementFromHost` |
| `./rooms` | `contentBody`, `attachmentItem`, `attachmentOf`, `CallFacts`, `addCallFact`, `callOfferOf` |
| `./keys` | `selfCustodiedChatKeys`, `keypairProver` (an identity of the product's own) |
| `./testing` | `StandInStatementStore` (admission rules, faults), `StandInHop`, `LocalProver`, `testIdentity`, `StandInDirectory`, `StandInChatKeys`, `StandInDelivery`, `StandInPush`, `PROTOCOL_VECTORS`, `checkVectors()` |

Rules:

- Build codecs that nest this package's codecs from its re-exported `scale-ts` combinators (`Struct`, `Enum`,
  `Vector`, ...). A codec of another `scale-ts` copy does not take the outer decoder's read position and fails with
  "Out of bounds access".
- Frames decode strictly (`decodeStrict`), chat content leniently (`decodeLenient`, trailing bytes ignored as Android
  does); an unknown content variant becomes `Unsupported` with its raw bytes kept for a later re-parse.
- A third-party identity's chat key is not on Asset Hub: its peers learn it from the product, and it cannot reach
  native person chat users.
- Import crypto from `@parity/product-sdk-crypto` subpaths (`/x25519`, `/chacha`, ...) in a worker, never the barrel,
  which reaches tweetnacl's Node `require("crypto")`.
