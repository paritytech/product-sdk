import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface PackageRegistry {
  /** Folder names under `packages/` that contain a documentable workspace package. */
  folders: ReadonlySet<string>;
  /** Map package name (from package.json `name`) → folder name. */
  nameToFolder: ReadonlyMap<string, string>;
  /** Map folder name → package name. */
  folderToName: ReadonlyMap<string, string>;
}

// Scan `packagesDir` and build a registry of every documentable package.
//
// "Documentable" means the folder contains a `package.json` with a `name` field
// AND a `src/index.ts` entry point. Packages without `src/index.ts` (e.g.
// tooling packages like `descriptors` that only expose generated artifacts)
// are intentionally skipped.
//
// The registry decouples the docs generator from any hardcoded list of
// folders or package names, so renaming a package or adding a new one needs
// no changes here.
export function discoverPackages(packagesDir: string): PackageRegistry {
  const folders = new Set<string>();
  const nameToFolder = new Map<string, string>();
  const folderToName = new Map<string, string>();

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(packagesDir, entry.name);
    const pkgJsonPath = join(pkgDir, "package.json");
    const entryFile = join(pkgDir, "src", "index.ts");
    if (!existsSync(pkgJsonPath) || !existsSync(entryFile)) continue;

    let pkgJson: { name?: string };
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string };
    } catch {
      continue;
    }
    if (!pkgJson.name) continue;

    folders.add(entry.name);
    nameToFolder.set(pkgJson.name, entry.name);
    folderToName.set(entry.name, pkgJson.name);
  }

  return { folders, nameToFolder, folderToName };
}
