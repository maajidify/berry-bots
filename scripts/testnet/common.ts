/**
 * Shared helpers for the testnet scripts. These scripts SEND REAL TESTNET TRANSACTIONS and are
 * never run by `npm test` or `npm run dev`. Every script is a dry run unless you pass --yes.
 */
import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairString } from "near-api-js";
import { testnetEnv } from "../../src/chain/near-testnet";

try {
  (process as any).loadEnvFile?.(".env");
} catch {
  /* optional */
}

export const YES = process.argv.includes("--yes");
export const env = testnetEnv();
export const provider = new JsonRpcProvider({ url: env.rpcUrl });
export const operator = new Account(env.operatorId, provider, env.operatorKey);
export const TGAS = 1_000_000_000_000n;
export const operatorPublicKey = () => KeyPair.fromString(env.operatorKey).getPublicKey();

export function plan(lines: string[]) {
  console.log(`\n${YES ? "SENDING" : "DRY RUN (add --yes to send)"} on ${env.rpcUrl}`);
  for (const l of lines) console.log("  • " + l);
  console.log("");
}

export async function accountExists(accountId: string) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

export function saveBotKey(accountId: string, kp: KeyPair) {
  fs.mkdirSync(env.credentialsDir, { recursive: true });
  const file = path.join(env.credentialsDir, `${accountId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() as KeyPairString }, null, 2),
    { mode: 0o600 },
  );
  return file;
}
