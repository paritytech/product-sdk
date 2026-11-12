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

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createAuthClient } from "./auth.js";
import type { AuthConfig } from "./types.js";

const config: AuthConfig = {
    dappId: "test-app",
    productId: "test.dot",
    derivationIndex: 0,
};

describe("createAuthClient", () => {
    test("returns the bound auth surface (all functions)", () => {
        const client = createAuthClient(config);
        for (const fn of [
            "connect",
            "waitForLogin",
            "getSessionSigner",
            "findSession",
            "waitForLogout",
            "requestAllocation",
            "clearLocalAppStorage",
        ] as const) {
            expect(typeof client[fn]).toBe("function");
        }
    });

    test("clearLocalAppStorage returns (no throw) when the dir does not exist", async () => {
        const client = createAuthClient(config);
        await expect(
            client.clearLocalAppStorage("/nonexistent/dir/should-not-exist-xyz"),
        ).resolves.toBeUndefined();
    });

    // A CLI may point storageDir at its own config folder, so logout must
    // remove only the session it stored there.
    test("clearLocalAppStorage removes the session and old session files and nothing else", async () => {
        const root = await mkdtemp(join(tmpdir(), "auth-clear-"));
        try {
            const storageDir = join(root, "my-cli");
            for (const dir of ["core", "product", "plugins"]) {
                await mkdir(join(storageDir, dir), { recursive: true });
                await writeFile(join(storageDir, dir, "f"), "x");
            }
            await writeFile(join(storageDir, "config.json"), "{}");
            await writeFile(join(root, "test-app_SsoSessions.json"), "x");
            await writeFile(join(root, "other-app_SsoSessions.json"), "x");

            await createAuthClient({ ...config, storageDir }).clearLocalAppStorage(root);

            expect({
                storageDir: (await readdir(storageDir)).sort(),
                root: (await readdir(root)).sort(),
            }).toEqual({
                storageDir: ["config.json", "plugins"],
                root: ["my-cli", "other-app_SsoSessions.json"],
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
