// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { type AccountsController, createAccountsController } from "./accounts.js";
import { type ChainController, createChainController } from "./chain.js";
import { type ChatController, createChatController } from "./chat.js";
import { type CloudStorageController, createCloudStorageController } from "./cloud-storage.js";
import type { AnyChains, TruapiConfig } from "./config.js";
import { type ContractsController, createContractsController } from "./contracts.js";
import { type HostController, createHostController } from "./host.js";
import { type LocaleState, createLocaleStore } from "./locale.js";
import { type PaymentsController, createPaymentsController } from "./payments.js";
import {
    type PocketController,
    type RendererController,
    createPocketController,
    createRendererController,
} from "./pocket.js";
import { type PreimageController, createPreimageController } from "./preimage.js";
import { type StatementsController, createStatementsController } from "./statements.js";
import type { ReadonlyStore } from "./store.js";
import { type ThemeState, createThemeStore } from "./theme.js";
import { type TxController, createTxController } from "./tx.js";

export interface TruapiRuntime<TChains extends AnyChains = AnyChains> {
    config: TruapiConfig<TChains>;
    host: HostController;
    theme: ReadonlyStore<ThemeState>;
    locale: ReadonlyStore<LocaleState>;
    chains: ChainController<TChains>;
    accounts: AccountsController;
    tx: TxController<TChains>;
    contracts: ContractsController<TChains>;
    chat: ChatController;
    statements: StatementsController;
    payments: PaymentsController;
    cloudStorage: CloudStorageController;
    preimage: PreimageController;
    pocket: PocketController;
    renderer: RendererController;
    /** Terminal: tears down clients, subscriptions and the signer manager. */
    destroy(): void;
}

export function createRuntime<TChains extends AnyChains>(
    config: TruapiConfig<TChains>,
): TruapiRuntime<TChains> {
    const host = createHostController();
    const chains = createChainController(config, host);
    const accounts = createAccountsController(config, host);

    return {
        config,
        host,
        theme: createThemeStore(host),
        locale: createLocaleStore(host),
        chains,
        accounts,
        tx: createTxController(chains, accounts),
        contracts: createContractsController(config, chains, accounts),
        chat: createChatController(host),
        statements: createStatementsController(config, host),
        payments: createPaymentsController(host),
        cloudStorage: createCloudStorageController(config, accounts),
        preimage: createPreimageController(host),
        pocket: createPocketController(host),
        renderer: createRendererController(host),
        destroy: () => {
            chains.destroy();
            accounts.destroy();
        },
    };
}
