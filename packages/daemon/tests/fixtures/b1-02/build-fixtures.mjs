import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

/**
 * Generates reproducible, zero-PII synthetic + sanitized format-faithful fixtures
 * covering all 5 local history source types (Codex CLI, Codex Desktop, Claude CLI,
 * AGY CLI, AGY Desktop) plus an independent Codex account & corrupt/partial cases.
 */
export function buildB102Fixtures(baseDir) {
  const codexHome = path.join(baseDir, 'codex-home');
  const codexSessions = path.join(codexHome, 'sessions', '2026', '11', '26');
  const codexArchived = path.join(codexHome, 'archived_sessions');
  fs.mkdirSync(codexSessions, { recursive: true });
  fs.mkdirSync(codexArchived, { recursive: true });

  const codexCliId = '11111111-1111-4111-8111-111111111111';
  const codexDesktopId = '22222222-2222-4222-8222-222222222222';
  const codexZstId = '33333333-3333-4333-8333-333333333333';
  const codexPartialId = '12121212-1212-4121-8121-121212121212';

  fs.writeFileSync(
    path.join(codexHome, 'session_index.jsonl'),
    [
      JSON.stringify({ id: codexCliId, thread_name: 'Codex CLI 示例会话（中文检索）', updated_at: '2026-11-26T10:00:00Z' }),
      JSON.stringify({ id: codexDesktopId, thread_name: 'Codex Desktop 桌面会话', updated_at: '2026-11-26T10:05:00Z' }),
      JSON.stringify({ id: codexZstId, thread_name: 'Codex 归档 Zstd 会话', updated_at: '2026-11-25T08:00:00Z' }),
    ].join('\n') + '\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(codexSessions, `rollout-2026-11-26T10-00-00-${codexCliId}.jsonl`),
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-11-26T10:00:00Z',
        payload: { id: codexCliId, cwd: 'D:\\Fixtures\\repo-codex-cli', originator: 'codex_cli_rs', source: 'cli', cli_version: '0.147.0' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-26T10:00:01Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<environment_context>\nos=windows\n</environment_context>' },
            { type: 'input_text', text: '请检查 Codex CLI 历史导入兼容性' },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-26T10:00:03Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成 Codex CLI 历史兼容性检查。' }] },
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(codexSessions, `rollout-2026-11-26T10-05-00-${codexDesktopId}.jsonl`),
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-11-26T10:05:00Z',
        payload: { id: codexDesktopId, cwd: 'D:\\Fixtures\\repo-codex-desktop', originator: 'Codex Desktop', source: 'vscode', cli_version: '0.171.0-alpha.13' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-26T10:05:01Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '桌面端第一轮提问' }] },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-26T10:05:04Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '桌面端第一轮回复' }] },
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  const zstContent = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-11-25T08:00:00Z',
      payload: { id: codexZstId, cwd: 'D:\\Fixtures\\repo-archived', originator: 'Codex Desktop', source: 'vscode', cli_version: '0.163.0-alpha.10.2' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-11-25T08:00:01Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '压缩归档问题' }] },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-11-25T08:00:05Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '压缩归档回答' }] },
    }),
  ].join('\n') + '\n';
  fs.writeFileSync(
    path.join(codexArchived, `rollout-2026-11-25T08-00-00-${codexZstId}.jsonl.zst`),
    zstdCompressSync(Buffer.from(zstContent, 'utf8')),
  );

  fs.writeFileSync(
    path.join(codexSessions, `rollout-2026-11-26T09-50-00-${codexPartialId}.jsonl`),
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-11-26T09:50:00Z',
        payload: { id: codexPartialId, cwd: 'D:\\Fixtures\\repo-partial', originator: 'codex_exec', source: 'exec', cli_version: '0.147.0' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-26T09:50:01Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '部分损坏尾行测试' }] },
      }),
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"truncated',
    ].join('\n'),
    'utf8',
  );

  // Independent Codex account B with colliding nativeSessionId = codexCliId
  const codexAccountB = path.join(baseDir, 'codex-account-b');
  const codexBSessions = path.join(codexAccountB, 'sessions', '2026', '11', '26');
  fs.mkdirSync(codexBSessions, { recursive: true });
  fs.writeFileSync(
    path.join(codexBSessions, `rollout-2026-11-26T11-00-00-${codexCliId}.jsonl`),
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-11-26T11:00:00Z',
        payload: { id: codexCliId, cwd: 'D:\\Fixtures\\repo-account-b', originator: 'codex_cli_rs', source: 'cli', cli_version: '0.147.0' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-26T11:00:01Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '独立账户 B 同名 ID 记录' }] },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-26T11:00:02Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '来自账户 B 的独立内容' }] },
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  // Claude CLI home
  const claudeHome = path.join(baseDir, 'claude-home');
  const claudeProj = path.join(claudeHome, 'projects', 'demo-proj');
  fs.mkdirSync(claudeProj, { recursive: true });
  const claudeId = '44444444-4444-4444-8444-444444444444';
  fs.writeFileSync(
    path.join(claudeHome, 'history.jsonl'),
    JSON.stringify({ sessionId: claudeId, display: 'Claude Code 样本会话', project: 'D:\\Fixtures\\repo-claude' }) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(claudeProj, `${claudeId}.jsonl`),
    [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({ type: 'user', version: '2.1.197', cwd: 'D:\\Fixtures\\repo-claude', timestamp: '2026-11-26T10:10:00Z', message: { role: 'user', content: 'Claude 你好' } }),
      JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-11-26T10:10:01Z', message: { role: 'user', content: 'ignored meta' } }),
      JSON.stringify({ type: 'assistant', version: '2.1.197', timestamp: '2026-11-26T10:10:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude 历史回复内容' }] } }),
    ].join('\n') + '\n',
    'utf8',
  );

  // AGY CLI & AGY Desktop SQLite roots
  const agyCliRoot = path.join(baseDir, 'agy-cli-root');
  const agyDesktopRoot = path.join(baseDir, 'agy-desktop-root');
  const agyCliId = '55555555-5555-4555-8555-555555555555';
  const agyCliNoFtsId = '66666666-6666-4666-8666-666666666666';
  const agyDesktopId = '77777777-7777-4777-8777-777777777777';
  const agyDesktopNoFtsId = '88888888-8888-4888-8888-888888888888';

  seedAgyRoot(agyCliRoot, {
    indexed: {
      id: agyCliId,
      title: 'AGY CLI 已索引会话',
      cwd: 'D:\\Fixtures\\repo-agy-cli',
      modified: '2026-11-26T10:15:00Z',
      userTexts: ['AGY CLI 问题'],
      agentTexts: ['AGY CLI 回答'],
    },
    unindexed: {
      id: agyCliNoFtsId,
      title: 'AGY CLI 仅有摘要无正文会话',
      cwd: 'D:\\Fixtures\\repo-agy-cli',
      modified: '2026-11-26T10:14:00Z',
    },
  });

  seedAgyRoot(agyDesktopRoot, {
    indexed: {
      id: agyDesktopId,
      title: 'AGY Desktop 已索引会话',
      cwd: 'D:\\Fixtures\\repo-agy-desktop',
      modified: '2026-11-26T10:20:00Z',
      userTexts: ['AGY Desktop 问题'],
      agentTexts: ['AGY Desktop 回答'],
    },
    unindexed: {
      id: agyDesktopNoFtsId,
      title: 'AGY Desktop 仅有 .pb 无 FTS 正文会话',
      cwd: 'D:\\Fixtures\\repo-agy-desktop',
      modified: '2026-11-26T10:19:00Z',
    },
  });

  // Corrupt AGY root (for single-source failure isolation test)
  const agyCorruptRoot = path.join(baseDir, 'agy-corrupt-root');
  fs.mkdirSync(agyCorruptRoot, { recursive: true });
  fs.writeFileSync(path.join(agyCorruptRoot, 'conversation_summaries.db'), 'not-a-sqlite-file', 'utf8');

  return {
    codexHome,
    codexAccountB,
    claudeHome,
    agyCliRoot,
    agyDesktopRoot,
    agyCorruptRoot,
    ids: {
      codexCliId,
      codexDesktopId,
      codexZstId,
      codexPartialId,
      claudeId,
      agyCliId,
      agyCliNoFtsId,
      agyDesktopId,
      agyDesktopNoFtsId,
    },
  };
}

function seedAgyRoot(rootDir, { indexed, unindexed }) {
  fs.mkdirSync(path.join(rootDir, 'conversations'), { recursive: true });
  const dbPath = path.join(rootDir, 'conversation_summaries.db');
  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        last_modified_time TEXT
      );
      CREATE TABLE conversations_fts (
        conversation_id TEXT,
        chunk_index INTEGER,
        user_body TEXT,
        agent_body TEXT,
        user_step_byte_offsets BLOB,
        agent_step_byte_offsets BLOB
      );
    `);

    const insertSummary = db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?)',
    );
    insertSummary.run(indexed.id, indexed.title, JSON.stringify([pathToFileURL(indexed.cwd).href]), indexed.modified);
    insertSummary.run(unindexed.id, unindexed.title, JSON.stringify([pathToFileURL(unindexed.cwd).href]), unindexed.modified);

    const buildBodyAndOffsets = (texts, startStep) => {
      let buf = Buffer.alloc(0);
      const offsets = [];
      let step = startStep;
      for (const text of texts) {
        const piece = Buffer.from(text, 'utf8');
        offsets.push([step, buf.length]);
        buf = Buffer.concat([buf, piece]);
        step += 2;
      }
      return { body: buf.toString('utf8'), offsets: JSON.stringify(offsets) };
    };
    const u = buildBodyAndOffsets(indexed.userTexts, 0);
    const a = buildBodyAndOffsets(indexed.agentTexts, 1);
    db.prepare(
      `INSERT INTO conversations_fts
       (conversation_id, chunk_index, user_body, agent_body, user_step_byte_offsets, agent_step_byte_offsets)
       VALUES (?, 0, ?, ?, ?, ?)`,
    ).run(indexed.id, u.body, a.body, u.offsets, a.offsets);
  } finally {
    db.close();
  }

  // Create dummy .pb placeholders for both (unindexed has .pb without FTS)
  fs.writeFileSync(path.join(rootDir, 'conversations', `${indexed.id}.pb`), Buffer.from([0x0a, 0x04, 0x74, 0x65, 0x73, 0x74]));
  fs.writeFileSync(path.join(rootDir, 'conversations', `${unindexed.id}.pb`), Buffer.from([0x0a, 0x04, 0x74, 0x65, 0x73, 0x74]));
}
