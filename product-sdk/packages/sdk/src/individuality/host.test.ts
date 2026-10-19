// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import * as umbrella from "./host.js";

describe("@parity/product-sdk/individuality/host", () => {
    it("reaches the game-registration capabilities without a second dependency", () => {
        expect(typeof umbrella.hostGameRegistrationCapabilities).toBe("function");
        expect(typeof umbrella.hostPersonhoodProver).toBe("function");
        expect(typeof umbrella.hostSubmitSignUp).toBe("function");
    });
});
