// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Register the verifiablejs Node.js loader hook.
 *
 * Must be loaded BEFORE the application entry point so the loader
 * intercepts `verifiablejs/bundler` imports from the host-papp SDK.
 *
 * @example
 * ```bash
 * node --import @parity/product-sdk-terminal/register app.js
 * tsx --import @parity/product-sdk-terminal/register app.ts
 * ```
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderPath = join(__dirname, "loader.mjs");

register(pathToFileURL(loaderPath).href, { parentURL: import.meta.url });
