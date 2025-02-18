import express from 'express';
import fetch from 'node-fetch';  // Now using ES module import
import { Keypair, PublicKey, Transaction, SystemProgram, TransactionInstruction, Connection} from '@solana/web3.js';
import cors from 'cors';
import bs58 from "bs58";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

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

const DEFAULT_HELIUS_MOON = [
  "9af21197-faa1-45de-bd64-f08b576e491b",
  "aebc66b8-9006-4d3b-9384-e58faa64e7ef",
];
export const RPC_HTTP_URL = `https://staked.helius-rpc.com?api-key=${DEFAULT_HELIUS_MOON[0]}`;

const connection = new Connection(RPC_HTTP_URL || "");
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
        "Authorization": "entry1730832791-bN14n%2BFtqfPJqWXWtXteSftVdzUt5yHH7ACRmoRtCvk%3D",
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

    return {
      isSucess: true,
      txSignature : responseData?.signature,
    }
  } catch (error) {
    throw error;
  }
}

// Express route to handle POST request
app.post('/buy', async (req, res) => {
  const {
    mintStr, solIn, slippageDecimal, privateKey, virtualSolReserves, virtualTokenReserves,
    coinDataMint, bonding_curve, associated_bonding_curve, tipAmount,
  } = req.body;

  try {
    const keyPair = await getKeyPair(privateKey);
    var result = await buyWithNextBlockv2(
      mintStr,
      solIn,
      slippageDecimal,
      keyPair,
      virtualSolReserves,
      virtualTokenReserves,
      coinDataMint,
      bonding_curve,
      associated_bonding_curve,
      tipAmount
    );
    res.status(200).json(result);
  } catch (error) {
    console.error('Error in buy request:', error);
    res.status(500).json({ isSucess: false, error: error });
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


function getKeyPair(privateKey){
  return new Promise((resolve, reject) => {
    try {
      let privateKeyBytes;

      if (/^[0-9a-fA-F]+$/.test(privateKey)) {
        // Handle hexadecimal encoded private key
        privateKeyBytes = Uint8Array.from(Buffer.from(privateKey, "hex"));
      } else {
        // Assume base58 encoding
        privateKeyBytes = bs58.decode(privateKey);
      }

      // Ensure the private key has a valid length
      if (privateKeyBytes.length !== 32 && privateKeyBytes.length !== 64) {
        throw new Error("Invalid private key length. Must be 32 or 64 bytes.");
      }

      // Create and resolve the Keypair
      const keypair = Keypair.fromSecretKey(privateKeyBytes);
      resolve(keypair);
    } catch (error) {
      console.error("Error creating Keypair:", error);
      reject(error);
    }
  });
}

function packIntegers(integers) {
  const binarySegments = new Uint8Array(new ArrayBuffer(integers.length * 8));
  integers.forEach((integer, index) => {
    const view = new DataView(binarySegments.buffer);
    view.setBigUint64(index * 8, integer, true);
  });
  return Buffer.from(binarySegments);
}