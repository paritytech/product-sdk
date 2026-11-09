---
"@parity/product-sdk": patch
"@parity/product-sdk-auth": patch
"@parity/product-sdk-individuality": patch
"@parity/product-sdk-signer": patch
---

**Document that usernames are owned by the `peopl.<tld>/0` main account (RFC-0028).**

JSDoc and skill docs now say that the account owning a person's lite and full usernames, and keying `Resources.Consumers`, is their main account `//product//peopl.<tld>/0` (https://github.com/paritytech/trinity-user-agents/pull/1974, draft). On hosts implementing RFC-0028 a paired session's `rootAddress` is that account, and `signMessageWithDotNsIdentity`'s `accountId` is that account, which the host's legacy signer accepts as the session's identity account. Documentation only, no behaviour change: `lookupUsername`, `resolvePeopleUsernameOwner` and `signMessageWithDotNsIdentity` stay account-agnostic.
