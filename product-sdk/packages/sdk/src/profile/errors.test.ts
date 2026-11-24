// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import { ProfileError } from "./errors.js";

describe("ProfileError", () => {
    test("implements the SdkError marker, with its reason and cause", () => {
        const cause = new Error("boom");
        const error = new ProfileError("Host", "the host did not answer", { cause });
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
            name: "ProfileError",
            isSdkError: true,
            source: "profile",
            reason: "Host",
            cause,
        });
    });
});
