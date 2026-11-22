import { createDaemon } from './server/app.js';

async function main(): Promise<void> {
  const daemon = createDaemon();
  const { host, port } = await daemon.start();

  console.log(
    JSON.stringify({
      event: 'daemon.ready',
      desktopId: daemon.config.desktopId,
      desktopName: daemon.config.desktopName,
      host,
      port,
      lanEnabled: daemon.config.lanEnabled,
      dataDir: daemon.paths.dataDir,
    }),
  );

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err) => {
  console.error('Fatal daemon error:', err);
  process.exit(1);
});
