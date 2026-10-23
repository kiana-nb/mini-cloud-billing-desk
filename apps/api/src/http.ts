// HTTP plumbing: strict input parsing and role checks.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { AppError } from './errors.ts';
import { rolePermissions, staffForToken, type Permission, type Staff } from './auth.ts';
import type { Db } from './db.ts';

declare module 'fastify' {
  interface FastifyRequest {
    staff: Staff | null;
  }
  interface FastifyContextConfig {
    /** Every API route must declare what it needs; 'public' skips authentication. */
    permission?: Permission | 'public';
  }
}

/**
 * Parses input with a strict schema: unknown keys are an error, not silently dropped.
 * Query strings arrive as strings; schemas coerce them explicitly.
 */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown, where: 'query' | 'body' | 'params'): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) =>
    issue.code === 'unrecognized_keys'
      ? { param: issue.keys.join(', '), issue: 'unknown parameter' }
      : { param: issue.path.join('.') || '(root)', issue: issue.message },
  );
  throw new AppError(400, `invalid_${where}`, `invalid ${where}: ${details.map((d) => `${d.param} (${d.issue})`).join('; ')}`, details);
}

export const zs = {
  uuid: z.string().uuid(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** comma separated list of enum values, e.g. status=running,pending */
  csvEnum: <T extends [string, ...string[]]>(values: T) =>
    z
      .string()
      .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
      .pipe(z.array(z.enum(values)).min(1)),
  search: z.string().trim().max(100),
};

export function idempotencyKey(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw new AppError(400, 'idempotency_key_required', 'send an Idempotency-Key header (8-100 characters: letters, digits, - or _)');
  }
  return key;
}

export function staffOf(req: FastifyRequest): Staff {
  if (!req.staff) throw new AppError(401, 'unauthenticated', 'sign in first');
  return req.staff;
}

/** Installs authentication and refuses to register an /api route without a declared permission. */
export function installAccessControl(app: FastifyInstance, db: Db) {
  app.decorateRequest('staff', null);

  app.addHook('onRoute', (route: RouteOptions) => {
    if (!route.url.startsWith('/api/')) return;
    const permission = route.config?.permission;
    if (!permission) throw new Error(`route ${route.method} ${route.url} does not declare a permission`);
  });

  app.addHook('preHandler', async (req: FastifyRequest, _reply: FastifyReply) => {
    const permission = req.routeOptions.config?.permission;
    if (!req.url.startsWith('/api/') || permission === 'public' || permission === undefined) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const staff = token ? await staffForToken(db, token) : null;
    if (!staff) throw new AppError(401, 'unauthenticated', 'sign in first');
    if (!rolePermissions[staff.role].includes(permission)) {
      throw new AppError(403, 'forbidden', `the ${staff.role} role may not do this`);
    }
    req.staff = staff;
  });
}
