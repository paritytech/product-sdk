# Security Policy

## Security status

This repository contains SDK packages, tooling, examples, and Claude Code plugin skills for building applications in the Polkadot ecosystem.

The code and generated patterns may involve chain connections, transaction construction, transaction signing, signer management, key derivation, key handling, contract interactions, storage, and end-to-end application scaffolding.

Unless a specific release states otherwise, this repository has not received a full security audit.

Use of this repository in production or production-like deployments, with funded accounts, production credentials, production infrastructure, or security-sensitive signing flows should only happen after an independent security review of the relevant code, configuration, generated output, and deployment environment.

Even where a particular Parity-operated mainnet or production deployment does not yet exist, this code may be used by third parties on live networks or reused in future production contexts once published.

Claude-generated code, examples, and scaffolded applications should be reviewed before being run or deployed.

## Supported versions

Security fixes are provided only for versions, packages, or branches that are actively maintained by Parity.

If a package, example, skill, or branch is experimental, archived, deprecated, or clearly marked as unsupported, Parity may decline to triage or fix issues unless they affect maintained packages, Parity-operated infrastructure, user funds, private keys, signing flows, or transaction integrity.

## Bug bounty scope

This repository is not in scope for Parity's paid bug bounty programme unless it is explicitly listed in the official bounty scope at the time of submission.

Reports for this repository may still be reviewed through Parity's responsible disclosure process, but bounty eligibility applies only where the affected repository, package, service, deployed asset, or vulnerability class is explicitly in scope.

Because this repository includes experimental and reference material, Parity may not triage general hardening reports, best-practice findings, dependency noise, missing security headers, theoretical issues, or issues that only affect local, demo, testnet, or unsupported deployments.

## What to report

Please report a security issue only if it demonstrates realistic impact against one or more of the following:

- Parity-operated production infrastructure;
- deployed Parity-operated services;
- maintained SDK packages that downstream users are expected to consume;
- user funds or assets;
- private keys, seed phrases, signer flows, or key-management boundaries;
- transaction construction, transaction integrity, or signing intent;
- remote code execution or credential compromise in a realistic deployment;
- vulnerabilities in Claude Code plugin skills or generated patterns that would predictably cause unsafe handling of keys, signatures, transactions, funds, or production credentials.

## Out of scope for this repository

The following are generally out of scope unless they can be shown to cause realistic high-impact harm:

- issues affecting only local development environments;
- issues affecting only demo, example, or testnet deployments;
- missing security headers on non-production demo apps;
- lack of rate limiting in local/demo examples;
- dependency vulnerability reports without a working exploit path;
- dependency vulnerability reports that do not affect shipped or maintained packages;
- hypothetical attack paths without practical impact;
- reports that amount to "this code is unaudited" or "this should not be used in production";
- issues already documented as known limitations;
- unsafe use of the SDK contrary to documented warnings;
- vulnerabilities introduced by third-party applications that use this SDK incorrectly;
- reports requiring access to internal Parity systems, credentials, or repositories that are not explicitly in scope.

## Reporting a qualifying issue

Please do not open a public GitHub issue for a qualifying security vulnerability.

Send reports to:

security@parity.io

Please include:

- the affected repository, package, skill, commit, branch, or release;
- clear reproduction steps;
- realistic impact;
- whether the issue affects production infrastructure, maintained packages, user funds, private keys, signing flows, transaction integrity, or only local/demo/testnet usage;
- any relevant proof of concept, logs, screenshots, or generated code;
- whether the issue depends on SDK code, example code, Claude-generated code, or a specific skill under `product-sdk/skills/`;
- any assumptions required for exploitation.

## Researcher expectations

When investigating or reporting issues, please:

- do not access, modify, or delete data that is not yours;
- do not disrupt services or degrade availability;
- do not attempt to extract private keys, seed phrases, credentials, or secrets beyond what is necessary to demonstrate impact safely;
- do not test against production systems unless they are explicitly in scope;
- do not use social engineering, phishing, physical attacks, or attacks against Parity employees or users;
- do not publicly disclose the issue until Parity has had a reasonable opportunity to investigate and remediate it.

## Safe-use guidance

Before using this repository for production or production-like deployments, review at minimum:

- how keys, seed phrases, accounts, and signers are generated, stored, accessed, and destroyed;
- whether signing prompts clearly display transaction intent before approval;
- whether transactions are constructed against the intended chain, account, network, and runtime;
- whether generated apps default to testnet/devnet environments;
- whether browser, mobile, desktop, and server-side storage assumptions are appropriate;
- whether any cloud storage or statement-store data is public, private, authenticated, encrypted, or integrity-checked;
- whether examples rely on internal, test, deprecated, or unstable endpoints;
- whether dependencies are pinned, reviewed, and appropriate for the target environment;
- whether generated Claude Code output has been manually reviewed before execution or deployment;
- whether deployment configuration, CORS, authentication, admin routes, logging, and telemetry are appropriate for the intended environment.

## Licence

This repository is licensed under the Apache License, Version 2.0.

The licence provides the terms for use, reproduction, modification, and distribution of the software. This security policy does not modify the licence.
