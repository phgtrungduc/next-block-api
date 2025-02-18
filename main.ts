import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { Keypair, PublicKey, Transaction, SystemProgram, TransactionInstruction, Connection } from "https://esm.sh/@solana/web3.js@^1.93.1";
import { decode, encode } from "https://deno.land/std@0.192.0/encoding/base58.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "https://cdn.skypack.dev/@solana/spl-token";

const LAMPORTS_PER_SOL = 1000000000;
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
const EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const DEFAULT_HELIUS_MOON = "https://staked.helius-rpc.com?api-key=9af21197-faa1-45de-bd64-f08b576e491b";
const connection = new Connection(DEFAULT_HELIUS_MOON);

function log(message, type) {
  console.log(`[${type}] ${message}`);
}

async function buyWithNextBlockv2(mintStr, solIn, slippageDecimal, keyPair, virtualSolReserves, virtualTokenReserves, coinDataMint, bonding_curve, associated_bonding_curve, tipAmount) {
  const owner = keyPair.publicKey;
  log(`${owner.toString()} preparing to buy ${solIn} SOL for token address: ${mintStr}`, "INFO");

  try {
    if (slippageDecimal > 1) throw new Error("Slippage decimal must be less than 1 (100%).");
    
    const mint = new PublicKey(mintStr);
    const tokenAccount = await getAssociatedTokenAddress(mint, owner);

    let createTokenAccountIx = null;
    try {
      const accountInfo = await connection.getParsedTokenAccountsByOwner(owner, { mint });
      if (!accountInfo.value.length) throw new Error("No token account found");
    } catch {
      createTokenAccountIx = createAssociatedTokenAccountInstruction(keyPair.publicKey, tokenAccount, owner, mint);
    }

    const solInLamports = solIn * LAMPORTS_PER_SOL;
    const tokenOut = Math.floor((solInLamports * virtualTokenReserves) / virtualSolReserves);
    const solInWithSlippage = solIn * (1 + slippageDecimal);
    const maxSolCost = Math.floor(solInWithSlippage * LAMPORTS_PER_SOL);

    const keys = [
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(coinDataMint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(bonding_curve), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(associated_bonding_curve), isSigner: false, isWritable: true },
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

    const swapInstruction = new TransactionInstruction({ keys, programId: PUMP_FUN_PROGRAM, data });
    const instructions = createTokenAccountIx ? [createTokenAccountIx, swapInstruction] : [swapInstruction];
    
    const transaction = new Transaction().add(...instructions);
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = owner;
    transaction.sign(keyPair);

    const response = await fetch("https://ny.nextblock.io/api/v2/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: { content: encode(transaction.serialize()) }, frontRunningProtection: true })
    });
    
    if (!response.ok) throw new Error(`API Error: ${response.status} ${response.statusText}`);
    const responseData = await response.json();
    return { isSuccess: true, txSignature: responseData?.signature };
  } catch (error) {
    throw error;
  }
}

const router = new Router();
router.post("/buy", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const keyPair = getKeyPair(body.privateKey);
    const result = await buyWithNextBlockv2(body.mintStr, body.solIn, body.slippageDecimal, keyPair, body.virtualSolReserves, body.virtualTokenReserves, body.coinDataMint, body.bonding_curve, body.associated_bonding_curve, body.tipAmount);
    ctx.response.status = 200;
    ctx.response.body = result;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = { isSuccess: false, error: error.message };
  }
});

router.get("/ping", (ctx) => {
  ctx.response.body = "pong";
});

const app = new Application();
app.use(router.routes());
app.use(router.allowedMethods());

app.listen({ port: 8080 });
console.log("Server running on port 8080");

function getKeyPair(privateKey) {
  const privateKeyBytes = /^[0-9a-fA-F]+$/.test(privateKey) ? new Uint8Array(Buffer.from(privateKey, "hex")) : decode(privateKey);
  return Keypair.fromSecretKey(privateKeyBytes);
}

function packIntegers(integers) {
  return Buffer.from(new Uint8Array(integers.flatMap(int => [...[new DataView(new ArrayBuffer(8)).setBigUint64(0, int, true)]])));
}
