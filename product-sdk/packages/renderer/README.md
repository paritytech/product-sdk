# @parity/product-sdk-renderer

Build and validate renderer trees for Polkadot product surfaces — Pocket card faces, and rendered chat
bodies.

The host draws a face from a `RendererNode`: a closed vocabulary of layout and design tokens resolved by
the host's own theme. A product names structure, never markup, colours or URLs. There are eleven node
types, twelve modifiers, nine semantic colour tokens, five typography presets and one effect.

## Building a face

```ts
import { background, button, column, fillWidth, padding, rounded, text } from "@parity/product-sdk-renderer";

const face = column(
    [
        text("Loyalty", { style: "TitleMediumRegular", color: "FgPrimary" }),
        text("6 of 10 stamps", { style: "BodySmallRegular", color: "FgSecondary" }),
        button("Stamp", { clickAction: "stamp", variant: "Primary" }),
    ],
    { modifiers: [fillWidth(), padding(20), background("BgSurfaceContainer", rounded(20))] },
);
```

`padding(20)` is 20 on every edge and `padding(20, 24)` is 20 vertical and 24 horizontal. The protocol's
`Dimensions` is a shorthand where `bottom` defaults to `top` and `start` to `end`, and taking it as
vertical/horizontal is why you cannot leave out an edge by accident. Use `paddingEach` when all four
differ.

## Checking a face

```ts
import { androidLimits, validateFace } from "@parity/product-sdk-renderer";

const verdict = validateFace(face);
verdict.ok;        // no errors
verdict.errors;    // what the protocol forbids — no host can draw these
verdict.warnings;  // what the protocol allows and you probably did not mean
```

Each issue carries a `path` such as `.value.children[2].value.props.style`, so it names the place and not
only the problem. `assertFaceValid(face)` throws instead, which is what a build step wants.

Errors are protocol violations: an unknown node or enum name, a missing required field, a `Size` that is
not a non-negative whole number, an `Opacity` outside 0..255. Warnings are legal but suspect: a prop name
the host does not recognise and silently ignores, a `Button` with no `clickAction`, a `Text` with no
`String` child.

## Host bounds

Depth limits, size ceilings and the cap on a face's size in bytes are **not** protocol — they belong to
whichever app draws the face, and they differ. By default `validateFace` reports a breach of any known
host's bound as a warning naming that host. Name a host to have its bounds enforced:

```ts
validateFace(face, { host: androidLimits }); // a breach is now an error
```

A face that passes with no `host` is correct against the shared protocol and owes nothing to any
particular renderer.

The size check measures what you give it. A string is measured as it stands, a tree as compact JSON. If
you write a preview file with indentation, pass the text you are about to write, or the check measures
something smaller than the file.
