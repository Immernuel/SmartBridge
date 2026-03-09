// ============================================================
//  SmartBridge Registry Backend
//
//  Run:
//    npm install
//    npm run dev       (Node 22 — watches for file changes)
//    npm start         (Node 22 — single run)
//
//  Node 22.6+ has native TypeScript stripping (--experimental-strip-types)
//  and native .env loading (--env-file). No ts-node, tsx, or dotenv needed.
//
//  Endpoints:
//    POST /register                   — store DEX wallet → CEX credentials
//    GET  /credentials/:walletAddress — fetch credentials for a wallet
//    GET  /health                     — liveness check
// ============================================================

import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response, NextFunction } from "express";

// Load express via require — it is a CommonJS module. Using createRequire is
// the correct way to load CJS modules from ESM/TS files under "type":"module".
const require = createRequire(import.meta.url);
const express = require("express") as typeof import("express");

// ── Load .env manually (works on Node 20+ without any extra packages) ─────────
// Node 22+ supports --env-file flag, but loading manually works on Node 20+ too
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(resolve(__dirname, ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const val = trimmed.slice(eqIndex + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
} catch {
  // .env not found — rely on real environment variables (fine for production)
  console.log(
    "[Registry] No .env file found — using environment variables directly",
  );
}

// ── Validate required environment variables ───────────────────────────────────
const BEARER_TOKEN = process.env.REGISTRY_BEARER_TOKEN ?? "";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "";
const PORT = process.env.PORT ?? "3000";

if (!BEARER_TOKEN) {
  console.error("[Registry] ERROR: REGISTRY_BEARER_TOKEN is not set");
  process.exit(1);
}

if (!ENCRYPTION_KEY || Buffer.from(ENCRYPTION_KEY, "hex").length !== 32) {
  console.error(
    "[Registry] ERROR: ENCRYPTION_KEY must be a 64-character hex string (32 bytes)",
  );
  console.error(
    "[Registry] Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  process.exit(1);
}

const ENC_KEY = Buffer.from(ENCRYPTION_KEY, "hex");

// ── In-memory credential store ────────────────────────────────────────────────
// For the hackathon this is fine. For production, replace with Postgres/Redis.
interface StoredRecord {
  exchange: string; // e.g. "binance"
  encryptedApiKey: string; // base64(iv[12] + authTag[16] + ciphertext)
  encryptedSecret: string; // base64(iv[12] + authTag[16] + ciphertext)
  createdAt: string; // ISO timestamp
}

const store = new Map<string, StoredRecord>(); // key = walletAddress lowercased

// ── AES-256-GCM helpers ───────────────────────────────────────────────────────
function encrypt(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit IV
  const cipher = createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 128-bit tag
  // Layout: iv(12) | authTag(16) | ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────
function authenticate(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"] ?? "";
  if (!auth.startsWith("Bearer ") || auth.slice(7) !== BEARER_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── POST /register ────────────────────────────────────────────────────────────
// Called by the CRE register-workflow after the HTTP trigger fires.
// Body: { walletAddress, exchange, apiKey, apiSecret }
app.post("/register", authenticate, (req: Request, res: Response): void => {
  const { walletAddress, exchange, apiKey, apiSecret } = req.body as {
    walletAddress?: string;
    exchange?: string;
    apiKey?: string;
    apiSecret?: string;
  };

  if (!walletAddress || !exchange || !apiKey || !apiSecret) {
    res.status(400).json({
      error: "walletAddress, exchange, apiKey and apiSecret are all required",
    });
    return;
  }

  const key = walletAddress.toLowerCase();

  store.set(key, {
    exchange: exchange.toLowerCase(),
    encryptedApiKey: encrypt(apiKey),
    encryptedSecret: encrypt(apiSecret),
    createdAt: new Date().toISOString(),
  });

  console.log(
    `[Registry] ✅ Registered  wallet=${walletAddress}  exchange=${exchange}`,
  );
  res.status(200).json({ success: true });
});

// ── GET /credentials/:walletAddress ──────────────────────────────────────────
// Called by the CRE transfer-workflow to fetch credentials before querying CEX.
// Returns: { exchange, apiKey, apiSecret }
app.get(
  "/credentials/:walletAddress",
  authenticate,
  (req: Request, res: Response): void => {
    const key = (req.params.walletAddress ?? "").toLowerCase();
    const record = store.get(key);

    if (!record) {
      res.status(404).json({
        error: `No credentials found for wallet: ${req.params.walletAddress}`,
      });
      return;
    }

    let apiKey: string;
    let apiSecret: string;

    try {
      apiKey = decrypt(record.encryptedApiKey);
      apiSecret = decrypt(record.encryptedSecret);
    } catch {
      console.error(`[Registry] ❌ Decryption failed for wallet ${key}`);
      res.status(500).json({ error: "Failed to decrypt credentials" });
      return;
    }

    console.log(
      `[Registry] 🔍 Served credentials  wallet=${key}  exchange=${record.exchange}`,
    );
    res.status(200).json({
      exchange: record.exchange,
      apiKey,
      apiSecret,
    });
  },
);

// ── GET /health ───────────────────────────────────────────────────────────────

// ── GET /deposit-address/:walletAddress ───────────────────────────────────────
app.get("/deposit-address/:walletAddress", authenticate, async (req, res) => {
  const key    = (req.params.walletAddress ?? "").toLowerCase()
  const record = store.get(key)
  if (record == null) {
    res.status(404).json({ error: "No credentials found for wallet: " + req.params.walletAddress })
    return
  }
  const coin    = req.query.coin
  const network = req.query.network
  if (coin == null || network == null) {
    res.status(400).json({ error: "coin and network query params are required" })
    return
  }
  let apiKey, apiSecret
  try {
    apiKey    = decrypt(record.encryptedApiKey)
    apiSecret = decrypt(record.encryptedSecret)
  } catch (e) {
    res.status(500).json({ error: "Failed to decrypt credentials" })
    return
  }
  try {
    const timestamp   = String(Date.now())
    const qs          = "coin=" + encodeURIComponent(coin) + "&network=" + encodeURIComponent(network) + "&timestamp=" + timestamp
    const { createHmac } = await import("node:crypto")
    const signature   = createHmac("sha256", apiSecret).update(qs).digest("hex")
    const url         = "https://api.binance.com/sapi/v1/capital/deposit/address?" + qs + "&signature=" + signature
    const resp        = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey, "Accept": "application/json" } })
    const data        = await resp.json()
    if (resp.ok == false || data.address == null) {
      res.status(502).json({ error: "Binance API error: " + (data.msg ?? resp.status) })
      return
    }
    console.log("[Registry] Deposit address served  wallet=" + key + "  coin=" + coin)
    res.status(200).json({ address: data.address, coin: data.coin, tag: data.tag ?? null })
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch deposit address from Binance" })
  }
})

app.get("/health", (_req: Request, res: Response): void => {
  res.status(200).json({
    status: "ok",
    entries: store.size,
    timestamp: new Date().toISOString(),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(Number(PORT), () => {
  console.log(
    `[Registry] 🚀 SmartBridge registry running on http://localhost:${PORT}`,
  );
  console.log(`[Registry]    POST /register`);
  console.log(`[Registry]    GET  /credentials/:walletAddress`);
  console.log(`[Registry]    GET  /health`);
});