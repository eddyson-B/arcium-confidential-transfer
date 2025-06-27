use anchor_lang::prelude::*;
use arcium_anchor::{
    comp_def_offset,
    derive_cluster_pda,
    derive_comp_def_pda,
    derive_comp_pda,
    derive_execpool_pda,
    derive_mempool_pda,
    derive_mxe_pda,
    init_comp_def,
    queue_computation,
    ComputationOutputs,
    ARCIUM_CLOCK_ACCOUNT_ADDRESS,
    ARCIUM_STAKING_POOL_ACCOUNT_ADDRESS,
    CLUSTER_PDA_SEED,
    COMP_PDA_SEED,
    COMP_DEF_PDA_SEED,
    EXECPOOL_PDA_SEED,
    MEMPOOL_PDA_SEED,
    MXE_PDA_SEED,
};
use arcium_client::idl::arcium::{
    accounts::{
        ClockAccount, Cluster, ComputationDefinitionAccount, PersistentMXEAccount, StakingPoolAccount
    },
    program::Arcium,
    types::Argument,
    ID_CONST as ARCIUM_PROG_ID,
};
use arcium_macros::{
    arcium_callback,
    arcium_program,
    callback_accounts,
    init_computation_definition_accounts,
    queue_computation_accounts,
};
use anchor_spl::{
    token::{Mint, Token, TokenAccount},
    associated_token::AssociatedToken,
};

const COMP_DEF_OFFSET_WRAP: u32 = comp_def_offset("wrap");
const COMP_DEF_OFFSET_TRANSFER: u32 = comp_def_offset("transfer");

declare_id!("75MYEEgbXuUeXwUa834fhyAWgEtsjrajgWjiQj5Th3eF");

#[arcium_program]
pub mod confidential_transfer_arcium_demo {
    use arcium_client::idl::arcium::types::CallbackAccount;

    use super::*;

    pub fn init_wrap_comp_def(ctx: Context<InitWrapCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, None, None)?;
        Ok(())
    }

    pub fn init_transfer_comp_def(ctx: Context<InitTransferCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, true, None, None)?;
        Ok(())
    }

    pub fn wrap(
        ctx: Context<Wrap>,
        computation_offset: u64,
        amount: u64,
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        // Transfer SPL tokens to program-owned PDA
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.program_token_account.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        );
        anchor_spl::token::transfer(transfer_ctx, amount)?;

        let args = vec![
            Argument::PlaintextU64(amount),
            Argument::ArcisPubkey(pub_key),
            Argument::PlaintextU128(nonce),
        ];
        queue_computation(ctx.accounts, computation_offset, args, vec![
            CallbackAccount{
                pubkey: ctx.accounts.encrypted_balance_account.to_account_info().key(),
                is_writable: true,
            },
        ], None)?;
        Ok(())
    }

    pub fn transfer(
        ctx: Context<Transfer>,
        computation_offset: u64,
        amount: u64,
    ) -> Result<()> {
        let args = vec![
            Argument::ArcisPubkey(ctx.accounts.sender_account.encryption_pubkey),
            Argument::PlaintextU128(ctx.accounts.sender_account.nonce),
            Argument::EncryptedU64(ctx.accounts.sender_account.encrypted_balance),
            Argument::ArcisPubkey(ctx.accounts.receiver_account.encryption_pubkey),
            Argument::PlaintextU128(ctx.accounts.receiver_account.nonce),
            Argument::EncryptedU64(ctx.accounts.receiver_account.encrypted_balance),
            Argument::PlaintextU64(amount),
        ];
        queue_computation(ctx.accounts, computation_offset, args, vec![
            CallbackAccount{
                pubkey: ctx.accounts.sender_account.to_account_info().key(),
                is_writable: true,
            },
            CallbackAccount{
                pubkey: ctx.accounts.receiver_account.to_account_info().key(),
                is_writable: true,
            },
        ], None)?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "wrap")]
    pub fn wrap_callback(
        ctx: Context<WrapCallback>,
        output: ComputationOutputs,
    ) -> Result<()> {
        let bytes = if let ComputationOutputs::Bytes(bytes) = output {
            bytes
        } else {
            return Err(ErrorCode::AbortedComputation.into());
        };

        // Store the encrypted balance in the PDA
        ctx.accounts.encrypted_balance_account.encryption_pubkey = bytes[0..32].try_into().unwrap();
        ctx.accounts.encrypted_balance_account.nonce = u128::from_le_bytes(bytes[32..48].try_into().unwrap());
        ctx.accounts.encrypted_balance_account.encrypted_balance = bytes[48..80].try_into().unwrap();
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "transfer")]
    pub fn transfer_callback(
        ctx: Context<TransferCallback>,
        output: ComputationOutputs,
    ) -> Result<()> {
        let bytes = if let ComputationOutputs::Bytes(bytes) = output {
            bytes
        } else {
            return Err(ErrorCode::AbortedComputation.into());
        };

        let success = bytes[0];
        
        if success == 1 {
            // Offset by 1 because of the success byte
            // No need to set the encryption pubkey as it's the same as before, skip 32 bytes
            ctx.accounts.sender_account.nonce = u128::from_le_bytes(bytes[33..49].try_into().unwrap()   );
            ctx.accounts.sender_account.encrypted_balance = bytes[49..81].try_into().unwrap();

            // No need to set the encryption pubkey as it's the same as before, skip 32 bytes
            ctx.accounts.receiver_account.nonce = u128::from_le_bytes(bytes[113..129].try_into().unwrap());
            ctx.accounts.receiver_account.encrypted_balance = bytes[129..161].try_into().unwrap();
        }
        
        Ok(())
    }
}


#[init_computation_definition_accounts("wrap", payer)]
#[derive(Accounts)]
pub struct InitWrapCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("transfer", payer)]
#[derive(Accounts)]
pub struct InitTransferCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, PersistentMXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    /// Can't check it here as it's not initialized yet.
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct SumEvent {
    pub sum: [u8; 32],
    pub nonce: [u8; 16],
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
}

#[queue_computation_accounts("wrap", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Wrap<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, PersistentMXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_WRAP)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_STAKING_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, StakingPoolAccount>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = token_mint,
        associated_token::authority = pool_authority,
    )]
    pub program_token_account: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    /// CHECK: PDA for pool authority
    #[account(
        init_if_needed,
        payer = payer,
        space = 8, // discriminator
        seeds = [b"pool_authority"],
        bump,
    )]
    pub pool_authority: Account<'info, PoolAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + 32 + 16 + 32, // discriminator + encrypted_balance + nonce + encryption_pubkey
        seeds = [b"encrypted_balance", payer.key().as_ref()],
        bump,
    )]
    pub encrypted_balance_account: Account<'info, EncryptedBalanceAccount>,
}

#[callback_accounts("wrap", payer)]
#[derive(Accounts)]
pub struct WrapCallback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_WRAP)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    // CHECK: No need for seeds as we pass this account to arcium via the callback accounts field in the wrap instruction
    pub encrypted_balance_account: Account<'info, EncryptedBalanceAccount>,
}

#[queue_computation_accounts("transfer", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Transfer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, PersistentMXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account, checked by the arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool, checked by the arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account, checked by the arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_TRANSFER)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_STAKING_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, StakingPoolAccount>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        mut,
        seeds = [b"encrypted_balance", sender.key().as_ref()],
        bump,
    )]
    pub sender_account: Account<'info, EncryptedBalanceAccount>,
    #[account(
        mut,
        seeds = [b"encrypted_balance", receiver.key().as_ref()],
        bump,
    )]
    pub receiver_account: Account<'info, EncryptedBalanceAccount>,
    /// CHECK: Sender public key
    pub sender: UncheckedAccount<'info>,
    /// CHECK: Receiver public key
    pub receiver: UncheckedAccount<'info>,
}

#[callback_accounts("transfer", payer)]
#[derive(Accounts)]
pub struct TransferCallback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_TRANSFER)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"encrypted_balance", sender.key().as_ref()],
        bump,
    )]
    pub sender_account: Account<'info, EncryptedBalanceAccount>,
    #[account(
        mut,
        seeds = [b"encrypted_balance", receiver.key().as_ref()],
        bump,
    )]
    pub receiver_account: Account<'info, EncryptedBalanceAccount>,
    /// CHECK: Sender public key
    pub sender: UncheckedAccount<'info>,
    /// CHECK: Receiver public key
    pub receiver: UncheckedAccount<'info>,
}

#[account]
pub struct EncryptedBalanceAccount {
    pub encrypted_balance: [u8; 32],
    pub nonce: u128,
    pub encryption_pubkey: [u8; 32],
}

#[account]
pub struct PoolAccount {}

