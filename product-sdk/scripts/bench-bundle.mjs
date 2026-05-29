#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Bundle-size benchmark for @parity/product-sdk-* packages.
//
// Modes:
//   measure  — build the workspace, measure each package, write JSON + markdown
//   compare  — diff two JSON reports, print markdown table, exit non-zero on regression
//
// Usage:
//   node scripts/bench-bundle.mjs measure --out bundle-size.json [--md report.md]
//   node scripts/bench-bundle.mjs compare --base before.json --head after.json [--md diff.md] [--strict]

import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";

// esbuild is only needed in `measure` mode. Loaded lazily so `compare` can
// run in CI environments without installing workspace dependencies.
let esbuild;

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, "..");
const PACKAGES_DIR = join(WORKSPACE_ROOT, "packages");
// Disposable workspace consumer that depends on every @parity/product-sdk-*
// package. esbuild resolves bare imports relative to this directory so
// pnpm's per-package node_modules linking works.
const BENCH_CONSUMER_DIR = join(WORKSPACE_ROOT, "scripts", "bench-consumer");

// Regression thresholds (looser for v1; tighten once we have data).
// For deps-dominated entries (>100 KB baseline) only the percentage applies.
// For small entries (<100 KB) absolute byte budgets also kick in.
const THRESHOLDS = {
    fail: { pct: 20, bytes: 15 * 1024 },
    warn: { pct: 10, bytes: 5 * 1024 },
};

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

async function discoverPackages() {
    const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(PACKAGES_DIR, d.name));

    const packages = [];
    for (const dir of dirs) {
        const pkgPath = join(dir, "package.json");
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
        if (!pkg.name?.startsWith("@parity/product-sdk")) continue;
        packages.push({ dir, pkg });
    }
    return packages.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

// Resolve every entry point a consumer could import: "." plus any subpath
// exports that point at a real .js / .mjs file we can bundle.
function entryPointsFor(pkg, dir) {
    const entries = [];
    const exp = pkg.exports;
    if (!exp || typeof exp === "string") {
        entries.push({ subpath: ".", file: resolveExportFile(pkg.main ?? "./dist/index.js", dir) });
        return entries.filter((e) => e.file && existsSync(e.file));
    }
    for (const [subpath, value] of Object.entries(exp)) {
        const file = resolveExportFile(typeof value === "string" ? value : (value.import ?? value.default), dir);
        if (file && existsSync(file)) entries.push({ subpath, file });
    }
    return entries;
}

function resolveExportFile(rel, dir) {
    if (!rel) return null;
    return resolve(dir, rel);
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

function rawSizes(file) {
    const buf = readFileSync(file);
    return {
        raw: buf.byteLength,
        gzip: gzipSync(buf, { level: 9 }).byteLength,
        brotli: brotliCompressSync(buf, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
        }).byteLength,
    };
}

async function bundleSize({ entryPath, packageName, treeShake }) {
    // Build a tiny in-memory entry that imports the package by name and pins
    // the import to a global side-effect so esbuild can't DCE the whole thing.
    //
    // - treeShake=false: `import * as M` + pin M — every export is reachable,
    //   measures the consumer ceiling for "I use everything".
    // - treeShake=true:  `import { firstExport }` + pin that one binding —
    //   measures the tree-shaken cost of one symbol. Comparing the two ratios
    //   tells us whether tree-shaking is actually working.
    //
    // We use stdin with resolveDir = workspace root so esbuild resolves bare
    // imports against the workspace's node_modules instead of /tmp.
    let contents;
    if (treeShake) {
        const firstExport = await detectFirstExport(entryPath);
        if (!firstExport) return { raw: null, gzip: null, brotli: null, error: "no exports detected" };
        contents = `import { ${firstExport} } from ${JSON.stringify(packageName)}; globalThis.__pin = ${firstExport};`;
    } else {
        contents = `import * as M from ${JSON.stringify(packageName)}; globalThis.__pin = M;`;
    }

    const tmp = await mkdtemp(join(tmpdir(), "bench-"));
    const outFile = join(tmp, "out.mjs");

    try {
        await esbuild.build({
            stdin: {
                contents,
                resolveDir: BENCH_CONSUMER_DIR,
                sourcefile: "bench-entry.mjs",
                loader: "js",
            },
            outfile: outFile,
            bundle: true,
            format: "esm",
            platform: "browser",
            target: "es2022",
            minify: true,
            treeShaking: true,
            absWorkingDir: WORKSPACE_ROOT,
            logLevel: "silent",
            // Externalise both `node:`-prefixed and bare Node built-ins:
            // tsup/esbuild can strip the `node:` prefix on dynamic imports
            // in library output (e.g. contracts/src/pvm.ts), so matching
            // only `node:*` misses the rewritten form.
            external: [
                "node:*",
                "fs",
                "fs/promises",
                "path",
                "os",
                "crypto",
                "stream",
                "util",
                "url",
                "buffer",
                "events",
                "child_process",
                "worker_threads",
            ],
        });
        return rawSizes(outFile);
    } catch (err) {
        return { raw: null, gzip: null, brotli: null, error: err.message };
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}

async function detectFirstExport(distFile, seen = new Set()) {
    if (seen.has(distFile)) return null;
    seen.add(distFile);
    const content = await readFile(distFile, "utf8");

    // tsup emits `export { Foo, Bar };` and `export { Foo as default };` patterns.
    const blockMatch = content.match(/export\s*\{([^}]+)\}/);
    if (blockMatch) {
        const first = blockMatch[1]
            .split(",")
            .map((s) => s.trim())
            .map((s) => s.split(/\s+as\s+/i).pop())
            .find((name) => name && name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name));
        if (first) return first;
    }
    const named = content.match(/export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/);
    if (named) return named[1];

    // Re-export shim: `export * from "<spec>"` — chase the target.
    const reExports = [...content.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)].map(
        (m) => m[1],
    );
    for (const spec of reExports) {
        const target = await resolveReExportTarget(spec);
        if (target) {
            const found = await detectFirstExport(target, seen);
            if (found) return found;
        }
    }
    return null;
}

async function resolveReExportTarget(spec) {
    // Bare specifier — resolve against bench-consumer's node_modules.
    if (!spec.startsWith(".") && !spec.startsWith("/")) {
        const slash = spec.indexOf("/", spec.startsWith("@") ? spec.indexOf("/") + 1 : 0);
        const pkgName = slash === -1 ? spec : spec.slice(0, slash);
        const subpath = slash === -1 ? "." : `./${spec.slice(slash + 1)}`;
        const pkgJsonPath = join(BENCH_CONSUMER_DIR, "node_modules", pkgName, "package.json");
        if (!existsSync(pkgJsonPath)) return null;
        const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
        const entry = pickExport(pkg.exports, subpath) ?? pkg.module ?? pkg.main ?? "./dist/index.js";
        return resolve(dirname(pkgJsonPath), entry);
    }
    return null;
}

function pickExport(exp, subpath) {
    if (!exp || typeof exp === "string") return typeof exp === "string" ? exp : null;
    const e = exp[subpath];
    if (!e) return null;
    if (typeof e === "string") return e;
    return e.import ?? e.default ?? null;
}

// ---------------------------------------------------------------------------
// Measure command
// ---------------------------------------------------------------------------

async function cmdMeasure(args) {
    esbuild = await import("esbuild");
    const outPath = resolve(WORKSPACE_ROOT, args.out ?? "bundle-size.json");
    const mdPath = args.md ? resolve(WORKSPACE_ROOT, args.md) : null;

    const packages = await discoverPackages();
    const report = {
        version: 1,
        generatedAt: new Date().toISOString(),
        node: process.version,
        esbuild: esbuild.version ?? esbuild.default?.version ?? "unknown",
        packages: {},
    };

    for (const { dir, pkg } of packages) {
        const entries = entryPointsFor(pkg, dir);
        if (entries.length === 0) {
            console.warn(`skip ${pkg.name}: no resolvable entry points`);
            continue;
        }

        const pkgReport = { entries: {} };
        for (const { subpath, file } of entries) {
            const importSpecifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, "")}`;
            const ship = rawSizes(file);
            const bundledFull = await bundleSize({
                entryPath: file,
                packageName: importSpecifier,
                treeShake: false,
            });
            const bundledShaken = await bundleSize({
                entryPath: file,
                packageName: importSpecifier,
                treeShake: true,
            });

            pkgReport.entries[subpath] = {
                file: file.replace(`${WORKSPACE_ROOT}/`, ""),
                ship, // what npm sends per file
                bundled: bundledFull, // import * — full consumer cost
                shaken: bundledShaken, // single named import — tree-shaken cost
                shakeRatio:
                    bundledFull.raw && bundledShaken.raw
                        ? +(bundledShaken.raw / bundledFull.raw).toFixed(4)
                        : null,
            };
            console.log(
                `${pkg.name} ${subpath}: ship ${fmt(ship.gzip)} gzip · bundled ${fmt(bundledFull.gzip)} · shaken ${fmt(bundledShaken.gzip)}`,
            );
        }
        report.packages[pkg.name] = pkgReport;
    }

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWrote ${outPath}`);

    if (mdPath) {
        await writeFile(mdPath, renderReportMd(report));
        console.log(`Wrote ${mdPath}`);
    }
}

// ---------------------------------------------------------------------------
// Compare command
// ---------------------------------------------------------------------------

async function cmdCompare(args) {
    const basePath = resolve(WORKSPACE_ROOT, args.base);
    const headPath = resolve(WORKSPACE_ROOT, args.head);
    const mdPath = args.md ? resolve(WORKSPACE_ROOT, args.md) : null;
    const strict = !!args.strict;

    const base = JSON.parse(await readFile(basePath, "utf8"));
    const head = JSON.parse(await readFile(headPath, "utf8"));

    const rows = [];
    let maxSeverity = "ok";

    const allPkgs = new Set([...Object.keys(base.packages), ...Object.keys(head.packages)]);
    for (const name of [...allPkgs].sort()) {
        const basePkg = base.packages[name];
        const headPkg = head.packages[name];
        if (!headPkg) {
            rows.push({ name, subpath: "—", severity: "warn", note: "removed" });
            maxSeverity = worse(maxSeverity, "warn");
            continue;
        }
        if (!basePkg) {
            rows.push({ name, subpath: "—", severity: "ok", note: "new package" });
            continue;
        }
        const subpaths = new Set([
            ...Object.keys(basePkg.entries ?? {}),
            ...Object.keys(headPkg.entries ?? {}),
        ]);
        for (const sub of [...subpaths].sort()) {
            const b = basePkg.entries?.[sub];
            const h = headPkg.entries?.[sub];
            if (!h) {
                rows.push({ name, subpath: sub, severity: "warn", note: "entry removed" });
                maxSeverity = worse(maxSeverity, "warn");
                continue;
            }
            if (!b) {
                rows.push({ name, subpath: sub, severity: "ok", note: "new entry" });
                continue;
            }
            // Base errored, head succeeded — surface as informational
            // rather than read the null → N KB jump as a regression.
            if (b.bundled?.error && !h.bundled?.error) {
                rows.push({
                    name,
                    subpath: sub,
                    severity: "ok",
                    note: "now measurable",
                    bundledBefore: null,
                    bundledAfter: h.bundled?.raw ?? null,
                    deltaBytes: null,
                    deltaPct: null,
                    shipGzipBefore: b.ship?.gzip ?? null,
                    shipGzipAfter: h.ship?.gzip ?? null,
                    shakeBefore: b.shakeRatio ?? null,
                    shakeAfter: h.shakeRatio ?? null,
                });
                continue;
            }
            const beforeBundled = b.bundled?.raw ?? 0;
            const afterBundled = h.bundled?.raw ?? 0;
            const deltaB = afterBundled - beforeBundled;
            const pct = beforeBundled > 0 ? (deltaB / beforeBundled) * 100 : 0;

            const beforeShake = b.shakeRatio ?? null;
            const afterShake = h.shakeRatio ?? null;

            const severity = classify(pct, deltaB, beforeBundled);
            maxSeverity = worse(maxSeverity, severity);

            rows.push({
                name,
                subpath: sub,
                severity,
                bundledBefore: beforeBundled,
                bundledAfter: afterBundled,
                deltaBytes: deltaB,
                deltaPct: pct,
                shipGzipBefore: b.ship?.gzip ?? null,
                shipGzipAfter: h.ship?.gzip ?? null,
                shakeBefore: beforeShake,
                shakeAfter: afterShake,
            });
        }
    }

    const md = renderDiffMd(rows, { base, head });
    process.stdout.write(`${md}\n`);
    if (mdPath) await writeFile(mdPath, md);

    if (strict && maxSeverity === "fail") {
        console.error("\nBundle size regression exceeds fail threshold.");
        process.exit(1);
    }
}

function classify(pct, bytes, baseBytes) {
    if (bytes <= 0) return "ok";
    // For deps-dominated entries (>100 KB baseline) a 5 KB swing is noise —
    // gate on percentage only. Absolute thresholds apply to small entries
    // where a 5 KB add is a meaningful regression. Below a 10 KB baseline
    // we drop the percentage rule entirely and govern by absolute bytes alone
    const useAbsolute = baseBytes < 100 * 1024;
    const usePercent = baseBytes >= 10 * 1024;
    const pctFails = usePercent && pct >= THRESHOLDS.fail.pct;
    const pctWarns = usePercent && pct >= THRESHOLDS.warn.pct;
    if (pctFails || (useAbsolute && bytes >= THRESHOLDS.fail.bytes)) return "fail";
    if (pctWarns || (useAbsolute && bytes >= THRESHOLDS.warn.bytes)) return "warn";
    return "ok";
}

function worse(a, b) {
    const order = { ok: 0, warn: 1, fail: 2 };
    return order[b] > order[a] ? b : a;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmt(n) {
    if (n == null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtPct(p) {
    if (!Number.isFinite(p)) return "—";
    const sign = p > 0 ? "+" : "";
    return `${sign}${p.toFixed(1)}%`;
}

function fmtDelta(b) {
    if (b == null) return "—";
    if (b === 0) return "0 B";
    const sign = b > 0 ? "+" : "-";
    return `${sign}${fmt(Math.abs(b))}`;
}

function severityIcon(s) {
    return { ok: "🟢", warn: "🟡", fail: "🔴" }[s] ?? "⚪";
}

function renderReportMd(report) {
    const lines = [];
    lines.push(`# Bundle size report`);
    lines.push(``);
    lines.push(`Generated ${report.generatedAt} · node ${report.node} · esbuild ${report.esbuild}`);
    lines.push(``);
    lines.push(`| Package | Entry | Ship gzip | Bundled gzip | Shaken gzip | Shake ratio |`);
    lines.push(`|---|---|---:|---:|---:|---:|`);
    for (const [name, pkg] of Object.entries(report.packages)) {
        for (const [sub, e] of Object.entries(pkg.entries)) {
            lines.push(
                `| \`${name}\` | \`${sub}\` | ${fmt(e.ship?.gzip)} | ${fmt(e.bundled?.gzip)} | ${fmt(e.shaken?.gzip)} | ${e.shakeRatio != null ? `${(e.shakeRatio * 100).toFixed(0)}%` : "—"} |`,
            );
        }
    }
    return `${lines.join("\n")}\n`;
}

function renderDiffMd(rows, ctx) {
    const lines = [];
    lines.push(`<!-- product-sdk-bundle-size -->`);
    lines.push(`## 📦 Bundle size impact`);
    lines.push(``);
    lines.push(`Comparing \`${ctx.base.generatedAt}\` → \`${ctx.head.generatedAt}\``);
    lines.push(``);

    const changed = rows.filter(
        (r) =>
            r.severity !== "ok" || (r.deltaBytes != null && r.deltaBytes !== 0) || r.note != null,
    );

    if (changed.length === 0) {
        lines.push(`No size changes detected. 🟢`);
        return `${lines.join("\n")}\n`;
    }

    lines.push(
        `| | Package | Entry | Bundled before | Bundled after | Δ | Ship gzip Δ | Shake ratio |`,
    );
    lines.push(`|---|---|---|---:|---:|---:|---:|---:|`);
    for (const r of changed) {
        if (r.note) {
            lines.push(
                `| ${severityIcon(r.severity)} | \`${r.name}\` | \`${r.subpath}\` | — | — | ${r.note} | — | — |`,
            );
            continue;
        }
        const shipDelta =
            r.shipGzipAfter != null && r.shipGzipBefore != null
                ? r.shipGzipAfter - r.shipGzipBefore
                : null;
        const shake =
            r.shakeAfter != null
                ? `${(r.shakeAfter * 100).toFixed(0)}%${r.shakeBefore != null ? ` (was ${(r.shakeBefore * 100).toFixed(0)}%)` : ""}`
                : "—";
        lines.push(
            `| ${severityIcon(r.severity)} | \`${r.name}\` | \`${r.subpath}\` | ${fmt(r.bundledBefore)} | ${fmt(r.bundledAfter)} | ${fmtDelta(r.deltaBytes)} (${fmtPct(r.deltaPct)}) | ${shipDelta != null ? fmtDelta(shipDelta) : "—"} | ${shake} |`,
        );
    }

    lines.push(``);
    lines.push(
        `Thresholds — warn: ≥${THRESHOLDS.warn.pct}% or ≥${fmt(THRESHOLDS.warn.bytes)} · fail: ≥${THRESHOLDS.fail.pct}% or ≥${fmt(THRESHOLDS.fail.bytes)} (bundled). Percentage only applies once the baseline is ≥ 10 KB.`,
    );
    return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const [cmd, ...rest] = argv;
    const args = { _: cmd };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = rest[i + 1];
            if (next && !next.startsWith("--")) {
                args[key] = next;
                i++;
            } else {
                args[key] = true;
            }
        }
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
switch (args._) {
    case "measure":
        await cmdMeasure(args);
        break;
    case "compare":
        await cmdCompare(args);
        break;
    default:
        console.error("Usage: bench-bundle.mjs <measure|compare> [options]");
        console.error("  measure --out bundle-size.json [--md report.md]");
        console.error("  compare --base before.json --head after.json [--md diff.md] [--strict]");
        process.exit(2);
}
