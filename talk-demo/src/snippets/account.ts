import { app } from "../sdk";

// Ask the host who the user is. Private keys never leave the host.
export async function getAccount() {
  const { accounts } = await app.wallet.connect();
  app.wallet.selectAccount(accounts[0].address);
  return accounts[0]; // { address, name, source }
}
