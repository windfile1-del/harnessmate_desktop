import { PLUGIN_EVENT_VERSION, type PluginEventV4 } from '@harnessmate/plugin-api';
import type { CanonicalEvent } from '@harnessmate/protocol';

export function toPluginEvent(event: CanonicalEvent): PluginEventV4 | undefined {
  const { type, sessionId, turnId, seq, createdAt, payload } = event;
  const base = { version: PLUGIN_EVENT_VERSION, sessionId, turnId, seq, createdAt } as const;
  const string = (name: string) => typeof payload[name] === 'string' ? payload[name] : null;
  const harness = { harnessId: string('harnessId') };
  switch (type) {
    case 'turn.started': return { ...base, type, data: harness };
    case 'turn.completed': return { ...base, type, data: {
      ...harness, stopReason: string('stopReason'), maintenance: payload.maintenance === true,
    } };
    case 'turn.failed': return { ...base, type, data: {
      ...harness, message: string('message'), maintenance: payload.maintenance === true,
    } };
    case 'turn.cancelled': return { ...base, type, data: harness };
    case 'message.user':
    case 'message.assistant.completed': return { ...base, type, data: { text: string('text') ?? '' } };
    case 'tool.call.completed': return { ...base, type: 'tool.completed', data: {
      toolCallId: string('toolCallId') ?? '', toolName: string('toolName') ?? '', status: string('status') ?? '',
    } };
    case 'approval.requested': {
      const approval = payload.approval as { id?: unknown; toolName?: unknown } | undefined;
      if (typeof approval?.id !== 'string') return;
      return { ...base, type, data: { approvalId: approval.id, toolName: typeof approval.toolName === 'string' ? approval.toolName : '' } };
    }
    case 'session.harness_switched': return { ...base, type, data: {
      previousHarnessId: string('fromHarnessId') ?? string('previousHarnessId'),
      targetHarnessId: string('toHarnessId') ?? string('targetHarnessId') ?? '',
      driverId: string('driverId') ?? string('toHarnessKind') ?? undefined,
      reason: string('reason') ?? undefined,
    } };
    case 'handoff.snapshot_delivered': return { ...base, type: 'handoff.delivered', data: {
      handoffId: string('handoffId') ?? string('snapshotId') ?? '',
      toInstanceId: string('toInstanceId') ?? string('targetHarnessId') ?? '',
      deliveryChannel: string('deliveryChannel') ?? string('driver') ?? '',
      deliveryStatus: string('deliveryStatus') ?? 'confirmed',
    } };
    default: return;
  }
}
