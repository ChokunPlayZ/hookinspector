import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  console.log(`Hook Inspector listening on http://${config.host}:${config.port}`);
  if (config.publicUrl) console.log(`Public endpoint: ${config.publicUrl}`);
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { app.server.closeAllConnections(); }, 10_000);
    deadline.unref();
    void app.close().then(() => process.exit(0), (error: unknown) => {
      console.error('Shutdown failed:', error);
      process.exit(1);
    });
  });
}
