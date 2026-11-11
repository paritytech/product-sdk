# Pocket card example

A worker that draws one Pocket card, `loyalty`, front and back, and generates the static faces the host's
approval sheet shows before the card is added, and the static back it shows until the worker draws one.

The point of it is that the live card and the approval sheet come from **one module**. A sheet that
disagrees with the card it is offering is worse than no sheet.

## Run it

```bash
pnpm --filter "@parity/product-sdk-pocket-card-example" test        # the faces are drawable
pnpm --filter "@parity/product-sdk-pocket-card-example" build       # faces, bundle, and the ASCII check
```

`build` does three things in order. It writes `dist/pocket/*.json`, the preview states and `back.json`,
checking each before writing it.
It bundles the worker to a single `dist/worker.js`. Then it asserts that bundle is ASCII.

## The files

| File | What it is |
|---|---|
| `src/face.tsx` | the face and the back, authored in JSX with `@parity/product-sdk-react-renderer` |
| `src/member-code.ts` | the QR code on the back, as the hex an inline image carries |
| `src/worker.tsx` | the worker entry, drawing through `getPocketManager()` |
| `src/render.ts` | mounts a face once and hands back the tree it produced |
| `src/write-faces.tsx` | writes and checks the static faces and back, and checks the manifest agrees |
| `src/face.test.tsx` | every state of the card draws, and the back draws, as the text that ships |
| `src/worker.test.tsx` | the stamps survive the card leaving the screen, and a stamp on the back counts |
| `scripts/check-bundle.mjs` | the bundle is ASCII only |
| `manifest/worker.json` | what the product publishes so the host knows the card exists |

## Three things that cost time to find out

**The bundle has to be minified.** The host reads worker JS as Latin-1. esbuild keeps output ASCII for
string literals and identifiers but copies comments through verbatim, and `@parity/truapi`'s JSDoc alone
puts three em dashes into this worker. `--legal-comments=none` does not help, because they are ordinary
comments. `--minify` drops them, and `scripts/check-bundle.mjs` proves the result.

**The card's state cannot live in the drawn tree.** `drawPocketCard` mounts a fresh tree every time the
host puts the card on screen and unmounts it when the card leaves, so a `useState` inside the card resets
on every tab switch. `src/worker.tsx` holds the stamps at module scope and subscribes the tree to them.

**A face gets large quickly.** Each of these is about 12 KB, and almost all of it is the ten stamp boxes,
because the vocabulary has no progress bar. The cap is 256 KB on the android host, so ten boxes is fine
and a hundred would not be.

## Publishing it for real

This example stops at the bundle. Getting the card onto a device means publishing the archive and a worker
manifest that points at it, which `bulletin-deploy` does. `manifest/worker.json` here is the shape the
manifest takes: `includes.pocket` true, and one entry in `pocket.cards` whose `id` matches the `CARD_ID`
the worker draws. Get that id wrong and the card silently keeps its static face with nothing saying why.
