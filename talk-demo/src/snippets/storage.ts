import { requestResourceAllocation } from "@parity/product-sdk-host";
import { app } from "../sdk";

// ── LOCAL — on-device key/value. Instant. ────────────────────────────
export const saveLocal = (key: string, value: string) => app.localStorage.set(key, value);
export const loadLocal = (key: string) => app.localStorage.get(key);

// ── CLOUD — same idea, but persisted on-chain (Bulletin). ────────────
export async function saveCloud(text: string): Promise<string> {
  if (!app.wallet.getSelectedAccount()) {
    const { accounts } = await app.wallet.connect();
    app.wallet.selectAccount(accounts[0].address);
  }
  // Ask the host for a Bulletin storage allowance — it sponsors the fee.
  await requestResourceAllocation([{ tag: "BulletinAllowance", value: undefined }]);

  if (!app.cloudStorage) throw new Error("cloud storage is disabled");
  return app.cloudStorage.upload(text); // returns the CID
}

export async function loadCloud(cid: string): Promise<string> {
  if (!app.cloudStorage) throw new Error("cloud storage is disabled");
  const bytes = await app.cloudStorage.fetch(cid);
  return new TextDecoder().decode(bytes);
}
