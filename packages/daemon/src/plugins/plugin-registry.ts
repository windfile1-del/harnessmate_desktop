import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { PLUGIN_API_VERSION, PluginApiError } from '@harnessmate/plugin-api';
import {
  RemotePluginIndexSchema,
  TrustedPublisherSchema,
  type PluginRegistryStateDto,
  type RemotePluginEntry,
  type TrustedPublisher,
} from '@harnessmate/protocol';
import { packageFromFilesRecord, type PluginPackage } from './plugin-package.js';

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export type SignatureVerificationStatus = 'verified' | 'untrusted_publisher' | 'invalid' | 'unsigned';

export interface ReleaseSigningInput {
  id: string;
  version: string;
  packageDigest: string;
  pluginApi: string;
}

export interface EvaluatedRemotePluginEntry {
  entry: RemotePluginEntry;
  registryUrl: string;
  publisherName: string;
  signatureStatus: SignatureVerificationStatus;
  compatible: boolean;
  incompatibleReason: string | null;
}

interface PersistedRegistryConfig {
  indexUrls: string[];
  requireSigned: boolean;
  trustedPublishers: TrustedPublisher[];
}

export function generatePublisherKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: String(publicKey), privateKeyPem: String(privateKey) };
}

export function canonicalReleaseSigningPayload(release: ReleaseSigningInput): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 'harnessmate-plugin-release-v1',
      id: release.id,
      version: release.version,
      packageDigest: release.packageDigest,
      pluginApi: release.pluginApi,
    }),
    'utf8',
  );
}

export function signPluginRelease(privateKeyPem: string, release: ReleaseSigningInput): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, canonicalReleaseSigningPayload(release), key);
  return sig.toString('base64');
}

export function verifyPluginSignature(
  publicKeyPem: string,
  release: ReleaseSigningInput,
  signatureBase64: string,
): boolean {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    const sig = Buffer.from(signatureBase64, 'base64');
    if (sig.length === 0) return false;
    return crypto.verify(null, canonicalReleaseSigningPayload(release), key, sig);
  } catch {
    return false;
  }
}

export function validatePublicKeyPem(publicKeyPem: string): void {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('仅支持 Ed25519 公钥');
    }
  } catch (error) {
    throw new PluginApiError(
      'E_INVALID_INPUT',
      `发布者公钥格式无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function fetchIndexText(sourceUrl: string): Promise<string> {
  if (sourceUrl.startsWith('file://')) {
    const filePath = fileURLToPath(sourceUrl);
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_INDEX_BYTES) throw new PluginApiError('E_LIMIT_EXCEEDED', '索引文件超过 4 MiB');
    return fs.readFileSync(filePath, 'utf8');
  }
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PluginApiError('E_INVALID_INPUT', `不支持的索引协议: ${parsed.protocol}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_INDEX_BYTES) {
      throw new PluginApiError('E_LIMIT_EXCEEDED', '远程索引超过 4 MiB 限制');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export class PluginRegistryService {
  private readonly configPath: string;
  private config: PersistedRegistryConfig;
  private cachedEntries: EvaluatedRemotePluginEntry[] = [];
  private lastSyncedAt: number | null = null;
  private errors: Array<{ url: string; error: string }> = [];

  constructor(dataDir: string) {
    this.configPath = path.join(dataDir, 'plugin-registry.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): PersistedRegistryConfig {
    const defaults: PersistedRegistryConfig = {
      indexUrls: [],
      requireSigned: true,
      trustedPublishers: [],
    };
    if (!fs.existsSync(this.configPath)) return defaults;
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as Partial<PersistedRegistryConfig>;
      const trustedPublishers = Array.isArray(raw.trustedPublishers)
        ? raw.trustedPublishers
            .map((p) => TrustedPublisherSchema.safeParse(p))
            .filter((r): r is { success: true; data: TrustedPublisher } => r.success)
            .map((r) => r.data)
        : [];
      return {
        indexUrls: Array.isArray(raw.indexUrls) ? raw.indexUrls.filter((u): u is string => typeof u === 'string' && u.length > 0) : [],
        requireSigned: typeof raw.requireSigned === 'boolean' ? raw.requireSigned : true,
        trustedPublishers,
      };
    } catch {
      return defaults;
    }
  }

  private saveConfig(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf8');
    fs.renameSync(tmp, this.configPath);
  }

  getState(): PluginRegistryStateDto {
    return {
      indexUrls: [...this.config.indexUrls],
      requireSigned: this.config.requireSigned,
      trustedPublishers: this.config.trustedPublishers.map((p) => ({ ...p })),
      lastSyncedAt: this.lastSyncedAt,
      errors: [...this.errors],
    };
  }

  updateConfig(input: { indexUrls: string[]; requireSigned?: boolean }): PluginRegistryStateDto {
    for (const url of input.indexUrls) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new PluginApiError('E_INVALID_INPUT', `无效的索引地址: ${url}`);
      }
      if (!['https:', 'http:', 'file:'].includes(parsed.protocol)) {
        throw new PluginApiError('E_INVALID_INPUT', `索引地址仅支持 https/http/file 协议: ${url}`);
      }
    }
    this.config = {
      ...this.config,
      indexUrls: [...new Set(input.indexUrls)],
      ...(input.requireSigned !== undefined ? { requireSigned: input.requireSigned } : {}),
    };
    this.saveConfig();
    return this.getState();
  }

  addTrustedPublisher(publisher: Omit<TrustedPublisher, 'addedAt'>): PluginRegistryStateDto {
    validatePublicKeyPem(publisher.publicKeyPem);
    const next: TrustedPublisher = { ...publisher, addedAt: Date.now() };
    const filtered = this.config.trustedPublishers.filter((p) => p.id !== publisher.id);
    this.config = { ...this.config, trustedPublishers: [...filtered, next] };
    this.saveConfig();
    this.reEvaluateCachedEntries();
    return this.getState();
  }

  removeTrustedPublisher(publisherId: string): PluginRegistryStateDto {
    this.config = {
      ...this.config,
      trustedPublishers: this.config.trustedPublishers.filter((p) => p.id !== publisherId),
    };
    this.saveConfig();
    this.reEvaluateCachedEntries();
    return this.getState();
  }

  private evaluateEntry(
    entry: RemotePluginEntry,
    registryUrl: string,
    indexPublishers: ReadonlyMap<string, TrustedPublisher>,
  ): EvaluatedRemotePluginEntry {
    const trustedMap = new Map(this.config.trustedPublishers.map((p) => [p.id, p]));
    const trustedPub = trustedMap.get(entry.publisherId);
    const indexPub = indexPublishers.get(entry.publisherId);
    const publisherName = trustedPub?.name ?? indexPub?.name ?? entry.publisherId;

    const range = entry.engines.pluginApi;
    let compatible = false;
    let incompatibleReason: string | null = null;
    if (!semver.validRange(range)) {
      incompatibleReason = `无效的 API 版本范围 ${range}`;
    } else if (!semver.satisfies(PLUGIN_API_VERSION, range)) {
      incompatibleReason = `需要插件 API ${range}，当前宿主为 ${PLUGIN_API_VERSION}`;
    } else {
      compatible = true;
    }

    const releasePayload: ReleaseSigningInput = {
      id: entry.id,
      version: entry.version,
      packageDigest: entry.packageDigest,
      pluginApi: entry.engines.pluginApi,
    };

    let signatureStatus: SignatureVerificationStatus = 'unsigned';
    if (entry.signature) {
      if (trustedPub) {
        signatureStatus = verifyPluginSignature(trustedPub.publicKeyPem, releasePayload, entry.signature)
          ? 'verified'
          : 'invalid';
      } else if (indexPub) {
        signatureStatus = verifyPluginSignature(indexPub.publicKeyPem, releasePayload, entry.signature)
          ? 'untrusted_publisher'
          : 'invalid';
      } else {
        signatureStatus = 'untrusted_publisher';
      }
    }

    return {
      entry,
      registryUrl,
      publisherName,
      signatureStatus,
      compatible,
      incompatibleReason,
    };
  }

  private reEvaluateCachedEntries(): void {
    const emptyMap = new Map<string, TrustedPublisher>();
    this.cachedEntries = this.cachedEntries.map((item) =>
      this.evaluateEntry(item.entry, item.registryUrl, emptyMap),
    );
  }

  async refresh(): Promise<{ entries: EvaluatedRemotePluginEntry[]; state: PluginRegistryStateDto }> {
    const nextEntries: EvaluatedRemotePluginEntry[] = [];
    const nextErrors: Array<{ url: string; error: string }> = [];

    for (const url of this.config.indexUrls) {
      try {
        const text = await fetchIndexText(url);
        const parsed = RemotePluginIndexSchema.parse(JSON.parse(text));
        const indexPublishers = new Map(parsed.publishers.map((p) => [p.id, p]));
        for (const entry of parsed.entries) {
          nextEntries.push(this.evaluateEntry(entry, url, indexPublishers));
        }
      } catch (error) {
        nextErrors.push({
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.cachedEntries = nextEntries;
    this.errors = nextErrors;
    this.lastSyncedAt = Date.now();
    return { entries: this.listEntries(), state: this.getState() };
  }

  listEntries(): EvaluatedRemotePluginEntry[] {
    return [...this.cachedEntries];
  }

  findEntry(pluginId: string, version?: string): EvaluatedRemotePluginEntry | undefined {
    const matching = this.cachedEntries.filter(({ entry }) => entry.id === pluginId && (!version || entry.version === version));
    return matching[0];
  }

  async resolveRemotePackage(
    pluginId: string,
    version?: string,
    options?: { allowUntrusted?: boolean },
  ): Promise<{ pack: PluginPackage; evaluated: EvaluatedRemotePluginEntry }> {
    let found = this.findEntry(pluginId, version);
    if (!found && this.config.indexUrls.length > 0 && this.lastSyncedAt === null) {
      await this.refresh();
      found = this.findEntry(pluginId, version);
    }
    if (!found) {
      throw new PluginApiError('E_INVALID_INPUT', `在远程插件索引中找不到插件 ${pluginId}${version ? `@${version}` : ''}`);
    }
    if (!found.compatible) {
      throw new PluginApiError('E_NOT_SUPPORTED', found.incompatibleReason ?? `插件 ${pluginId} 与当前宿主 API 不兼容`);
    }
    if (found.signatureStatus === 'invalid') {
      throw new PluginApiError('E_PERMISSION_DENIED', `插件 ${pluginId} 发布者签名校验失败，拒绝安装`);
    }
    if (this.config.requireSigned && !options?.allowUntrusted && found.signatureStatus !== 'verified') {
      const reason = found.signatureStatus === 'unsigned'
        ? '该插件未包含发布者签名'
        : `发布者 ${found.publisherName} (${found.entry.publisherId}) 尚未加入信任列表`;
      throw new PluginApiError('E_PERMISSION_DENIED', `${reason}，已拦截安装`);
    }

    let filesRecord: Record<string, string> | undefined = found.entry.files;
    if (!filesRecord && found.entry.downloadUrl) {
      const text = await fetchIndexText(found.entry.downloadUrl);
      const parsed = JSON.parse(text) as { files?: Record<string, string> };
      if (!parsed.files || typeof parsed.files !== 'object') {
        throw new PluginApiError('E_INVALID_INPUT', '远程插件包缺少 files 字段');
      }
      filesRecord = parsed.files;
    }
    if (!filesRecord) {
      throw new PluginApiError('E_INVALID_INPUT', `远程索引条目 ${pluginId} 缺少包内容或下载地址`);
    }

    const pack = packageFromFilesRecord(filesRecord);
    if (pack.manifest.id !== found.entry.id || pack.manifest.version !== found.entry.version) {
      throw new PluginApiError('E_CONFLICT', '远程插件包内的清单 ID/版本与索引声明不一致');
    }
    if (pack.digest !== found.entry.packageDigest) {
      throw new PluginApiError('E_PERMISSION_DENIED', '远程插件包摘要与签名摘要不匹配，可能已被篡改');
    }

    return { pack, evaluated: found };
  }
}
