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

type FailureKind = "infra" | "assertion";

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
 * Best-effort classification of a failed attempt. A `timedOut` status, or an
 * error message mentioning the transport / chain, is infra. Anything else —
 * most importantly an `expect(...)` mismatch — is treated as a real assertion
 * failure, which is the conservative choice: we would rather over-report a
 * masked regression than let one slip through as "just flaky".
 */
function classify(result: TestResult, error: TestError | undefined): FailureKind {
    if (result.status === "timedOut") return "infra";

    // Strip ANSI colour codes before matching — Playwright colourises assertion
    // messages, and the codes can sit between tokens (`\x1b[2mexpect(\x1b[22m`).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI escape (ESC) is the point.
    const haystack = `${error?.message ?? ""} ${error?.stack ?? ""}`
        .replace(/\x1b\[[0-9;]*m/g, "")
        .toLowerCase();

    // Playwright's assertion failures carry one of these unambiguous markers.
    // An assertion always wins over an infra signal — a mismatch whose *value*
    // happens to contain the word "timeout" is still a real assertion failure,
    // which is the conservative call (over-report a masked regression rather
    // than wave one through as flaky).
    const ASSERTION_SIGNALS = [
        "expect(",
        "\nexpected:",
        "\nreceived:",
        "tocontaintext",
        "tohavetext",
        "tobe(",
        "toequal(",
        "tohavelength",
    ];
    if (ASSERTION_SIGNALS.some((s) => haystack.includes(s))) return "assertion";

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
        "rpc",
        "network",
        "getaddrinfo",
        "navigation",
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
        // Playwright reports each attempt separately. The one that matters for
        // masking is the *first* failure (retry === 0): that's the failure a
        // later retry could hide. We record it here; whether the retry rescued
        // it is read from `outcome()` later, in `onEnd`.
        if (result.retry === 0 && result.status !== "passed" && result.status !== "skipped") {
            const error = result.error ?? result.errors[0];
            this.retried.push({
                test,
                title: test.titlePath().slice(1).join(" › "),
                location: `${test.location.file}:${test.location.line}`,
                firstFailureKind: classify(result, error),
                firstFailureMessage: firstLine(error?.message),
            });
        }
    }

    /**
     * `outcome()` is only final once every retry has run, so it's read here in
     * `onEnd` rather than in `onTestEnd` (which fires per-attempt, before the
     * retry exists). `flaky` = failed then passed on retry — the masked case.
     */
    private rescued(attempt: RetriedAttempt): boolean {
        return attempt.test.outcome() === "flaky";
    }

    onEnd(result: FullResult): void | Promise<void> {
        if (this.retried.length === 0) return;

        // The case worth shouting about: a test that first failed an ASSERTION
        // (not infra) and then went GREEN on retry. That green is suspect — the
        // assertion may be a real, nondeterministic regression the retry masked.
        const maskedAssertions = this.retried.filter(
            (r) => r.firstFailureKind === "assertion" && this.rescued(r),
        );

        console.log("");
        console.log("──────────────────────────────────────────────────────────────");
        console.log(`  Retry diagnostics — ${this.retried.length} test(s) needed a retry`);
        console.log("──────────────────────────────────────────────────────────────");
        for (const r of this.retried) {
            const tag = r.firstFailureKind === "infra" ? "INFRA    " : "ASSERTION";
            const outcome = this.rescued(r) ? "→ GREEN on retry" : "→ still failed";
            console.log(`  [${tag}] ${outcome}  ${r.title}`);
            console.log(`            ${r.location}`);
            console.log(`            first failure: ${r.firstFailureMessage}`);
        }
        if (maskedAssertions.length > 0) {
            console.log("");
            console.log(
                `  ⚠  ${maskedAssertions.length} test(s) first failed on an ASSERTION and then went`,
            );
            console.log(
                "     GREEN on retry. A retry is meant for infrastructure flakiness, not for",
            );
            console.log(
                "     assertion mismatches — treat each of these as a possible regression the",
            );
            console.log("     retry masked, and investigate before trusting the green run.");
        }
        console.log("──────────────────────────────────────────────────────────────");
        console.log(`  Run status: ${result.status}`);
        console.log("");
    }
}

export default RetryDiagnosticsReporter;
