import crypto from 'node:crypto';
import path from 'node:path';
import type {
  ApprovalAnnotationDto,
  ApprovalRequest,
  CustomRiskRule,
  RiskAnnotationSeverity,
  RiskLevel,
  RuntimeRequestKind,
  ToolKind,
} from '@harnessmate/protocol';
import { CustomRiskRuleSchema } from '@harnessmate/protocol';
import type { HarnessMateStore } from '../db/sqlite.js';

export const APPROVAL_CENTER_PLUGIN_ID = 'hm.plugin.approval-center';
const CUSTOM_RULES_KV_KEY = 'custom_risk_rules';
export const ANNOTATOR_TIMEOUT_MS = 300;
export const SECRET_RECEIPT_LABEL = '已安全提供凭据（内容已隐藏）';

export interface ApprovalAnnotateContext {
  approvalId: string;
  sessionId: string;
  workspaceId: string;
  cwd?: string;
  kind: RuntimeRequestKind;
  toolName: string;
  toolKind: ToolKind;
  summary: string;
  input: unknown;
  diffPreview?: string | null;
  riskLevel: RiskLevel;
}

export type ExternalApprovalAnnotator = {
  pluginId: string;
  annotate: (
    ctx: ApprovalAnnotateContext,
  ) => Promise<ApprovalAnnotationDto[] | ApprovalAnnotationDto | null | undefined>;
};

export interface RiskEvaluationResult {
  highestRisk: RiskLevel;
  highestSeverity: RiskAnnotationSeverity;
  annotations: ApprovalAnnotationDto[];
  hadDegradedAnnotator: boolean;
}

const SEVERITY_RANK: Record<RiskAnnotationSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityToRiskLevel(severity?: RiskAnnotationSeverity): RiskLevel {
  if (!severity || severity === 'info' || severity === 'low') return 'low';
  if (severity === 'medium') return 'medium';
  if (severity === 'high') return 'high';
  return 'critical';
}

export function riskLevelToSeverity(risk?: RiskLevel): RiskAnnotationSeverity {
  if (!risk || risk === 'low') return 'info';
  return risk;
}

export const BUILTIN_RISK_RULES: readonly CustomRiskRule[] = [
  {
    id: 'builtin.rm_rf_root',
    name: '递归强制删除根目录或家目录',
    pattern: '(?:\\brm\\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\\b[^;|&\\n]*(?:\\s+/(?:\\s|$|\\*)|\\s+~|\\s+\\*\\b|\\s+\\.\\.))|(?:Remove-Item\\b[^\\n]*-Recurse[^\\n]*-Force[^\\n]*(?:C:\\\\|/))',
    severity: 'critical',
    target: 'command',
    reason: '检测到针对根目录、家目录或通配路径的递归强制删除，可能导致不可逆数据灾难。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.curl_pipe_shell',
    name: '管道直接执行远程脚本',
    pattern: '(?:\\b(?:curl|wget)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|fish|dash|python|node|perl)\\b)|(?:\\b(?:iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\\b[^\\n|]*\\|\\s*(?:iex|Invoke-Expression)\\b)',
    severity: 'critical',
    target: 'command',
    reason: '远程下载的内容直接通过管道交付 Shell/解释器执行，存在供应链与任意代码执行风险。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.git_force_push',
    name: 'Git 强制推送覆盖远端历史',
    pattern: '\\bgit\\s+push\\b[^\\n]*(?:--force\\b|-f\\b|--force-with-lease\\b)',
    severity: 'critical',
    target: 'command',
    reason: '强制推送可能覆盖远端团队提交历史，属于高危破坏性操作。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.disk_format_dd',
    name: '底层磁盘格式化或原始块写入',
    pattern: '(?:\\bmkfs(?:\\.[a-z0-9]+)?\\b)|(?:\\bdd\\b[^\\n]*\\bof=/dev/)|(?:\\bformat\\s+[a-zA-Z]:)',
    severity: 'critical',
    target: 'command',
    reason: '检测到直接操作块设备或格式化磁盘的命令，可能彻底损毁系统分区。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.chmod_777_root',
    name: '大范围放开系统权限 (chmod 777)',
    pattern: '\\bchmod\\b[^\\n]*(?:-R\\s+)?(?:0?777)\\s+(?:/|~|\\.\\.)',
    severity: 'critical',
    target: 'command',
    reason: '递归赋予 777 权限会破坏系统与工作区安全边界。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.sql_destructive',
    name: '破坏性 SQL 删除指令',
    pattern: '\\b(?:DROP\\s+DATABASE|DROP\\s+TABLE|TRUNCATE\\s+TABLE)\\b',
    severity: 'critical',
    target: 'any',
    reason: '检测到不可逆的数据库表/库销毁操作。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.ssh_aws_credentials',
    name: '访问本机 SSH 私钥或云凭据',
    pattern: '(?:~|/|\\\\)\\.(?:ssh(?:/|\\\\)(?:id_|config|authorized_keys)|aws(?:/|\\\\)credentials|kube(?:/|\\\\)config|npmrc|pypirc)|/etc/shadow\\b',
    severity: 'critical',
    target: 'any',
    reason: '尝试读取或修改 SSH 私钥、云厂商凭据或系统影子密码文件。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.env_secret_file',
    name: '读取或修改 .env / 私钥证书文件',
    pattern: '(?:^|[\\s"\'/\\\\])(?:\\.env(?:\\.[a-zA-Z0-9_-]+)?|[^\\s"\'/\\\\]+\\.(?:pem|key|p12|pfx))(?:$|[\\s"\'])',
    severity: 'high',
    target: 'any',
    reason: '涉及 .env 环境变量或私钥证书文件，可能暴露敏感 API 密钥或凭据。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.sudo_privilege',
    name: '提权执行 (sudo / su / runas)',
    pattern: '(?:^|[;&|]\\s*)(?:sudo|su|runas)\\s+',
    severity: 'high',
    target: 'command',
    reason: '请求以管理员或 root 权限执行系统命令。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.git_destructive_reset',
    name: 'Git 硬重置或强制清理未追踪文件',
    pattern: '\\bgit\\s+(?:reset\\s+--hard|clean\\s+-[a-zA-Z]*f[a-zA-Z]*d|clean\\s+-[a-zA-Z]*d[a-zA-Z]*f)\\b',
    severity: 'high',
    target: 'command',
    reason: '可能直接丢弃尚未提交的本地修改或未追踪文件。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.base64_eval_exec',
    name: '编码混淆脚本执行',
    pattern: '\\bbase64\\s+(?:-d|--decode)\\b[^\\n|]*\\|\\s*(?:sh|bash|zsh|python|node)\\b',
    severity: 'high',
    target: 'command',
    reason: '解码混淆内容并直接执行，常见于恶意载荷投递。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.package_publish',
    name: '公开发布软件包 (npm/cargo/twine publish)',
    pattern: '\\b(?:npm|pnpm|yarn|cargo)\\s+publish\\b|\\btwine\\s+upload\\b',
    severity: 'high',
    target: 'command',
    reason: '将本地制品公开发布到外部包仓库，操作难以撤回。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.docker_privileged',
    name: '特权容器启动 (docker --privileged)',
    pattern: '\\bdocker\\s+run\\b[^\\n]*(?:--privileged|-v\\s+/:/|--pid=host)',
    severity: 'high',
    target: 'command',
    reason: '特权容器或宿主机根目录挂载可导致容器逃逸。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.mcp_destructive_tool',
    name: '破坏性 MCP 工具调用',
    pattern: '(?:^|[.:/_-])(?:delete|destroy|drop|purge|terminate|wipe|exec_shell|run_sql)(?:$|[.:/_-])',
    severity: 'high',
    target: 'mcp',
    reason: 'MCP 外部工具名称包含删除、销毁或任意执行动作，请仔细核对参数。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.git_push_standard',
    name: '推送代码至远端仓库',
    pattern: '\\bgit\\s+push\\b(?!.*(?:--force\\b|-f\\b|--force-with-lease\\b))',
    severity: 'medium',
    target: 'command',
    reason: '将本地提交推送至远端仓库。',
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin.rm_non_root',
    name: '删除工作区文件 (rm)',
    pattern: '\\brm\\s+(?!-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\\b[^;|&\\n]*(?:\\s+/(?:\\s|$|\\*)|\\s+~|\\s+\\*\\b|\\s+\\.\\.))',
    severity: 'medium',
    target: 'command',
    reason: '将从磁盘删除指定文件或目录。',
    enabled: true,
    builtin: true,
  },
];

function extractCommandString(ctx: ApprovalAnnotateContext): string {
  const parts: string[] = [];
  if (ctx.summary) parts.push(ctx.summary);
  if (ctx.input && typeof ctx.input === 'object') {
    const inp = ctx.input as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'script', 'shellCommand', 'args']) {
      const val = inp[key];
      if (typeof val === 'string') parts.push(val);
      else if (Array.isArray(val)) parts.push(val.map(String).join(' '));
    }
  } else if (typeof ctx.input === 'string') {
    parts.push(ctx.input);
  }
  return parts.join('\n');
}

function extractFilePaths(ctx: ApprovalAnnotateContext): string[] {
  const paths: string[] = [];
  const collect = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) paths.push(val.trim());
    else if (Array.isArray(val)) {
      for (const item of val) collect(item);
    }
  };
  if (ctx.input && typeof ctx.input === 'object') {
    const inp = ctx.input as Record<string, unknown>;
    for (const key of ['path', 'filePath', 'file_path', 'targetPath', 'target_file', 'files', 'destination']) {
      collect(inp[key]);
    }
  }
  if (ctx.kind === 'file_change_approval' || ctx.toolKind === 'file_edit' || ctx.toolKind === 'file_read') {
    if (ctx.summary) paths.push(ctx.summary);
  }
  return paths;
}

function detectOutOfWorkspacePath(filePaths: string[], cwd?: string): string | null {
  for (const raw of filePaths) {
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(raw)) {
      return raw;
    }
    if (cwd && path.isAbsolute(raw)) {
      const resolvedCwd = path.resolve(cwd);
      const resolvedTarget = path.resolve(raw);
      const rel = path.relative(resolvedCwd, resolvedTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return raw;
      }
    }
  }
  return null;
}

export function validateSafeRegex(pattern: string): RegExp {
  if (!pattern || pattern.length > 300) {
    throw new Error('正则表达式长度必须在 1-300 字符之间');
  }
  // Reject obvious nested-quantifier ReDoS patterns
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) {
    throw new Error('正则表达式包含可能导致回溯卡死的嵌套量词，请简化模式');
  }
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`无效的正则表达式：${err instanceof Error ? err.message : String(err)}`);
  }
}

export class ApprovalCenterService {
  private readonly externalAnnotators = new Map<string, ExternalApprovalAnnotator>();

  constructor(private readonly store: HarnessMateStore) {}

  registerAnnotator(annotator: ExternalApprovalAnnotator): () => void {
    this.externalAnnotators.set(annotator.pluginId, annotator);
    return () => {
      if (this.externalAnnotators.get(annotator.pluginId) === annotator) {
        this.externalAnnotators.delete(annotator.pluginId);
      }
    };
  }

  listRules(): CustomRiskRule[] {
    const custom = this.loadCustomRules();
    return [...BUILTIN_RISK_RULES, ...custom];
  }

  listCustomRules(): CustomRiskRule[] {
    return this.loadCustomRules();
  }

  addCustomRule(input: Omit<CustomRiskRule, 'id' | 'builtin'> & { id?: string }): CustomRiskRule {
    validateSafeRegex(input.pattern);
    const rules = this.loadCustomRules();
    const id = input.id?.trim() || `custom.${crypto.randomBytes(4).toString('hex')}`;
    if (BUILTIN_RISK_RULES.some((r) => r.id === id)) {
      throw new Error(`规则 ID 与内置规则冲突：${id}`);
    }
    const rule = CustomRiskRuleSchema.parse({
      ...input,
      id,
      builtin: false,
    });
    const next = [...rules.filter((r) => r.id !== rule.id), rule];
    this.saveCustomRules(next);
    return rule;
  }

  deleteCustomRule(ruleId: string): boolean {
    if (BUILTIN_RISK_RULES.some((r) => r.id === ruleId)) {
      throw new Error('无法删除内置安全规则');
    }
    const rules = this.loadCustomRules();
    const next = rules.filter((r) => r.id !== ruleId);
    if (next.length === rules.length) return false;
    this.saveCustomRules(next);
    return true;
  }

  evaluateLocalRules(ctx: ApprovalAnnotateContext): ApprovalAnnotationDto[] {
    const annotations: ApprovalAnnotationDto[] = [];
    if (ctx.kind === 'user_question' || ctx.kind === 'secret_request') {
      return annotations;
    }

    const commandText = extractCommandString(ctx);
    const filePaths = extractFilePaths(ctx);
    const allText = [commandText, ...filePaths, ctx.diffPreview ?? ''].filter(Boolean).join('\n');

    // Out-of-workspace path traversal check
    const escapedPath = detectOutOfWorkspacePath(filePaths, ctx.cwd);
    if (escapedPath) {
      annotations.push({
        pluginId: APPROVAL_CENTER_PLUGIN_ID,
        sourcePluginId: APPROVAL_CENTER_PLUGIN_ID,
        risk: 'high',
        severity: 'high',
        label: '越界路径访问 (工作区外部)',
        title: '越界路径访问 (工作区外部)',
        detail: `目标路径「${escapedPath}」超出当前工作区边界，可能修改或读取敏感系统文件。`,
        matchedPattern: '../',
      });
    }

    const allRules = this.listRules();
    for (const rule of allRules) {
      if (!rule.enabled) continue;
      let targetText = '';
      if (rule.target === 'command') {
        if (ctx.toolKind !== 'shell' && ctx.kind !== 'command_approval' && !commandText) continue;
        targetText = commandText;
      } else if (rule.target === 'file_path') {
        targetText = filePaths.join('\n');
      } else if (rule.target === 'mcp') {
        if (ctx.toolKind !== 'mcp' && ctx.kind !== 'mcp_tool_approval') continue;
        targetText = `${ctx.toolName}\n${commandText}`;
      } else {
        targetText = allText;
      }
      if (!targetText) continue;

      try {
        const re = new RegExp(rule.pattern, 'i');
        if (re.test(targetText)) {
          annotations.push({
            pluginId: APPROVAL_CENTER_PLUGIN_ID,
            sourcePluginId: APPROVAL_CENTER_PLUGIN_ID,
            risk: severityToRiskLevel(rule.severity),
            severity: rule.severity,
            label: rule.name,
            title: rule.name,
            detail: rule.reason,
            matchedPattern: rule.pattern,
          });
        }
      } catch {
        // Ignore broken custom regex at evaluation time
      }
    }

    return annotations;
  }

  /**
   * Evaluates local rules AND invokes all third-party `approval.annotate` hooks in parallel,
   * enforcing a strict 300ms timeout and error boundary per plugin annotator.
   */
  async evaluateWithPlugins(
    ctx: ApprovalAnnotateContext,
    extraAnnotators: readonly ExternalApprovalAnnotator[] = [],
  ): Promise<RiskEvaluationResult> {
    const local = this.evaluateLocalRules(ctx);
    const annotators = [...this.externalAnnotators.values(), ...extraAnnotators];
    let hadDegradedAnnotator = false;

    const externalSettled = await Promise.all(
      annotators.map(async (annotator): Promise<ApprovalAnnotationDto[]> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`timeout after ${ANNOTATOR_TIMEOUT_MS}ms`));
            }, ANNOTATOR_TIMEOUT_MS);
            timer.unref?.();
          });
          const raw = await Promise.race([
            Promise.resolve().then(() => annotator.annotate(ctx)),
            timeoutPromise,
          ]);
          const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
          return list
            .filter((item) => item && typeof item.label === 'string' && item.label.trim().length > 0)
            .map((item) => ({
              ...item,
              pluginId: item.pluginId || annotator.pluginId,
              sourcePluginId: item.sourcePluginId || item.pluginId || annotator.pluginId,
              title: item.title || item.label,
              severity: item.severity ?? riskLevelToSeverity(item.risk),
              risk: item.risk ?? severityToRiskLevel(item.severity),
            }));
        } catch {
          hadDegradedAnnotator = true;
          return [
            {
              pluginId: annotator.pluginId,
              sourcePluginId: annotator.pluginId,
              risk: 'low',
              severity: 'info',
              label: '部分安全规则检查未响应',
              title: '部分安全规则检查未响应',
              detail: `插件 ${annotator.pluginId} 的安全标注器超时（>${ANNOTATOR_TIMEOUT_MS}ms）或异常退出，已隔离跳过。`,
              degraded: true,
            },
          ];
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }),
    );

    const combined = [...local, ...externalSettled.flat()];
    // Deduplicate by pluginId+label and sort by severity descending
    const dedup = new Map<string, ApprovalAnnotationDto>();
    for (const note of combined) {
      const key = `${note.pluginId}::${note.label}`;
      if (!dedup.has(key)) dedup.set(key, note);
    }
    const sorted = [...dedup.values()].sort((a, b) => {
      const sa = SEVERITY_RANK[a.severity ?? riskLevelToSeverity(a.risk)] ?? 0;
      const sb = SEVERITY_RANK[b.severity ?? riskLevelToSeverity(b.risk)] ?? 0;
      return sb - sa;
    });

    let highestSeverity: RiskAnnotationSeverity = riskLevelToSeverity(ctx.riskLevel);
    for (const note of sorted) {
      if (note.degraded) continue;
      const sev = note.severity ?? riskLevelToSeverity(note.risk);
      if (SEVERITY_RANK[sev] > SEVERITY_RANK[highestSeverity]) {
        highestSeverity = sev;
      }
    }

    return {
      highestRisk: severityToRiskLevel(highestSeverity),
      highestSeverity,
      annotations: sorted,
      hadDegradedAnnotator,
    };
  }

  /**
   * Produces a read-only sanitized receipt representation for `chat.block` rendering.
   * For `secret_request`, NEVER includes any secret plaintext.
   */
  buildReceiptSummary(approval: ApprovalRequest): {
    title: string;
    textBody: string;
    payload: Record<string, unknown>;
  } {
    const deviceLabel =
      approval.resolvedBy === 'mobile'
        ? '移动端'
        : approval.resolvedBy === 'desktop'
          ? '桌面端'
          : '系统';

    if (approval.kind === 'secret_request') {
      const text =
        approval.status === 'cancelled'
          ? '凭据请求已取消'
          : approval.status === 'expired'
            ? '凭据请求已过期'
            : approval.decision === 'deny'
              ? `已拒绝提供凭据（${deviceLabel}）`
              : `${SECRET_RECEIPT_LABEL} · 由${deviceLabel}提交`;
      return {
        title: `凭据请求回执 · ${approval.secretSpec?.fieldLabel || approval.toolName}`,
        textBody: text,
        payload: {
          requestId: approval.id,
          kind: 'secret_request',
          status: approval.status,
          resolvedBy: approval.resolvedBy ?? null,
          secretProvided: Boolean(approval.secretProvided),
          resolvedAt: approval.resolvedAt ?? Date.now(),
        },
      };
    }

    if (approval.kind === 'user_question') {
      const ans = approval.questionAnswer;
      const parts: string[] = [];
      if (ans?.selectedOptionIds?.length) {
        const labels = ans.selectedOptionIds.map(
          (id) => approval.questionSpec?.options?.find((o) => o.id === id)?.label ?? id,
        );
        parts.push(`已选：${labels.join('、')}`);
      }
      if (ans?.freeText?.trim()) {
        parts.push(`补充：${ans.freeText.trim()}`);
      }
      return {
        title: `提问回执 · ${approval.questionSpec?.question.slice(0, 48) || approval.summary}`,
        textBody: parts.length > 0 ? `${parts.join(' · ')}（${deviceLabel}）` : `已处理（${deviceLabel}）`,
        payload: {
          requestId: approval.id,
          kind: 'user_question',
          status: approval.status,
          resolvedBy: approval.resolvedBy ?? null,
          questionAnswer: approval.questionAnswer ?? null,
          resolvedAt: approval.resolvedAt ?? Date.now(),
        },
      };
    }

    const decisionText =
      approval.status === 'cancelled'
        ? '已取消'
        : approval.status === 'expired'
          ? '已过期'
          : approval.decision === 'deny'
            ? '已拒绝'
            : approval.decision === 'allow_session'
              ? '本会话信任'
              : '已允许本次';

    return {
      title: `审批回执 · ${approval.toolName}`,
      textBody: `${decisionText}（${deviceLabel}） · ${approval.summary}`,
      payload: {
        requestId: approval.id,
        kind: approval.kind ?? 'command_approval',
        toolName: approval.toolName,
        riskLevel: approval.riskLevel,
        status: approval.status,
        decision: approval.decision ?? null,
        resolvedBy: approval.resolvedBy ?? null,
        annotations: approval.annotations ?? [],
        resolvedAt: approval.resolvedAt ?? Date.now(),
      },
    };
  }

  private loadCustomRules(): CustomRiskRule[] {
    const stored = this.store.getPluginStorageValue('global', APPROVAL_CENTER_PLUGIN_ID, CUSTOM_RULES_KV_KEY);
    if (!Array.isArray(stored)) return [];
    const valid: CustomRiskRule[] = [];
    for (const item of stored) {
      const parsed = CustomRiskRuleSchema.safeParse(item);
      if (parsed.success) valid.push({ ...parsed.data, builtin: false });
    }
    return valid;
  }

  private saveCustomRules(rules: CustomRiskRule[]): void {
    this.store.setPluginStorageValue('global', APPROVAL_CENTER_PLUGIN_ID, CUSTOM_RULES_KV_KEY, rules);
  }
}
