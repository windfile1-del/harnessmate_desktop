import type { NavigationResultV1 } from '@harnessmate/protocol';
import { daemonApi } from './client';
import { navigationBus } from '../kernel/navigation-bus';
/** Resolve a capability and its declared page using public APIs. No official ID assumptions. */
export async function openContractPage(contract: string, pageId?: string, context?: Record<string, unknown>, navigate: typeof navigationBus.navigate = req => navigationBus.navigate(req)): Promise<NavigationResultV1> {
  const selection = await daemonApi.resolveServiceSelection(contract, { allowSingleCandidate: false });
  if (selection.status !== 'ready' || !selection.instanceId) return { requestId: crypto.randomUUID(), status: 'unavailable', code: 'E_SERVICE_UNAVAILABLE', message: contract + ' 未绑定活动实例' };
  const { plugins } = await daemonApi.listPlugins();
  const plugin = plugins.find(p => (p.instanceId ?? p.id) === selection.instanceId);
  const page = plugin?.contributes.slots?.find(s => s.slot === 'workspace.pages' && (!pageId || s.id === pageId));
  if (!page) return { requestId: crypto.randomUUID(), status: 'unavailable', code: 'E_NOT_SUPPORTED', message: '目标实例没有该页面' };
  return navigate({ target: { kind: 'page', instanceId: selection.instanceId, pageId: page.id, contract }, context, placement: 'primary' });
}
