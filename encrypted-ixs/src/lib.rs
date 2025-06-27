use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    #[instruction]
    pub fn wrap(plaintext_tokens: u64, enc: Shared) -> Enc<Shared, u64> {
        enc.from_arcis(plaintext_tokens)
    }

    // returns (success, sender_balance, receiver_balance)
    #[instruction]
    pub fn transfer(sender_balance: Enc<Shared, u64>, receiver_balance: Enc<Shared, u64>, amount: u64) -> (u8, Enc<Shared, u64>, Enc<Shared, u64>) {
        let sender_balance_inner = sender_balance.to_arcis();
        let receiver_balance_inner = receiver_balance.to_arcis();
        // If we have insufficient funds, we return a failure
        let success = if sender_balance_inner < amount {
            0
        } else {
            1
        };

        let new_sender_balance = sender_balance_inner - amount;
        let new_receiver_balance = receiver_balance_inner + amount;
        (success, sender_balance.owner.from_arcis(new_sender_balance), receiver_balance.owner.from_arcis(new_receiver_balance))
    }
    
    // TODO: Add unwrap function, left as an exercise for the reader ;)
}


