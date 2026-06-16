// Wires each button to its snippet. The snippets (src/snippets/*) are the
// code shown on the slides; this file is just glue.
import { getEl, setResult, log, toHex } from "./ui";
import {
  askPermission,
  REMOTE_PERMISSIONS,
  DEVICE_PERMISSIONS,
  type PermissionTag,
} from "./snippets/permission";
import { watchBlocks } from "./snippets/connect";
import { getAccount } from "./snippets/account";
import { saveLocal, loadLocal, clearLocal } from "./snippets/storage";
import { signMessage } from "./snippets/transaction";

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

// 3 — Ask permission (both families, grouped in the dropdown)
const permSelect = getEl<HTMLSelectElement>("permission-select");
function addPermissionGroup(label: string, tags: readonly string[]): void {
  const group = document.createElement("optgroup");
  group.label = label;
  for (const tag of tags) {
    const opt = document.createElement("option");
    opt.value = tag;
    opt.textContent = tag;
    group.append(opt);
  }
  permSelect.append(group);
}
addPermissionGroup("Chain / Network", REMOTE_PERMISSIONS);
addPermissionGroup("Device", DEVICE_PERMISSIONS);

wire("btn-permission", async () => {
  const tag = getEl<HTMLSelectElement>("permission-select").value as PermissionTag;
  log(`requesting ${tag} permission…`);
  const granted = await askPermission(tag);
  setResult("out-permission", granted ? `${tag}: granted ✓` : `${tag}: denied`, !granted);
  log(`permission ${tag}: ${granted ? "granted" : "denied"}`);
});

// 2 — Connect to a chain (toggle: Connect ↔ Stop)
let blockSub: { unsubscribe: () => void } | undefined;
const $btnConnect = getEl<HTMLButtonElement>("btn-connect");
wire("btn-connect", async () => {
  if (blockSub) {
    blockSub.unsubscribe();
    blockSub = undefined;
    $btnConnect.textContent = "Connect";
    log("stopped watching blocks");
    return;
  }
  log("connecting to Asset Hub…");
  blockSub = await watchBlocks(
    ({ number, hash }) => {
      setResult("out-connect", `block #${number}  ●  ${hash.slice(0, 14)}…`);
      log(`block #${number}`);
    },
    (err) => {
      setResult("out-connect", `error: ${err.message}`, true);
      log(`✗ connect: ${err.message}`);
      blockSub = undefined;
      $btnConnect.textContent = "Connect";
    },
  );
  $btnConnect.textContent = "Stop";
  log("connected — waiting for first block…");
});

// 3 — Get my account
wire("btn-account", async () => {
  log("asking the host for this dapp's account…");
  const account = await getAccount();
  setResult("out-account", `${account.name ?? "app account"}: ${account.address}`);
  log(`app account: ${account.address}`);
});

// 4 — Store something (local)
wire("btn-save-local", async () => {
  const value = getEl<HTMLInputElement>("in-storage").value || "hello Berlin";
  await saveLocal("key", value);
  setResult("out-storage", `saved: "${value}"`);
  log(`set key="${value}"`);
});
wire("btn-load-local", async () => {
  const value = await loadLocal("key");
  setResult("out-storage", `loaded: ${value ?? "null"}`);
  log(`get key → ${value ?? "null"}`);
});
wire("btn-clear-local", async () => {
  await clearLocal("key");
  setResult("out-storage", "cleared");
  log("key cleared");
});

// 5 — Sign a message (prompts the phone)
wire("btn-sign", async () => {
  const text = getEl<HTMLInputElement>("in-tx").value || "gm from Web3Summit";
  log("signing — approve on your phone…");
  const signature = await signMessage(text);
  const hex = toHex(signature);
  setResult("out-tx", `signed ✓ ${hex.slice(0, 26)}…`);
  log(`signature: ${hex.slice(0, 26)}…`);
});

log("talk-demo ready — running inside the host");
