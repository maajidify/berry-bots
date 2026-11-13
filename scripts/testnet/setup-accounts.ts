/**
 * Give every bot its own NEAR testnet wallet:
 *   <bot>.<BOT_PARENT_ACCOUNT>  (default parent: your operator account)
 * Each bot account is created holding ONLY a function-call access key that can call `bot_pay`
 * on the berry contract, with a small gas allowance. No full-access key exists for bots: the
 * worst a compromised bot key can do is pay another registered bot, up to max_bot_pay per call.
 * Then the operator registers each bot on the contract, which mints its starting $BERRY.
 *   npm run testnet:setup            # dry run
 *   npm run testnet:setup -- --yes   # sends transactions; keys saved to .near-credentials/berry-bots/
 */
import { actions, KeyPair, parseNearAmount } from "near-api-js";
import { BOT_SPECS } from "../../src/bots/personalities";
import { makeConfig } from "../../src/engine/config";
import { botAccountId } from "../../src/chain/near-testnet";
import { accountExists, env, operator, plan, saveBotKey, TGAS, YES } from "./common";

const fundEach = process.env.BOT_FUNDING_NEAR ?? "0.2";
const allowance = BigInt(parseNearAmount((process.env.BOT_GAS_ALLOWANCE_NEAR ?? "0.15") as `${number}`)!);
const startBalance = String(makeConfig().startBalance);

if (env.botParent !== env.operatorId) {
  throw new Error("This script creates bots as sub-accounts of your operator account; set BOT_PARENT_ACCOUNT to NEAR_OPERATOR_ID");
}

plan([
  ...BOT_SPECS.map((b) => `create ${botAccountId(b.id, env.botParent)} (${fundEach} NEAR) with a function-call key → ${env.contractId}.bot_pay`),
  ...BOT_SPECS.map((b) => `register_bot(${botAccountId(b.id, env.botParent)}, "${b.name}", "${b.personality}", ${startBalance}) → mints ${Number(startBalance) / 1000} $BERRY`),
]);
if (!YES) process.exit(0);

for (const b of BOT_SPECS) {
  const accountId = botAccountId(b.id, env.botParent);
  if (await accountExists(accountId)) {
    console.log(`${accountId} exists, skipping creation`);
  } else {
    const kp = KeyPair.fromRandom("ed25519");
    await operator.signAndSendTransaction({
      receiverId: accountId,
      actions: [
        actions.createAccount(),
        actions.transfer(BigInt(parseNearAmount(fundEach as `${number}`)!)),
        actions.addFunctionCallAccessKey(kp.getPublicKey(), env.contractId, ["bot_pay"], allowance),
      ],
    });
    console.log(`created ${accountId}; key saved to ${saveBotKey(accountId, kp)}`);
  }
  await operator.callFunction({
    contractId: env.contractId,
    methodName: "register_bot",
    args: { account_id: accountId, name: b.name, personality: b.personality, initial_balance: startBalance },
    gas: 50n * TGAS,
  });
  console.log(`registered ${accountId}`);
}
console.log("\nDone. Start the game on testnet with: CHAIN_MODE=testnet npm run dev");
