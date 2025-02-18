import express from 'express';
import fetch from 'node-fetch';  // Now using ES module import
import { Keypair, PublicKey, Transaction, SystemProgram, TransactionInstruction} from '@solana/web3.js';
import cors from 'cors';

const app = express();
app.use(cors());
const LAMPORTS_PER_SOL = 1000000000;  // Sol to Lamports conversion
const PUMP_FUN_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const GLOBAL = new PublicKey(
  process.env.GLOBAL || "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
);
const FEE_RECIPIENT = new PublicKey(
  process.env.FEE_RECIPIENT || "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
);
const RENT = new PublicKey(
  process.env.RENT || "SysvarRent111111111111111111111111111111111"
);

const EVENT_AUTHORITY = new PublicKey(
  process.env.EVENT_AUTHORITY || "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"
);

// Middleware to parse JSON body
app.use(express.json());

function log(message, type){
  console.log(`[${type}] ${message}`);
};

// The buyWithNextBlockv2 function
async function buyWithNextBlockv2(
  mintStr, solIn, slippageDecimal, keyPair, virtualSolReserves, virtualTokenReserves,
  coinDataMint, bonding_curve, associated_bonding_curve, tipAmount
) {
  const owner = keyPair.publicKey;
  const ownerStr = owner.toString();
  log(`${ownerStr} preparing to buy ${solIn} SOL for token address: ${mintStr}`, "INFO");

  try {
    if (slippageDecimal > 1) {
      throw new Error("Slippage decimal must be less than 1 (100%).");
    }

    const mint = new PublicKey(mintStr);
    const tokenAccount = await getAssociatedTokenAddress(mint, owner);

    let createTokenAccountIx = null;

    // Check if token account exists; otherwise, create one
    try {
      const accountInfo = await connection.getParsedTokenAccountsByOwner(owner, { mint });
      if (!accountInfo.value.length) {
        throw new Error("No token account found");
      }
    } catch {
      createTokenAccountIx = createAssociatedTokenAccountInstruction(
        keyPair.publicKey,
        tokenAccount,
        owner,
        mint
      );
    }

    const solInLamports = solIn * LAMPORTS_PER_SOL;
    const tokenOut = Math.floor((solInLamports * virtualTokenReserves) / virtualSolReserves);

    const solInWithSlippage = solIn * (1 + slippageDecimal);
    const maxSolCost = Math.floor(solInWithSlippage * LAMPORTS_PER_SOL);

    const MINT = new PublicKey(coinDataMint);
    const BONDING_CURVE = new PublicKey(bonding_curve);
    const ASSOCIATED_BONDING_CURVE = new PublicKey(associated_bonding_curve);

    const keys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: BONDING_CURVE, isSigner: false, isWritable: true },
      { pubkey: ASSOCIATED_BONDING_CURVE, isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ];

    const discriminatorAsInt = BigInt("16927863322537952870");
    const integers = [discriminatorAsInt, BigInt(tokenOut), BigInt(maxSolCost)];
    const data = packIntegers(integers);

    const swapInstruction = new TransactionInstruction({
      keys,
      programId: PUMP_FUN_PROGRAM,
      data,
    });

    const instructions = [];

    if (createTokenAccountIx) {
      instructions.push(createTokenAccountIx);
    }
    instructions.push(swapInstruction);

    const tipAccount = new PublicKey("NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE");
    const jitoTipInstruction = SystemProgram.transfer({
      fromPubkey: keyPair.publicKey,
      toPubkey: tipAccount,
      lamports: tipAmount * LAMPORTS_PER_SOL,
    });
    instructions.push(jitoTipInstruction);

    const { blockhash } = await connection.getLatestBlockhash();
    const transaction = new Transaction().add(...instructions);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = owner;
    transaction.sign(keyPair);

    // Serialize the transaction
    const serializedTx = transaction.serialize();
    const base64Tx = serializedTx.toString("base64");

    // Send the transaction via API
    const payload = {
      transaction: { content: base64Tx },
      frontRunningProtection: true,
    };
    log(
      `${ownerStr} starting send and confirm buy ${solIn} sol`,
      "NORMAL"
    );
    const response = await fetch("https://ny.nextblock.io/api/v2/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "your-authorization-token",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      log(
        `API Error: ${response.status} ${response.statusText}`,
        "ERROR"
      );
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const responseData = await response.json();
    console.log("Transaction submitted successfully:", responseData);

    const txSignature = responseData?.signature;
    if (txSignature) {
      log(
        `${ownerStr} Buy transaction signature  ${createHyperlink(
          `https://solscan.io/tx/${txSignature}`,
          txSignature
        )}`,
        "SUCCESS"
      );
      console.log(`View transaction details: https://solscan.io/tx/${txSignature}`);
    }
  } catch (error) {
    log(`${ownerStr} Buy transaction fail  ${error}`, "SUCCESS");
    console.error(ownerStr, "- Error in buy function:", error);
  }
}

// Express route to handle POST request
app.post('/buy', async (req, res) => {
  const {
    mintStr, solIn, slippageDecimal, secretKey, virtualSolReserves, virtualTokenReserves,
    coinDataMint, bonding_curve, associated_bonding_curve, tipAmount,
  } = req.body;

  try {
    const keyPair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    await buyWithNextBlockv2(
      mintStr,
      solIn,
      slippageDecimal,
      keyPair,
      virtualSolReserves,
      virtualTokenReserves,
      coinDataMint,
      bonding_curve,
      associated_bonding_curve,
      tipAmount,
      logCallback
    );

    res.status(200).json({ message: 'Transaction submitted successfully' });
  } catch (error) {
    console.error('Error in buy request:', error);
    res.status(500).json({ error: 'Error processing buy request', details: error.message });
  }
});
app.get("/ping", (req, res) => {
  res.send("pong")
});

// Start the Express server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
