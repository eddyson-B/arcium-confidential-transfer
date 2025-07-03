import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { ConfidentialTransfer } from "../target/types/confidential_transfer_arcium";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgAddress,
  uploadCircuit,
  buildFinalizeCompDefTx,
  RescueCipher,
  deserializeLE,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  x25519,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

describe("ConfidentialTransfer", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace
    .ConfidentialTransfer as Program<ConfidentialTransfer>;
  const provider = anchor.getProvider();

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(
    eventName: E
  ): Promise<Event[E]> => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (event) => {
        res(event);
      });
    });
    await program.removeEventListener(listenerId);

    return event;
  };

  const arciumEnv = getArciumEnv();

  // Shared test setup
  let owner: anchor.web3.Keypair;
  let mint: PublicKey;
  let userTokenAccount: PublicKey;
  let sender: anchor.web3.Keypair;
  let receiver: anchor.web3.Keypair;
  let senderTokenAccount: PublicKey;
  let receiverTokenAccount: PublicKey;
  let poolAuthority: PublicKey;
  let programTokenAccount: PublicKey;

  before(async () => {
    owner = readKpJson(`./id.json`);

    // Create a test mint
    console.log("Creating test mint");
    mint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9 // 9 decimals
    );
    console.log("Mint created:", mint.toBase58());

    // Create user token account for first test
    console.log("Creating user token account");
    userTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      owner.publicKey
    );
    console.log("User token account created:", userTokenAccount.toBase58());

    // Create two users for second test
    sender = anchor.web3.Keypair.generate();
    receiver = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to both users
    console.log("Airdropping SOL to sender and receiver");
    await provider.connection.requestAirdrop(sender.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(receiver.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    
    // Create token accounts for both users
    console.log("Creating token accounts for sender and receiver");
    senderTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      sender.publicKey
    );
    receiverTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      receiver.publicKey
    );
    console.log("Sender token account:", senderTokenAccount.toBase58());
    console.log("Receiver token account:", receiverTokenAccount.toBase58());

    // Get PDAs
    [poolAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_authority")],
      program.programId
    );

    [programTokenAccount] = PublicKey.findProgramAddressSync(
      [
        poolAuthority.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    console.log("Pool authority:", poolAuthority.toBase58());
    console.log("Program token account:", programTokenAccount.toBase58());

    // Get encrypted balance account PDA for owner
    const [encryptedBalanceAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("encrypted_balance"), owner.publicKey.toBuffer()],
      program.programId
    );

    console.log("Encrypted balance account:", encryptedBalanceAccount.toBase58());

    // Initialize wrap computation definition
    console.log("Initializing wrap computation definition");
    const initWrapSig = await initWrapCompDef(program, owner, false, false);
    console.log("Wrap computation definition initialized with signature", initWrapSig);

    // Initialize transfer computation definition
    console.log("Initializing transfer computation definition");
    const initTransferSig = await initTransferCompDef(program, owner, false, false);
    console.log("Transfer computation definition initialized with signature", initTransferSig);
  });

  it("Should wrap tokens successfully", async () => {
    // Mint some tokens to user
    const mintAmount = 1000000000; // 1 token with 9 decimals
    console.log("Minting tokens to user");
    await mintTo(
      provider.connection,
      owner,
      mint,
      userTokenAccount,
      owner,
      mintAmount
    );
    console.log("Tokens minted to user");

    // Check user balance
    const userAccountInfo = await getAccount(provider.connection, userTokenAccount);
    console.log("User balance before wrap:", userAccountInfo.amount.toString());
    expect(userAccountInfo.amount.toString()).to.equal(mintAmount.toString());

    // Setup encryption
    const privateKey = x25519.utils.randomPrivateKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const mxePublicKey = new Uint8Array([
      34, 56, 246, 3, 165, 122, 74, 68, 14, 81, 107, 73, 129, 145, 196, 4, 98,
      253, 120, 15, 235, 108, 37, 198, 124, 111, 38, 1, 210, 143, 72, 87,
    ]);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    const wrapAmount = 500000000; // 0.5 tokens
    const nonce = randomBytes(16);
    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    // Get encrypted balance account PDA for owner
    const [encryptedBalanceAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("encrypted_balance"), owner.publicKey.toBuffer()],
      program.programId
    );

    console.log("Pool authority:", poolAuthority.toBase58());
    console.log("Program token account:", programTokenAccount.toBase58());
    console.log("Encrypted balance account:", encryptedBalanceAccount.toBase58());

    // Execute wrap
    console.log("Executing wrap");
    const queueSig = await program.methods
      .wrap(
        computationOffset,
        new anchor.BN(wrapAmount),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        computationAccount: getComputationAccAddress(
          program.programId,
          computationOffset
        ),
        clusterAccount: arciumEnv.arciumClusterPubkey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(program.programId),
        executingPool: getExecutingPoolAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("wrap")).readUInt32LE()
        ),
        userTokenAccount: userTokenAccount,
        programTokenAccount: programTokenAccount,
        tokenMint: mint,
        poolAuthority: poolAuthority,
        encryptedBalanceAccount: encryptedBalanceAccount,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Wrap queue signature:", queueSig);

    // Wait for computation finalization
    const finalizeSig = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      computationOffset,
      program.programId,
      "confirmed"
    );
    console.log("Wrap finalize signature:", finalizeSig);

    // Check that tokens were transferred
    const userAccountAfter = await getAccount(provider.connection, userTokenAccount);
    const programAccountAfter = await getAccount(provider.connection, programTokenAccount);
    
    console.log("User balance after wrap:", userAccountAfter.amount.toString());
    console.log("Program balance after wrap:", programAccountAfter.amount.toString());
    
    expect(userAccountAfter.amount.toString()).to.equal((mintAmount - wrapAmount).toString());
    expect(programAccountAfter.amount.toString()).to.equal(wrapAmount.toString());

    // Check encrypted balance account was created and populated
    const encryptedBalanceAccountInfo = await program.account.encryptedBalanceAccount.fetch(encryptedBalanceAccount);
    console.log("Encrypted balance account created:", encryptedBalanceAccountInfo);
    const decryptedBalance = cipher.decrypt(
      [encryptedBalanceAccountInfo.encryptedBalance], 
      new Uint8Array(encryptedBalanceAccountInfo.nonce.toArrayLike(Buffer, "le", 16))
    )[0];

    expect(decryptedBalance.toString()).to.equal(wrapAmount.toString());
  });

  it("Should transfer tokens between accounts successfully", async () => {
    // Mint tokens to sender
    const mintAmount = 1000000000; // 1 token with 9 decimals
    console.log("Minting tokens to sender");
    await mintTo(
      provider.connection,
      owner,
      mint,
      senderTokenAccount,
      owner,
      mintAmount
    );
    console.log("Tokens minted to sender");
    console.log("Minting tokens to receiver");
    await mintTo(
      provider.connection,
      owner,
      mint,
      receiverTokenAccount,
      owner,
      mintAmount
    );
    console.log("Tokens minted to receiver");

    // Setup encryption
    const privateKey = x25519.utils.randomPrivateKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const mxePublicKey = new Uint8Array([
      34, 56, 246, 3, 165, 122, 74, 68, 14, 81, 107, 73, 129, 145, 196, 4, 98,
      253, 120, 15, 235, 108, 37, 198, 124, 111, 38, 1, 210, 143, 72, 87,
    ]);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);

    // First, wrap tokens for sender
    const wrapAmount = 800000000; // 0.8 tokens
    const wrapNonce = randomBytes(16);
    const wrapComputationOffset = new anchor.BN(randomBytes(8), "hex");

    // Get encrypted balance account PDAs
    const [senderEncryptedBalanceAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("encrypted_balance"), sender.publicKey.toBuffer()],
      program.programId
    );

    const [receiverEncryptedBalanceAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("encrypted_balance"), receiver.publicKey.toBuffer()],
      program.programId
    );

    console.log("Wrapping tokens for sender");
    const wrapQueueSig = await program.methods
      .wrap(
        wrapComputationOffset,
        new anchor.BN(wrapAmount),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(wrapNonce).toString())
      )
      .accountsPartial({
        payer: sender.publicKey,
        computationAccount: getComputationAccAddress(
          program.programId,
          wrapComputationOffset
        ),
        clusterAccount: arciumEnv.arciumClusterPubkey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(program.programId),
        executingPool: getExecutingPoolAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("wrap")).readUInt32LE()
        ),
        userTokenAccount: senderTokenAccount,
        programTokenAccount: programTokenAccount,
        tokenMint: mint,
        poolAuthority: poolAuthority,
        encryptedBalanceAccount: senderEncryptedBalanceAccount,
      })
      .signers([sender])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Wrap queue signature:", wrapQueueSig);

    // Wait for wrap computation finalization
    const wrapFinalizeSig = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      wrapComputationOffset,
      program.programId,
      "confirmed"
    );
    console.log("Wrap finalize signature:", wrapFinalizeSig);

    // Now wrap tokens for receiver (smaller amount)
    const receiverWrapAmount = 200000000; // 0.2 tokens
    const receiverWrapNonce = randomBytes(16);
    const receiverWrapComputationOffset = new anchor.BN(randomBytes(8), "hex");

    console.log("Wrapping tokens for receiver");
    const receiverWrapQueueSig = await program.methods
      .wrap(
        receiverWrapComputationOffset,
        new anchor.BN(receiverWrapAmount),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(receiverWrapNonce).toString())
      )
      .accountsPartial({
        payer: receiver.publicKey,
        computationAccount: getComputationAccAddress(
          program.programId,
          receiverWrapComputationOffset
        ),
        clusterAccount: arciumEnv.arciumClusterPubkey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(program.programId),
        executingPool: getExecutingPoolAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("wrap")).readUInt32LE()
        ),
        userTokenAccount: receiverTokenAccount,
        programTokenAccount: programTokenAccount,
        tokenMint: mint,
        poolAuthority: poolAuthority,
        encryptedBalanceAccount: receiverEncryptedBalanceAccount,
      })
      .signers([receiver])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Receiver wrap queue signature:", receiverWrapQueueSig);

    // Wait for receiver wrap computation finalization
    const receiverWrapFinalizeSig = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      receiverWrapComputationOffset,
      program.programId,
      "confirmed"
    );
    console.log("Receiver wrap finalize signature:", receiverWrapFinalizeSig);

    // Now perform transfer between the two accounts
    const transferAmount = 300000000; // 0.3 tokens
    const transferNonce = randomBytes(16);
    const transferComputationOffset = new anchor.BN(randomBytes(8), "hex");

    console.log("Transferring tokens from sender to receiver");
    const transferQueueSig = await program.methods
      .transfer(
        transferComputationOffset,
        new anchor.BN(transferAmount)
      )
      .accountsPartial({
        computationAccount: getComputationAccAddress(
          program.programId,
          transferComputationOffset
        ),
        clusterAccount: arciumEnv.arciumClusterPubkey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(program.programId),
        executingPool: getExecutingPoolAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("transfer")).readUInt32LE()
        ),
        senderAccount: senderEncryptedBalanceAccount,
        receiverAccount: receiverEncryptedBalanceAccount,
        sender: sender.publicKey,
        receiver: receiver.publicKey,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("Transfer queue signature:", transferQueueSig);

    // Wait for transfer computation finalization
    const transferFinalizeSig = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      transferComputationOffset,
      program.programId,
      "confirmed"
    );
    console.log("Transfer finalize signature:", transferFinalizeSig);

    // Check the encrypted balance accounts after transfer
    const senderEncryptedBalanceAfter = await program.account.encryptedBalanceAccount.fetch(senderEncryptedBalanceAccount);
    const receiverEncryptedBalanceAfter = await program.account.encryptedBalanceAccount.fetch(receiverEncryptedBalanceAccount);
    
    console.log("Sender encrypted balance after transfer:", senderEncryptedBalanceAfter);
    console.log("Receiver encrypted balance after transfer:", receiverEncryptedBalanceAfter);

    // Decrypt the balances to verify the transfer
    const senderDecryptedBalance = cipher.decrypt(
      [senderEncryptedBalanceAfter.encryptedBalance], 
      new Uint8Array(senderEncryptedBalanceAfter.nonce.toArrayLike(Buffer, "le", 16))
    )[0];

    const receiverDecryptedBalance = cipher.decrypt(
      [receiverEncryptedBalanceAfter.encryptedBalance], 
      new Uint8Array(receiverEncryptedBalanceAfter.nonce.toArrayLike(Buffer, "le", 16))
    )[0];

    console.log("Sender decrypted balance after transfer:", senderDecryptedBalance.toString());
    console.log("Receiver decrypted balance after transfer:", receiverDecryptedBalance.toString());

    // Verify the transfer was successful
    expect(senderDecryptedBalance.toString()).to.equal((wrapAmount - transferAmount).toString());
    expect(receiverDecryptedBalance.toString()).to.equal((receiverWrapAmount + transferAmount).toString());
  });

  async function initWrapCompDef(
    program: Program<ConfidentialTransfer>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("wrap");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log("Comp def pda is ", compDefPDA);

    const sig = await program.methods
      .initWrapCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc({
        commitment: "confirmed",
      });
    console.log("Init wrap computation definition transaction", sig);

    if (uploadRawCircuit) {
      const rawCircuit = fs.readFileSync("build/wrap.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "wrap",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return sig;
  }

  async function initTransferCompDef(
    program: Program<ConfidentialTransfer>,
    owner: anchor.web3.Keypair,
    uploadRawCircuit: boolean,
    offchainSource: boolean
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset("transfer");

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgAddress()
    )[0];

    console.log("Comp def pda is ", compDefPDA);

    const sig = await program.methods
      .initTransferCompDef()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc({
        commitment: "confirmed",
      });
    console.log("Init transfer computation definition transaction", sig);

    if (uploadRawCircuit) {
      const rawCircuit = fs.readFileSync("build/transfer.arcis");

      await uploadCircuit(
        provider as anchor.AnchorProvider,
        "transfer",
        program.programId,
        rawCircuit,
        true
      );
    } else if (!offchainSource) {
      const finalizeTx = await buildFinalizeCompDefTx(
        provider as anchor.AnchorProvider,
        Buffer.from(offset).readUInt32LE(),
        program.programId
      );

      const latestBlockhash = await provider.connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

      finalizeTx.sign(owner);

      await provider.sendAndConfirm(finalizeTx);
    }
    return sig;
  }
});

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}
