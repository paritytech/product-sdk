// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time guard for the chain contract in `@parity/product-sdk-individuality`.
 *
 * That package types its chain parameter structurally, listing the storage
 * entries it needs rather than naming a descriptor. That keeps it free of a
 * chain-client dependency and lets its tests use a plain double, at the cost that
 * the contract can drift from the real chain silently, since the double satisfies
 * it by construction.
 *
 * This file closes that gap: if a descriptor regeneration changes a key or a
 * value type, `pnpm typecheck` fails here. It guards both of that package's
 * chain contracts, `IndividualityChain` for the personhood batch and
 * `ConsumersChain` for the account to username read.
 *
 * **It checks the built `dist`, not the sibling's `src`.** The contracts resolve
 * through `@parity/product-sdk-individuality`'s `types` field, so editing a
 * contract and running this typecheck without rebuilding that package asserts
 * against the previous build. Run `pnpm -r build` first, or the guard silently
 * checks stale types. Verified 2026-08-19 by mutating a contract and watching
 * the typecheck pass until the sibling was rebuilt.
 *
 * **It lives in the umbrella package deliberately.** Inside the individuality
 * package the same assertion is vacuous, passing even against a contract that
 * demands a pallet the chain does not have, because the descriptor types do not
 * fully resolve through that package's dependency graph. Here, where both
 * `chain-client` and the individuality package are direct dependencies, it
 * correctly rejects a bogus contract. The negative control below keeps that
 * property honest: if `IndividualityChain` ever stopped constraining, the
 * `@ts-expect-error` would report as unused and this file would fail.
 */
import type { getChainAPI } from "@parity/product-sdk-chain-client";
import type {
    RingVRFProof as HostRingVRFProof,
    VrfSignature as HostVrfSignature,
    VrfTranscriptItem as HostVrfTranscriptItem,
} from "@parity/product-sdk-host";
import type {
    AirdropChain,
    ClaimChain,
    ConsumersChain,
    GameChain,
    IndividualityChain,
    PrizeStatusChain,
    SignUpChain,
    AccountVrfSignature,
    VrfTranscriptItem as IndividualityVrfTranscriptItem,
    RingVRFProof as AsPersonRingVRFProof,
} from "@parity/product-sdk-individuality";
import { expect, test } from "vitest";

// The false branch must be `false`, not `never`. `never` is assignable to
// `true`, so a `never` branch would make the assertion unfalsifiable.
type Assert<T extends true> = T;

type PaseoClient = Awaited<ReturnType<typeof getChainAPI<"paseo">>>;
type DevnetClient = Awaited<ReturnType<typeof getChainAPI<"devnet">>>;
// Previewnet runs a Paseo runtime kept a step ahead of paseo-next-v2, so it
// satisfies every individuality contract paseo does — including the game
// surface devnet predates. These assertions are a compile-time guard on the
// re-added descriptor. The only shape drift is `PeopleLite.LitePeople`'s method
// enum gaining a `Fee` variant, which the contracts type as `unknown` and absorb.
type PreviewnetClient = Awaited<ReturnType<typeof getChainAPI<"previewnet">>>;

// These aliases are the test. Each fails to typecheck if its condition
// breaks, so they need no export and no runtime reference.
type PaseoSatisfiesContract = Assert<PaseoClient extends IndividualityChain ? true : false>;
type DevnetSatisfiesContract = Assert<DevnetClient extends IndividualityChain ? true : false>;
type PreviewnetSatisfiesContract = Assert<
    PreviewnetClient extends IndividualityChain ? true : false
>;

// `ConsumersChain` needs this more than the batch contract does: its value shape
// was derived from the pallet and the codegen rather than read off the emitted
// descriptor, so these two lines are what make that derivation a checked fact.
type PaseoSatisfiesConsumers = Assert<PaseoClient extends ConsumersChain ? true : false>;
type DevnetSatisfiesConsumers = Assert<DevnetClient extends ConsumersChain ? true : false>;
type PreviewnetSatisfiesConsumers = Assert<PreviewnetClient extends ConsumersChain ? true : false>;

// Separate from the personhood contract: reading draws needs neither `Resources`
// nor `PeopleLite`. Both chains satisfy it, which is weaker than it looks — devnet's
// event-id base is 28 bytes to paseo's 27, and `SizedHex<N>` erases `N`, so only the
// length check in `airdrop-ids.ts` catches that.
type PaseoSatisfiesAirdropContract = Assert<PaseoClient extends AirdropChain ? true : false>;
type DevnetSatisfiesAirdropContract = Assert<DevnetClient extends AirdropChain ? true : false>;
type PreviewnetSatisfiesAirdropContract = Assert<
    PreviewnetClient extends AirdropChain ? true : false
>;

// Same again for the current-game contract, which shares no entry with either of
// the other two — but paseo only, and that asymmetry is the point.
type PaseoSatisfiesGameContract = Assert<PaseoClient extends GameChain ? true : false>;
// Previewnet is ahead of paseo, so it carries the game surface too (unlike devnet).
type PreviewnetSatisfiesGameContract = Assert<PreviewnetClient extends GameChain ? true : false>;

// Devnet's metadata predates the multi-airdrop game work — the 28-byte base above is
// one symptom, `game-types.ts` lists the rest — so the game surface is paseo-only.
// Asserted negatively on purpose: a devnet re-pin breaks this line, which is the
// prompt to flip it positive and check the read against it.
type DevnetPredatesTheGameContract = Assert<DevnetClient extends GameChain ? false : true>;

// Negative control, kept type-only so it emits no runtime code. If
// `IndividualityChain` ever stopped constraining, this flips to `false` and the
// file fails to typecheck, which is what keeps the assertions above honest.
type ClientWithoutIndividuality = {
    assetHub: unknown;
    raw: { assetHub: unknown };
    destroy(): void;
};
type RejectsBogusClient = Assert<
    ClientWithoutIndividuality extends IndividualityChain ? false : true
>;
type RejectsBogusAirdropClient = Assert<
    ClientWithoutIndividuality extends AirdropChain ? false : true
>;
type RejectsBogusGameClient = Assert<ClientWithoutIndividuality extends GameChain ? false : true>;

// `Game.Game` being optional is what makes "between games" representable at all,
// and `GameIndex` / `GameSchedules` being `ValueQuery` is what lets the read treat
// them as always answering. The structural contract pins the latter two by typing
// them non-optional; this pins the first, which no assignability check would
// catch — a suddenly-required `Game` would still satisfy an optional contract.
type GameStorage = PaseoClient["individuality"]["query"]["Game"];
type GameValue = Awaited<ReturnType<GameStorage["Game"]["getValue"]>>;
type GameIsOptional = Assert<undefined extends GameValue ? true : false>;
// Negative control: `GameIndex` is `ValueQuery`, so it must *not* admit undefined.
type GameIndexValue = Awaited<ReturnType<GameStorage["GameIndex"]["getValue"]>>;
type GameIndexIsNotOptional = Assert<undefined extends GameIndexValue ? false : true>;

// The event id is derived from a runtime constant rather than a storage entry, so
// the constant has to exist and still be a plain string. Its *width* cannot be
// asserted here: PAPI's `SizedHex<N>` is `string & { __hexString?: N | unknown }`,
// and the `| unknown` collapses every width to the same type, so `SizedHex<32>`
// and `SizedHex<27>` are mutually assignable and any such assertion would pass
// vacuously. The 27-byte expectation is enforced at runtime instead, by the
// length check in `airdrop-ids.ts` and the pinned vectors beside it.
type GameConstants = PaseoClient["individuality"]["constants"]["Game"];
type EventIdBaseExists = Assert<"airdrop_event_id_base" extends keyof GameConstants ? true : false>;
type AirdropEventIdBase = Awaited<ReturnType<GameConstants["airdrop_event_id_base"]>>;
type EventIdBaseIsAString = Assert<AirdropEventIdBase extends string ? true : false>;

// The composed prize-status read spans both pallets, so it is the intersection
// that has to hold — and on paseo only, since it inherits `GameChain`.
type PaseoSatisfiesPrizeStatusContract = Assert<
    PaseoClient extends PrizeStatusChain ? true : false
>;
type PreviewnetSatisfiesPrizeStatusContract = Assert<
    PreviewnetClient extends PrizeStatusChain ? true : false
>;
type DevnetPredatesThePrizeStatusContract = Assert<
    DevnetClient extends PrizeStatusChain ? false : true
>;

// `Registrations` is keyed by the entropy slot with the entry as its *value*, so
// `readDrawRegistration` can only work by scanning the event's prefix. Pinning the
// arity here is what would catch a descriptor regeneration that added a reverse
// index and made the scan unnecessary.
type RegistrationsEntries = Awaited<
    ReturnType<PaseoClient["individuality"]["query"]["Airdrop"]["Registrations"]["getEntries"]>
>;
type RegistrationsKeyIsEventIdAndSlot = Assert<
    RegistrationsEntries[number]["keyArgs"] extends [unknown, unknown] ? true : false
>;

// `Winners` is a double map keyed by the registration entry, which is what makes
// "did I win" a point lookup instead of a scan of every winner. If a descriptor
// regeneration ever collapsed it to a single key, the read layer would silently
// need rewriting, so the arity is pinned.
type WinnersKey = Parameters<
    PaseoClient["individuality"]["query"]["Airdrop"]["Winners"]["getValue"]
>;
type WinnersTakesTwoKeys = Assert<
    WinnersKey extends [unknown, unknown, ...unknown[]] ? true : false
>;

type RejectsBogusConsumersClient = Assert<
    ClientWithoutIndividuality extends ConsumersChain ? false : true
>;

// The write half declares its own `RingVRFProof` rather than importing the
// host's, for the same reason `IndividualityChain` is structural: it keeps the
// individuality package free of a dependency on `@parity/product-sdk-host`. The
// cost is that a field rename on the host side would go unnoticed there, since
// nothing in that package resolves the host type. Here both are direct
// dependencies, so this is where the two can be tied together.
type HostProofSatisfiesLocal = Assert<HostRingVRFProof extends AsPersonRingVRFProof ? true : false>;

// Negative control for the same assertion. If `AsPersonRingVRFProof` ever
// stopped constraining, this flips to `false` and the file fails to typecheck.
type ProofWithoutRingIndex = {
    proof: Uint8Array;
    contextualAlias: { context: Uint8Array; alias: Uint8Array };
    ringRevision: number;
};
type RejectsProofMissingRingIndex = Assert<
    ProofWithoutRingIndex extends AsPersonRingVRFProof ? false : true
>;

// `AliasWithProof` is only ever accepted for `People.set_alias_account`, so the
// call has to exist on the real chain with the two arguments the extension's
// validation reads. A descriptor regeneration that renames either fails here.
type PeopleTx = PaseoClient["individuality"]["tx"]["People"];
type SetAliasAccountExists = Assert<"set_alias_account" extends keyof PeopleTx ? true : false>;
type SetAliasAccountArgs = Parameters<PeopleTx["set_alias_account"]>[0];
type SetAliasAccountTakesAccountAndValidAt = Assert<
    "account" extends keyof SetAliasAccountArgs
        ? "call_valid_at" extends keyof SetAliasAccountArgs
            ? true
            : false
        : false
>;

// The JSDoc examples in the individuality package submit
// `Game.sign_up_with_alias` under a person origin. A person origin supplies only
// the origin, never the call arguments, so those snippets go stale the moment
// this call's parameters change — and nothing else in the repo compiles them.
type GameTx = PaseoClient["individuality"]["tx"]["Game"];
type SignUpWithAliasExists = Assert<"sign_up_with_alias" extends keyof GameTx ? true : false>;
type SignUpWithAliasArgs = Parameters<GameTx["sign_up_with_alias"]>[0];
type SignUpWithAliasTakesTheDocumentedArgs = Assert<
    "identifier_key" extends keyof SignUpWithAliasArgs
        ? "statement_account" extends keyof SignUpWithAliasArgs
            ? "sig" extends keyof SignUpWithAliasArgs
                ? true
                : false
            : false
        : false
>;

// Negative control for the assertion above. The `extends keyof` chain would pass
// vacuously if `SignUpWithAliasArgs` ever resolved to something permissive such
// as `any`, so this pins a shape that is missing `sig` and requires it to fail.
type SignUpArgsWithoutSig = Pick<SignUpWithAliasArgs, "identifier_key" | "statement_account">;
type RejectsSignUpArgsMissingSig = Assert<"sig" extends keyof SignUpArgsWithoutSig ? false : true>;

// The claim is the one contract here that touches `tx` as well as storage. Paseo
// only, like the game surface it composes with.
type PaseoSatisfiesClaimContract = Assert<PaseoClient extends ClaimChain ? true : false>;
type PreviewnetSatisfiesClaimContract = Assert<PreviewnetClient extends ClaimChain ? true : false>;
type RejectsBogusClaimClient = Assert<ClientWithoutIndividuality extends ClaimChain ? false : true>;

// `claim_airdrop`'s three arguments, pinned by name. `ClaimChain` types them
// structurally, and PAPI encodes whatever object it is handed — so a renamed field
// would encode as `undefined` and fail on chain with nothing local to point at it.
type ClaimAirdropArgs = Parameters<GameTx["claim_airdrop"]>[0];
type ClaimAirdropTakesTheDocumentedArgs = Assert<
    "game_index" extends keyof ClaimAirdropArgs
        ? "airdrop_index" extends keyof ClaimAirdropArgs
            ? "beneficiary" extends keyof ClaimAirdropArgs
                ? true
                : false
            : false
        : false
>;

// Game sign-up.
type PaseoSatisfiesSignUpContract = Assert<PaseoClient extends SignUpChain ? true : false>;
type RejectsBogusSignUpClient = Assert<
    ClientWithoutIndividuality extends SignUpChain ? false : true
>;

// `SignUpChain` alone does not reject devnet and cannot: a `tx` argument is
// checked contravariantly and excess-property checking does not apply between
// named types, so an interface naming `airdrops` is satisfied by devnet's call,
// which has only `airdrop`. `identifier_key` does not separate them either, since
// `SizedHex<N>`'s brand is optional. Assert on the intersection the read takes,
// where `GameChain` is the half that rejects devnet.
type PaseoSatisfiesSignUpRead = Assert<PaseoClient extends GameChain & SignUpChain ? true : false>;
type PreviewnetSatisfiesSignUpRead = Assert<
    PreviewnetClient extends GameChain & SignUpChain ? true : false
>;
type DevnetPredatesTheSignUpRead = Assert<
    DevnetClient extends GameChain & SignUpChain ? false : true
>;

// The divergence itself: devnet's argument is `airdrop`, so `signUpWithAccountTx`
// emitting `airdrops` would encode as `undefined` and enter no draw at all.
type DevnetGameTx = DevnetClient["individuality"]["tx"]["Game"];
type DevnetSignUpArgs = Parameters<DevnetGameTx["sign_up_with_account"]>[0];
type DevnetHasNoAirdropsArg = Assert<"airdrops" extends keyof DevnetSignUpArgs ? false : true>;
type DevnetHasTheSingularArg = Assert<"airdrop" extends keyof DevnetSignUpArgs ? true : false>;

// Pinned by name for the same reason `claim_airdrop`'s are: PAPI encodes the
// object it is handed, so a renamed field silently encodes as `undefined`.
type SignUpWithAccountArgs = Parameters<GameTx["sign_up_with_account"]>[0];
type SignUpWithAccountTakesTheDocumentedArgs = Assert<
    "identifier_key" extends keyof SignUpWithAccountArgs
        ? "airdrops" extends keyof SignUpWithAccountArgs
            ? true
            : false
        : false
>;

// `None` is how a player enters no draw, and the only form a recognized player
// can use at all.
type AirdropsArg = SignUpWithAccountArgs["airdrops"];
type AirdropsIsOptional = Assert<undefined extends AirdropsArg ? true : false>;

// Extracted from the enum rather than restated, so a renamed field fails here
// instead of on chain.
type AccountVrfs = Extract<NonNullable<AirdropsArg>, { type: "Account" }>["value"][number];
type AccountVrfHasPreOutputAndProof = Assert<
    "pre_output" extends keyof AccountVrfs
        ? "proof" extends keyof AccountVrfs
            ? true
            : false
        : false
>;

// The VRF types are local copies of the host's, declared here for the same reason
// `AsPersonRingVRFProof` is: so the package keeps no host dependency. Those host
// types are mapped straight off truapi's wire types, so a rename there changes them
// with no line of this repo touched, and the break would land as a runtime
// TypeError rather than a failed typecheck.
type HostVrfSignatureSatisfiesLocal = Assert<
    HostVrfSignature extends AccountVrfSignature ? true : false
>;
type HostVrfItemSatisfiesLocal = Assert<
    HostVrfTranscriptItem extends IndividualityVrfTranscriptItem ? true : false
>;

// Negative controls, so the two above cannot pass vacuously.
type RejectsSignatureMissingProof = Assert<
    { preOutput: Uint8Array } extends AccountVrfSignature ? false : true
>;
type RejectsItemMissingValue = Assert<
    { label: Uint8Array } extends IndividualityVrfTranscriptItem ? false : true
>;

// `Game.Players`: the variant spelling the read keys by, and the one field it uses.
// Sibling reads got exactly these pins.
type PlayersEntry = PaseoClient["individuality"]["query"]["Game"]["Players"];
type PlayersKey = Parameters<PlayersEntry["getValue"]>[0];
type PlayersKeyIsAccountOrPerson = Assert<
    PlayersKey extends { type: "Account" | "Person" } ? true : false
>;
type RejectsAliasSpelling = Assert<
    { type: "Alias"; value: string } extends PlayersKey ? false : true
>;
type PlayersValue = NonNullable<Awaited<ReturnType<PlayersEntry["getValue"]>>>;
type PlayersHasRegistered = Assert<"registered" extends keyof PlayersValue ? true : false>;

test("the individuality chain contract is asserted at compile time", () => {
    // The type assertions above are the test. This keeps vitest from reporting
    // the file as an empty suite.
    expect(true).toBe(true);
});
