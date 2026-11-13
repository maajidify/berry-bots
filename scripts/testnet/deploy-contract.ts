/**
 * Deploy the berry contract (NEP-141 $BERRY + game ledger) to a testnet sub-account of yours.
 *   1. cd contracts/berry && cargo near build non-reproducible-wasm
 *   2. npm run testnet:deploy            # dry run
 *   3. npm run testnet:deploy -- --yes   # sends the transaction
 * Creates BERRY_CONTRACT_ID (default berry.<NEAR_OPERATOR_ID>) with 3 NEAR, deploys and calls
 * new(owner_id = operator, max_bot_pay = MAX_BOT_PAY) in ONE batched transaction.
 */
import fs from "node:fs";
import { actions, parseNearAmount } from "near-api-js";
import { accountExists, env, operator, operatorPublicKey, plan, TGAS, YES } from "./common";

const wasmPath = process.env.BERRY_WASM ?? "contracts/berry/target/near/berry.wasm";
const maxBotPay = process.env.MAX_BOT_PAY ?? "100000"; // 100 $BERRY (3 decimals)
const funding = process.env.CONTRACT_FUNDING_NEAR ?? "3";

if (!env.contractId.endsWith(`.${env.operatorId}`)) {
  throw new Error(`BERRY_CONTRACT_ID must be a sub-account of ${env.operatorId} for this script`);
}
if (!fs.existsSync(wasmPath)) throw new Error(`${wasmPath} not found. Build it: cd contracts/berry && cargo near build non-reproducible-wasm`);
if (await accountExists(env.contractId)) throw new Error(`${env.contractId} already exists. Delete it or pick another BERRY_CONTRACT_ID.`);

const wasm = fs.readFileSync(wasmPath);
plan([
  `create ${env.contractId} funded with ${funding} NEAR by ${env.operatorId}`,
  `add your operator key as its full-access key (so you can upgrade it)`,
  `deploy ${wasmPath} (${wasm.length} bytes)`,
  `call new({ owner_id: "${env.operatorId}", max_bot_pay: "${maxBotPay}" })`,
]);
if (!YES) process.exit(0);

const res = await operator.signAndSendTransaction({
  receiverId: env.contractId,
  actions: [
    actions.createAccount(),
    actions.transfer(BigInt(parseNearAmount(funding as `${number}`)!)),
    actions.addFullAccessKey(operatorPublicKey()),
    actions.deployContract(new Uint8Array(wasm)),
    actions.functionCall("new", { owner_id: env.operatorId, max_bot_pay: maxBotPay }, 100n * TGAS, 0n),
  ],
});
console.log(`deployed: https://testnet.nearblocks.io/txns/${(res as any).transaction?.hash}`);
