#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scaffoldPluginFiles } from '../packages/plugin-sdk/dist/index.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function hashDirectoryFiles(dirPath) {
  const files = new Map();
  const visit = (root, prefix) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && ['.harnessmate-active.json', '.revisions', '.git', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(root, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(full, rel);
      else if (entry.isFile()) files.set(rel, fs.readFileSync(full));
    }
  };
  visit(fs.realpathSync(dirPath), '');
  const hash = crypto.createHash('sha256');
  for (const [name, content] of files) {
    hash.update(JSON.stringify([name, content.length]));
    hash.update(content);
  }
  return { files, digest: hash.digest('hex') };
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'init';

if (command === 'keygen') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  console.log(JSON.stringify({ publicKeyPem: String(publicKey), privateKeyPem: String(privateKey) }, null, 2));
  process.exit(0);
}

if (command === 'sign') {
  const dir = args.dir;
  const keyPath = args.key;
  const publisherId = args.publisher;
  if (!dir || !keyPath || !publisherId) {
    console.error('用法: pnpm create:plugin sign --dir <插件目录> --key <私钥PEM路径> --publisher <发布者ID>');
    process.exit(1);
  }
  const { files, digest } = hashDirectoryFiles(dir);
  const manifestBuf = files.get('harnessmate-plugin.json');
  if (!manifestBuf) throw new Error('插件目录缺少 harnessmate-plugin.json');
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  const pluginApi = manifest.engines?.pluginApi ?? '^4.0';
  const payload = Buffer.from(
    JSON.stringify({
      format: 'harnessmate-plugin-release-v1',
      id: manifest.id,
      version: manifest.version ?? '1.0.0',
      packageDigest: digest,
      pluginApi,
    }),
    'utf8',
  );
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  const signature = crypto.sign(null, payload, privateKey).toString('base64');
  const utf8Files = Object.fromEntries([...files.entries()].map(([k, v]) => [k, v.toString('utf8')]));
  console.log(
    JSON.stringify(
      {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version ?? '1.0.0',
        description: manifest.description,
        author: manifest.author,
        category: manifest.category ?? 'workflow',
        tags: [],
        engines: { pluginApi },
        publisherId,
        packageDigest: digest,
        signature,
        files: utf8Files,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const id = args.id;
const name = args.name;
const template = args.template ?? 'isolated';
const targetDir = args.dir ?? path.resolve(process.cwd(), String(id ?? 'my-plugin'));

if (!id || !name) {
  console.error(
    '用法:\n' +
      '  pnpm create:plugin --id user.my-plugin --name "我的插件" [--template isolated|ui-slot|service|declarative|browser-preview|browser-workspace|harness-adapter] [--dir ./out]\n' +
      '  pnpm create:plugin keygen\n' +
      '  pnpm create:plugin sign --dir ./out --key ./private.pem --publisher acme',
  );
  process.exit(1);
}

const { files } = scaffoldPluginFiles({
  id: String(id),
  name: String(name),
  description: typeof args.description === 'string' ? args.description : undefined,
  author: typeof args.author === 'string' ? args.author : undefined,
  template,
  serviceName: typeof args.service === 'string' ? args.service : undefined,
  driverId: typeof args.driverId === 'string' ? args.driverId : undefined,
  binaryName: typeof args.binary === 'string' ? args.binary : undefined,
});

fs.mkdirSync(targetDir, { recursive: true });
for (const [relPath, content] of Object.entries(files)) {
  const full = path.join(targetDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}
console.log(`已创建 HarnessMate V4 插件脚手架 (${template}): ${targetDir}`);
for (const rel of Object.keys(files)) {
  console.log(`  - ${rel}`);
}
