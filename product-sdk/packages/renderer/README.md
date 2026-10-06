# @parity/product-sdk-renderer

The renderer protocol as data, plus a checker for it.

The host draws a Pocket card face, and a rendered chat body, from a `RendererNode`: a closed vocabulary of
layout and design tokens resolved by the host's own theme. A product names structure, never markup, colours
or URLs. There are eleven node types, twelve modifiers, nine semantic colour tokens, five typography presets
and one effect.

**This package does not build trees.** To write a face, reach for `@parity/product-sdk-react-renderer`,
which authors one in JSX and serializes it to a `RendererNode`. What lives here is `validateFace`, which
holds a finished tree against the vocabulary so a face is wrong at build time rather than blank on a phone,
and the vocabulary tables themselves, so anything that builds trees can hold its own coverage against the
protocol.

Nothing here is specific to Pocket, and nothing here talks to a host.

## Check a face

```ts
import { validateFace } from "@parity/product-sdk-renderer";

const verdict = validateFace(face);
verdict.ok;        // true when there are no errors
verdict.errors;    // what the protocol forbids, and no host can draw
verdict.warnings;  // what the protocol allows and no product means
```

`face` is either a parsed tree or the JSON text of one. Both are checked the same way.

**Errors are protocol violations.** An unknown node, modifier or enum name, a missing required field, a
`Size` that is not a non-negative whole number, an `Opacity` outside 0 to 255. No host can draw any of
these.

**Warnings are legal but suspect.** A prop name the host does not recognise and silently ignores, a
`Button` with no `clickAction`, a `Text` with no `String` child. Each of these draws something, just not
what you meant. Warnings never make a face invalid, so `ok` ignores them.

Every issue is a `FaceIssue` carrying three things:

```ts
for (const issue of verdict.errors) {
    issue.path;     // ".value.children[2].value.props.style", empty for the face itself
    issue.code;     // "unknown-enum", a stable name a test can match on
    issue.message;  // the prose for a human
}
```

`path` is what makes a verdict usable: it names the place and not only the problem. `code` is what a test
should assert against, because the prose is free to change.

## Stop a build on a broken face

```ts
import { assertFaceValid } from "@parity/product-sdk-renderer";

assertFaceValid(face);  // throws FaceValidationError on any error
```

The thrown `FaceValidationError` carries the whole verdict on `.verdict`, warnings included, and its
message lists every error with its path. Warnings do not throw, because a build that failed on advice
would teach people to switch it off.

## Host bounds are opt in

Depth limits, size ceilings and the cap on a face's size in bytes are **not** protocol. They belong to
whichever app draws the face, and they differ between apps. So `validateFace` never counts a breach of one
as a protocol error unless you name the host it belongs to.

By default, a breach of any known host's bound is reported as a warning naming that host. Name a host to
have its bounds enforced as errors instead:

```ts
import { androidLimits, KNOWN_HOST_LIMITS, validateFace } from "@parity/product-sdk-renderer";

validateFace(face);                          // protocol only, host bounds are advice
validateFace(face, { host: androidLimits }); // android's bounds are now errors
```

A face that passes with no host named is correct against the shared protocol and owes nothing to any
particular renderer. Name a host when you are about to ship to one. `androidLimits` is the Polkadot
Android app, and `KNOWN_HOST_LIMITS` is every host whose bounds we know, which is what an unnamed check
runs through.

Each `HostLimits` is a plain record, so you can read a bound rather than only breach it:

```ts
androidLimits.name;          // "android"
androidLimits.maxDepth;      // 32, counting the root as level 1
androidLimits.maxSizeValue;  // 2147483647
androidLimits.maxBytes;      // 262144
```

## The byte cap measures what you pass

The size check measures the argument, not some canonical form of it. A string is measured as it stands,
and a tree is measured as compact JSON.

This matters when you write a preview face to a file. The host measures the bytes it reads, so indented
JSON is roughly three times what the tree alone would measure. Pass the string you are about to write:

```ts
const json = `${JSON.stringify(face, null, 2)}\n`;
assertFaceValid(json, { host: androidLimits });  // the text is what the host reads
writeFileSync(path, json);
```

Check the tree instead and you have measured something smaller than the file, which is the one case where
a green build still ships a face the device refuses.

## The vocabulary as data

`NODE_SCHEMA` and `MODIFIER_SCHEMA` are the tables the validator itself reads, keyed by protocol tag. They
are exported so that anything building trees can hold its own coverage against the protocol rather than
against a list somebody remembered to update:

```ts
import { MODIFIER_SCHEMA, NODE_SCHEMA } from "@parity/product-sdk-renderer";

// EMITTED_NODES and EMITTED_MODIFIERS are your builder's own lists of the tags it can produce.
test("every node the protocol declares is reachable from my builder", () => {
    expect([...EMITTED_NODES].sort()).toEqual(Object.keys(NODE_SCHEMA).sort());
});

test("every modifier the protocol declares is reachable from my builder", () => {
    expect([...EMITTED_MODIFIERS].sort()).toEqual(Object.keys(MODIFIER_SCHEMA).sort());
});
```

This is how `@parity/product-sdk-react-renderer` keeps its JSX components honest. Each table is pinned at
compile time to the matching type in `@parity/truapi`, so a vocabulary that grows in a later protocol
version fails to typecheck here rather than falling silently behind. That pin is what makes the test worth
writing: the table cannot drift from the protocol, so holding your own list against it really does catch a
node type you never wired up.

`NODE_SCHEMA[tag]` gives a `NodeSchema`, which says whether the node carries `modifiers` and `children`,
and declares its `props`. `MODIFIER_SCHEMA[tag]` gives the `FieldKind` that modifier's `value` holds.

## Also exported

The protocol's own vocabulary types are re-exported, so one import covers a face: `RendererNode`,
`Modifier`, `Dimensions`, `Size`, `ColorToken`, `TypographyStyle`, `ButtonVariant`, `Shape`,
`ImageSource`, `ImageFit`, `Effect`, `Arrangement`, `BlendingMode`, `ContentAlignment`,
`HorizontalAlignment`, `VerticalAlignment`.
