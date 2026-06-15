import { SignerManager } from "@parity/product-sdk";
import { submitAndWatch } from "@parity/product-sdk-tx";
import type { TxStatus } from "@parity/product-sdk-tx";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { Binary } from "polkadot-api";
import { getApp } from "../sdk";

// ⚠️ BEFORE THE TALK: set this to a DotNS name your host build maps to a
// funded product account, or signing will fail on stage.
const PRODUCT_ACCOUNT = "talk-demo.dot";

// createApp's wallet API doesn't submit product-account transactions, so this
// one beat uses SignerManager directly (the App still gives us the chain).
const signer = new SignerManager({ ss58Prefix: 0, dappName: "talk-demo" });

// Sign + submit a transaction. The host prompts the user on their phone.
export async function sendRemark(text: string, onStatus: (s: TxStatus) => void) {
  if (signer.getState().status !== "connected") {
    const session = await signer.connect();
    if (!session.ok) throw session.error;
  }

  const account = await signer.getProductAccount(PRODUCT_ACCOUNT, 0);
  if (!account.ok) throw account.error;

  const { assetHub } = await (await getApp()).chain.connect({ assetHub: paseo_asset_hub });
  const tx = assetHub.tx.System.remark({ remark: Binary.fromText(text) });

  return submitAndWatch(tx, account.value.getSigner(), { onStatus });
}
