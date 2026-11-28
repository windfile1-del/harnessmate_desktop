import type { CanonicalEvent } from '@harnessmate/protocol';
import { describe, expect, it } from 'vitest';
import { createSessionEventProjector, projectSessionEvents } from '../src/lib/projector';
import { parseFileLink } from '../src/lib/file-links';

describe('projectSessionEvents', () => {
  it('projects streaming assistant text, thinking, tools, and mobile-resolved approvals deterministically', () => {
    const events: CanonicalEvent[] = [
      {
        sessionId: 's1',
        seq: 1,
        type: 'message.user',
        turnId: 't1',
        createdAt: 1000,
        payload: { text: 'Check git status' },
      },
      {
        sessionId: 's1',
        seq: 2,
        type: 'thinking.delta',
        turnId: 't1',
        createdAt: 1005,
        payload: { text: 'Let me inspect the repo.' },
      },
      {
        sessionId: 's1',
        seq: 3,
        type: 'tool.call.started',
        turnId: 't1',
        createdAt: 1010,
        payload: {
          toolCallId: 'tc_1',
          toolName: 'Bash',
          toolKind: 'shell',
          summary: 'git status',
          input: { command: 'git status' },
        },
      },
      {
        sessionId: 's1',
        seq: 4,
        type: 'approval.requested',
        turnId: 't1',
        createdAt: 1015,
        payload: {
          approval: {
            id: 'appr_1',
            sessionId: 's1',
            nativeRequestId: 'n1',
            toolName: 'Bash',
            toolKind: 'shell',
            summary: 'Run git status',
            input: { command: 'git status' },
            riskLevel: 'low',
            status: 'pending',
            createdAt: 1015,
          },
        },
      },
      {
        sessionId: 's1',
        seq: 5,
        type: 'approval.resolved',
        turnId: 't1',
        createdAt: 1020,
        payload: {
          approvalId: 'appr_1',
          decision: 'allow_once',
          resolvedBy: 'mobile',
        },
      },
      {
        sessionId: 's1',
        seq: 6,
        type: 'tool.call.completed',
        turnId: 't1',
        createdAt: 1030,
        payload: {
          toolCallId: 'tc_1',
          toolName: 'Bash',
          status: 'success',
          output: 'nothing to commit',
        },
      },
      {
        sessionId: 's1',
        seq: 7,
        type: 'message.assistant.delta',
        turnId: 't1',
        createdAt: 1035,
        payload: { text: 'Working tree is clean.' },
      },
      {
        sessionId: 's1',
        seq: 8,
        type: 'turn.completed',
        turnId: 't1',
        createdAt: 1040,
        payload: { stopReason: 'end_turn' },
      },
    ];

    const projected = projectSessionEvents(events);
    expect(projected.turns).toHaveLength(1);
    expect(projected.pendingApprovals).toHaveLength(0);

    const turn = projected.turns[0]!;
    expect(turn.userText).toBe('Check git status');
    expect(turn.thinking).toBe('Let me inspect the repo.');
    expect(turn.tools[0]?.output).toBe('nothing to commit');
    expect(turn.approvals[0]?.status).toBe('approved');
    expect(turn.approvals[0]?.resolvedBy).toBe('mobile');
    expect(turn.assistantText).toBe('Working tree is clean.');
    expect(turn.status).toBe('completed');

    const project = createSessionEventProjector();
    const beforeResolution = project(events.slice(0, 4));
    const expired: CanonicalEvent = { ...events[4]!, payload: { approvalId: 'appr_1', status: 'expired' } };
    const afterResolution = project([...events.slice(0, 4), expired]);
    expect(beforeResolution.pendingApprovals[0]?.status).toBe('pending');
    expect(afterResolution.pendingApprovals).toHaveLength(0);
    expect(afterResolution.turns[0]?.approvals[0]?.status).toBe('expired');
  });

  it('projects multi-harness turns with per-turn attribution and interleaved switch dividers', () => {
    const events: CanonicalEvent[] = [
      {
        sessionId: 's2',
        seq: 1,
        type: 'message.user',
        turnId: 't1',
        createdAt: 1000,
        payload: { text: 'Start on AGY', harnessId: 'agy', harnessKind: 'agy', actualModel: 'gemini-4-neon' },
      },
      {
        sessionId: 's2',
        seq: 2,
        type: 'message.assistant.completed',
        turnId: 't1',
        createdAt: 1100,
        payload: { text: 'Done by AGY', harnessId: 'agy', actualModel: 'gemini-4-neon' },
      },
      {
        sessionId: 's2',
        seq: 3,
        type: 'turn.completed',
        turnId: 't1',
        createdAt: 1200,
        payload: { stopReason: 'end_turn', harnessId: 'agy', harnessKind: 'agy', actualModel: 'gemini-4-neon' },
      },
      {
        sessionId: 's2',
        seq: 4,
        type: 'session.harness_switched',
        turnId: null,
        createdAt: 1300,
        payload: {
          fromHarnessId: 'agy',
          fromHarnessKind: 'agy',
          toHarnessId: 'codex',
          toHarnessKind: 'codex',
          toModel: 'gpt-6.2-sol',
          syncedUpToSeq: 0,
          currentLastSeq: 3,
          unsyncedTurnCount: 1,
          estimatedTokens: 640,
          driverPlanned: 'codex_inject_items',
          isWarmBinding: false,
          gitAnchor: 'main · clean',
        },
      },
      {
        sessionId: 's2',
        seq: 5,
        type: 'message.user',
        turnId: 't2',
        createdAt: 1400,
        payload: { text: 'Continue on Codex', harnessId: 'codex', harnessKind: 'codex', model: 'gpt-6.2-sol' },
      },
      {
        sessionId: 's2',
        seq: 6,
        type: 'turn.completed',
        turnId: 't2',
        createdAt: 1500,
        payload: { stopReason: 'end_turn', harnessId: 'codex', harnessKind: 'codex', actualModel: 'gpt-6.2-sol' },
      },
    ];

    const projected = projectSessionEvents(events, { id: 'codex', kind: 'codex' });
    expect(projected.items).toHaveLength(3);
    expect(projected.items[0]?.kind).toBe('turn');
    expect(projected.items[1]?.kind).toBe('switch');
    expect(projected.items[2]?.kind).toBe('turn');

    expect(projected.turns[0]?.harnessId).toBe('agy');
    expect(projected.turns[0]?.actualModel).toBe('gemini-4-neon');
    expect(projected.turns[1]?.harnessId).toBe('codex');
    expect(projected.turns[1]?.actualModel).toBe('gpt-6.2-sol');

    const project = createSessionEventProjector();
    const initial = project(events.slice(0, 3));
    const append = project(events);
    expect(append.turns[0]).toBe(initial.turns[0]);
    expect(project([events[0]!, events[2]!]).turns[0]?.assistantText).toBe('');
  });
});

it('recognizes native and workspace file links without intercepting protocol URLs', () => {
  expect(parseFileLink('/D:/Project/src/main.ts:25:3')).toEqual({ path: 'D:/Project/src/main.ts', line: 25, column: 3 });
  expect(parseFileLink('file:///D:/My%20Project/readme.md#L17-L21')).toEqual({ path: 'D:/My Project/readme.md', line: 17 });
  expect(parseFileLink('src/index.ts#L3')).toEqual({ path: 'src/index.ts', line: 3 });
  expect(parseFileLink('https://example.com/path.ts#L3')).toBeNull();
  expect(parseFileLink('javascript:alert(1)')).toBeNull();
});
