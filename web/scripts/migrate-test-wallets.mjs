import { migratePlainToEncrypted, hasEncryptedStore, hasPlainStore } from "./wallet-store.mjs";

if (!hasPlainStore()) {
  if (hasEncryptedStore()) {
    console.log("Plaintext test-wallets.json already migrated; encrypted store exists.");
    process.exit(0);
  }
  console.error("No test-wallets.json found to migrate.");
  process.exit(1);
}

migratePlainToEncrypted();
console.log("Migrated test-wallets.json to test-wallets.json.enc and removed plaintext file.");
