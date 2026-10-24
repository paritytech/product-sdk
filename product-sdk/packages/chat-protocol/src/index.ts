// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-chat-protocol — the person-to-person chat protocol of the
 * Polkadot apps, over the statement store.
 *
 * This is the protocol the iOS and Android apps and the person chat product run
 * (`vendor/chat-spec/base-spec.md`): the SCALE codecs of statements, frames,
 * messages, chat requests and push payloads; the key and topic derivations; the
 * pairwise and multi-device session lanes; the session state machine and its
 * runtime; chat requests; HOP compaction (chat-spec RFC 0002); and the call
 * signalling that carries a host call engine's signals as native messages.
 *
 * Everything that reaches the network goes through ports (`StatementsPort`,
 * `StatementProver`, `HopPort`, `DirectoryPort`, `ChatKeysPort`, ...): the
 * `./host` subpath implements them over the host, `./keys` gives a product its
 * own chat identity (experimental), `./rooms` maps the protocol's contents onto
 * Chat Extension v2 bodies, and `./testing` holds stand-ins and the spec's
 * vectors.
 *
 * The person chat's application layer (contacts, chat requests, devices, pushes)
 * stays in the person chat product: it is bound to identities whose chat keys
 * are on chain.
 *
 * @packageDocumentation
 */
export * from "./bytes.js";
export * from "./ports.js";
export * from "./crypto/primitives.js";
export * from "./crypto/derivations.js";
export * from "./crypto/twox.js";
export * from "./wire/scale.js";
export * from "./wire/statement.js";
export * from "./wire/statementData.js";
export * from "./wire/chatMessage.js";
export * from "./wire/chatRequest.js";
export * from "./wire/notification.js";
export * from "./wire/hop.js";
export * from "./wire/call.js";
export * from "./wire/sync.js";
export * from "./transport/statements.js";
export * from "./transport/lanes.js";
export * from "./transport/sessionState.js";
export * from "./transport/session.js";
export * from "./chat/ports.js";
export * from "./chat/contactSession.js";
export * from "./chat/requests.js";
export * from "./chat/directory.js";
export * from "./chat/accountNames.js";
export * from "./chat/hopCompactor.js";
export * from "./chat/routing.js";
export * from "./calls/sdp.js";
export * from "./calls/relay.js";
