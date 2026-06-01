// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Pure formatters that map the `LoginStatus` / `LogoutStatus` streams to
 * one-line terminal messages. No I/O, no terminal deps — `import type` only,
 * so this module stays unit-testable without the SSO stack.
 */
import type { LoginStatus, LogoutStatus } from "../auth.js";

export function renderLoginStatus(status: LoginStatus): string {
    switch (status.step) {
        case "waiting":
            return "Waiting for you to scan the QR code with your phone…";
        case "paired":
            return "Paired — finishing sign-in…";
        case "pending":
            return `Working: ${status.stage}…`;
        case "success":
            return `Signed in as ${status.address}`;
        case "error":
            return `Sign-in failed: ${status.message}`;
    }
}

export function renderLogoutStatus(status: LogoutStatus): string {
    switch (status.step) {
        case "disconnecting":
            return `Signing out ${status.address}…`;
        case "success":
            return `Signed out ${status.address}`;
        case "partial":
            return `Signed out locally (${status.address}); the phone was not notified: ${status.reason}`;
        case "error":
            return `Sign-out error: ${status.message}`;
    }
}
