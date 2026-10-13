---
"@parity/product-sdk-individuality": minor
---

Add `PeopleAirdrops` support, so any product can enter a person in the recurring People-chain prize draws (Humanity's Daily Dollar) without its own copy of the chain logic.

- `readPeopleAirdropsStanding(chain, { account })` reads every `PeopleAirdrops` draw on chain at one block and, for each, whether the account's airdrop alias is registered (through the derived slot) and has won. Other schedulers' draws in `Airdrop.Events` (the weekly game's) are skipped.
- `readPeopleAirdropsSigning(chain, { account })` says which `withAsPerson` origin a registration needs now: `Bound` (the account's signature is enough), `Revised` (the ring moved on, so a fresh proof for the binding's context), `Unbound` (bind with `People.set_alias_account` first), `OtherContext` or `RingUnavailable`.
- `peopleAirdropsRegisterCalls(chain, eventIds)` builds the `PeopleAirdrops.register` calls, chunked to the runtime's `MaxRegisterBatch` (falling back to 16), with duplicates dropped and non-`PeopleAirdrops` ids refused.
- `derivePeopleAirdropsSlot(eventId, salt, alias)` is the slot derivation on its own.
