import { createApp } from "@parity/product-sdk";
import type { App } from "@parity/product-sdk";

// One shared app — the SDK's unified entry point. Wires up wallet, storage,
// chain, and cloud storage against the host. Created lazily on first use.
let app: App | undefined;
export const getApp = async (): Promise<App> =>
  (app ??= await createApp({ name: "talk-demo" }));
