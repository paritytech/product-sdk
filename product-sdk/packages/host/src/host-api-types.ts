/**
 * TypeScript type aliases for `@novasamatech/host-api` permission and resource
 * codecs.
 *
 * The upstream package ships these as runtime SCALE Codecs only — consumers
 * who want a TS type for the request/response shapes either re-declare them
 * inline or reach for `CodecType<typeof X>` directly. This module derives the
 * aliases once via `CodecType` and re-exports them, so schema drift in
 * host-api becomes a TypeScript error at this boundary instead of silently
 * flowing through `as never` casts in consumer code.
 *
 * @module
 */

import type {
    AllocatableResource as AllocatableResourceCodec,
    AllocationOutcome as AllocationOutcomeCodec,
    CodecType,
    RemotePermission as RemotePermissionCodec,
} from "@novasamatech/host-api";

/**
 * Resource the dapp can ask the host to allocate via
 * `hostApi.requestResourceAllocation([...])`.
 *
 * Mirrors `@novasamatech/host-api`'s `AllocatableResource` codec.
 *
 * - `StatementStoreAllowance` — quota for storing statements via the host.
 * - `BulletInAllowance` — quota for posting to the bulletin chain.
 * - `SmartContractAllowance` — budget (in some host-defined unit) for contract
 *   calls signed by the app's product account. The numeric value is the
 *   derivation index of the product account the budget is attached to.
 * - `AutoSigning` — skip per-transaction host prompts after this one.
 */
export type AllocatableResource = CodecType<typeof AllocatableResourceCodec>;

/** Tag-only view of {@link AllocatableResource} for places that just need the variant name. */
export type AllocatableResourceTag = AllocatableResource["tag"];

/**
 * Per-resource outcome returned by `hostApi.requestResourceAllocation`.
 *
 * The response array is aligned positionally with the request array — entry
 * `i` is the outcome for resource `i`. A single rejected entry doesn't fail
 * the whole call; inspect each tag individually.
 *
 * Mirrors `@novasamatech/host-api`'s `AllocationOutcome` codec.
 */
export type AllocationOutcome = CodecType<typeof AllocationOutcomeCodec>;

/** Tag-only view of {@link AllocationOutcome} (`"Allocated" | "Rejected" | "NotAvailable"`). */
export type AllocationOutcomeTag = AllocationOutcome["tag"];

/**
 * Remote permission the dapp can ask the host to grant via
 * `hostApi.permission(...)`.
 *
 * Mirrors `@novasamatech/host-api`'s `RemotePermission` codec.
 */
export type RemotePermission = CodecType<typeof RemotePermissionCodec>;

/** Tag-only view of {@link RemotePermission}. */
export type RemotePermissionTag = RemotePermission["tag"];

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    // These assertions are primarily type-level — the typed const arrays fail
    // to compile if any variant drifts from the upstream codec.

    test("AllocatableResource covers all known tags", () => {
        const cases: AllocatableResource[] = [
            { tag: "StatementStoreAllowance", value: undefined },
            { tag: "BulletInAllowance", value: undefined },
            { tag: "SmartContractAllowance", value: 0 },
            { tag: "AutoSigning", value: undefined },
        ];
        const tags: AllocatableResourceTag[] = cases.map((c) => c.tag);
        expect(tags).toEqual([
            "StatementStoreAllowance",
            "BulletInAllowance",
            "SmartContractAllowance",
            "AutoSigning",
        ]);
    });

    test("AllocationOutcome covers all known tags", () => {
        const cases: AllocationOutcome[] = [
            { tag: "Allocated", value: undefined },
            { tag: "Rejected", value: undefined },
            { tag: "NotAvailable", value: undefined },
        ];
        const tags: AllocationOutcomeTag[] = cases.map((c) => c.tag);
        expect(tags).toEqual(["Allocated", "Rejected", "NotAvailable"]);
    });

    test("RemotePermission covers all known tags", () => {
        const cases: RemotePermission[] = [
            { tag: "Remote", value: ["app.example"] },
            { tag: "WebRTC", value: undefined },
            { tag: "ChainSubmit", value: undefined },
            { tag: "PreimageSubmit", value: undefined },
            { tag: "StatementSubmit", value: undefined },
        ];
        const tags: RemotePermissionTag[] = cases.map((c) => c.tag);
        expect(tags).toEqual([
            "Remote",
            "WebRTC",
            "ChainSubmit",
            "PreimageSubmit",
            "StatementSubmit",
        ]);
    });
}
