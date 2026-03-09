// ============================================================
//  SmartBridge — Transfer Workflow (Phase 2 + 3)
//
//  Secrets via secretsProvider (2nd param of initWorkflow).
//  secretsProvider is captured in closure and passed into
//  runInNodeMode as an extra argument — this avoids needing
//  getSecret on NodeRuntime (which your SDK version doesn't have).
//
//  No cacheSettings on GET requests (only needed for POST/PUT).
//  Backend handles Binance HMAC signing server-side.
// ============================================================

import {
  HTTPCapability,
  HTTPClient,
  EVMClient,
  handler,
  ok,
  getNetwork,
  consensusIdenticalAggregation,
  hexToBase64,
  bytesToHex,
  TxStatus,
  Runner,
  type Runtime,
  type NodeRuntime,
  type SecretsProvider,
  type HTTPPayload,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters, type Address } from "viem";
import { z } from "zod";

// ── Config schema ─────────────────────────────────────────────────────────────
const configSchema = z.object({
  registryUrl: z.string(),
  chainSelectorName: z.string(),
  receiverContract: z.string(),
  tokenContract: z.string(),
  gasLimit: z.string(),
  authorizedSignerAddress: z.string(),
});
type Config = z.infer<typeof configSchema>;

// ── Types ─────────────────────────────────────────────────────────────────────
type TriggerPayload = {
  walletAddress: string;
  token: string;
  network: string;
  amount: string;
};

type ResolvedAddress = {
  address: string;
  tag: string;
};

// ── Node function ─────────────────────────────────────────────────────────────
// secretsProvider is passed as a plain extra arg to runInNodeMode.
// This avoids calling getSecret on NodeRuntime (not available in older SDKs).
// runInNodeMode signature: fn(nodeRuntime, ...args) — extra args passed through.
const resolveDepositAddress = (
  nodeRuntime: NodeRuntime<Config>,
  registryToken: string,
  walletAddress: string,
  token: string,
  network: string,
): ResolvedAddress => {
  const httpClient = new HTTPClient();

  const url =
    `${nodeRuntime.config.registryUrl}/deposit-address/${encodeURIComponent(walletAddress)}` +
    `?coin=${encodeURIComponent(token)}&network=${encodeURIComponent(network)}`;

  const resp = httpClient
    .sendRequest(nodeRuntime, {
      url,
      method: "GET" as const,
      headers: {
        Authorization: `Bearer ${registryToken}`,
        Accept: "application/json",
      },
    })
    .result();

  if (!ok(resp)) {
    throw new Error(
      `[SmartBridge] deposit-address failed: status=${resp.statusCode}`,
    );
  }

  const bodyStr = new TextDecoder().decode(resp.body);
  const parsed = JSON.parse(bodyStr) as {
    address: string;
    tag?: string | null;
  };

  if (!parsed.address) {
    throw new Error(
      `[SmartBridge] No address returned for token=${token} network=${network}`,
    );
  }

  return { address: parsed.address, tag: parsed.tag ?? "" };
};

// ── HTTP trigger handler ──────────────────────────────────────────────────────
const makeOnHttpTrigger =
  (secretsProvider: SecretsProvider) =>
  (runtime: Runtime<Config>, payload: HTTPPayload): string => {
    const triggerData = JSON.parse(
      new TextDecoder().decode(payload.input),
    ) as TriggerPayload;

    if (
      !triggerData.walletAddress ||
      !triggerData.token ||
      !triggerData.network ||
      !triggerData.amount
    ) {
      throw new Error(
        "Invalid payload: walletAddress, token, network and amount are all required.",
      );
    }

    runtime.log(`[SmartBridge] Wallet:  ${triggerData.walletAddress}`);
    runtime.log(`[SmartBridge] Token:   ${triggerData.token}`);
    runtime.log(`[SmartBridge] Network: ${triggerData.network}`);
    runtime.log(`[SmartBridge] Amount:  ${triggerData.amount}`);

    // Fetch secret at DON level (Runtime has getSecret via secretsProvider)
    const registryToken = secretsProvider
      .getSecret({ id: "REGISTRY_TOKEN" })
      .result().value;

    // ── Phase 2: Resolve deposit address with DON consensus ───────────────────
    // Pass registryToken + payload fields as extra args to runInNodeMode.
    // The node fn receives (nodeRuntime, registryToken, walletAddress, token, network).
    const resolved = runtime
      .runInNodeMode(
        resolveDepositAddress,
        consensusIdenticalAggregation<ResolvedAddress>(),
      )(registryToken, triggerData.walletAddress, triggerData.token, triggerData.network)
      .result();

    runtime.log(`[SmartBridge] ✅ Deposit address: ${resolved.address}`);
    if (resolved.tag) runtime.log(`[SmartBridge] ⚠️ Memo/Tag: ${resolved.tag}`);

    // ── Phase 3: EVM write — official two-step pattern ────────────────────────
    const config = runtime.config;
    const network = getNetwork({
      chainFamily: "evm",
      chainSelectorName: config.chainSelectorName,
      isTestnet: true,
    });
    if (!network)
      throw new Error(
        `[SmartBridge] Network not found: ${config.chainSelectorName}`,
      );

    const evmClient = new EVMClient(network.chainSelector.selector);

    const reportPayload = encodeAbiParameters(
      parseAbiParameters("address token, address recipient, uint256 amount"),
      [
        config.tokenContract as Address,
        resolved.address as Address,
        BigInt(triggerData.amount),
      ],
    );

    // Step 1: Generate signed report
    const reportResponse = runtime
      .report({
        encodedPayload: hexToBase64(reportPayload),
        encoderName: "evm",
        signingAlgo: "ecdsa",
        hashingAlgo: "keccak256",
      })
      .result();

    // Step 2: Submit to contract via Chainlink KeystoneForwarder
    const writeResult = evmClient
      .writeReport(runtime, {
        receiver: config.receiverContract,
        report: reportResponse,
        gasConfig: { gasLimit: config.gasLimit },
      })
      .result();

    if (writeResult.txStatus === TxStatus.SUCCESS) {
      const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32));
      runtime.log(`[SmartBridge] ✅ TX: ${txHash}`);
      return JSON.stringify({
        success: true,
        depositAddress: resolved.address,
        memo: resolved.tag || null,
        token: triggerData.token,
        network: triggerData.network,
        amount: triggerData.amount,
        transactionHash: txHash,
      });
    }

    throw new Error(
      `[SmartBridge] Transaction failed: ${writeResult.txStatus}`,
    );
  };

// ── Workflow initialisation ───────────────────────────────────────────────────
const initWorkflow = (config: Config, secretsProvider: SecretsProvider) => {
  const http = new HTTPCapability();
  return [
    handler(
      http.trigger({
        authorizedKeys:
          config.authorizedSignerAddress ===
          "0x0000000000000000000000000000000000000000"
            ? []
            : [
                {
                  type: "KEY_TYPE_ECDSA_EVM",
                  publicKey: config.authorizedSignerAddress,
                },
              ],
      }),
      makeOnHttpTrigger(secretsProvider),
    ),
  ];
};

// ── Entry point ───────────────────────────────────────────────────────────────
export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
