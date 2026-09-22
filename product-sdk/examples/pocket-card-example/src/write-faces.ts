// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Writes the static faces the host's approval sheet draws, and checks that the
 * manifest still agrees with this module.
 *
 * The sheet shows a card before it is added, when no worker is running to draw
 * one, so the face has to exist as a file in the worker archive. These come from
 * the same module the worker renders live.
 *
 * Each face is checked before it is written. A face that reaches the archive
 * broken is only found by looking at a phone.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

import { androidLimits, assertFaceValid } from "@parity/product-sdk-renderer";

import { CARD_ID, loyaltyFace, PREVIEW_STATES } from "./face.js";

interface WorkerManifest {
    entrypoint: string;
    pocket?: { cards: { id: string; title: string; preview: string }[] };
}

const manifest: WorkerManifest = JSON.parse(
    readFileSync(new URL("../manifest/worker.json", import.meta.url), "utf8"),
);

/**
 * The manifest and this module name the same card and the same files, in two
 * places that nothing otherwise ties together.
 *
 * Renaming one and not the other leaves every build and test green while the
 * shipped card is broken: the approval sheet points at a file nobody wrote, or
 * the card keeps its static face with nothing on the device saying why.
 */
function checkManifestAgrees(): void {
    const cards = manifest.pocket?.cards ?? [];
    const problems: string[] = [];

    if (cards.length === 0) problems.push("the manifest declares no pocket cards");

    for (const card of cards) {
        if (card.id !== CARD_ID) {
            problems.push(`the manifest declares card '${card.id}', but face.ts names '${CARD_ID}'`);
        }
        const state = card.preview.replace(/^pocket\//, "").replace(/\.json$/, "");
        if (!Object.hasOwn(PREVIEW_STATES, state)) {
            problems.push(
                `the manifest's preview '${card.preview}' names no state that face.ts writes ` +
                    `(${Object.keys(PREVIEW_STATES).join(", ")})`,
            );
        }
    }

    if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        process.exit(1);
    }
}

checkManifestAgrees();

const outDir = new URL("../dist/pocket/", import.meta.url);
mkdirSync(outDir, { recursive: true });

for (const [name, state] of Object.entries(PREVIEW_STATES)) {
    const json = `${JSON.stringify(loyaltyFace(state), null, 2)}\n`;

    // The text is what the host reads and measures, so that is what is checked.
    // Indented JSON is about three times the compact form the tree alone would
    // measure.
    assertFaceValid(json, { host: androidLimits });

    writeFileSync(new URL(`${name}.json`, outDir), json);
    console.log(`wrote pocket/${name}.json`);
}

console.log(`manifest entrypoint is ${manifest.entrypoint}, card is ${CARD_ID}`);
