// ============================================================
//  SmartBridge — Register Workflow (Phase 1)
//
//  Secrets via secretsProvider (2nd param of initWorkflow).
//  registryToken captured in closure, passed as extra arg
//  into runInNodeMode — no getSecret on NodeRuntime needed.
// ============================================================

import {
  HTTPCapability,
  HTTPClient,
  handler,
  ok,
  consensusIdenticalAggregation,
  Runner,
  type Runtime,
  type NodeRuntime,
  type SecretsProvider,
  type HTTPPayload,
} from "@chainlink/cre-sdk";
import { z } from "zod";

const configSchema = z.object({
  registryUrl: z.string(),
  authorizedSignerAddress: z.string(),
});
type Config = z.infer<typeof configSchema>;

type TriggerPayload = {
  walletAddress: string;
  exchange: string;
  apiKey: string;
  apiSecret: string;
};

type RegistryResponse = { statusCode: number };

// ── Node function ─────────────────────────────────────────────────────────────
const registerCredentials = (
  nodeRuntime: NodeRuntime<Config>,
  registryToken: string,
  payload: TriggerPayload,
): RegistryResponse => {
  const httpClient = new HTTPClient();
  const body = Buffer.from(JSON.stringify(payload)).toString("base64");

  const resp = httpClient
    .sendRequest(nodeRuntime, {
      url: `${nodeRuntime.config.registryUrl}/register`,
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registryToken}`,
      },
      body,
    })
    .result();

  if (!ok(resp)) throw new Error(`Registry POST failed: ${resp.statusCode}`);
  return { statusCode: resp.statusCode };
};

// ── HTTP trigger handler ──────────────────────────────────────────────────────
const makeOnHttpTrigger =
  (secretsProvider: SecretsProvider) =>
  (runtime: Runtime<Config>, payload: HTTPPayload): string => {
    const raw = JSON.parse(
      new TextDecoder().decode(payload.input),
    ) as TriggerPayload;

    if (!raw.walletAddress || !raw.exchange || !raw.apiKey || !raw.apiSecret) {
      throw new Error(
        "Invalid payload: walletAddress, exchange, apiKey and apiSecret are all required.",
      );
    }

    runtime.log(`[SmartBridge Register] Wallet:   ${raw.walletAddress}`);
    runtime.log(`[SmartBridge Register] Exchange: ${raw.exchange}`);

    const registryToken = secretsProvider
      .getSecret({ id: "REGISTRY_TOKEN" })
      .result().value;

    const result = runtime
      .runInNodeMode(
        registerCredentials,
        consensusIdenticalAggregation<RegistryResponse>(),
      )(registryToken, raw)
      .result();

    const message = `[SmartBridge Register] ✅ Registered wallet ${raw.walletAddress} for ${raw.exchange}. Status: ${result.statusCode}`;
    runtime.log(message);
    return message;
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
