//! Shared Soroban test fixtures: generated accounts and minimal mock tokens.
#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, testutils::Address as _, Address, Env};

/// Generate `N` fresh accounts.
pub fn accounts<const N: usize>(env: &Env) -> [Address; N] {
    core::array::from_fn(|_| Address::generate(env))
}

/// Generate a fresh account and mint `amount` of `token` (a [`MockToken`]) to it.
pub fn funded_account(env: &Env, token: &Address, amount: i128) -> Address {
    let account = Address::generate(env);
    MockTokenClient::new(env, token).mint(&account, &amount);
    account
}

/// Register a [`MockToken`] and return its address.
pub fn register_mock_token(env: &Env) -> Address {
    env.register(MockToken, ())
}

/// Register a [`NoopToken`] and return its address.
pub fn register_noop_token(env: &Env) -> Address {
    env.register(NoopToken, ())
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Balance(Address),
}

/// Minimal SEP-41-style token: `mint`, `balance` and a balance-checked `transfer`.
#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let bal = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&Key::Balance(to), &(bal + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&Key::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_bal = Self::balance(env.clone(), from.clone());
        assert!(from_bal >= amount, "insufficient balance");
        env.storage()
            .persistent()
            .set(&Key::Balance(from), &(from_bal - amount));
        Self::mint(env, to, amount);
    }
}

/// Token whose `transfer` does nothing; for tests that only need a callable token.
pub mod noop {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    #[contract]
    pub struct NoopToken;

    #[contractimpl]
    impl NoopToken {
        pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
    }
}
pub use noop::NoopToken;
