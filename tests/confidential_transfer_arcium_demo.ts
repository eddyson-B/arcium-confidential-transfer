import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { ConfidentialTransferArciumDemo } from "../target/types/confidential_transfer_arcium_demo";
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

describe("ConfidentialTransferArciumDemo", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace
    .ConfidentialTransferArciumDemo as Program<ConfidentialTransferArciumDemo>;
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

  it("Should wrap tokens successfully", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    // Create a test mint
    console.log("Creating test mint");
    const mint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9 // 9 decimals
    );
    console.log("Mint created:", mint.toBase58());

    // Create user token account
    console.log("Creating user token account");
    const userTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      owner.publicKey
    );
    console.log("User token account created:", userTokenAccount.toBase58());

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

    // Initialize wrap computation definition
    console.log("Initializing wrap computation definition");
    const initWrapSig = await initWrapCompDef(program, owner, false, false);
    console.log("Wrap computation definition initialized with signature", initWrapSig);

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

    // Get PDAs
    const [poolAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_authority")],
      program.programId
    );

    const [encryptedBalanceAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("encrypted_balance"), owner.publicKey.toBuffer()],
      program.programId
    );

    const [programTokenAccount] = PublicKey.findProgramAddressSync(
      [
        poolAuthority.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    console.log("Pool authority:", poolAuthority.toBase58());
    console.log("Encrypted balance account:", encryptedBalanceAccount.toBase58());
    console.log("Program token account:", programTokenAccount.toBase58());

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
        poolAccount: arciumEnv.arciumStakingPoolPubkey,
        clockAccount: arciumEnv.arciumClockPubkey,
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

  async function initWrapCompDef(
    program: Program<ConfidentialTransferArciumDemo>,
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
});

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}
