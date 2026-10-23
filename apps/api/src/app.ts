import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { Db } from './db.ts';
import { AppError, toAppError } from './errors.ts';
import { installAccessControl } from './http.ts';
import type { InfraClient } from './infra-client.ts';
import { customerRoutes } from './routes/customers.ts';
import { serverRoutes } from './routes/servers.ts';
import { adminRoutes } from './routes/admin.ts';

export type AppOptions = { db: Db; infra: InfraClient; infraUrl?: string; webDist?: string; logger?: boolean };

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const { db, infra } = options;

  app.setErrorHandler((err, req, reply) => {
    let appError: AppError;
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (!(err instanceof AppError) && statusCode && statusCode >= 400 && statusCode < 500) {
      // Fastify's own refusals (malformed JSON, wrong content type, body too large)
      appError = new AppError(statusCode, 'bad_request', err instanceof Error ? err.message : 'bad request');
    } else {
      appError = toAppError(err);
    }
    if (appError.status >= 500) req.log.error(err);
    reply.code(appError.status).send({ error: { code: appError.code, message: appError.message, details: appError.details } });
  });

  installAccessControl(app, db);
  customerRoutes(app, db);
  serverRoutes(app, db);
  adminRoutes(app, db, infra, options.infraUrl ?? '');

  app.all('/api/*', { config: { permission: 'public' } }, async () => {
    throw new AppError(404, 'not_found', 'no such endpoint');
  });

  if (options.webDist && existsSync(options.webDist)) {
    // files are looked up per request, so a rebuilt bundle is served without a restart
    await app.register(fastifyStatic, { root: options.webDist });
    // Single page app: page paths get index.html so deep links survive a reload. A missing
    // file (a path with an extension, e.g. an old bundle) stays a 404: answering it with
    // index.html would hand HTML to a <script> tag.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0]!;
      if (req.method === 'GET' && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path)) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'not_found', message: 'not found' } });
    });
  }
  return app;
}
