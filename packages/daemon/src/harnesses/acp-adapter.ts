import { registerAcpFlavorPolicyFactory } from './acp/strict-acp-adapter.js';
import { AntigravityAcpFlavorPolicy } from './agy/agy-driver.js';

registerAcpFlavorPolicyFactory('antigravity', () => new AntigravityAcpFlavorPolicy());
registerAcpFlavorPolicyFactory('agy', () => new AntigravityAcpFlavorPolicy());

export * from './acp/strict-acp-adapter.js';
