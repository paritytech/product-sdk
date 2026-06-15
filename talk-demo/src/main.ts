// Wires each button to its snippet. The snippets (src/snippets/*) are the
// code shown on the slides; this file is just glue.
import { getEl, setResult, log } from "./ui";
import { askToSubmit } from "./snippets/permission";
import { watchBlocks } from "./snippets/connect";
import { getAccount } from "./snippets/account";
import { saveLocal, loadLocal, saveCloud, loadCloud } from "./snippets/storage";
import { sendRemark } from "./snippets/transaction";

function wire(id: string, handler: () => Promise<void>): void {
  getEl<HTMLButtonElement>(id).addEventListener("click", async () => {
    try {
      await handler();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`✗ ${msg}`);
    }
  });
}

// 1 — Ask permission
wire("btn-permission", async () => {
  log("requesting ChainSubmit permission…");
  const granted = await askToSubmit();
  setResult("out-permission", granted ? "granted ✓" : "denied", !granted);
  log(`permission: ${granted ? "granted" : "denied"}`);
});

// 2 — Connect to a chain (live block subscription)
let blockSub: { unsubscribe: () => void } | undefined;
wire("btn-connect", async () => {
  blockSub?.unsubscribe();
  log("connecting to Asset Hub — watching blocks…");
  blockSub = await watchBlocks((block) => {
    setResult("out-connect", `Asset Hub block #${block}  ● live`);
  });
});

// 3 — Get my account
wire("btn-account", async () => {
  log("asking the host for the account…");
  const account = await getAccount();
  setResult("out-account", `${account.name ?? "account"}: ${account.address}`);
  log(`account: ${account.address}`);
});

// 4a — Local storage
wire("btn-save-local", async () => {
  const value = getEl<HTMLInputElement>("in-storage").value || "hello Berlin";
  await saveLocal("greeting", value);
  setResult("out-storage", `saved locally: "${value}"`);
  log(`local set greeting="${value}"`);
});
wire("btn-load-local", async () => {
  const value = await loadLocal("greeting");
  setResult("out-storage", `loaded locally: ${value ?? "null"}`);
  log(`local get greeting → ${value ?? "null"}`);
});

// 4b — Cloud storage (Bulletin)
wire("btn-save-cloud", async () => {
  const value = getEl<HTMLInputElement>("in-storage").value || "hello Berlin";
  log("uploading to cloud (Bulletin)…");
  const cid = await saveCloud(value);
  getEl<HTMLInputElement>("in-cid").value = cid;
  setResult("out-storage", `cloud CID: ${cid}`);
  log(`cloud stored — CID ${cid}`);
});
wire("btn-load-cloud", async () => {
  const cid = getEl<HTMLInputElement>("in-cid").value;
  log(`fetching CID ${cid}…`);
  const text = await loadCloud(cid);
  setResult("out-storage", `cloud loaded: "${text}"`);
  log(`cloud fetched → "${text}"`);
});

// 5 — Sign a transaction (prompts the phone)
wire("btn-sign", async () => {
  const text = getEl<HTMLInputElement>("in-tx").value || "gm from Web3Summit";
  log("submitting remark — approve on your phone…");
  const result = await sendRemark(text, (status) => {
    setResult("out-tx", `status: ${status}`);
    log(`tx status: ${status}`);
  });
  if (result.ok) {
    setResult("out-tx", `landed in block #${result.block.number} ✓`);
    log(`tx finalized in block #${result.block.number}`);
  } else {
    setResult("out-tx", `failed: ${JSON.stringify(result.dispatchError)}`, true);
  }
});

log("talk-demo ready — running inside the host");
