#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol,
};

const ADMIN: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN: Symbol = symbol_short!("PEND_ADM");

// Conservative TTL bump so offset records don't get archived between writes.
// Values are in ledgers (~5s each): ~6 days threshold, ~30 days bump.
const BUMP_THRESHOLD: u32 = 100_000;
const BUMP_AMOUNT: u32 = 500_000;

// Instance TTL bounds: ~6 days threshold, ~30 days bump. Instance storage holds
// the admin config, so every state-changing entrypoint must extend it to avoid
// the config being archived on a quiet deployment.
const TTL_MIN: u32 = 100_000;
const TTL_MAX: u32 = 500_000;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Offset(u64),
}

/// On-chain carbon offset certificate for a single order.
#[derive(Clone)]
#[contracttype]
pub struct CarbonOffset {
    pub order_id: u64,
    pub kg_co2: u64,
    pub offset_paid: bool,
    pub verifier: Address,
}

#[contract]
pub struct CarbonOffsetContract;

/// Extend the instance storage TTL so admin/config data is never archived.
fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(TTL_MIN, TTL_MAX);
}

#[contractimpl]
impl CarbonOffsetContract {
    /// One-time setup: sets the platform admin address allowed to call `record_offset`.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
        bump_instance(&env);
    }

    /// Record a verified carbon offset for `order_id`. Callable only by the platform admin.
    /// Emits ("carbon", "offset", order_id, kg_co2).
    pub fn record_offset(env: Env, order_id: u64, kg_co2: u64, verifier: Address) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        admin.require_auth();

        let key = DataKey::Offset(order_id);
        if env.storage().persistent().has(&key) {
            panic!("offset already recorded for this order");
        }

        let record = CarbonOffset {
            order_id,
            kg_co2,
            offset_paid: true,
            verifier,
        };

        // Write state before publishing the event — no external calls occur in this
        // function, so there is no reentrancy window, but this keeps the pattern
        // consistent with the escrow contracts (state settled before any side effect).
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);

        bump_instance(&env);

        env.events().publish(
            (symbol_short!("carbon"), symbol_short!("offset")),
            (order_id, kg_co2),
        );
    }

    /// Public, read-only lookup of an order's carbon offset record.
    pub fn get_offset(env: Env, order_id: u64) -> CarbonOffset {
        env.storage()
            .persistent()
            .get(&DataKey::Offset(order_id))
            .expect("offset not found")
    }

    /// Begin a two-step admin transfer. Only the current admin may propose.
    pub fn propose_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&PENDING_ADMIN, &new_admin);
        bump_instance(&env);
    }

    /// Complete an admin transfer. Only the proposed address may accept.
    pub fn accept_admin(env: Env) {
        let pending: Address = env
            .storage()
            .instance()
            .get(&PENDING_ADMIN)
            .expect("no pending admin");
        pending.require_auth();
        env.storage().instance().set(&ADMIN, &pending);
        env.storage().instance().remove(&PENDING_ADMIN);
        bump_instance(&env);
    }

    /// Replace this contract's WASM. Only the current admin may upgrade.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .expect("not initialized");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        bump_instance(&env);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    #[test]
    fn record_and_get_offset() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, CarbonOffsetContract);
        let client = CarbonOffsetContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);

        client.initialize(&admin);
        client.record_offset(&42, &120, &verifier);

        let record = client.get_offset(&42);
        assert_eq!(record.order_id, 42);
        assert_eq!(record.kg_co2, 120);
        assert!(record.offset_paid);
        assert_eq!(record.verifier, verifier);
    }

    #[test]
    #[should_panic(expected = "offset already recorded")]
    fn duplicate_offset_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, CarbonOffsetContract);
        let client = CarbonOffsetContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);

        client.initialize(&admin);
        client.record_offset(&1, &10, &verifier);
        client.record_offset(&1, &10, &verifier);
    }

    #[test]
    fn instance_ttl_extended_across_calls() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, CarbonOffsetContract);
        let client = CarbonOffsetContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);

        client.initialize(&admin);

        // Advance the ledger past TTL_MIN between calls; the instance config
        // (admin) must still be readable because each entrypoint bumps the TTL.
        env.ledger().with_mut(|l| {
            l.sequence_number += TTL_MIN + 1;
        });

        client.record_offset(&7, &50, &verifier);

        env.ledger().with_mut(|l| {
            l.sequence_number += TTL_MIN + 1;
        });

        let record = client.get_offset(&7);
        assert_eq!(record.order_id, 7);
        assert_eq!(record.kg_co2, 50);
    }
}
