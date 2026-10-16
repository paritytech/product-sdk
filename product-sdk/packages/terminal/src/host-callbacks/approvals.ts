// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * How the terminal answers the core's reviews and permission requests.
 *
 * A CLI is itself the product asking, and every request still needs the
 * user's approval on the paired phone, so by default the terminal approves the
 * host-side step. Pass {@link TerminalApprovals} to ask at a prompt
 * instead. Device permissions (camera, location, ...) are denied: a terminal
 * has none of those devices.
 */
import type { PermissionDecision, UserConfirmationReview } from "@parity/truapi-host";
import type { WebWorkerHostCallbacks } from "@parity/truapi-host/node";

/** What the core is asking the user to approve. */
export type TerminalApprovalRequest =
    | { kind: "review"; review: UserConfirmationReview }
    | { kind: "permission"; permission: string };

/** Answers `true` to approve once, `false` to refuse. */
export type TerminalApprovals = (request: TerminalApprovalRequest) => Promise<boolean>;

export const approveAll: TerminalApprovals = async () => true;

const decision = (approved: boolean): PermissionDecision => (approved ? "AllowOnce" : "Deny");

export function createApprovalCallbacks(
    approve: TerminalApprovals,
): Pick<WebWorkerHostCallbacks, "userConfirmation" | "permissions"> {
    return {
        userConfirmation: {
            confirmUserAction: (review) => approve({ kind: "review", review }),
            confirmPermission: async (review) =>
                decision(await approve({ kind: "review", review })),
        },
        permissions: {
            async devicePermission() {
                return "Deny";
            },
            remotePermission: async (_product, request) =>
                decision(await approve({ kind: "permission", permission: request.permission.tag })),
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const product = { productId: "my-cli.dot", executionKind: "App" as const };

    describe("createApprovalCallbacks", () => {
        test("forwards each review and remote permission to the policy and maps its answer", async () => {
            const asked: TerminalApprovalRequest[] = [];
            const callbacks = createApprovalCallbacks(async (request) => {
                asked.push(request);
                return request.kind === "review";
            });
            const signRaw = { tag: "SignRaw" } as UserConfirmationReview;
            const answers = [
                await callbacks.userConfirmation.confirmUserAction(signRaw),
                await callbacks.permissions.remotePermission(product, {
                    permission: { tag: "ChainSubmit" },
                } as never),
            ];
            expect({ answers, asked }).toEqual({
                answers: [true, "Deny"],
                asked: [
                    { kind: "review", review: signRaw },
                    { kind: "permission", permission: "ChainSubmit" },
                ],
            });
        });

        test("never grants device permissions, whatever the policy says", async () => {
            const { permissions } = createApprovalCallbacks(approveAll);
            expect(await permissions.devicePermission(product, "Camera" as never)).toBe("Deny");
        });
    });
}
