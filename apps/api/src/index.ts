import { PrismaClient } from "@prisma/client";
import { EMPTY_DIRECTORY } from "@waysafe/core";
import { buildServer, type ServerRepos } from "./server.js";
import { PrismaAgentKeyRepository } from "./agent-keys/prisma-repository.js";
import { PrismaAuthorizationRepository } from "./authorization/prisma-repository.js";
import { PrismaEvidenceRepository } from "./evidence/prisma-repository.js";
import { loadOrGenerateEvidenceSigningKey } from "./evidence/signing-key.js";
import { PrismaPrincipalRepository } from "./principals/prisma-repository.js";
import { PrismaInstrumentRepository } from "./instruments/prisma-repository.js";
import { PrismaWebauthnRepository } from "./webauthn/prisma-repository.js";
import { PrismaProviderEventRepository } from "./webhooks/prisma-repository.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

/**
 * Real persistence when DATABASE_URL is configured; otherwise the in-memory
 * fakes buildServer() defaults to. A developer running `npm run dev` with no
 * database gets a working (if non-persistent) server rather than a crash --
 * D-15/D-16's in-memory repositories exist for exactly this, not just tests.
 */
const repos: ServerRepos | undefined = process.env.DATABASE_URL
  ? (() => {
      const prisma = new PrismaClient();
      return {
        authorization: new PrismaAuthorizationRepository(prisma, EMPTY_DIRECTORY),
        agentKeys: new PrismaAgentKeyRepository(prisma),
        evidence: new PrismaEvidenceRepository(prisma, loadOrGenerateEvidenceSigningKey()),
        webauthn: new PrismaWebauthnRepository(prisma),
        providerEvents: new PrismaProviderEventRepository(prisma),
        principals: new PrismaPrincipalRepository(prisma),
        instruments: new PrismaInstrumentRepository(prisma),
      };
    })()
  : undefined;

const app = buildServer({
  repos,
  webauthnConfig: {
    rpId: process.env.WAYSAFE_RP_ID ?? "localhost",
    origin: process.env.WAYSAFE_RP_ORIGIN ?? "http://localhost:3000",
  },
});

if (!repos) {
  app.log.warn(
    "DATABASE_URL not set -- running on in-memory repositories. Nothing persists across restarts.",
  );
}

app
  .listen({ port, host })
  .then(() => {
    app.log.info(`waysafe api listening on ${host}:${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
