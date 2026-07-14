---
"@parity/product-sdk-terminal": minor
---

Export the RFC-0010 resource-allocation API from the package root: the cached, adapter-scoped `requestResourceAllocation`, plus a new cache-free `sendResourceAllocation(session, productId, resources, onExisting)` primitive for consumers that hold only a `productId` and manage their own policy. The `AllocatableResource`, `ApAllocationOutcome`, `OnExistingAllowancePolicy`, and `RequestResourceAllocationOptions` types (all derived from `UserSession`, so they can't drift from the host codec) are exported alongside.

This lets `@parity/product-sdk-auth` delegate its allocation call to terminal instead of maintaining a second hand-declared copy of the wire types and call.
