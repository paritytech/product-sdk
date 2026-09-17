// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import { stripSuffix } from "./dotns-namehash.js";
import { isResolvableDotNsName, isValidDotNsName, normalizeDotNsName } from "./dotns.js";

// The two deployments these helpers actually have to serve. Every case below
// runs against `.paseo` as well as `.dot`, because a helper that only behaves
// on a four-character suffix is the defect being fixed.
const DOT = ".dot";
const PASEO = ".paseo";

describe("stripSuffix", () => {
    test("removes the suffix by its own length", () => {
        expect(stripSuffix("alice.paseo", PASEO)).toBe("alice");
        expect(stripSuffix("alice.dot", DOT)).toBe("alice");
    });

    test("a six-character suffix does not lose two characters to a hardcoded 4", () => {
        // `slice(0, -4)` returns "alice.pa" here, which then hashes and queries
        // as the subname `pa` under `alice`.
        expect(stripSuffix("alice.paseo", PASEO)).not.toBe("alice.pa");
    });

    test("leaves a name that does not carry the suffix untouched", () => {
        expect(stripSuffix("alice", PASEO)).toBe("alice");
        expect(stripSuffix("alice.dot", PASEO)).toBe("alice.dot");
    });

    test("keeps subname structure", () => {
        expect(stripSuffix("bob.alice.paseo", PASEO)).toBe("bob.alice");
    });

    test("a bare suffix strips to the empty label", () => {
        expect(stripSuffix(".paseo", PASEO)).toBe("");
    });
});

describe("normalizeDotNsName", () => {
    test("appends the deployment's suffix to a bare label", () => {
        expect(normalizeDotNsName("alice", PASEO)).toBe("alice.paseo");
        expect(normalizeDotNsName("alice", DOT)).toBe("alice.dot");
    });

    test("is idempotent for a name that already carries the suffix", () => {
        expect(normalizeDotNsName("alice.paseo", PASEO)).toBe("alice.paseo");
    });

    test("leaves a foreign suffix alone instead of burying it", () => {
        // The rule this pins: appending only when there is no dot at all means
        // `alice.dot` survives to be refused by validation. The `endsWith`
        // rule would produce `alice.dot.paseo`, which is a well-formed subname
        // and would resolve silently to a node nobody owns.
        expect(normalizeDotNsName("alice.dot", PASEO)).toBe("alice.dot");
        expect(normalizeDotNsName("alice.dot", PASEO)).not.toBe("alice.dot.paseo");
    });

    test("leaves a bare multi-label name alone", () => {
        // Recorded behaviour change: this used to become `bob.alice.dot` and
        // resolve. It is now left as-is and refused by validation, because
        // telling `bob.alice` from `alice.dot` needs a list of known TLDs.
        expect(normalizeDotNsName("bob.alice", PASEO)).toBe("bob.alice");
    });

    test("lowercases, trims, and drops a single trailing root dot", () => {
        // Matches `normalize_host` in truapi-server, so a name arriving from a
        // URL keys the same way here as it does in the host.
        expect(normalizeDotNsName("  Alice.PASEO.  ", PASEO)).toBe("alice.paseo");
        expect(normalizeDotNsName("ALICE", PASEO)).toBe("alice.paseo");
    });

    test("drops only one trailing dot, so a doubled dot stays visible", () => {
        // `alice.paseo..` is malformed and must reach validation as such
        // rather than being quietly repaired into a valid name.
        expect(normalizeDotNsName("alice.paseo..", PASEO)).toBe("alice.paseo.");
    });
});

describe("isValidDotNsName", () => {
    test("accepts one label under the deployment's suffix", () => {
        expect(isValidDotNsName("alice.paseo", PASEO)).toBe(true);
        expect(isValidDotNsName("alice.dot", DOT)).toBe(true);
    });

    test("refuses another deployment's suffix", () => {
        expect(isValidDotNsName("alice.dot", PASEO)).toBe(false);
        expect(isValidDotNsName("alice.paseo", DOT)).toBe(false);
    });

    test("refuses a subname, which the registrar cannot mint", () => {
        expect(isValidDotNsName("bob.alice.paseo", PASEO)).toBe(false);
    });

    test("applies the label rule to the label, not to the suffix's length", () => {
        // With a hardcoded `slice(0, -4)` the label here would be `dim2.pa`,
        // which fails the label regex and would reject a registrable name.
        expect(isValidDotNsName("dim2.paseo", PASEO)).toBe(true);
    });

    test("keeps the on-chain label rules", () => {
        expect(isValidDotNsName("ab.paseo", PASEO)).toBe(false); // under 3 chars
        expect(isValidDotNsName("-alice.paseo", PASEO)).toBe(false); // edge hyphen
        expect(isValidDotNsName("al ice.paseo", PASEO)).toBe(false); // space
        expect(isValidDotNsName(`${"a".repeat(64)}.paseo`, PASEO)).toBe(false); // over 63
    });
});

describe("isResolvableDotNsName", () => {
    test("accepts a subname, which the registry supports even though the registrar does not", () => {
        expect(isResolvableDotNsName("bob.alice.paseo", PASEO)).toBe(true);
        expect(isResolvableDotNsName("alice.paseo", PASEO)).toBe(true);
    });

    test("refuses another deployment's suffix", () => {
        expect(isResolvableDotNsName("bob.alice.dot", PASEO)).toBe(false);
    });

    test("extracts the labels by suffix length, not by a constant 4", () => {
        // `slice(0, -4)` would split `dim2.pa` into ["dim2", "pa"] and reject
        // it on the 3-character minimum.
        expect(isResolvableDotNsName("dim2.paseo", PASEO)).toBe(true);
    });

    test("refuses an empty label anywhere in the chain", () => {
        expect(isResolvableDotNsName("bob..alice.paseo", PASEO)).toBe(false);
        expect(isResolvableDotNsName(".paseo", PASEO)).toBe(false);
    });
});
