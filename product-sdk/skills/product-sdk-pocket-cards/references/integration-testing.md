# Pocket card support: integration testing, and what is still unproven

Two questions this answers. **Is the Pocket feature in `@parity/product-sdk` complete?** And **how do you
repeat this testing against a different host**, which is what the iOS work needs.

Run 2026-09-22 against the Android debug app on an emulator, with `humanity-spa` as the product and the
SDK at `feat/product-sdk-pocket-example` (PRs 388, 390, 392).

**Short answer: the product half is proven, the host surface is proven except for three things, and one
version conflict stops a product from having everything at once.** Details below.

## The result

### Proven on a device

| # | What | How it was shown |
|---|---|---|
| 1 | Builders produce protocol-valid trees | 77 SDK unit tests, plus all 5 generated Humanity faces validate with 0 errors and 0 warnings against `androidLimits` |
| 2 | The live face and the approval-sheet face come from one module | `humanity-face.ts` feeds both the worker and `write-pocket-faces.mts` |
| 3 | Worker bundle is one ASCII ESM file | asserted in the build, 0 non-ASCII characters |
| 4 | `getPocketManager()` resolves inside a host container | worker logs "pocket card renderer registered" |
| 5 | `drawCard` puts a face on screen | the card draws in the Pocket tab |
| 6 | `drawCard` redraws in place | the countdown on the face moves between screenshots |
| 7 | An async draw handler works | the handler awaits `resolveFace()` before its first `send` |
| 8 | `subscribeCardAction` delivers presses | worker logs "pocket card ping 1" and "ping 2", and the face reads "pressed 2x" |
| 9 | The cleanup returned by the handler runs when the render ends | worker logs "pocket card released" on removal |
| 10 | The approval sheet draws the generated static face | the sheet showed `devicehood.json`, sample name and all |
| 11 | The add-card deeplink flow | remove, then re-add, then the live card returns |
| 12 | `removeCard` resolves and ends the render | card reverted to the host's bundled face, cleanup ran |

Item 12 needed `@parity/truapi@0.17.0`. Everything else ran on `0.16.0`. That split is the problem, see
below.

### Not proven, and why

| # | What | Why it could not be run |
|---|---|---|
| A | `subscribeCards` delivers the card list | the subscription is accepted with no item and no error. The debug product has no **published** `pocket.cards`, so the host publishes no collection for it. Needs a published manifest. |
| B | One `onRender` registration multiplexes two cards | the debug Product bots form takes a **single** card id. Needs a published manifest with two cards. |
| C | A throwing or rejecting handler costs one render, not every card | same reason as B: you need a second card to observe that the first survives |

B and C are the headline claims of the host wrapper. They hold in unit tests against a fake client, and
they have **not** been shown on a device. Closing them means publishing a manifest with two cards, which
is the `bulletin-deploy` path rather than the debug loop.

### The one thing that blocks "complete"

**A product cannot currently have both the action stream and the pocket client.**

- `drawCard` and `subscribeCardAction` need only `client.renderer`, present in truapi `0.16.0`.
- `subscribeCards` and `removeCard` need `client.pocket`, which arrives in `0.17.0`.
- On this Android build, `0.17.0` kills `renderer.actionSubscribe()` the moment it is subscribed:

```
SubscriptionError {"tag":"MalformedFrame","value":{"reason":"Input buffer has still data left after decoding!"}}
```

So a card that needs the card list or removal loses its button presses, and a card that needs presses
cannot read or remove its own card. Until that is resolved the feature is complete in the SDK and
incomplete in practice.

**This needs the host team.** Either the emulator build predates 0.17.0's wire change, or 0.17.0 is wrong.
Worth checking before anyone designs around it.

## Where iOS starts from

Checked in `polkadot-ios-community` at `0fd4547`, because it decides how much of this you can reuse today:

- **`includes.pocket` is parsed** as a plain `Bool` (`ProductManifestDTO.swift`,
  `ProductExecutable.includesPocket`). `pocket.cards[]` is not, so card id, title and preview path have
  nowhere to land.
- **`onRenderWidget` exists but is chat only.** `ContainerBridge+HostApi.swift` wires it through
  `registerChatRenderWidget`, keyed by `messageId`. There is no `RenderContext`, so no `PocketCard`
  variant to dispatch on.
- **No Pocket UI, no face decoder, no card action stream.**

The product half of this document works on iOS today. The host half does not exist yet. What you are
really building first is: parse `pocket.cards`, add a `PocketCard` render context, decode a
`RendererNode` tree, and deliver actions back.

## How to run it

### 1. Build the SDK and link it into the product

Nothing is published yet.

```bash
cd product-sdk && pnpm install && pnpm -r build
```

Then overlay the built `dist` folders into the product's `node_modules`: `product-sdk-host`,
`product-sdk-renderer` (a new package, so create the directory), and `product-sdk`, whose `exports` map
must be copied too or `./renderer` will not resolve. Do **not** `npm pack` the umbrella: its dependencies
use the `workspace:` protocol and an install goes looking for versions that are not on the registry.

Keep it in a script. **Every `npm install` silently undoes it.**

### 2. Write the face, and check it before the device

```ts
import { validateFace, assertFaceValid, androidLimits } from "@parity/product-sdk/renderer";

validateFace(face);                          // protocol only
validateFace(face, { host: androidLimits }); // plus one host's own bounds
```

Errors are protocol violations. Warnings are legal shapes you probably did not mean, such as a prop name
the host ignores. When you write the preview file, validate **the text you are about to write**: indented
JSON is bigger than the compact form and the byte cap applies to the file.

### 3. Draw it

```ts
const pocket = await getPocketManager();   // null outside a host container
pocket?.drawCard("humanity", (send) => {
    send(face());
    const timer = setInterval(() => send(face()), 1000);
    return () => clearInterval(timer);      // runs when the render ends
});
pocket?.subscribeCardAction("humanity", (action) => { /* action.actionId */ });
```

A one second redraw is worth keeping while you work: a moving counter is how you tell a live card from a
picture at a glance.

### 4. Bundle it

One file, ESM, **ASCII only**, because the host reads worker JS as Latin-1. **Minify it.** Bundlers keep
string literals and identifiers ASCII but copy comments through verbatim, and `@parity/truapi`'s JSDoc
alone carries em dashes. `--legal-comments=none` does not help, they are ordinary comments. Then assert
the output is ASCII rather than trusting it.

### 5. Serve, tunnel, point the host at it

```bash
npx serve -l 5173 packages/chat-worker/dist   # must send Cache-Control: no-store
adb reverse tcp:5173 tcp:5173                 # iOS: a simulator may need nothing
```

Android has a debug menu with **Product bots** taking a dotNS name, a script URL, and one card id, title
and face URL. Use a name with **no published worker**, because a published worker always wins. The TLD is
appended rather than validated, so read the product id off the list row rather than trusting what you
typed.

Then add the card:

```bash
adb shell am start -n <package>/<activity> -a android.intent.action.VIEW \
  -d "'polkadotapp://<product-id>/-/pocket/add?card=<card-id>'"
```

The URL is quoted twice because it crosses two shells and the device's reads `?` as a glob.

### 6. Assert, in this order

They fail independently, so check them separately.

```bash
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png .
adb logcat -d | grep -i pocket
```

1. **Render stream**: the counter changes between two screenshots seconds apart.
2. **Action stream**: pressing the button changes the next face, and the worker logs the action id.

The second was broken for me while the first looked perfect.

## The traps

Every one of these is silent.

**A split `@parity/truapi` breaks the transport.** `npm install` will leave `0.17.0` hoisted at the root
while both workspaces keep `0.16.0`. The SDK caches one TruAPI client at module scope, so two physical
copies make the webview message ports clobber each other, and you also get type errors from two different
`TrUApiClient`s. `npm install <pkg>@<older>` does **not** downgrade a hoisted copy. What works:

```bash
git checkout package-lock.json && rm -rf node_modules packages/*/node_modules && npm ci
```

Check with `find . -path "*/node_modules/@parity/truapi/package.json"`. Expect exactly one.

**A dead subscription looks like your filter dropping events.** When presses vanished, the natural
conclusion was a bad card-id filter. The stream was already dead. Only a raw
`renderer.actionSubscribe()` with its `error` callback logged shows this, because the manager filters
internally. That one diagnostic turned a guessing game into a two minute fix.

**Confirm your tap lands before you blame the protocol.** I lost time believing the card's button was
inert in the collapsed Pocket stack. It is not. Dumping the view hierarchy showed it clickable at known
bounds, and a tap at its centre logged the press at once. The earlier taps had been computed from a
screenshot taken before the stack shifted.

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml
```

The node with the button's text is `clickable=false`, and its clickable parent carries the bounds.

**The worker is kept warm and the bundle is cached.** Rebuilding is not enough. Serve with `no-store` and
`adb shell am force-stop <package>` between runs, or you are reading results from the code you replaced.

**An emulator can be running with no window.** Mine had been started `-no-window` by an earlier session,
so `adb` and screenshots worked perfectly while nothing was on screen.

**A pinned card does not disappear when removed.** `removeCard` on the Humanity card resolved and ended
the product's stream, and the card stayed with the host's bundled face. That is the pinned-card handover
working in reverse, not a failure.

## Something unrelated that you will see

The worker logs a flood of transport errors, roughly 250 in 15 seconds:

```
Transport error TypeError: innerDecoder is not a function
[truapi] unsupported frame with discriminant (0, 0): request <id> is not pending and has no subscription
```

**This is not the Pocket path.** I confirmed it by starting the app and never opening the Pocket tab: 248
errors with zero card renders. It does not stop the card drawing or the presses arriving. Worth someone
tracing, but do not let it distract you from a Pocket problem.

## What I ran

- SDK: `product-sdk` at `feat/product-sdk-pocket-example`, PRs 388, 390, 392.
- Product: `humanity-spa` at `feat/pocket-card-via-product-sdk`, commit `cd49773`. The face is
  `packages/shared/src/pocket/humanity-face.ts` on the builders, the worker half is
  `packages/chat-worker/src/pocket-card.ts` on `getPocketManager`.
- Host: Android debug app on an emulator, product `humanity.testnet`, card id `humanity`.
- truapi `0.16.0` for everything except the `removeCard` run, which needed `0.17.0`.
