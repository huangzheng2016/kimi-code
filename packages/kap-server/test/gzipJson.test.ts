import { gunzipSync } from 'node:zlib';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGzipJsonHook } from '../src/middleware/gzipJson';

describe('gzip JSON hook', () => {
  let app: FastifyInstance;
  const big = { data: 'x'.repeat(8192) };

  beforeEach(async () => {
    app = Fastify();
    app.addHook('onSend', createGzipJsonHook());
    app.get('/big', async () => big);
    app.get('/small', async () => ({ ok: true }));
    app.get('/stream', async (_req, reply) =>
      reply.type('application/json').header('content-encoding', 'identity').send('"preset"'),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('gzips a large JSON response when the client accepts it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/big',
      headers: { 'accept-encoding': 'br, gzip' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.headers['content-length']).toBe(String(response.rawPayload.length));
    expect(response.rawPayload.length).toBeLessThan(1024);
    expect(JSON.parse(gunzipSync(response.rawPayload).toString('utf8'))).toEqual(big);
  });

  it('serves identity when the client does not accept gzip', async () => {
    const response = await app.inject({ method: 'GET', url: '/big' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.json()).toEqual(big);
  });

  it('serves identity for small JSON responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/small',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.json()).toEqual({ ok: true });
  });

  it('does not touch responses that already carry a content encoding', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/stream',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('identity');
    expect(response.body).toBe('"preset"');
  });
});
