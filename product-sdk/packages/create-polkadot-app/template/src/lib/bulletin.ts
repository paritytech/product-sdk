// Encrypted storage on Bulletin Chain.
//
// BulletinClient uploads bytes to Bulletin Chain and returns a content-
// addressed CID. Pair with `./lib/crypto` to encrypt before upload.
//
// The lazy signer means BulletinClient can be created at app boot,
// before the user has signed in. Each upload resolves the current
// signer at call time and throws a clear error if none is selected.
//
// Usage:
//   import { getBulletin } from "./lib/bulletin";
//   const client = await getBulletin();
//   const { cid } = await client.store(ciphertext).send();
//   const bytes = await client.fetchBytes(cid);
//
// Reference: `bulletin-demo` in the @parity/product-sdk repo.

import { BulletinClient, createLazySigner } from "@parity/product-sdk-bulletin";
import { signerManager } from "./auth";

let clientPromise: Promise<BulletinClient> | null = null;

export async function getBulletin() {
  if (!clientPromise) {
    clientPromise = BulletinClient.create({
      environment: "paseo",
      signer: createLazySigner(() => signerManager.getSigner()),
    });
  }
  return clientPromise;
}
