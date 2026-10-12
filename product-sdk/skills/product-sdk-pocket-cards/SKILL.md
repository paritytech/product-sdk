---
name: product-sdk-pocket-cards
description: >
  Author, check and draw a Pocket card face in product-sdk.
  Use when: adding a card to the Polkadot app's Pocket tab, writing a card face in JSX, turning a
  component into a RendererNode, a card draws blank or is refused, wiring a worker that draws a live
  card, or writing the static preview face the approval sheet shows.
  Covers @parity/product-sdk-react-renderer (JSX components, createRenderer, drawPocketCard),
  @parity/product-sdk-renderer (validateFace, assertFaceValid, host limits) and
  @parity/product-sdk-host (getPocketManager, card list, removal).
---

# Pocket cards

A Pocket card is a face a product draws into the Polkadot app's Pocket tab. The product declares its cards
in its **worker** manifest and answers the host whenever a card is on screen.

| Package | Import | Purpose |
|---------|--------|---------|
| react-renderer | `@parity/product-sdk-react-renderer` | write the face in JSX, and draw it |
| renderer | `@parity/product-sdk-renderer` | check it before it reaches a device |
| host | `@parity/product-sdk-host` | reach the Pocket manager, list and remove cards |

Worked example: `examples/pocket-card-example/`.

## The shape of the whole thing

1. The worker manifest declares the cards. `includes.pocket: true`, plus one entry per card:

```json
{
    "$v": 1,
    "kind": "worker",
    "appVersion": [0, 1, 0],
    "entrypoint": "worker.js",
    "includes": { "pocket": true },
    "pocket": {
        "cards": [{ "id": "loyalty", "title": "Loyalty", "preview": "pocket/partial.json" }]
    }
}
```

2. `preview` is a path inside the worker archive to a face written as JSON. The host draws it in the
   approval sheet, before any of your code runs.
3. Once the card is added, the host asks the worker for a face whenever the card is on screen.

**The `id` in the manifest must match the id the worker draws.** Get it wrong and the card silently keeps
its static preview face, with nothing on the device saying why.

## Write a face

Faces are authored in JSX. `@parity/product-sdk-renderer` has no builder functions, so anything that calls
`column(...)` or `text(...)` is written against an API that no longer exists.

```tsx
import { Button, Column, Row, Text } from "@parity/product-sdk-react-renderer";

interface LoyaltyFaceProps {
    stamps: number;
    goal: number;
    onStamp?(): void;
}

export function LoyaltyFace({ stamps, goal, onStamp }: LoyaltyFaceProps) {
    return (
        <Column
            fillMaxWidth
            padding={20}
            background={{ color: "BgSurfaceContainer", shape: { tag: "Rounded", value: 20 } }}
            verticalArrangement="SpaceBetween"
        >
            <Row fillMaxWidth horizontalArrangement="SpaceBetween">
                <Text style="TitleMediumRegular" color="FgPrimary">Loyalty</Text>
                <Text style="BodySmallRegular" color="FgSecondary">{`${stamps} of ${goal}`}</Text>
            </Row>
            <Button text="Stamp" variant="Primary" onClick={onStamp ?? (() => {})} />
        </Column>
    );
}
```

The components are `Box`, `Button`, `Column`, `Effect`, `Image`, `Row`, `Spacer`, `Text` and `TextField`.
Modifiers are plain props on any of them except `Effect`: `padding`, `margin`, `background`, `border`,
`width`, `height`, `minWidth`, `minHeight`, `fillMaxWidth`, `fillMaxHeight`, `opacity`, `blendingMode`.

The vocabulary is small and closed: 11 node types, 12 modifiers, **9 semantic colour tokens**, 5
typography presets, one effect. No literal colours, no gradients. Images come from a Bulletin CID or a
path inside your archive, never a URL.

**A press is `onClick`, not an action id.** react-renderer mints the id behind `onClick` and routes the
press back to that handler, so you never name one and never match on one. The same goes for `onValueChange`
on a `TextField`.

**Gaps in a row: prefer a margin over interleaved `Spacer` nodes, and name all four edges.** Interleaving
spacers needs a keyed fragment per item, which React warns about, and it doubles the node count. A margin
is the better shape, but `Dimensions` is a shorthand that fills `bottom` from `top` and `start` from `end`,
so `margin={{ top: 0, end: 4 }}` is **not** a gap on the end edge alone. `start` defaults to `end`, giving
4 on both horizontal edges: the space between two neighbours becomes 8, and the first item is indented by
4. Write every edge you mean:

```tsx
<Box margin={{ top: 0, end: gapAfterThisOne, bottom: 0, start: 0 }} />
```

## Turn a face into a tree

A component is not a `RendererNode`. To check one, or to write it to a preview file, mount it once and keep
the tree it produced. There is no helper for this in the packages, so products write a small one:

```tsx
import { createRenderer } from "@parity/product-sdk-react-renderer";
import type { RendererNode } from "@parity/product-sdk-renderer";
import type { ReactNode } from "react";

export function renderOnce(element: ReactNode): RendererNode {
    const frames: RendererNode[] = [];
    const renderer = createRenderer({
        onRender: (node) => frames.push(node),
        subscribeActions: () => () => {},
    });

    renderer.mount(element);
    const mounted = frames.at(-1);
    renderer.unmount();

    if (mounted === undefined) throw new Error("the face produced no frame");
    return mounted;
}
```

**Read the last frame before unmounting.** `unmount()` emits a `Nil` face. Read after it and you get an
empty tree that validates clean and tells you nothing.

`createRenderer` and `drawPocketCard` both take a `validate` checker, which runs over every tree they
produce and reports what is wrong to the console:

```tsx
import { validateFace } from "@parity/product-sdk-renderer";

drawPocketCard(pocket, "loyalty", <LoyaltyCard />, { validate: validateFace });
```

You pass the checker rather than a flag, so a bundle that never asks for one does not carry it. It never
throws, because this runs inside React's commit where an exception leaves a tree half applied. Treat it as
a development aid. The real gate is a build step.

## Check it before it reaches a device

```tsx
import { androidLimits, assertFaceValid, validateFace } from "@parity/product-sdk-renderer";

const verdict = validateFace(renderOnce(<LoyaltyFace stamps={6} goal={10} />));
verdict.errors;    // the protocol forbids these, no host can draw them
verdict.warnings;  // legal, and probably not what you meant
```

Each issue carries a `path` such as `.value.children[2].value.props.style`, so it names the place and not
just the problem, and a `code` such as `"unknown-enum"`, which is what a test should match on.

`assertFaceValid(face, { host: androidLimits })` throws instead, which is what a build step wants. Name
the host. Without it a breach of that host's depth, size or byte bounds is only a warning, so a build step
calling `assertFaceValid(face)` alone will happily ship a face the device then refuses.

Check **every state the card can be in**, not just the one the preview shows. A state that only appears
after ten stamps is exactly the one nobody checks by hand.

## The traps

These are the ones that cost real time:

- **`Padding` and `Margin` need `top` and `end`.** They are a shorthand where `bottom` defaults to `top`
  and `start` to `end`. Omitting `end` is a missing field, not a default. In JSX, `padding={20}` covers
  every edge, so reach for the bare number unless the edges genuinely differ, and name all four when they
  do.
- **Sizes are non-negative whole numbers.** `16.5` is refused, not rounded.
- **Enum names are PascalCase.** `FgPrimary`, `TitleMediumRegular`. A wrong one is refused.
- **A misspelled prop is ignored, not refused.** `colour` for `color` does nothing at all. `validateFace`
  warns about it, and nothing else will tell you.
- **A `Text` draws nothing without a `String` child.** In JSX its children become one.
- **A `Button` with no `clickAction` is inert.** It draws and reports nothing when pressed. In JSX that
  means a `Button` with no `onClick`.
- **A `Box` with no children is fine.** It is how you draw a filled rectangle, which is what progress
  marks have to be, since the vocabulary has no progress bar.

## Host limits are not the protocol

Depth bounds, size ceilings and the cap on a face's size in bytes belong to whichever app draws the face.
The renderer RFC says a tree deeper than *the host's* bound is a decode failure, and the byte cap is one
app's constant.

```ts
validateFace(face);                          // protocol only, host bounds are warnings
validateFace(face, { host: androidLimits }); // android's bounds are errors
```

A face that passes with no host named is correct against the shared protocol and does not depend on any
particular renderer. Name a host when you are about to ship to it.

## Draw the card

`drawPocketCard` is the whole loop. It registers the card, mounts your tree onto the sink the host opened,
routes every press back to the `onClick` that asked for it, and unmounts when the card leaves the screen.

```tsx
import { getPocketManager } from "@parity/product-sdk-host";
import { drawPocketCard } from "@parity/product-sdk-react-renderer";
import { useState } from "react";

function LoyaltyCard() {
    const [stamps, setStamps] = useState(0);

    return (
        <LoyaltyFace
            stamps={stamps}
            goal={10}
            onStamp={() => setStamps((count) => count + 1)}
        />
    );
}

const pocket = await getPocketManager();  // null outside a host container

if (pocket !== null) {
    drawPocketCard(pocket, "loyalty", <LoyaltyCard />);
}
```

**The card is a component with state.** A press calls `setState` and React streams the next face through
the sink the host already opened. There is no repaint closure to keep, no action id to match on, and no
cleanup to remember. That is the whole difference between a card and a picture.

`drawPocketCard` returns a registration with `unsubscribe()`, for giving the card up while the worker keeps
running. The host tears the tree down on its own when the card leaves the screen, and mounts a fresh one if
the card comes back.

The rest of the Pocket manager is plain host API:

```ts
pocket.subscribeCards((cards) => console.log(cards.map((card) => card.cardId)));
await pocket.removeCard("loyalty");  // rejects on a card the host placed itself
```

Drawing the same card twice replaces the handler rather than stacking one, and different cards never
interfere, so one worker can draw as many as its manifest declares.

## The preview face, and the worker bundle

Generate the preview from the same module the worker renders from, so the approval sheet and the live card
cannot disagree. Check each face as you write it:

```tsx
const json = `${JSON.stringify(renderOnce(<LoyaltyFace stamps={6} goal={10} />), null, 2)}\n`;

// The host measures the text it reads. Indented JSON is about three times the
// compact form the tree alone would measure, so check the string, not the tree.
assertFaceValid(json, { host: androidLimits });

writeFileSync(path, json);
```

**Bundle with `--jsx=automatic`.** Faces are JSX, so the entry is a `.tsx` file and esbuild needs to be told
how to compile it. Without the flag the bundle fails outright.

**Minify the worker bundle.** The host reads worker JS as Latin-1. esbuild keeps string literals and
identifiers ASCII but copies comments through verbatim, and `@parity/truapi`'s JSDoc alone carries em
dashes into the output. `--legal-comments=none` does not help, because they are ordinary comments.
`--minify` does, and it is worth asserting the result afterwards:

```bash
esbuild src/worker.tsx --bundle --outfile=dist/worker.js --format=esm --target=es2022 --minify --jsx=automatic
```

Keep every string in a face ASCII for the same reason.

## Trying it on a device

`docs/pocket-card-dev-loop.md` in `paritytech/polkadot-android-community` has two loops for working against
a debug build without deploying anything. Both need `adb`.
