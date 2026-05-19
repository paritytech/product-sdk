import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "template");
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;

async function main() {
    const argName = process.argv.slice(2).find((a) => !a.startsWith("-"));
    const projectName = argName ?? (await promptProjectName());

    if (!projectName) {
        fail("Project name is required.");
    }
    if (!VALID_NAME.test(projectName)) {
        fail(
            `Invalid project name: "${projectName}". Use letters, digits, hyphens, or underscores. Start with a letter or digit.`,
        );
    }

    const target = resolve(process.cwd(), projectName);
    if (existsSync(target)) {
        fail(`Directory already exists: ${relative(process.cwd(), target) || target}`);
    }

    console.log(`\nScaffolding a Polkadot app in ${relative(process.cwd(), target) || "."}...`);

    await copyDir(TEMPLATE_DIR, target);
    await rename(join(target, "_gitignore"), join(target, ".gitignore"));
    await rewritePackageName(join(target, "package.json"), projectName);

    console.log("\n  Done. Next steps:\n");
    console.log(`    cd ${projectName}`);
    console.log("    pnpm install");
    console.log("    pnpm dev\n");
    console.log("  Then open http://localhost:5173 and edit src/App.tsx.\n");
    console.log("  Learn more: https://github.com/paritytech/product-sdk\n");
}

async function promptProjectName(): Promise<string> {
    const rl = createInterface({ input, output });
    try {
        const answer = await rl.question("Project name: ");
        return answer.trim();
    } finally {
        rl.close();
    }
}

async function copyDir(src: string, dst: string): Promise<void> {
    await mkdir(dst, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const dstPath = join(dst, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, dstPath);
        } else if (entry.isFile()) {
            await copyFile(srcPath, dstPath);
        }
    }
}

async function rewritePackageName(pkgPath: string, name: string): Promise<void> {
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    pkg.name = name;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function fail(message: string): never {
    console.error(`\nerror: ${message}\n`);
    process.exit(1);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
