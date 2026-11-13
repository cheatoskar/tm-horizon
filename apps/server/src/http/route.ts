// Route helper: zod validation for params, query and body, the auth rule, and a registry the
// OpenAPI document is generated from (GET /v1/openapi.json).
import { z, type ZodType } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UsersTable } from '../db/db.ts';
import { HttpError, forbidden } from '../util.ts';

export interface Auth {
  user: UsersTable | null;
  admin: boolean;
  via: 'session' | 'token' | null;
  csrf: string | null;
  token: { id: string; scopes: string[]; projects: string[] | null } | null;
}

declare module 'fastify' {
  interface FastifyRequest { auth: Auth }
}

/** none: public. user: logged in (session or token with the scope). admin: admin role. */
export type AuthRule = 'none' | 'user' | 'admin';

export interface RouteDef<P extends ZodType, Q extends ZodType, B extends ZodType> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  summary: string;
  tags: string[];
  auth: AuthRule;
  /** Token scope(s) accepted when called with an API token (any one is enough); routes without one are session-only. */
  scope?: string | string[];
  params?: P;
  query?: Q;
  body?: B;
  /** multipart/form-data upload (body parsed by the handler). */
  multipart?: boolean;
  response?: string;
  rateLimit?: { max: number; timeWindow: string };
}

export const registry: RouteDef<ZodType, ZodType, ZodType>[] = [];

const scopesOf = (d: { scope?: string | string[] }): string[] => (Array.isArray(d.scope) ? d.scope : d.scope ? [d.scope] : []);

type Infer<T> = T extends ZodType ? z.infer<T> : undefined;

export function route<P extends ZodType = ZodType, Q extends ZodType = ZodType, B extends ZodType = ZodType>(
  app: FastifyInstance,
  def: RouteDef<P, Q, B>,
  handler: (req: FastifyRequest, ctx: { params: Infer<P>; query: Infer<Q>; body: Infer<B>; reply: FastifyReply }) => Promise<unknown>,
) {
  registry.push(def as unknown as RouteDef<ZodType, ZodType, ZodType>);
  app.route({
    method: def.method,
    url: def.url,
    config: def.rateLimit ? { rateLimit: def.rateLimit } : {},
    handler: async (req, reply) => {
      const a = req.auth;
      if (def.auth !== 'none') {
        if (!a.user) throw new HttpError(401, 'unauthorized', 'Log in first');
        if (a.user.suspended_at) throw new HttpError(403, 'suspended', 'This account is suspended');
        if (a.via === 'token' && !scopesOf(def).some((sc) => a.token!.scopes.includes(sc))) throw forbidden('This API token cannot do this');
        if (def.auth === 'admin' && !a.admin) throw forbidden('Admins only');
      }
      const parse = <T extends ZodType>(schema: T | undefined, v: unknown, where: string) => {
        if (!schema) return undefined;
        const r = schema.safeParse(v);
        if (!r.success) throw new HttpError(400, 'invalid_' + where, r.error.issues.map((i) => `${i.path.join('.') || where}: ${i.message}`).join('; '), r.error.issues);
        return r.data;
      };
      const params = parse(def.params, req.params, 'params') as Infer<P>;
      const query = parse(def.query, req.query, 'query') as Infer<Q>;
      const body = def.multipart ? (undefined as Infer<B>) : (parse(def.body, req.body ?? {}, 'body') as Infer<B>);
      const out = await handler(req, { params, query, body, reply });
      if (out === undefined) return reply.sent ? undefined : reply.code(204).send();
      return out;
    },
  });
}

/** OpenAPI 3.1 from the registry. */
export function openapi(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  const toJson = (s: ZodType) => { try { return z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }); } catch { return {}; } };
  for (const r of registry) {
    const p = r.url.replace(/:(\w+)/g, '{$1}');
    const params: unknown[] = [];
    const add = (schema: ZodType | undefined, where: 'path' | 'query') => {
      const js = schema ? (toJson(schema) as { properties?: Record<string, unknown>; required?: string[] }) : null;
      for (const [name, sch] of Object.entries(js?.properties ?? {})) params.push({ name, in: where, required: where === 'path' || !!js?.required?.includes(name), schema: sch });
    };
    add(r.params, 'path');
    add(r.query, 'query');
    paths[p] ??= {};
    paths[p][r.method.toLowerCase()] = {
      summary: r.summary, tags: r.tags,
      security: r.auth === 'none' ? [] : r.scope ? [{ session: [] }, { token: scopesOf(r) }] : [{ session: [] }],
      parameters: params,
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: toJson(r.body) } } } } : {}),
      ...(r.multipart ? { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, meta: { type: 'string', description: 'JSON of the other fields' } } } } } } } : {}),
      responses: { '200': { description: r.response ?? 'OK' }, '4XX': { description: 'ApiError {error, message, details?}' } },
      ...(r.auth === 'admin' ? { 'x-admin': true } : {}),
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'TM Horizon Hub API', version: '1', description: 'Read API (projects, versions, search, signed index, downloads) and write API for the portal and API tokens. Session requests that change data need the X-CSRF-Token header from GET /v1/me.' },
    servers: [{ url: baseUrl.replace(/\/$/, '') }],
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'tmhub_session' },
        token: { type: 'http', scheme: 'bearer', description: 'API token (tmh_...) with scopes, created in the portal' },
      },
    },
    paths,
  };
}
