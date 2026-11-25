import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AgyModelEffortPicker,
  AgyNativeCommandPalette,
  AgyNativeModePicker,
  NativeCommandSubmissionController,
  SYNTHETIC_HARNESS_MODELS,
  SYNTHETIC_OBSERVED_CONFIG_OPTIONS,
  buildNativeCommandItems,
  buildNativeModeItems,
  makeNp06CommandDescriptorsFixture,
  resolveActualModelEffortOptions,
  searchNativeCommandItems,
} from '../src/components/agy/native/commands';
import {
  NativeClientError,
  type ActivityId,
  type BindingGeneration,
  type NativeCommandSubmitRequest,
} from '../src/lib/native-client';

describe('NP-06 Web Native Command Palette, Mode Picker, Model/Effort Picker & Draft Preservation (synthetic)', () => {
  it('shares the exact same CapabilityDescriptor projection between Native Command Palette and Mode Picker', () => {
    const descriptors = makeNp06CommandDescriptorsFixture({
      snapshotRevision: 5,
      swarmAdvertised: true,
      boostAdvertised: false,
      includeUnknownSlash: true,
    });

    const commandItems = buildNativeCommandItems(descriptors, { profileVerified: true });
    const modeItems = buildNativeModeItems(descriptors, { profileVerified: true });

    const swarmCmd = commandItems.find((i) => i.capabilityId === 'AGY-W04');
    const swarmMode = modeItems.find((m) => m.id === 'swarm');
    expect(swarmCmd?.runnable).toBe(true);
    expect(swarmMode?.runnable).toBe(true);
    expect(swarmCmd?.snapshotRevision).toBe(5);
    expect(swarmMode?.snapshotRevision).toBe(5);

    const boostCmd = commandItems.find((i) => i.capabilityId === 'AGY-W06');
    const boostMode = modeItems.find((m) => m.id === 'boost');
    expect(boostCmd?.runnable).toBe(false);
    expect(boostMode?.runnable).toBe(false);
    expect(boostCmd?.disabledReason).toBe(boostMode?.disabledReason);
    expect(boostCmd?.disabledReason).toContain('计划不支持');

    // Unknown dynamic slash command is visible for transparency but strictly non-runnable
    const unknownCmd = commandItems.find((i) => i.capabilityId === 'AGY-DYN-experimental_tui');
    expect(unknownCmd?.runnable).toBe(false);
    expect(unknownCmd?.disabledReason).toContain('未验证的动态 slash 命令');

    // Revocation degrades BOTH palette and mode picker together
    const revokedDescriptors = makeNp06CommandDescriptorsFixture({
      snapshotRevision: 6,
      swarmAdvertised: false,
    });
    const revokedCmd = buildNativeCommandItems(revokedDescriptors, { profileVerified: true }).find(
      (i) => i.capabilityId === 'AGY-W04',
    );
    const revokedMode = buildNativeModeItems(revokedDescriptors, { profileVerified: true }).find(
      (m) => m.id === 'swarm',
    );
    expect(revokedCmd?.runnable).toBe(false);
    expect(revokedMode?.runnable).toBe(false);
    expect(revokedCmd?.disabledReason).toContain('未广告或已撤销');
    expect(revokedMode?.disabledReason).toContain('未广告或已撤销');
  });

  it('supports slash search, lane filtering, parameter hints, disabled reasons, and conflict draft banner in rendered UI', () => {
    const descriptors = makeNp06CommandDescriptorsFixture({
      snapshotRevision: 7,
      swarmAdvertised: true,
      boostAdvertised: false,
      includeUnknownSlash: true,
    });
    const items = buildNativeCommandItems(descriptors, { profileVerified: true });

    const slashSwarm = searchNativeCommandItems(items, '/swarm');
    expect(slashSwarm[0]?.command).toBe('/swarm');

    const queryOnly = searchNativeCommandItems(items, '', 'query');
    expect(queryOnly.every((i) => i.lane === 'query')).toBe(true);
    expect(queryOnly.map((i) => i.command)).toEqual(expect.arrayContaining(['/usage', '/skills']));

    const paletteHtml = renderToStaticMarkup(
      <AgyNativeCommandPalette
        descriptors={descriptors}
        catalogRevision={7}
        profileVerified={true}
        preservedDraftText="Refactor command router"
        preservedAttachmentCount={2}
        conflictMessage="能力目录已更新，已保留草稿"
        onSelectCommand={() => {}}
        onRefreshCapabilities={() => {}}
      />,
    );
    expect(paletteHtml).toContain('agy-native-command-palette');
    expect(paletteHtml).toContain('rev #7');
    expect(paletteHtml).toContain('/swarm');
    expect(paletteHtml).toContain('&lt;协作目标&gt;');
    expect(paletteHtml).toContain('禁用原因：当前账号计划不支持此模式');
    expect(paletteHtml).toContain('agy-command-conflict-banner');
    expect(paletteHtml).toContain('2 个附件');
    expect(paletteHtml).toContain('选择命令仅填充输入草稿');

    const modePickerHtml = renderToStaticMarkup(
      <AgyNativeModePicker
        selectedModeId="swarm"
        descriptors={descriptors}
        profileVerified={true}
        defaultOpen={true}
        onSelectMode={() => {}}
      />,
    );
    expect(modePickerHtml).toContain('agy-native-mode-picker');
    expect(modePickerHtml).toContain('模式: Swarm 协作');
    expect(modePickerHtml).toContain('AGY 工作模式（同源目录 · 保留草稿）');
    expect(modePickerHtml).toContain('当前账号计划不支持此模式');
  });

  it('preserves draft and ordered attachments on 409 conflicts, reuses idempotencyKey on BUSY retry, and shows honest pending confirmation', async () => {
    const controller = new NativeCommandSubmissionController({
      text: 'Investigate flaky tests',
      attachmentIds: ['att_a', 'att_b'],
    });

    // Switching mode preserves user text & attachment ordering
    controller.selectMode({
      modeId: 'swarm',
      capabilityId: 'AGY-W04',
      actionKey: 'launch_swarm',
    });
    expect(controller.getState().draft.text).toBe('Investigate flaky tests');
    expect(controller.getState().draft.attachmentIds).toEqual(['att_a', 'att_b']);

    // 1. 409 STALE_BINDING preserves draft & attachments and requests capability refresh
    const refreshMock = vi.fn();
    const capturedRequests: NativeCommandSubmitRequest[] = [];
    const staleState = await controller.submit(
      {
        bindingGeneration: 'gen_1' as BindingGeneration,
        catalogRevision: 3,
        capabilityId: 'AGY-W04',
        actionKey: 'launch_swarm',
        args: { task: 'Investigate flaky tests' },
      },
      async (req) => {
        capturedRequests.push(req);
        throw new NativeClientError('Catalog revision is stale', 409, 'STALE_BINDING');
      },
      refreshMock,
    );
    expect(staleState.phase).toBe('conflict_preserved');
    expect(staleState.draft.text).toBe('Investigate flaky tests');
    expect(staleState.draft.attachmentIds).toEqual(['att_a', 'att_b']);
    expect(staleState.capabilitiesRefreshRequested).toBe(true);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(capturedRequests[0]?.args.attachmentIds).toEqual(['att_a', 'att_b']);

    // 2. 409 BUSY preserves the exact idempotencyKey so immediate duplicate retry does not mint a second key
    const busyKeys: string[] = [];
    const busyState = await controller.submit(
      {
        bindingGeneration: 'gen_1' as BindingGeneration,
        catalogRevision: 4,
        capabilityId: 'AGY-W04',
        actionKey: 'launch_swarm',
        args: { task: 'Investigate flaky tests' },
      },
      async (req) => {
        busyKeys.push(req.idempotencyKey);
        throw new NativeClientError('Request in flight', 409, 'BUSY');
      },
    );
    expect(busyState.phase).toBe('conflict_preserved');
    expect(busyState.activeIdempotencyKey).toBe(busyKeys[0]);

    // Retry with same revision reuses the exact same idempotencyKey and succeeds with honest waiting-evidence message
    const acceptedState = await controller.submit(
      {
        bindingGeneration: 'gen_1' as BindingGeneration,
        catalogRevision: 4,
        capabilityId: 'AGY-W04',
        actionKey: 'launch_swarm',
        args: { task: 'Investigate flaky tests' },
      },
      async (req) => {
        busyKeys.push(req.idempotencyKey);
        return {
          schemaVersion: 1,
          status: 'accepted',
          receiptId: 'rcpt_ok_1',
          activityId: 'act_ok_1' as ActivityId,
          modeEvidenceObserved: false,
        };
      },
    );
    expect(busyKeys[1]).toBe(busyKeys[0]);
    expect(acceptedState.phase).toBe('accepted_waiting_evidence');
    expect(acceptedState.statusMessage).toBe('已发送，等待原生确认');
    expect(acceptedState.draft.text).toBe('');
  });

  it('derives model and effort picker strictly from actual observed options and does not invent unobserved effort levels', () => {
    const resolved = resolveActualModelEffortOptions({
      harnessModels: SYNTHETIC_HARNESS_MODELS,
      activeModelId: 'gemini-3.8-flash',
      activeEffort: 'medium',
      observedConfigOptions: SYNTHETIC_OBSERVED_CONFIG_OPTIONS,
    });
    expect(resolved.models.map((m) => m.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-pro-orchestrator',
    ]);
    expect(resolved.availableEfforts).toEqual(['low', 'medium', 'high']);
    expect(resolved.effortObserved).toBe(true);

    const observedHtml = renderToStaticMarkup(
      <AgyModelEffortPicker
        harnessModels={SYNTHETIC_HARNESS_MODELS}
        activeModelId="gemini-3.8-flash"
        activeEffort="medium"
        observedConfigOptions={SYNTHETIC_OBSERVED_CONFIG_OPTIONS}
        onSelectModel={() => {}}
        onSelectEffort={() => {}}
      />,
    );
    expect(observedHtml).toContain('Gemini 3.8 Flash');
    expect(observedHtml).toContain('Gemini Pro Orchestrator');
    expect(observedHtml).toContain('Orchestrator (Planner + Executor)');
    expect(observedHtml).toContain('低 (low)');
    expect(observedHtml).toContain('高 (high)');
    expect(observedHtml).not.toContain('最大 (max)');

    // When backend has not advertised thought_level options, UI shows honest unobserved indicator
    const unobservedHtml = renderToStaticMarkup(
      <AgyModelEffortPicker
        harnessModels={[{ id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' }]}
        activeModelId="gemini-3.8-flash"
        observedConfigOptions={[]}
        onSelectModel={() => {}}
        onSelectEffort={() => {}}
      />,
    );
    expect(unobservedHtml).toContain('agy-effort-unobserved');
    expect(unobservedHtml).toContain('未观测到思考强度选项');
  });
});
