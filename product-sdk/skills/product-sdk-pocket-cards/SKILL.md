---
name: product-sdk-pocket-cards
description: >
  Build, check and draw a Pocket card face in product-sdk.
  Use when: adding a card to the Polkadot app's Pocket tab, writing or debugging a RendererNode tree,
  a card draws blank or is refused, wiring a worker that answers renderer.onRender, or writing the
  static preview face the approval sheet shows.
  Covers @parity/product-sdk-renderer (face builders, validateFace, host limits) and
  @parity/product-sdk-host (getPocketManager, drawing, actions, card list, removal).
---

# Pocket cards

A Pocket card is a face a product draws into the Polkadot app's Pocket tab. The product declares its cards
in its **worker** manifest and answers the host whenever a card is on screen.

| Package | Import | Purpose |
|---------|--------|---------|
| renderer | `@parity/product-sdk-renderer` | build a face, check it before it reaches a device |
| host | `@parity/product-sdk-host` | draw the card, hear presses, list and remove cards |

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

## Build a face

```ts
import {
    background, button, column, fillWidth, padding, rounded, row, text,
} from "@parity/product-sdk-renderer";

// A face is built from state rather than stored, because a card redraws.
const loyaltyFace = (stamps: number) =>
    column(
        [
            row([text("Loyalty", { style: "TitleMediumRegular", color: "FgPrimary" })], {
                modifiers: [fillWidth()],
                horizontalArrangement: "SpaceBetween",
            }),
            text(`${stamps} of 10 stamps`, { style: "BodySmallRegular", color: "FgSecondary" }),
            button("Stamp", { clickAction: "stamp", variant: "Primary" }),
        ],
        { modifiers: [fillWidth(), padding(20), background("BgSurfaceContainer", rounded(20))] },
    );
```

The vocabulary is small and closed: 11 node types, 12 modifiers, **9 semantic colour tokens**, 5
typography presets, one effect. There are no literal colours and no gradients. Images come from a Bulletin
CID or a path inside your archive, never a URL.

## Check it before it reaches a device

```ts
import { validateFace, assertFaceValid, androidLimits } from "@parity/product-sdk-renderer";

const face = loyaltyFace(6);

const verdict = validateFace(face);
verdict.errors;    // the protocol forbids these, no host can draw them
verdict.warnings;  // legal, and probably not what you meant
```

Each issue carries a `path` such as `.value.children[2].value.props.style`, so it names the place and not
just the problem.

`assertFaceValid(face, { host: androidLimits })` throws instead, which is what a build step wants. Name
the host. Without it a breach of that host's depth, size or byte bounds is only a warning, so a build step
calling `assertFaceValid(face)` alone will happily ship a face the device then refuses.

## The traps

These are the ones that cost real time:

- **`Padding` and `Margin` need `top` and `end`.** They are a shorthand where `bottom` defaults to `top`
  and `start` to `end`. Omitting `end` is a missing field, not a default. The builder's
  `padding(vertical, horizontal)` makes this unreachable, so use it rather than writing `Dimensions`.
- **Sizes are non-negative whole numbers.** `16.5` is refused, not rounded.
- **Enum names are PascalCase.** `FgPrimary`, `TitleMediumRegular`. A wrong one is refused.
- **A misspelled prop is ignored, not refused.** `colour` for `color` does nothing at all. `validateFace`
  warns about it; nothing else will tell you.
- **A `Text` draws nothing without a `String` child.** The builder's `text()` adds it for you.
- **A `Button` with no `clickAction` is inert.** It draws and reports nothing when pressed.
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

```ts
import { getPocketManager } from "@parity/product-sdk-host";

const pocket = await getPocketManager();   // null outside a host container

let stamps = 0;

// Keep the sink the render was opened with. It is the only way to draw again,
// and an action handler has no other way to change the card.
let repaint: (() => void) | null = null;

pocket?.drawCard("loyalty", (send) => {
    repaint = () => send(loyaltyFace(stamps));
    repaint();
    return () => {
        repaint = null;                     // the host calls this when the card leaves
    };
});

pocket?.subscribeCardAction("loyalty", (action) => {
    if (action.actionId !== "stamp") return;
    stamps += 1;
    repaint?.();                            // nothing changes on screen without this
});

pocket?.subscribeCards((cards) => console.log(cards.map((card) => card.cardId)));
await pocket?.removeCard("loyalty");        // rejects on a card the host placed itself
```

**The render stays open while the card is on screen.** Call `send` as often as you like. That is the whole
difference between a card and a picture.

**Return the cleanup.** It is what stops your timer. Without it the timer outlives the card.

**`subscribeCardAction` is the only way back from a card.** A face is a one way stream, and a press arrives
as the `clickAction` id you named in the tree.

One registration serves every card, so calling `drawCard` twice is safe and the cards do not interfere.

## The preview face, and the worker bundle

Generate the preview from the same module the worker renders from, and check it as you write it:

```ts
const json = `${JSON.stringify(loyaltyFace(6), null, 2)}\n`;
assertFaceValid(json, { host: androidLimits });   // the text is what the host measures
writeFileSync(path, json);
```

**Minify the worker bundle.** The host reads worker JS as Latin-1. esbuild keeps string literals and
identifiers ASCII but copies comments through verbatim, and `@parity/truapi`'s JSDoc alone carries em
dashes into the output. `--legal-comments=none` does not help. `--minify` does, and it is worth asserting
the result:

```bash
esbuild src/worker.ts --bundle --outfile=dist/worker.js --format=esm --target=es2022 --minify
```

## Trying it on a device

`references/integration-testing.md` beside this file is the full loop: how to link an unpublished SDK
build into a product, get a card onto a running host, and assert the render and action streams separately.
It also lists what is proven, what is not, and the traps that cost the most time.

`docs/pocket-card-dev-loop.md` in `paritytech/polkadot-android-community` has the Android-specific loops.
Both need `adb`.
