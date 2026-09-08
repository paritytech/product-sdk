#!/usr/bin/env bash
# docs-deploy.yml only runs on release days, so check it here instead.
set -u

wf="${1:-.github/workflows/docs-deploy.yml}"
rc=0

# grep exits 2 on a missing file, which reads as "no match",
# so without this the guard passes while checking nothing.
if [ ! -f "$wf" ]; then
    echo "::error::$wf not found. If the deploy workflow moved, point this guard at it."
    exit 1
fi

bulletin_step="$(awk '
    /- name: Deploy to Bulletin Chain/ { inside = 1; next }
    inside && /^[[:space:]]*-[[:space:]]/ { exit }
    inside { print }
' "$wf")"

# bulletin-deploy resolves the TLD from the target environment,
# so a literal one breaks on every other.
if grep -nE 'bulletin-deploy .*\.(dot|paseo|test)\b' "$wf"; then
    echo "::error file=$wf,title=Deploy domain carries a TLD::Pass the bare label. The environment decides the suffix."
    rc=1
fi

# Unpinned, an upstream release changes this workflow with no
# commit here. A tag such as @latest is not a pin.
if grep -nE 'npm (install|i) (-g|--global) [^[:space:]]+' "$wf" | grep -vE '@[0-9]'; then
    echo "::error file=$wf,title=Global install is unpinned::Pin to a version, not a tag."
    rc=1
fi

if ! printf '%s\n' "$bulletin_step" | grep -qE '^[[:space:]]*continue-on-error:[[:space:]]*true[[:space:]]*$'; then
    echo "::error file=$wf,title=A Bulletin failure can skip the Pages deploy::Set continue-on-error: true on the Bulletin step."
    rc=1
fi

if ! printf '%s\n' "$bulletin_step" | grep -qE '^[[:space:]]*id:[[:space:]]*bulletin[[:space:]]*$'; then
    echo "::error file=$wf,title=The Bulletin step lost its id::The re-raise step reads steps.bulletin.outcome, so the step must keep id: bulletin."
    rc=1
fi

if ! grep -qE "steps\.bulletin\.outcome == 'failure'" "$wf"; then
    echo "::error file=$wf,title=A Bulletin failure would be silent::Keep the step that re-raises steps.bulletin.outcome."
    rc=1
fi

exit $rc
