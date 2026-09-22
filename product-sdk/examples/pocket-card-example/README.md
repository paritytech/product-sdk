# Pocket card example

A worker that draws one Pocket card, `loyalty`, and generates the static faces the host's approval sheet
shows before the card is added.

The point of it is that the live card and the approval sheet come from **one module**. A sheet that
disagrees with the card it is offering is worse than no sheet.

## Run it

```bash
pnpm --filter "@parity/product-sdk-pocket-card-example" test        # the faces are drawable
pnpm --filter "@parity/product-sdk-pocket-card-example" build       # faces, bundle, and the ASCII check
```

`build` does three things in order. It writes `dist/pocket/*.json`, checking each face before writing it.
It bundles the worker to a single `dist/worker.js`. Then it asserts that bundle is ASCII.

## The files

| File | What it is |
|---|---|
| `src/face.ts` | the face, built with `@parity/product-sdk-renderer` |
| `src/worker.ts` | the worker entry, drawing through `getPocketManager()` |
| `src/write-faces.ts` | writes and checks the approval sheet faces |
| `src/face.test.ts` | every state of the card draws with no errors and no warnings |
| `scripts/check-bundle.mjs` | the bundle is one file and ASCII only |
| `manifest/worker.json` | what the product publishes so the host knows the card exists |

## Three things that cost time to find out

**The bundle has to be minified.** The host reads worker JS as Latin-1. esbuild keeps output ASCII for
string literals and identifiers but copies comments through verbatim, and `@parity/truapi`'s JSDoc alone
puts three em dashes into this worker. `--legal-comments=none` does not help, because they are ordinary
comments. `--minify` drops them, and `scripts/check-bundle.mjs` proves the result.

**The cleanup you return is what stops your timer.** The host calls it when the card leaves the screen.
Without it the timer outlives the card and keeps sending faces into a render nobody is watching.

**A face gets large quickly.** Each of these is about 12 KB, and almost all of it is the ten stamp boxes,
because the vocabulary has no progress bar. The cap is 256 KB on the android host, so ten boxes is fine
and a hundred would not be.

## Publishing it for real

This example stops at the bundle. Getting the card onto a device means publishing the archive and a worker
manifest that points at it, which `bulletin-deploy` does. `manifest/worker.json` here is the shape the
manifest takes: `includes.pocket` true, and one entry in `pocket.cards` whose `id` matches the `CARD_ID`
the worker draws. Get that id wrong and the card silently keeps its static face with nothing saying why.
