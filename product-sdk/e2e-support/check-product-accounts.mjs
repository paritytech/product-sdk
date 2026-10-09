// Reports the balance of every product account a live-chain suite signs with.
//
// A product account is derived from (session root, product id), so it is its own
// account and starts empty. A drained one fails as `Invalid.Payment` before
// inclusion, or `Statement submission rejected: {}` from the statement store,
// which weights acceptance by balance. Both read as protocol faults, so naming
// the address and its balance here is what turns one into an errand.
//
// Usage: node e2e-support/check-product-accounts.mjs [--rpc <url>]
import { Twox128, Blake2128Concat, AccountId } from "@polkadot-api/substrate-bindings";

const RPC =
  process.argv[process.argv.indexOf("--rpc") + 1]?.startsWith("ws")
    ? process.argv[process.argv.indexOf("--rpc") + 1]
    : "wss://paseo-asset-hub-next-rpc.polkadot.io";

// The demos whose fixture proxies to a live chain, and the account each
// activates its session from (the first its fixture lists).
export const LIVE_CHAIN_ACCOUNTS = [
  { demo: "tx-demo", address: "5EEoZCuLSwtnbaJPEubsr6smMWsAoNW1Hv5omUGgQyM5zYEU" },
  { demo: "contracts-demo", address: "5Dkio4JAknT6B2T23UggdjwTeprFZZd8ijqQdzejuVcC5Scy" },
  { demo: "statement-store-demo", address: "5HpYZBoT3qSzXp5yHp1Xk5pdB2cRENFFeaq76yej51gefiTH" },
];

const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const label = new TextEncoder();

/** The `System.Account` storage key for an address. */
function accountKey(address) {
  return hex([
    ...Twox128(label.encode("System")),
    ...Twox128(label.encode("Account")),
    ...Blake2128Concat(AccountId().enc(address)),
  ]);
}

/** Free balance in planck, or `undefined` when the account is not on chain. */
export async function freeBalance(call, address) {
  const raw = await call("state_getStorage", [accountKey(address)]);
  if (!raw) return undefined;
  const bytes = Buffer.from(raw.slice(2), "hex");
  // AccountInfo: nonce u32, consumers u32, providers u32, sufficients u32, then
  // AccountData whose first field is the free balance, a u128.
  return bytes.readBigUInt64LE(16) + (bytes.readBigUInt64LE(24) << 64n);
}

async function main() {
  const socket = new WebSocket(RPC);
  const pending = new Map();
  let id = 1;
  const call = (method, params = []) =>
    new Promise((resolve, reject) => {
      const n = id++;
      pending.set(n, { resolve, reject });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
    });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`cannot reach ${RPC}`));
  });

  console.log(`${await call("system_chain")} (${RPC})\n`);
  const empty = [];
  for (const target of LIVE_CHAIN_ACCOUNTS) {
    const free = await freeBalance(call, target.address);
    const state =
      free === undefined ? "NOT ON CHAIN" : free === 0n ? "EMPTY" : `${(Number(free) / 1e10).toFixed(4)}`;
    if (free === undefined || free === 0n) empty.push(target);
    console.log(`  ${target.demo.padEnd(22)} ${state.padEnd(14)} ${target.address}`);
  }
  socket.close();

  if (empty.length) {
    console.log(`\n${empty.length} account(s) need funding before a write test can pass:`);
    for (const target of empty) console.log(`  ${target.address}   (${target.demo})`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
