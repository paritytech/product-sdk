// Dev-machine-only pnpm hook: point `@parity/truapi` at a local checkout during
// the truapi migration. This file is GITIGNORED and intentionally NOT committed.
//
// On CI / other machines `LOCAL_TRUAPI` does not exist, so the hook no-ops and
// `@parity/truapi` resolves from the catalog (^0.3.0) instead. See
// local-docs/truapi-migration.md.
//
// After (re)creating this file, run `pnpm install` to apply the link. The
// resulting lockfile change points at the local link — do not commit it.
const fs = require("node:fs");

const LOCAL_TRUAPI = "/Users/vale/Development/truapi/js/packages/truapi";

function readPackage(pkg) {
    // No local checkout (CI / other machines): leave the catalog version in place.
    if (!fs.existsSync(LOCAL_TRUAPI)) return pkg;

    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        if (pkg[field]?.["@parity/truapi"]) {
            pkg[field]["@parity/truapi"] = `link:${LOCAL_TRUAPI}`;
        }
    }
    return pkg;
}

module.exports = { hooks: { readPackage } };
