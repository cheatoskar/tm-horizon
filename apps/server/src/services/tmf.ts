// GET /tmf/servers: the TrackMania Nations/United Forever server list from the master server.
// Off unless TMF_ENABLED=1 and TMF_LIVE=1 (then the route answers 503 {"error":"tmf-disabled"}).
// Clients only ever read the service's cache: the service itself polls the master server (one bot
// session per game, every TMF_POLL_SECONDS, at most TMF_MAX_REQ_PER_MIN requests per minute in
// total), so the number of launchers never changes the request rate towards the master server.
import type { FastifyInstance } from 'fastify';
import type { TmfServersResponse } from '@tm-hub/shared';
import type { Config } from '../config.ts';

/** What the route needs from the service (tests pass a stub). */
export interface TmfSource {
  get(game: 'tmnf' | 'tmuf'): TmfServersResponse;
}

/** The real service when both switches are on (started), otherwise null. */
/** The master-server bot is not part of the public code: the route always answers "tmf-disabled". */
export function createTmfService(_cfg: Config, _env: Record<string, string | undefined> = process.env): (TmfSource & { stop(): Promise<void> }) | null {
  return null;
}

export function tmfRoutes(app: FastifyInstance, tmf: TmfSource | null) {
  app.get('/tmf/servers', async (req, reply) => {
    reply.header('cache-control', 'public, max-age=30');
    if (!tmf) return reply.code(503).send({ error: 'tmf-disabled', message: 'The TMNF/TMUF server list is switched off on this hub' });
    const game = (req.query as { game?: string }).game;
    if (game !== 'tmnf' && game !== 'tmuf') return reply.code(400).send({ error: 'invalid', message: 'game must be tmnf or tmuf' });
    const res = tmf.get(game);
    if (res.status === 'disabled') return reply.code(503).send({ error: 'tmf-disabled', message: res.error ?? 'The TMNF/TMUF server list is switched off on this hub' });
    return res;
  });
}
