/**
 * pvm-contracts-example — load a cargo-pvm-contract ABI artifact and wire it
 * into @parity/product-sdk-contracts without going through CDM.
 *
 * What this demonstrates:
 *   1. parsePvmContractAbi   — for ABIs already loaded in memory (browser-safe).
 *   2. loadPvmContractAbi    — async filesystem read (Node-only).
 *   3. Passing the parsed ABI into createContractFromClient to get a fully
 *      working contract handle with .query() / .tx() per ABI method.
 *
 * The fixture under fixtures/ mirrors what `cargo pvm-contract build` writes to
 *     target/<name>.release.abi.json
 *
 * To run end-to-end against a live Asset Hub deployment, replace the constants
 * marked TODO below with your contract address and a live RPC URL, then:
 *
 *     pnpm demo
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
    loadPvmContractAbi,
    parsePvmContractAbi,
    type PvmContractArtifacts,
} from "@parity/product-sdk-contracts/pvm";

// Re-import for the type — kept separate so this file documents both paths.
import abiInline from "../fixtures/counter.release.abi.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
    // ── 1. In-memory parse (browser-safe) ──────────────────────────────
    // Use parsePvmContractAbi() when the ABI is bundled, fetched, or
    // already loaded as JSON. Returns AbiEntry[] ready to hand to
    // createContract / createContractFromClient.
    const abiFromMemory = parsePvmContractAbi(abiInline);
    console.log(`[in-memory] parsed ABI: ${abiFromMemory.length} entries`);
    for (const entry of abiFromMemory) {
        if (entry.type === "function") {
            const args = entry.inputs.map((i) => `${i.name}: ${i.type}`).join(", ");
            console.log(`  fn ${entry.name}(${args})`);
        }
    }

    // ── 2. Filesystem load (Node-only) ─────────────────────────────────
    // Use loadPvmContractAbi() when reading directly from a cargo-pvm-contract
    // build output. The filesystem helpers lazy-import 'node:fs/promises' so
    // this module remains importable in browser bundles — only the call site
    // needs to be in Node.
    const abiPath = join(__dirname, "..", "fixtures", "counter.release.abi.json");
    const abiFromDisk = await loadPvmContractAbi(abiPath);
    console.log(`\n[from disk] parsed ABI: ${abiFromDisk.length} entries — match=${
        JSON.stringify(abiFromDisk) === JSON.stringify(abiFromMemory)
    }`);

    // ── 3. (Optional) full artifact pair ───────────────────────────────
    // loadPvmContractArtifacts(base) reads both <base>.abi.json and
    // <base>.polkavm into { abi, bytecode } — useful when you want to deploy
    // the bytecode directly via pallet-revive's instantiate_with_code.
    //
    // Skipped here because the fixture only has the ABI side. The full call
    // would be:
    //
    //     const artifacts: PvmContractArtifacts = await loadPvmContractArtifacts(
    //         join(__dirname, "..", "fixtures", "counter.release"),
    //     );
    //     console.log(`bytecode bytes: ${artifacts.bytecode.length}`);
    //
    // Reference for a future deploy() helper.
    void (null as unknown as PvmContractArtifacts);

    // ── 4. Wiring into a contract handle ───────────────────────────────
    // Once you have AbiEntry[] and a deployed address, createContractFromClient
    // gives you a typed handle with .query() / .tx() per method:
    //
    //     import { createClient } from "polkadot-api";
    //     import { getWsProvider } from "polkadot-api/ws";
    //     import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
    //     import {
    //         createContractFromClient,
    //         createContractRuntime,
    //         ensureContractAccountMapped,
    //     } from "@parity/product-sdk-contracts";
    //
    //     const client = createClient(getWsProvider("wss://asset-hub-paseo-rpc.dwellir.com"));
    //
    //     // One-time per signing account: register the SS58 → H160 mapping
    //     // that pallet-revive requires for the .tx() path. Idempotent — safe
    //     // to call on every app start.
    //     const runtime = createContractRuntime(client.getTypedApi(paseo_asset_hub));
    //     await ensureContractAccountMapped(runtime, signerAddress, signer);
    //
    //     const counter = createContractFromClient(
    //         client,
    //         paseo_asset_hub,                          // descriptor
    //         "0xC472..." as `0x${string}`,             // TODO: deployed address
    //         abiFromDisk,
    //     );
    //
    //     const { value } = await counter.get.query();
    //     console.log("counter value:", value);
    //     // await counter.increment.tx(1, { signer });  // needs a mapped signer
    //
    // We don't run this here because it requires a live deployment. The point
    // of this example is the loader path; the rest is identical to the
    // existing contracts-demo.
    console.log(
        "\nNext step: pass `abiFromDisk` plus a deployed address into",
        "`createContractFromClient(client, paseo_asset_hub, address, abiFromDisk)` to interact.",
    );
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
