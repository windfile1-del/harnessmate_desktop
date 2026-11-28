import type { BuilderV2Result } from '@harnessmate/protocol';
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { withManagement } from './helpers/management';
const renderToStaticMarkup = (node: ReactNode) => renderMarkup(withManagement(node));
import { describe, expect, it } from 'vitest';
import { PluginAuthoringForm } from '../src/plugins/developer-tools/PluginAuthoringForm';
import { PluginBuilderV2Review } from '../src/plugins/developer-tools/PluginDraftReview';

describe('Phase 3.3 · AI Plugin Builder v2 UI', () => {
  it('renders Tier 1 / Tier 2 mode selector and harness-adapter template option in PluginAuthoringForm', () => {
    const autoHtml = renderToStaticMarkup(
      <PluginAuthoringForm initialManifest="{}" onInstalled={() => {}} />,
    );

    expect(autoHtml).toContain('data-testid="builder-tier-select"');
    expect(autoHtml).toContain('Auto · 自动分类');
    expect(autoHtml).toContain('Tier 1 · 声明式快速草稿');
    expect(autoHtml).toContain('Tier 2 · 完整代码插件工程');
    expect(autoHtml).toContain('data-testid="builder-generate-btn"');

    const tier2Html = renderToStaticMarkup(
      <PluginAuthoringForm initialManifest="{}" initialTier="tier2" onInstalled={() => {}} />,
    );
    expect(tier2Html).toContain('data-testid="builder-template-select"');
    expect(tier2Html).toContain('harness-adapter · 第三方 Harness Adapter 驱动');
    expect(tier2Html).toContain('isolated · 隔离代码 + 沙箱 UI 插槽');
    expect(tier2Html).toContain('ui-slot · 纯沙箱 HTML UI 插槽');
    expect(tier2Html).toContain('service · 第三方服务提供方');
  });

  it('renders 4-step sandbox pipeline, repair attempts, multi-file code preview & enables install when verified and trusted', () => {
    const verifiedResult: BuilderV2Result = {
      tierUsed: 'tier2',
      templateUsed: 'harness-adapter',
      classificationReason: '检测到自定义 Harness 引擎适配器需求，自动路由至 Tier 2（harness-adapter）',
      draftId: 'b2_verified_1',
      digest: 'a'.repeat(64),
      verified: true,
      manifest: {
        id: 'user.demo-driver',
        name: 'Demo Driver',
        version: '1.0.0',
      },
      files: {
        'harnessmate-plugin.json': '{"id":"user.demo-driver"}',
        'index.mjs': 'export function apply(ctx) { ctx.logger.info("ready"); }',
        'ui/settings.html': '<!doctype html><html><body>Settings</body></html>',
      },
      steps: [
        {
          step: 'manifest_schema',
          label: '1. Manifest V4/V5 Schema & 文件引用校验',
          status: 'passed',
          durationMs: 12,
          details: '清单结构合法（ID: user.demo-driver）',
          errors: [],
        },
        {
          step: 'static_audit_and_syntax',
          label: '2. 静态安全审计 & 语法校验',
          status: 'passed',
          durationMs: 38,
          details: '零阻断安全风险（0 条告警），1 个脚本语法通过',
          errors: [],
        },
        {
          step: 'mock_host_activation',
          label: '3. 离线模拟宿主激活验证',
          status: 'passed',
          durationMs: 65,
          details: 'Mock 宿主激活成功（驱动: 1, 插槽: 2, 命令: 0, 服务: 0）',
          errors: [],
        },
        {
          step: 'sandbox_ui_check',
          label: '4. 沙箱 HTML UI / CSP 打包自检',
          status: 'passed',
          durationMs: 9,
          details: '1 个沙箱 HTML 插槽通过 CSP 本地打包校验',
          errors: [],
        },
      ],
      attempts: [
        { attempt: 1, durationMs: 90, passed: false, steps: [], errorSummary: 'missing net permission' },
        { attempt: 2, durationMs: 124, passed: true, steps: [] },
      ],
      audit: {
        passed: true,
        blockingIssues: [],
        warnings: [],
        permissionSummary: [
          {
            capability: 'harness:driver:register',
            risk: 'high',
            scope: 'global',
            description: '注册第三方 Harness 引擎驱动',
          },
          {
            capability: 'storage:plugin',
            risk: 'low',
            scope: 'global',
            description: '读写插件私有持久化存储',
          },
        ],
      },
    };

    const html = renderToStaticMarkup(
      <PluginBuilderV2Review
        result={verifiedResult}
        trustCode={true}
        onTrustCodeChange={() => {}}
        installMode="dev_link"
        onInstallModeChange={() => {}}
        onInstall={() => {}}
      />,
    );

    expect(html).toContain('data-testid="builder-v2-steps"');
    expect(html).toContain('Mock 宿主激活成功');
    expect(html).toContain('自动修复迭代记录（共 2 轮 / 上限 3 轮）');
    expect(html).toContain('harness:driver:register');
    expect(html).toContain('高风险');
    expect(html).toContain('export function apply(ctx)');
    expect(html).toContain('安全确认并关联 DevMode 热加载');

    const btnMatch = html.match(/<button[^>]*data-testid="builder-v2-install-btn"[^>]*>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch![0]).not.toMatch(/\sdisabled(?:=""|[\s>])/);
  });

  it('blocks install button and renders static audit errors when unsafe code or HTML is detected', () => {
    const blockedResult: BuilderV2Result = {
      tierUsed: 'tier2',
      templateUsed: 'isolated',
      classificationReason: '用户显式选择 Tier 2',
      draftId: 'b2_blocked_1',
      verified: false,
      files: {
        'index.mjs': 'import { exec } from "node:child_process";',
      },
      steps: [
        {
          step: 'static_audit_and_syntax',
          label: '2. 静态安全审计 & 语法校验',
          status: 'failed',
          durationMs: 21,
          details: 'AUDIT_FORBIDDEN_CHILD_PROCESS',
          errors: ['AUDIT_FORBIDDEN_CHILD_PROCESS (index.mjs:1): 禁止直接导入或调用 child_process'],
        },
      ],
      audit: {
        passed: false,
        blockingIssues: [
          {
            code: 'AUDIT_FORBIDDEN_CHILD_PROCESS',
            severity: 'error',
            file: 'index.mjs',
            line: 1,
            message: '禁止直接导入或调用 child_process / node:child_process',
            suggestion: '改用 ctx.runtime.spawnCli',
          },
        ],
        warnings: [],
        permissionSummary: [],
      },
      error: '已达最大自动修复轮次（3 轮），验证仍未通过，已熔断停止',
    };

    const html = renderToStaticMarkup(
      <PluginBuilderV2Review
        result={blockedResult}
        trustCode={true}
        onTrustCodeChange={() => {}}
        installMode="local_install"
        onInstallModeChange={() => {}}
        onInstall={() => {}}
      />,
    );

    expect(html).toContain('data-testid="builder-v2-blocking-issues"');
    expect(html).toContain('AUDIT_FORBIDDEN_CHILD_PROCESS');
    expect(html).toContain('禁止直接导入或调用 child_process');
    expect(html).toContain('安全验证未通过 · 禁止安装');

    const btnMatch = html.match(/<button[^>]*data-testid="builder-v2-install-btn"[^>]*>/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch![0]).toMatch(/\sdisabled(?:=""|[\s>])/);
  });
});
