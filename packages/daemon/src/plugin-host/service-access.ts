import { PEER_CONTRACTS } from '@harnessmate/plugin-api';

/** Internal adapter operations are unavailable to both plugin processes and pages. */
export function isHostHarnessOperation(contract: string, method: string): boolean {
  switch (contract) {
    case PEER_CONTRACTS.harnessMcpConfig:
    case PEER_CONTRACTS.sessionModelTools:
      return true;
    case PEER_CONTRACTS.sessionFailover:
      return method !== 'recommend' && method !== 'getPolicy';
    case PEER_CONTRACTS.harnessUsage:
      return method !== 'listAccounts' && method !== 'collectInstanceUsage';
    case PEER_CONTRACTS.harnessModelCatalog:
      return method !== 'listModels';
    default:
      return false;
  }
}
