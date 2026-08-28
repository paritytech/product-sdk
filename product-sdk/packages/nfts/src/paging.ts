// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Paging by index window, shared by every paged read here.
 *
 * All three of them walk a sequential `u32` index space whose entries can have
 * permanent gaps, which is what makes one helper enough:
 *
 * ```
 * getCollections            collection ids   gaps = deleted collections
 * getClaimableCollections   collection ids   gaps = unregistered collections
 * getCollectionItems        item indices     gaps = deleted item definitions
 * ```
 *
 * The runtime guarantees the shape in every case. Ids and indices are allocated
 * from a counter that only moves forward, and both `delete_collection` and
 * `delete_item` document that identifiers are **never reused**. So a window is a
 * page: it cannot shift or repeat while the chain is written to, because new
 * entries only ever appear past the end.
 */

/** What one filled window yields. */
export interface FilledWindow<T> {
    /** The entries the window found, ascending, at most `limit` of them. */
    kept: Array<{ id: number; value: T }>;
    /** The exclusive end of the index space this window walked. */
    ceiling: number;
    /** Where a next page resumes, or `null` at the end of the space. */
    nextId: number | null;
}

/**
 * How many ids a page may scan per collection it was asked for.
 *
 * A page fills itself by walking the id space, so a range that holds few of what
 * it is looking for could in principle read a lot of ids to find a few. This
 * bounds that: at `limit * SCAN_BUDGET_FACTOR` ids the page returns what it has
 * and reports where to resume, rather than reading on.
 *
 * What "few" means differs by read. For {@link getCollections} it is deleted
 * collections, which are rare — `delete_collection` requires the collection to be
 * emptied first — so the budget is a safety net. For
 * {@link getClaimableCollections} it is unregistered collections, which are
 * structural: a page fills only while roughly one collection in
 * `SCAN_BUDGET_FACTOR` is registered, and below that the page comes back short.
 * That is the right way round: a registry that sparse is small, so following
 * `nextId` through the short pages still reads all of it in a few round trips.
 */
export const SCAN_BUDGET_FACTOR = 16;

/**
 * How many entries a read returns when the caller does not say.
 *
 * Every read here is bounded. Nothing on chain caps how many collections exist
 * or how many items a collection holds — the pallet's only ceilings are
 * index-space exhaustion, and the indices are `u32` — so a read whose default is
 * "everything" is a read that works until a deployment grows and then breaks a
 * browser tab. A default page is the safe end of that trade: a caller who wants
 * everything follows the cursor and gets it, in bounded pieces.
 */
export const DEFAULT_PAGE_LIMIT = 100;

/**
 * The largest page a read will return, whatever was asked for.
 *
 * A page reads its window by exact key, so `limit` decides how many keys go into
 * one request — and a limit of a million would put a million keys in it. Asking
 * for more than this clamps rather than fails: the cursor still reports where the
 * page stopped, so following it is correct either way.
 */
export const MAX_PAGE_LIMIT = 1000;

/**
 * Normalise the paging options a read was given.
 *
 * `NaN` falls back to the default rather than being clamped, because it survives
 * both clamps: the page would come back empty with `nextId: null`, which a caller
 * cannot tell apart from a chain that holds nothing. `Number(param)` is `NaN` for
 * a missing or malformed query parameter, so this is reachable from ordinary
 * caller code. `Infinity` is left to clamp — asking for more than
 * {@link MAX_PAGE_LIMIT} is documented to clamp rather than fail.
 */
export function pageBounds(options: { limit?: number; fromId?: number }): {
    limit: number;
    fromId: number;
} {
    const asked = usable(options.limit) ?? DEFAULT_PAGE_LIMIT;
    const from = usable(options.fromId) ?? 0;
    return {
        limit: Math.min(Math.max(0, Math.trunc(asked)), MAX_PAGE_LIMIT),
        fromId: Math.max(0, Math.trunc(from)),
    };
}

/** A bound the clamps can act on, or `undefined` to take the default. */
function usable(bound: number | undefined): number | undefined {
    return bound === undefined || Number.isNaN(bound) ? undefined : bound;
}

/**
 * Walk the id space from `fromId` until `limit` ids that `probe` accepts are in
 * hand, and say where to resume.
 *
 * Shared by both paged reads, which differ only in what makes an id interesting:
 * a `Scarcity.Collections` record for {@link getCollections}, a
 * `NftClaims.CollectionMinters` entry for {@link getClaimableCollections}. Both
 * maps are keyed by collection id, and ids are allocated sequentially and never
 * reused, so a window is a page for either.
 *
 * The ceiling read does not gate the first window: an id past the end of the
 * space simply has nothing there, so asking for it is harmless, and asking
 * concurrently saves a sequential hop on every page.
 */
export async function fillByIdWindow<T>(
    fromId: number,
    limit: number,
    ceiling: Promise<number>,
    probe: (ids: number[]) => Promise<Array<T | undefined>>,
): Promise<FilledWindow<T>> {
    const ids = (from: number, to: number) =>
        Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

    const firstIds = ids(fromId, fromId + limit);
    const [idCeiling, firstProbe] = await Promise.all([ceiling, probe(firstIds)]);

    const scanCeiling = Math.min(idCeiling, fromId + limit * SCAN_BUDGET_FACTOR);
    const kept: Array<{ id: number; value: T }> = [];

    /** Take what a window yields, and report where to resume from. */
    const consume = (window: number[], found: Array<T | undefined>, windowEnd: number): number => {
        for (const [index, id] of window.entries()) {
            const value = found[index];
            if (value === undefined) continue;
            if (kept.length === limit) {
                // Filled mid-window. Resume from this id rather than from the
                // end of the window, so nothing scanned here is skipped.
                return id;
            }
            kept.push({ id, value });
        }
        return windowEnd;
    };

    let cursor = Math.min(consume(firstIds, firstProbe, fromId + limit), Math.max(idCeiling, 0));

    // Only while short. On a dense id space this never runs.
    while (kept.length < limit && cursor < scanCeiling) {
        const want = limit - kept.length;
        const scanned = cursor - fromId;
        // Widen by the density seen so far, so a sparse range converges in a
        // couple of reads rather than one read per gap.
        const density = Math.max(kept.length / Math.max(scanned, 1), 1 / SCAN_BUDGET_FACTOR);
        const width = Math.min(Math.ceil(want / density), want * SCAN_BUDGET_FACTOR);
        const end = Math.min(cursor + width, scanCeiling);
        const window = ids(cursor, end);
        cursor = consume(window, await probe(window), end);
    }

    return { kept, ceiling: idCeiling, nextId: cursor < idCeiling ? cursor : null };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    describe("pageBounds", () => {
        test("an omitted limit is the default page, not everything", () => {
            expect(pageBounds({})).toEqual({ limit: DEFAULT_PAGE_LIMIT, fromId: 0 });
        });

        test("a limit past the maximum clamps", () => {
            expect(pageBounds({ limit: 10_000_000 }).limit).toBe(MAX_PAGE_LIMIT);
        });

        test("negative and fractional inputs are floored to something sane", () => {
            expect(pageBounds({ limit: -5, fromId: -3 })).toEqual({ limit: 0, fromId: 0 });
            expect(pageBounds({ limit: 10.9, fromId: 4.7 })).toEqual({ limit: 10, fromId: 4 });
        });
    });

    describe("fillByIdWindow", () => {
        const probeFor = (live: (id: number) => boolean) => {
            const windows: number[][] = [];
            return {
                windows,
                probe: async (ids: number[]) => {
                    windows.push(ids);
                    return ids.map((id) => (live(id) ? { id } : undefined));
                },
            };
        };

        test("a dense space fills in one probe", async () => {
            const { probe, windows } = probeFor(() => true);
            const filled = await fillByIdWindow(0, 5, Promise.resolve(100), probe);
            expect(filled.kept.map((k) => k.id)).toEqual([0, 1, 2, 3, 4]);
            expect(filled.nextId).toBe(5);
            expect(windows).toHaveLength(1);
        });

        test("gaps are stepped over so the page still fills", async () => {
            const { probe } = probeFor((id) => id !== 1 && id !== 2);
            const filled = await fillByIdWindow(0, 3, Promise.resolve(100), probe);
            expect(filled.kept.map((k) => k.id)).toEqual([0, 3, 4]);
            expect(filled.nextId).toBe(5);
        });

        test("the ceiling ends the walk", async () => {
            // Nothing exists past the ceiling, which is what a real probe
            // reports for an id beyond the end of the space.
            const { probe } = probeFor((id) => id < 10);
            const filled = await fillByIdWindow(8, 10, Promise.resolve(10), probe);
            expect(filled.kept.map((k) => k.id)).toEqual([8, 9]);
            expect(filled.nextId).toBeNull();
        });

        test("the scan budget bounds a mostly-empty stretch", async () => {
            const { probe } = probeFor((id) => id > 500);
            const filled = await fillByIdWindow(0, 2, Promise.resolve(10_000), probe);
            expect(filled.kept).toEqual([]);
            // Stopped at limit * SCAN_BUDGET_FACTOR rather than reading on.
            expect(filled.nextId).toBe(2 * SCAN_BUDGET_FACTOR);
        });
    });
}
