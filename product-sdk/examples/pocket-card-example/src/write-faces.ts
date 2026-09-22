// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Writes the static faces the host's approval sheet draws.
 *
 * The sheet shows a card before it is added, when no worker is running to draw
 * one, so the face has to exist as a file in the worker archive. These come from
 * the same module the worker renders live.
 *
 * Each face is checked before it is written. A face that reaches the archive
 * broken is only found by looking at a phone.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { androidLimits, assertFaceValid } from "@parity/product-sdk-renderer";

import { loyaltyFace, PREVIEW_STATES } from "./face.js";

const outDir = new URL("../dist/pocket/", import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const [name, state] of Object.entries(PREVIEW_STATES)) {
    const json = `${JSON.stringify(loyaltyFace(state), null, 2)}\n`;

    // The text is what the host reads and measures, so that is what is checked.
    // Indented JSON is larger than the compact form the tree alone would measure.
    assertFaceValid(json, { host: androidLimits });

    writeFileSync(new URL(`${name}.json`, outDir), json);
    console.log(`wrote pocket/${name}.json`);
}
