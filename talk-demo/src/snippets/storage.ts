import { getApp } from "../sdk";

// ── LOCAL — on-device key/value. Instant. ────────────────────────────
export const saveLocal = async (key: string, value: string) =>
  (await getApp()).localStorage.set(key, value);

export const loadLocal = async (key: string) =>
  (await getApp()).localStorage.get(key);

// ── CLOUD — same idea, but persisted on-chain (Bulletin). ────────────
export async function saveCloud(text: string): Promise<string> {
  const app = await getApp();
  if (!app.cloudStorage) throw new Error("cloud storage is disabled");
  return app.cloudStorage.upload(text); // returns the CID
}

export async function loadCloud(cid: string): Promise<string> {
  const app = await getApp();
  if (!app.cloudStorage) throw new Error("cloud storage is disabled");
  const bytes = await app.cloudStorage.fetch(cid);
  return new TextDecoder().decode(bytes);
}
