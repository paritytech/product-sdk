import { requestPermission } from "@parity/product-sdk-host";

// Ask the host for permission to submit transactions.
// The product can't grant this itself — the host shows the user a prompt.
export function askToSubmit(): Promise<boolean> {
  return requestPermission({ tag: "ChainSubmit", value: undefined });
}
