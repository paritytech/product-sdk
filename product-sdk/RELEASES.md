# Releases

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing.

## Creating a Release

1. **Create a changeset** when making changes:
   ```bash
   pnpm changeset
   ```
   - Select affected packages
   - Choose bump type: `patch` (fixes), `minor` (features), `major` (breaking)
   - Write a short description

2. **Commit the changeset** with your PR (`.changeset/*.md` file)

3. **Merge to main** - the release workflow automatically:
   - Bumps versions and updates CHANGELOGs
   - Creates git tags
   - Publishes to NPM

## Notes

- No changeset = no release
- Multiple changesets can accumulate across PRs
- Highest bump type wins per package (patch < minor < major)
