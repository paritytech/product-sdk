---
type: llm
focus: trace
weight: 1
---

ensureContractAccountMapped is called for the owner before submission, and the prepared call is submitted with the product's signer using batchSubmitAndWatch or submitAndWatch with waitFor: "finalized"
