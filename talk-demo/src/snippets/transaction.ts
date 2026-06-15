import { app } from "../sdk";

// Sign a message with the user's host-held key. The host prompts on their phone.
// (signRaw under the hood — no chain submission, so no funded account needed.)
export async function signMessage(text: string): Promise<Uint8Array> {
  if (!app.wallet.getSelectedAccount()) {
    const { accounts } = await app.wallet.connect();
    app.wallet.selectAccount(accounts[0].address);
  }
  return app.wallet.signMessage(text);
}
