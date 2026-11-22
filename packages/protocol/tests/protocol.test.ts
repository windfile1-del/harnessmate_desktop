import { describe, expect, it } from 'vitest';
import {
  CreateSessionRequestSchema,
  CustomAcpHarnessConfigSchema,
  PairExchangeRequestSchema,
  WsClientFrameSchema,
} from '../src/index.js';

describe('@harnessmate/protocol schemas', () => {
  it('validates session creation defaults and WS subscribe cursor frames', () => {
    const sess = CreateSessionRequestSchema.parse({
      workspaceId: 'ws_1',
      harnessId: 'codex',
    });
    expect(sess.permissionMode).toBe('accept_edits');

    const wsFrame = WsClientFrameSchema.parse({
      op: 'subscribe',
      sessionId: 'sess_1',
    });
    expect(wsFrame.op).toBe('subscribe');
    if (wsFrame.op === 'subscribe') {
      expect(wsFrame.afterSeq).toBe(0);
    }

    const custom = CustomAcpHarnessConfigSchema.parse({
      id: 'opencode',
      displayName: 'OpenCode',
      command: 'opencode',
    });
    expect(custom.args).toEqual(['acp', '--stdio']);

    expect(() =>
      PairExchangeRequestSchema.parse({ pairingCode: '12', deviceName: '' }),
    ).toThrow();
  });
});
