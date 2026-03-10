# SmartBridge

> Automate CEX deposits from your DeFi wallet using Chainlink CRE

SmartBridge eliminates the friction and risk of manually looking up centralized exchange (CEX) deposit addresses when moving tokens from a self-custody DeFi wallet. Copying the wrong address — or the right address on the wrong network — is a common and often irreversible mistake that leads to permanent fund loss.

SmartBridge solves this using Chainlink Runtime Environment (CRE). Register your exchange API credentials once, then trigger a single workflow to automatically resolve the correct deposit address directly from the exchange API and execute the on-chain ERC-20 transfer — with Byzantine Fault Tolerant consensus guaranteeing the destination address was verified by a decentralized network before a single token moves.

---

## Demo

> 📹 [Video Demo](https://drive.google.com/file/d/1RKRJWIGZ_as_6qSjTN5t_zStvPcE6ntv/view?usp=drivesdk)

---

## How It Works

```
User Trigger: { walletAddress, token, network, amount }
        │
        ▼
┌─────────────────────────────────────────────┐
│         transaction_workflow (CRE)          │
│                                             │
│  secretsProvider → REGISTRY_TOKEN           │
│  (Vault DON threshold decryption via DKG)   │
│         │                                   │
│  runInNodeMode (each DON node):             │
│    GET /deposit-address → registry backend  │
│    backend signs → Binance API              │
│    returns { address }                      │
│         │                                   │
│  consensusIdenticalAggregation              │
│  (BFT quorum must agree on address)         │
│         │                                   │
│  runtime.report() → DON-signed report      │
│  evmClient.writeReport()                    │
└─────────────────────────────────────────────┘
        │
        ▼
SmartBridgeReceiver.sol
(Chainlink KeystoneForwarder validates DON signatures)
        │
        ▼
IERC20(token).transfer(depositAddress, amount) ✅
```

### Three phases:

**Phase 1 — Register (one-time)**
The user triggers the registration workflow with their wallet address and exchange API credentials. The registry bearer token is fetched from the Vault DON via `secretsProvider` — Chainlink's DKG-backed threshold secret management. Credentials are stored AES-256-GCM encrypted in the registry backend and never written on-chain.

**Phase 2 — Resolve (runtime)**
Every DON node independently calls the registry backend's `/deposit-address` endpoint, which signs and forwards the request to the Binance API. `consensusIdenticalAggregation` requires a BFT quorum of nodes to agree on the exact same address before execution continues.

**Phase 3 — Transfer (on-chain)**
The workflow ABI-encodes `(token, recipient, amount)`, generates a DON-signed report via `runtime.report()`, and submits it to `SmartBridgeReceiver` via `EVMClient.writeReport()`. The KeystoneForwarder validates DON signatures and the contract executes the ERC-20 transfer.

---

## Chainlink Usage

| File | Chainlink Features Used |
|------|------------------------|
| [registration_workflow/main.ts](./registration_workflow/main.ts) | `HTTPCapability`, `HTTPClient`, `runInNodeMode`, `consensusIdenticalAggregation`, `secretsProvider` (Vault DON / DKG) |
| [transaction_workflow/main.ts](./transaction_workflow/main.ts) | `HTTPClient`, `runInNodeMode`, `consensusIdenticalAggregation`, `EVMClient.writeReport()`, `runtime.report()`, `getNetwork`, `secretsProvider` |
| [contracts/SmartBridgeReceiver.sol](./contracts/SmartBridgeReceiver.sol) | `ReceiverTemplate` (Chainlink KeystoneForwarder integration) |

---

## Project Structure

```
registration/
├── project.yaml                        # CRE project config
├── secrets.yaml                        # Vault DON secret declarations
├── registration_workflow/
│   ├── main.ts                         # Phase 1: credential registration
│   ├── workflow.yaml
│   ├── config.staging.json
│   └──
├── transaction_workflow/
│   ├── main.ts                         # Phase 2 + 3: resolve + transfer
│   ├── workflow.yaml
│   ├── config.staging.json
│   └── 
└── contracts/
    └── SmartBridgeReceiver.sol         # Chainlink KeystoneForwarder consumer

smartbridgebackend/
├── registry.ts                         # Express registry server
└── package.json
```

---

## Stack

- **Chainlink CRE SDK** (`@chainlink/cre-sdk`) — workflow runtime
- **Viem** — ABI encoding for on-chain report payload
- **Zod** — config schema validation
- **Node.js 22 + TypeScript** — registry backend
- **Solidity 0.8.19** — consumer contract
- **Sepolia testnet** — deployment target

---

## Prerequisites

- [CRE CLI](https://docs.chain.link/cre) installed
- Node.js 22+
- A funded Sepolia wallet
- Binance account with API access enabled

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/Immernuel/SmartBridge.git
cd smartbridge
```

### 2. Install dependencies

```bash
cd registration/registration_workflow && npm install
cd ../transaction_workflow && npm install
cd ../../smartbridgebackend && npm install
```

### 3. Configure environment

Create `smartbridgebackend/.env`:
```env
ENCRYPTION_KEY=your_32_byte_hex_key
REGISTRY_BEARER_TOKEN=your_bearer_token
PORT=30001
```

Create `registration/.env`:
```env
CRE_ETH_PRIVATE_KEY=your_private_key
REGISTRY_TOKEN_ALL=your_bearer_token
```

### 4. Start the registry backend

```bash
cd smartbridgebackend
npm run dev
```

### 5. Register credentials (one-time)

```bash
cd registration
cre workflow simulate registration_workflow --target staging-settings
```

When prompted, enter:
```json
{"walletAddress":"0xYourWalletAddress","exchange":"binance","apiKey":"your-api-key","apiSecret":"your-api-secret"}
```

### 6. Run a transfer

```bash
cre workflow simulate transaction_workflow --broadcast
```

When prompted, enter:
```json
{"walletAddress":"0xYourWalletAddress","token":"USDC","network":"ETH","amount":"1"}
```

---

## On-chain Evidence

| Network | TX Hash |
|---------|---------|
| Sepolia | `0x7ad36314e990bf8d2850d677597dbf3cf36e3bfab15e905dc355398f7fbbce85` |

---

## Prize Tracks

- **DeFi & Tokenization** — automated ERC-20 transfer to verified CEX deposit address via Chainlink CRE
- **Top 10 Projects** — CRE workflow with on-chain write on Sepolia

---

## Security Notes

- Never commit real API keys or private keys to this repo
- The `.env` files are gitignored
- Registry bearer token is protected by Vault DON threshold decryption
- All stored credentials are AES-256-GCM encrypted at rest
- This project uses Sepolia testnet only — do not use mainnet credentials

---

## License

MIT