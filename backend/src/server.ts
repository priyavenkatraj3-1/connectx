import { createApp } from "./app";
import { env } from "./config/env";

const app = createApp();

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`ConnectX backend listening on port ${env.port} [${env.nodeEnv}]`);
});
