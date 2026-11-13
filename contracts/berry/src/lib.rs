//! Berry Bots on-chain layer: the $BERRY NEP-141 token and the game ledger in one contract.
//!
//! Why one contract: NEP-141 `ft_transfer` requires an attached deposit of exactly 1 yoctoNEAR,
//! and NEAR function-call access keys cannot attach deposits. Bots hold *function-call keys only*
//! (scoped to this contract, method `bot_pay`, with a gas allowance), so bot-to-bot payments go
//! through `bot_pay`, which needs no deposit and is capped per call. The game operator settles
//! each round's mints (pixel emission), burns (paint costs) and overwrite payouts with
//! `settle_round`, anchoring the board hash on chain.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint, FtTransfer};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

/// 3 decimals: 1 BERRY = 1000 units, identical to the off-chain engine's milli-BERRY.
pub const DECIMALS: u8 = 3;

const BERRY_ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 14' shape-rendering='crispEdges'%3E%3Crect x='3' y='3' width='6' height='9' fill='%23ff004d'/%3E%3Crect x='1' y='5' width='10' height='5' fill='%23ff004d'/%3E%3Crect x='3' y='1' width='6' height='2' fill='%23008751'/%3E%3Crect x='4' y='6' width='1' height='1' fill='%23ffec27'/%3E%3Crect x='7' y='8' width='1' height='1' fill='%23ffec27'/%3E%3C/svg%3E";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    FungibleToken,
    Metadata,
    Bots,
    Rounds,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BotInfo {
    pub name: String,
    pub personality: String,
    pub paid_out: U128,
    pub received: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RoundSummary {
    pub round: u32,
    pub board_hash: String,
    pub minted: U128,
    pub burned: U128,
    pub transferred: U128,
    pub block_height: u64,
}

#[near(serializers = [json])]
pub struct GameStats {
    pub owner_id: AccountId,
    pub total_supply: U128,
    pub total_minted: U128,
    pub total_burned: U128,
    pub last_round: u32,
    pub bots: u32,
    pub max_bot_pay: U128,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct BerryGame {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,
    bots: IterableMap<AccountId, BotInfo>,
    rounds: LookupMap<u32, RoundSummary>,
    last_round: u32,
    total_minted: u128,
    total_burned: u128,
    max_bot_pay: u128,
}

#[near]
impl BerryGame {
    #[init]
    pub fn new(owner_id: AccountId, max_bot_pay: U128) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Berry Bots Berry".to_string(),
            symbol: "BERRY".to_string(),
            icon: Some(BERRY_ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        };
        Self {
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            owner_id,
            bots: IterableMap::new(StorageKey::Bots),
            rounds: LookupMap::new(StorageKey::Rounds),
            last_round: 0,
            total_minted: 0,
            total_burned: 0,
            max_bot_pay: max_bot_pay.0,
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the game operator");
    }

    fn assert_bot(&self, id: &AccountId) {
        require!(self.bots.contains_key(id), "not a registered bot");
    }

    fn mint(&mut self, account_id: &AccountId, amount: u128, memo: &str) {
        if amount == 0 {
            return;
        }
        self.token.internal_deposit(account_id, amount);
        self.total_minted += amount;
        FtMint { owner_id: account_id, amount: U128(amount), memo: Some(memo) }.emit();
    }

    /// Operator registers a bot wallet (usually a sub-account like `pixela.berrybots.testnet`)
    /// and mints its starting balance.
    pub fn register_bot(&mut self, account_id: AccountId, name: String, personality: String, initial_balance: U128) {
        self.assert_owner();
        require!(!self.bots.contains_key(&account_id), "bot already registered");
        if self.token.accounts.get(&account_id).is_none() {
            self.token.internal_register_account(&account_id);
        }
        self.bots.insert(
            account_id.clone(),
            BotInfo { name, personality, paid_out: U128(0), received: U128(0) },
        );
        self.mint(&account_id, initial_balance.0, "spawn");
    }

    /// Operator settles one round (or a batch of rounds) of the off-chain game.
    /// `mints`: pixel emission per bot. `burns`: paint costs burned. `transfers`: overwrite payouts
    /// (painter -> previous owner). Inflows are applied before outflows so a valid engine
    /// ledger can never underflow mid-settlement.
    pub fn settle_round(
        &mut self,
        round: u32,
        board_hash: String,
        mints: Vec<(AccountId, U128)>,
        burns: Vec<(AccountId, U128)>,
        transfers: Vec<(AccountId, AccountId, U128)>,
    ) -> RoundSummary {
        self.assert_owner();
        require!(round > self.last_round, "round already settled");
        require!(board_hash.len() <= 128, "board hash too long");

        let mut minted: u128 = 0;
        for (acc, amount) in mints.iter() {
            self.assert_bot(acc);
            self.mint(acc, amount.0, "pixel emission");
            minted += amount.0;
        }
        let mut transferred: u128 = 0;
        for (from, to, amount) in transfers.iter() {
            self.assert_bot(from);
            self.assert_bot(to);
            require!(from != to, "self transfer");
            self.token.internal_deposit(to, amount.0);
            transferred += amount.0;
        }
        for (from, to, amount) in transfers.iter() {
            self.token.internal_withdraw(from, amount.0);
            FtTransfer { old_owner_id: from, new_owner_id: to, amount: *amount, memo: Some("pixel overwrite") }.emit();
        }
        let mut burned: u128 = 0;
        for (acc, amount) in burns.iter() {
            self.assert_bot(acc);
            if amount.0 == 0 {
                continue;
            }
            self.token.internal_withdraw(acc, amount.0);
            burned += amount.0;
            FtBurn { owner_id: acc, amount: *amount, memo: Some("paint") }.emit();
        }
        self.total_burned += burned;
        self.last_round = round;
        let summary = RoundSummary {
            round,
            board_hash,
            minted: U128(minted),
            burned: U128(burned),
            transferred: U128(transferred),
            block_height: env::block_height(),
        };
        self.rounds.insert(round, summary.clone());
        log!(
            "EVENT_JSON:{{\"standard\":\"berry-bots\",\"version\":\"1.0.0\",\"event\":\"round_settled\",\"data\":[{{\"round\":{},\"board_hash\":\"{}\",\"minted\":\"{}\",\"burned\":\"{}\"}}]}}",
            round, summary.board_hash, minted, burned
        );
        summary
    }

    /// A bot pays another bot (deal / bribe / mercenary contract). Callable with a function-call
    /// key because it needs no attached deposit. Capped per call by `max_bot_pay`.
    pub fn bot_pay(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let sender = env::predecessor_account_id();
        self.assert_bot(&sender);
        self.assert_bot(&receiver_id);
        require!(sender != receiver_id, "self payment");
        require!(amount.0 > 0 && amount.0 <= self.max_bot_pay, "amount over the per-call cap");
        self.token.internal_transfer(&sender, &receiver_id, amount.0, memo);
        let s = self.bots.get_mut(&sender).unwrap();
        s.paid_out = U128(s.paid_out.0 + amount.0);
        let r = self.bots.get_mut(&receiver_id).unwrap();
        r.received = U128(r.received.0 + amount.0);
    }

    pub fn set_max_bot_pay(&mut self, max_bot_pay: U128) {
        self.assert_owner();
        self.max_bot_pay = max_bot_pay.0;
    }

    pub fn get_bots(&self) -> Vec<(AccountId, BotInfo)> {
        self.bots.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn get_round(&self, round: u32) -> Option<RoundSummary> {
        self.rounds.get(&round).cloned()
    }

    pub fn get_stats(&self) -> GameStats {
        GameStats {
            owner_id: self.owner_id.clone(),
            total_supply: U128(self.token.total_supply),
            total_minted: U128(self.total_minted),
            total_burned: U128(self.total_burned),
            last_round: self.last_round,
            bots: self.bots.len(),
            max_bot_pay: U128(self.max_bot_pay),
        }
    }
}

/* ----------------------------------------------------------- NEP-141 boilerplate */

#[near]
impl FungibleTokenCore for BerryGame {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for BerryGame {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("Account @{} burned {}", sender_id, burned);
        }
        used.into()
    }
}

#[near]
impl StorageManagement for BerryGame {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for BerryGame {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("berry.testnet"))
            .predecessor_account_id(acc(predecessor))
            .build());
    }

    fn setup() -> BerryGame {
        ctx("operator.testnet");
        let mut c = BerryGame::new(acc("operator.testnet"), U128(50_000));
        c.register_bot(acc("goldie.berry.testnet"), "Goldie".into(), "greedy".into(), U128(250_000));
        c.register_bot(acc("grief.berry.testnet"), "Grief".into(), "troll".into(), U128(250_000));
        c
    }

    #[test]
    fn metadata_and_spawn() {
        let c = setup();
        assert_eq!(c.ft_metadata().symbol, "BERRY");
        assert_eq!(c.ft_metadata().decimals, 3);
        assert_eq!(c.ft_total_supply().0, 500_000);
        assert_eq!(c.ft_balance_of(acc("goldie.berry.testnet")).0, 250_000);
        assert_eq!(c.get_stats().bots, 2);
    }

    #[test]
    fn settle_round_mints_burns_and_pays() {
        let mut c = setup();
        let s = c.settle_round(
            1,
            "abcd".into(),
            vec![(acc("goldie.berry.testnet"), U128(1_200))],
            vec![(acc("grief.berry.testnet"), U128(3_000)), (acc("goldie.berry.testnet"), U128(40_000))],
            vec![(acc("grief.berry.testnet"), acc("goldie.berry.testnet"), U128(3_000))],
        );
        assert_eq!(s.minted.0, 1_200);
        assert_eq!(s.burned.0, 43_000);
        assert_eq!(c.ft_balance_of(acc("goldie.berry.testnet")).0, 250_000 + 1_200 + 3_000 - 40_000);
        assert_eq!(c.ft_balance_of(acc("grief.berry.testnet")).0, 250_000 - 3_000 - 3_000);
        assert_eq!(c.ft_total_supply().0, 500_000 + 1_200 - 43_000);
        assert_eq!(c.get_round(1).unwrap().board_hash, "abcd");
    }

    #[test]
    #[should_panic(expected = "round already settled")]
    fn settle_round_rejects_replay() {
        let mut c = setup();
        c.settle_round(1, "a".into(), vec![], vec![], vec![]);
        c.settle_round(1, "a".into(), vec![], vec![], vec![]);
    }

    #[test]
    #[should_panic(expected = "only the game operator")]
    fn settle_round_owner_only() {
        let mut c = setup();
        ctx("grief.berry.testnet");
        c.settle_round(1, "a".into(), vec![(acc("grief.berry.testnet"), U128(1_000_000))], vec![], vec![]);
    }

    #[test]
    fn bot_pay_moves_tokens_without_deposit() {
        let mut c = setup();
        ctx("goldie.berry.testnet");
        c.bot_pay(acc("grief.berry.testnet"), U128(8_000), Some("peace".into()));
        assert_eq!(c.ft_balance_of(acc("grief.berry.testnet")).0, 258_000);
        assert_eq!(c.ft_balance_of(acc("goldie.berry.testnet")).0, 242_000);
        let bots = c.get_bots();
        let g = bots.iter().find(|(a, _)| a.as_str() == "goldie.berry.testnet").unwrap();
        assert_eq!(g.1.paid_out.0, 8_000);
    }

    #[test]
    #[should_panic(expected = "amount over the per-call cap")]
    fn bot_pay_is_capped() {
        let mut c = setup();
        ctx("goldie.berry.testnet");
        c.bot_pay(acc("grief.berry.testnet"), U128(60_000), None);
    }

    #[test]
    #[should_panic(expected = "not a registered bot")]
    fn strangers_cannot_bot_pay() {
        let mut c = setup();
        ctx("random.testnet");
        c.bot_pay(acc("grief.berry.testnet"), U128(1), None);
    }
}
