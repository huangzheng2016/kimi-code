import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerWebAssetRoutes } from '../src/routes/webAssets';

describe('web asset cache policy', () => {
  let app: FastifyInstance;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-'));
    await mkdir(join(assetsDir, 'assets'));
    await Promise.all([
      writeFile(join(assetsDir, 'index.html'), '<main>Kimi</main>'),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), 'export {};'),
      writeFile(join(assetsDir, 'assets', 'application-configuration.json'), '{}'),
      writeFile(join(assetsDir, 'favicon.svg'), '<svg></svg>'),
    ]);
    app = Fastify();
    await registerWebAssetRoutes(app, assetsDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('caches content-hashed assets as immutable', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-Dy7xs5tu.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it.each([
    '/index.html',
    '/sessions/active',
    '/favicon.svg',
    '/assets/application-configuration.json',
  ])(
    'requires revalidation for %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-cache');
    },
  );
});

describe('web asset gzip', () => {
  let app: FastifyInstance;
  let assetsDir: string;
  let bigJs: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'kimi-web-assets-gzip-'));
    await mkdir(join(assetsDir, 'assets'));
    bigJs = `export const payload = '${'x'.repeat(4096)}';`;
    await Promise.all([
      writeFile(join(assetsDir, 'index.html'), '<main>Kimi</main>'),
      writeFile(join(assetsDir, 'assets', 'index-Dy7xs5tu.js'), bigJs),
      writeFile(join(assetsDir, 'assets', 'tiny-A1b2c3d4.js'), 'export {};'),
      writeFile(join(assetsDir, 'assets', 'font-B2c3d4e5.woff2'), Buffer.alloc(4096, 7)),
    ]);
    app = Fastify();
    await registerWebAssetRoutes(app, assetsDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('serves gzip when the client accepts it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/assets/index-Dy7xs5tu.js',
      headers: { 'accept-encoding': 'br, gzip' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['content-length']).toBe(String(response.rawPayload.length));
    expect(gunzipSync(response.rawPayload).toString('utf8')).toBe(bigJs);
  });

  it('serves identity with Vary when the client does not accept gzip', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-Dy7xs5tu.js' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.body).toBe(bigJs);
  });

  it('serves identity for incompressible extensions', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/assets/font-B2c3d4e5.woff2',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
  });

  it('serves identity for files below the gzip threshold', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/assets/tiny-A1b2c3d4.js',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
  });
});
