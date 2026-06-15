import { app } from "../sdk";

// On-device key/value storage. Instant — no chain, no fees.
export const saveLocal = (key: string, value: string) => app.localStorage.set(key, value);
export const loadLocal = (key: string) => app.localStorage.get(key);

// CLOUD (on-chain, via Bulletin) is the same shape — see SNIPPETS.md beat 4:
//   const cid = await app.cloudStorage.upload(text);
//   const bytes = await app.cloudStorage.fetch(cid);
// Not wired in this demo: the paseoli host's Bulletin genesis doesn't match the
// published descriptor, exposes no legacy signing account, and needs a funded
// BulletinAllowance. Re-enable once the demo host is provisioned for Bulletin.
