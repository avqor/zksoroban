import { Account, Contract, Keypair, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";

import { withRetry } from "./retry.js";
import { NetworkConfig, NetworkMismatchError, RetryOptions, SorobanZkError, SorobanZkErrorCode } from "./types.js";

const EXPECTED_CONTRACT_VERSION = "0.1.0";

export async function getContractVersion(
  network: NetworkConfig,
  retry?: RetryOptions
): Promise<string> {
  try {
    const server = withRetry(
      new rpc.Server(network.rpcUrl, { allowHttp: network.rpcUrl.startsWith("http://") }),
      retry
    );
    const rpcNetwork = await server.getNetwork();
    if (network.networkPassphrase !== rpcNetwork.passphrase) {
      throw new NetworkMismatchError(
        network.networkPassphrase,
        rpcNetwork.passphrase,
        "The supplied NetworkConfig declares"
      );
    }

    const sourceAccount = new Account(Keypair.random().publicKey(), "0");
    const contract = new Contract(network.contractId);

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: rpcNetwork.passphrase
    })
      .addOperation(contract.call("version"))
      .setTimeout(30)
      .build();

    const simulated = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simulated)) {
      throw new SorobanZkError(
        `version() simulation failed: ${simulated.error}`,
        SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
      );
    }

    const retval = simulated.result?.retval;
    if (!retval) {
      throw new SorobanZkError(
        "version() simulation did not return a value",
        SorobanZkErrorCode.CONTRACT_INVOCATION_FAILED
      );
    }

    const version = scValToNative(retval) as string;

    if (version !== EXPECTED_CONTRACT_VERSION) {
      console.warn(
        `zksoroban: deployed contract version "${version}" does not match the version this SDK build expects ("${EXPECTED_CONTRACT_VERSION}"). Proof encoding or verification behavior may not match what this SDK was built against.`
      );
    }

    return version;
  } catch (error) {
    if (error instanceof SorobanZkError) {
      throw error;
    }

    throw new SorobanZkError(
      error instanceof Error ? error.message : String(error),
      SorobanZkErrorCode.NETWORK_ERROR
    );
  }
}
