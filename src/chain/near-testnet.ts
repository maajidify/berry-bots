/**
 * Testnet mode (opt-in, never used by tests or the default `npm run dev`).
 * - The operator account (your testnet account) calls `settle_round` on the berry contract.
 * - Each bot is a sub-account holding ONLY a function-call key scoped to `bot_pay` on the
 *   berry contract (created by `npm run testnet:setup`). Bots sign their own deal payments.
 * Enable with CHAIN_MODE=testnet plus the env vars listed in .env.example.
 */
import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPairString } from "near-api-js";
import type { Bot, RoundLedger } from "../engine/types";
import { ChainAdapter, ChainInfo, planSettlement, SettleReceipt } from "./types";

export interface TestnetEnv {
  rpcUrl: string;
  contractId: string;
  operatorId: string;
  operatorKey: KeyPairString;
  botParent: string;
  credentialsDir: string;
  settleEvery: number;
}

export function testnetEnv(env: Record<string, string | undefined> = process.env): TestnetEnv {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`testnet mode needs ${k} (see .env.example)`);
    return v;
  };
  const operatorId = need("NEAR_OPERATOR_ID");
  return {
    rpcUrl: env.NEAR_RPC_URL || "https://test.rpc.fastnear.com",
    contractId: env.BERRY_CONTRACT_ID || `berry.${operatorId}`,
    operatorId,
    operatorKey: need("NEAR_OPERATOR_KEY") as KeyPairString,
    botParent: env.BOT_PARENT_ACCOUNT || operatorId,
    credentialsDir: env.BOT_CREDENTIALS_DIR || path.resolve(".near-credentials/berry-bots"),
    settleEvery: Number(env.SETTLE_EVERY || 5),
  };
}

export const botAccountId = (botId: string, parent: string) => `${botId}.${parent}`;

export function readBotKey(dir: string, accountId: string): KeyPairString {
  const file = path.join(dir, `${accountId}.json`);
  if (!fs.existsSync(file)) throw new Error(`missing bot key ${file}; run npm run testnet:setup`);
  return JSON.parse(fs.readFileSync(file, "utf8")).private_key as KeyPairString;
}

const TGAS = 1_000_000_000_000n;
const txHashOf = (res: any): string => res?.transaction?.hash ?? res?.transaction_outcome?.id ?? "unknown";

export class NearTestnetChain implements ChainAdapter {
  private provider: JsonRpcProvider;
  private operator: Account;
  private botAccounts = new Map<string, Account>();

  constructor(private env: TestnetEnv) {
    this.provider = new JsonRpcProvider({ url: env.rpcUrl });
    this.operator = new Account(env.operatorId, this.provider, env.operatorKey);
  }

  info(): ChainInfo {
    return {
      mode: "testnet",
      network: "NEAR testnet",
      contractId: this.env.contractId,
      explorer: `https://testnet.nearblocks.io/address/${this.env.contractId}`,
      settleEvery: this.env.settleEvery,
    };
  }

  async setup(bots: Bot[]) {
    const registered = (await this.provider.callFunction({
      contractId: this.env.contractId,
      method: "get_bots",
      args: {},
    })) as [string, unknown][] | undefined;
    const ids = new Set((registered ?? []).map((r) => r[0]));
    for (const b of bots) {
      const acc = botAccountId(b.id, this.env.botParent);
      if (!ids.has(acc)) throw new Error(`${acc} is not registered on ${this.env.contractId}; run npm run testnet:setup`);
      this.botAccounts.set(b.id, new Account(acc, this.provider, readBotKey(this.env.credentialsDir, acc)));
    }
  }

  async settle(ledgers: RoundLedger[]): Promise<SettleReceipt> {
    const fromRound = ledgers[0].round;
    const round = ledgers[ledgers.length - 1].round;
    const txHashes: string[] = [];
    const dealTxs: string[] = [];
    const acc = (id: string) => botAccountId(id, this.env.botParent);
    try {
      for (const step of planSettlement(ledgers)) {
        if (step.kind === "deal") {
          const t = step.transfer;
          const signer = this.botAccounts.get(t.from);
          if (!signer) throw new Error(`no key loaded for ${t.from}`);
          const res = await signer.callFunctionRaw({
            contractId: this.env.contractId,
            methodName: "bot_pay",
            args: { receiver_id: acc(t.to), amount: String(t.amount), memo: `deal r${step.round}` },
            gas: 30n * TGAS,
          });
          dealTxs.push(txHashOf(res));
        } else {
          const b = step.batch;
          const res = await this.operator.callFunctionRaw({
            contractId: this.env.contractId,
            methodName: "settle_round",
            args: {
              round: b.round,
              board_hash: b.boardHash,
              mints: Object.entries(b.mints).map(([id, v]) => [acc(id), String(v)]),
              burns: Object.entries(b.burns).map(([id, v]) => [acc(id), String(v)]),
              transfers: b.overwrites.map((t) => [acc(t.from), acc(t.to), String(t.amount)]),
            },
            gas: 300n * TGAS,
          });
          txHashes.push(txHashOf(res));
        }
      }
      const last = txHashes[txHashes.length - 1];
      return {
        mode: "testnet",
        fromRound,
        round,
        ok: true,
        txHashes,
        dealTxs,
        explorerUrl: last ? `https://testnet.nearblocks.io/txns/${last}` : undefined,
      };
    } catch (e) {
      return { mode: "testnet", fromRound, round, ok: false, txHashes, dealTxs, error: (e as Error).message };
    }
  }
}
