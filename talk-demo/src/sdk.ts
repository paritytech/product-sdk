import { createApp } from "@parity/product-sdk";

// One shared app for the whole demo — a single host session and connection set.
// (The slide snippets in SNIPPETS.md show `createApp` inline for clarity; the
// running demo uses this one instance so beats share wallet + connections.)
// cloudStorage:false for now — the published paseo-bulletin descriptor's genesis
// (0x8cfe6717…) is stale vs. what the paseoli host serves, so the eager Bulletin
// connection errors at startup. Re-enable once descriptors match the host.
export const app = await createApp({ name: "demo-app", cloudStorage: false });
