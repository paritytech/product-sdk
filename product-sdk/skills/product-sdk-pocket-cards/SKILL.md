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
    "kind": "worker",
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

const face = column(
    [
        row([text("Loyalty", { style: "TitleMediumRegular", color: "FgPrimary" })], {
            modifiers: [fillWidth()],
            horizontalArrangement: "SpaceBetween",
        }),
        text("6 of 10 stamps", { style: "BodySmallRegular", color: "FgSecondary" }),
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

const verdict = validateFace(face);
verdict.errors;    // the protocol forbids these, no host can draw them
verdict.warnings;  // legal, and probably not what you meant
```

Each issue carries a `path` such as `.value.children[2].value.props.style`, so it names the place and not
just the problem. `assertFaceValid(face)` throws instead, which is what a build step wants.

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

pocket?.drawCard("loyalty", (send) => {
    send(face());
    const timer = setInterval(() => send(face()), 1000);
    return () => clearInterval(timer);      // the host calls this when the card leaves
});

pocket?.subscribeCardAction("loyalty", (action) => {
    if (action.actionId === "stamp") { /* redraw */ }
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
const json = `${JSON.stringify(loyaltyFace(state), null, 2)}\n`;
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

`docs/pocket-card-dev-loop.md` in `paritytech/polkadot-android-community` has two loops for working against
a debug build without deploying anything. Both need `adb`.
