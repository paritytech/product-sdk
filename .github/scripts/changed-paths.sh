#!/usr/bin/env bash
# Whether a pull request touches any path matching the extended regex in $1.
# Writes `run=true` or `run=false` to $GITHUB_OUTPUT.
#
# Required checks must report on every PR, so the workflows that own them
# trigger unfiltered and skip their heavy jobs with this instead of with
# `paths:`. A job skipped by `if:` counts as passing; one that never starts
# leaves the PR waiting forever. Anything uncertain answers `true`.
set -euo pipefail

pattern="$1"
out="${GITHUB_OUTPUT:-/dev/stdout}"

if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]; then
    echo "run=true" >> "$out"
    exit 0
fi

# Renames count under both names. The files API lists at most 3000 files.
files="$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/files" \
    --jq '.[] | .filename, (.previous_filename // empty)')"
if [ "$(grep -c . <<< "$files")" -ge 3000 ] || grep -qE "$pattern" <<< "$files"; then
    echo "run=true" >> "$out"
else
    echo "run=false" >> "$out"
fi
