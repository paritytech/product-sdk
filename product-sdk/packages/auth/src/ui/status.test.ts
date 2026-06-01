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

import { describe, expect, test } from "vitest";
import { renderLoginStatus, renderLogoutStatus } from "./status.js";

describe("renderLoginStatus", () => {
    test("waiting", () => {
        expect(renderLoginStatus({ step: "waiting" })).toMatch(/scan/i);
    });
    test("paired", () => {
        expect(renderLoginStatus({ step: "paired" })).toMatch(/finishing/i);
    });
    test("pending surfaces the stage", () => {
        expect(renderLoginStatus({ step: "pending", stage: "attestation" })).toContain("attestation");
    });
    test("success surfaces the address", () => {
        expect(
            renderLoginStatus({
                step: "success",
                address: "5Fy2sypq",
                addresses: { rootAddress: "r", productAddress: "5Fy2sypq", productH160: "0xabc" },
            }),
        ).toContain("5Fy2sypq");
    });
    test("error surfaces the message", () => {
        expect(renderLoginStatus({ step: "error", message: "boom" })).toContain("boom");
    });
});

describe("renderLogoutStatus", () => {
    test("disconnecting", () => {
        expect(renderLogoutStatus({ step: "disconnecting", address: "5X" })).toContain("5X");
    });
    test("success", () => {
        expect(renderLogoutStatus({ step: "success", address: "5X" })).toMatch(/signed out/i);
    });
    test("partial surfaces the reason", () => {
        expect(
            renderLogoutStatus({ step: "partial", address: "5X", reason: "ws down" }),
        ).toContain("ws down");
    });
    test("error surfaces the message", () => {
        expect(renderLogoutStatus({ step: "error", message: "nope" })).toContain("nope");
    });
});
