#!/usr/bin/env node
// Entry point. `npm start`
import { loadConfig } from "./http/config.js";
import { buildServer } from "./http/server.js";

const config = loadConfig();
let app;
try {
  app = await buildServer(config);
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`GatePass on ${config.baseUrl}`);
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

// Render sends SIGTERM on deploy. Finish in-flight requests rather than
// dropping a guest's upload mid-flight.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, closing`);
    try { await app.close(); } catch { /* shutting down anyway */ }
    process.exit(0);
  });
}
