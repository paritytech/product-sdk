import { useEffect, useState } from "react";
import { signerManager } from "./lib/auth";
import { truncateAddress } from "@parity/product-sdk-address";
import type { SignerState } from "@parity/product-sdk-signer";
import pkg from "../package.json";

// ─── Demo: wallet connect ────────────────────────────────────────────
// Starter demo for @parity/product-sdk-signer + @parity/product-sdk-address.
// If your app doesn't need wallet sign-in, delete:
//   (a) this entire block down to "End demo block"
//   (b) the imports for useEffect, useState, signerManager, truncateAddress,
//       and SignerState at the top of this file (if unused elsewhere)
//   (c) the `<WalletConnect />` line in App() below

function WalletConnect() {
  const [state, setState] = useState<SignerState>(signerManager.getState());
  useEffect(() => signerManager.subscribe(setState), []);

  if (state.status === "connecting") {
    return <p style={{ color: "#666" }}>Connecting…</p>;
  }
  if (state.error) {
    return <p style={{ color: "crimson" }}>Error: {state.error.message}</p>;
  }
  if (state.status === "connected" && state.selectedAccount) {
    return (
      <p>
        Connected as <code>{truncateAddress(state.selectedAccount.address)}</code>{" "}
        <button onClick={() => signerManager.disconnect()}>Disconnect</button>
      </p>
    );
  }
  return (
    <button
      onClick={() => {
        void signerManager.connect();
      }}
    >
      Connect wallet
    </button>
  );
}
// ─── End demo block ──────────────────────────────────────────────────

export function App() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: "36rem",
        margin: "3rem auto",
        padding: "0 1.5rem",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ marginBottom: "0.5rem" }}>{pkg.name}</h1>
      <p style={{ color: "#444", marginTop: 0 }}>
        Scaffolded with <code>create-polkadot-app</code>. All thirteen{" "}
        <code>@parity/product-sdk-*</code> packages are installed and ready to wire up.
      </p>

      {/* Demo: wallet connect — delete this line if not needed */}
      <WalletConnect />

      <p style={{ color: "#888", fontSize: "0.9rem" }}>
        Open <code>src/App.tsx</code> to start building. The <code>src/lib/</code> stubs walk you
        through wallet sign-in, chain queries, encrypted storage, and typed contract calls.
      </p>
    </main>
  );
}
