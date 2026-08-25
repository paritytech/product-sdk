// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared Playwright reporter that makes `retries: 1` honest.
 *
 * The demo suites run against a live public chain (Paseo Asset Hub), so a
 * retry is the right call for genuine infrastructure flakiness — an RPC blip,
 * a slow block, a websocket that dropped mid-handshake. But Playwright's
 * `retries` is unconditional: it retries an assertion failure exactly the same
 * way it retries a timeout. A test that failed a *real* assertion on attempt 1
 * and happened to pass on attempt 2 (nondeterministic chain state, ordering
 * races) turns green with no trace in the summary. That silently converts a
 * regression into a flake.
 *
 * This reporter doesn't change retry behaviour — Playwright still decides
 * that. It observes every failed attempt, classifies it as INFRA (timeout /
 * connection / RPC) or ASSERTION (an `expect` mismatch), and prints a loud
 * end-of-run summary of every test that needed a retry. An ASSERTION failure
 * that was later "rescued" by a retry is called out specifically, because that
 * is the case most likely to be hiding a real bug behind a green check.
 *
 * Referenced from each demo's `playwright.config.ts`:
 *   reporter: [["list"], ["../e2e-retry-reporter.ts"]]
 */
import type {
    FullResult,
    Reporter,
    TestCase,
    TestError,
    TestResult,
} from "@playwright/test/reporter";

/**
 * - `infra`     — a transport/timeout failure with no assertion involved.
 * - `wait`      — a web-first assertion (`toHaveText`, `toContainText`, …) that
 *                 exhausted its own timeout while polling. It reads like an
 *                 assertion (`expect(` is in the message) but it failed on
 *                 *time*, not on a synchronous mismatch, so a retry is
 *                 legitimate — this is the shape of a slow chain connection.
 * - `assertion` — a synchronous `expect` mismatch. The one a retry must not
 *                 mask, because it means the value was genuinely wrong.
 */
type FailureKind = "infra" | "wait" | "assertion";

interface RetriedAttempt {
    /** The test itself, so its final `outcome()` can be read in `onEnd`. */
    test: TestCase;
    title: string;
    location: string;
    /** Kind of the first failed attempt — the one a retry might have masked. */
    firstFailureKind: FailureKind;
    firstFailureMessage: string;
}

/**
 * Best-effort classification of a failed attempt.
 *
 * The load-bearing distinction is between a *synchronous* `expect` mismatch (a
 * real regression — `assertion`) and a *web-first* assertion that timed out
 * while polling (a slow-connection flake — `wait`). Both carry `expect(` in the
 * message, so `expect(` alone can't tell them apart. The discriminator is
 * Playwright's `Call log:` section: it is present only for a polled/awaited
 * assertion that exhausted its timeout, never for a synchronous mismatch.
 * Verified across the timeout-vs-mismatch shapes.
 */
function classify(result: TestResult, error: TestError | undefined): FailureKind {
    if (result.status === "timedOut") return "infra";

    // Strip ANSI colour codes before matching — Playwright colourises assertion
    // messages, and the codes can sit between tokens (`\x1b[2mexpect(\x1b[22m`).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape (ESC) is the point.
    const haystack = `${error?.message ?? ""} ${error?.stack ?? ""}`
        .replace(/\x1b\[[0-9;]*m/g, "")
        .toLowerCase();

    const isExpect = haystack.includes("expect(");

    // A `Call log:` section means a polled/awaited matcher ran and ran out of
    // time. With an `expect` that's a web-first assertion timing out (`wait`);
    // without one it's a non-assertion wait (`infra`, e.g. `waitFor`).
    if (haystack.includes("call log:")) {
        return isExpect ? "wait" : "infra";
    }

    // No call log: a synchronous `expect` mismatch is a genuine assertion. This
    // is the only shape a retry must never be allowed to mask.
    if (isExpect) return "assertion";

    // Neither an expect nor a call log — a thrown transport/connection error.
    // Kept narrow: signals that are unambiguously infrastructure, not words like
    // "network" that appear inside real error *values* (e.g. "Balance decoding
    // failed for network Paseo" is a decode assertion, not an infra failure).
    const INFRA_SIGNALS = [
        "timeout",
        "timed out",
        "websocket",
        "ws error",
        "econnrefused",
        "econnreset",
        "socket hang up",
        "disconnected",
        "tracking stopped",
        "getaddrinfo",
    ];
    return INFRA_SIGNALS.some((s) => haystack.includes(s)) ? "infra" : "assertion";
}

function firstLine(message: string | undefined): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the ANSI escape (ESC) is the point.
    const clean = (message ?? "unknown error").replace(/\x1b\[[0-9;]*m/g, "");
    return clean.split("\n")[0]?.trim() ?? "unknown error";
}

class RetryDiagnosticsReporter implements Reporter {
    private readonly retried: RetriedAttempt[] = [];

    onTestEnd(test: TestCase, result: TestResult): void {
        // Record the *first* failed attempt (retry === 0) — that's the failure a
        // later retry could hide. But only for tests that genuinely failed:
        // `outcome() === "expected"` covers a `test.fail()` whose expected
        // failure Playwright counts as a pass, which we must not list as a
        // failure. Whether the retry rescued it is read from `outcome()` in
        // `onEnd` (final only after every retry has run).
        if (result.retry !== 0 || result.status === "passed" || result.status === "skipped") {
            return;
        }
        if (test.outcome() === "expected") return;

        const error = result.error ?? result.errors[0];
        this.retried.push({
            test,
            title: test.titlePath().slice(1).join(" › "),
            location: `${test.location.file}:${test.location.line}`,
            firstFailureKind: classify(result, error),
            firstFailureMessage: firstLine(error?.message),
        });
    }

    /** `flaky` = failed first attempt, then passed on retry — the masked case. */
    private rescued(attempt: RetriedAttempt): boolean {
        return attempt.test.outcome() === "flaky";
    }

    onEnd(result: FullResult): { status?: FullResult["status"] } | undefined {
        if (this.retried.length === 0) return;

        const retriedCount = this.retried.filter((r) => r.test.results.length > 1).length;

        // The case worth shouting about — and failing the run over: a test that
        // first failed a *synchronous* ASSERTION (not a slow-connection `wait`,
        // not infra) and then went GREEN on retry. That green is masking what is
        // very likely a real, nondeterministic regression.
        const maskedAssertions = this.retried.filter(
            (r) => r.firstFailureKind === "assertion" && this.rescued(r),
        );

        const TAG: Record<FailureKind, string> = {
            infra: "INFRA    ",
            wait: "WAIT     ",
            assertion: "ASSERTION",
        };

        console.log("");
        console.log("──────────────────────────────────────────────────────────────");
        console.log(
            `  Retry diagnostics — ${this.retried.length} test(s) failed first attempt` +
                `, ${retriedCount} retried`,
        );
        console.log("──────────────────────────────────────────────────────────────");
        for (const r of this.retried) {
            const outcome = this.rescued(r)
                ? "→ GREEN on retry"
                : r.test.results.length > 1
                  ? "→ still failed after retry"
                  : "→ failed (not retried)";
            console.log(`  [${TAG[r.firstFailureKind]}] ${outcome}  ${r.title}`);
            console.log(`            ${r.location}`);
            console.log(`            first failure: ${r.firstFailureMessage}`);
        }

        let status = result.status;
        if (maskedAssertions.length > 0) {
            console.log("");
            console.log(
                `  ⚠  ${maskedAssertions.length} test(s) first failed on a synchronous ASSERTION and`,
            );
            console.log(
                "     then went GREEN on retry. A retry is meant for infrastructure flakiness,",
            );
            console.log(
                "     not for assertion mismatches — each of these is very likely a real",
            );
            console.log("     regression the retry masked. Failing the run so it can't hide.");
            // A collapsed green CI group would bury the warning above; overriding
            // the status to `failed` turns the whole run red so it's seen.
            if (status === "passed") status = "failed";
        }

        console.log("──────────────────────────────────────────────────────────────");
        console.log(`  Run status: ${status}`);
        console.log("");

        return status === result.status ? undefined : { status };
    }
}

export default RetryDiagnosticsReporter;
