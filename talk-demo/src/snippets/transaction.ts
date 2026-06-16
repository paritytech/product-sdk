import { SignerManager } from "@parity/product-sdk";

// The host derives an app-scoped "product account" for this identity and signs
// with it. This must match the identifier the host binds the container to — for
// this dev app that's its URL, "localhost:4337" (same as createApp's `name`).
// A `*.dot` DotNS name works here too; a *legacy* (user wallet) account does NOT:
// the desktop host only implements raw signing for the product account, so
// signing with a legacy account fails there with "Account can't be derived from
// product account id" even though the browser host allows it.
const PRODUCT_ACCOUNT = "localhost:4337";

// createApp's wallet API doesn't expose product accounts, so this beat uses
// SignerManager directly (the App still drives the rest of the demo).
const signer = new SignerManager({ dappName: "talk-demo" });

// Sign a message with the user's host-held key. The host prompts on their phone.
// (signBytes under the hood — no chain submission, so no funded account needed.)
export async function signMessage(text: string): Promise<Uint8Array> {
  if (signer.getState().status !== "connected") {
    const session = await signer.connect();
    if (!session.ok) throw session.error;
  }

  const account = await signer.getProductAccount(PRODUCT_ACCOUNT, 0);
  if (!account.ok) throw account.error;

  const bytes = new TextEncoder().encode(text);
  return account.value.getSigner().signBytes(bytes);
}
