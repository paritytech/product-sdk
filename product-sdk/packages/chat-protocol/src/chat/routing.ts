// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChatContent } from "../wire/chatMessage.js";

/** Control content that is stored but not shown (tokens, device events, call candidates). */
export const INTERNAL_CONTENT = new Set<ChatContent["tag"]>([
    "Token",
    "DataChannelAnswer",
    "DataChannelIceCandidate",
    "DataChannelClosed",
    "DeviceAdded",
    "DeviceRemoved",
    "CompactionCommit",
]);

/** Contents that travel on the identity lane (Android routing). */
export const IDENTITY_LANE_CONTENT = new Set<ChatContent["tag"]>(["DeviceChatAccepted"]);
