import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildServer();

app
  .listen({ port, host })
  .then(() => {
    app.log.info(`agentpay api listening on ${host}:${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
