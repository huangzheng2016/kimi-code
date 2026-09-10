import { createReadStream, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import type { FastifyReply, FastifyRequest } from 'fastify';

const gzipBuffer = promisify(gzip);

const GZIP_MIN_BYTES = 1024;

const GZIP_COMPRESSIBLE_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.wasm',
]);

interface GzipCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly data: Buffer;
}

const gzipCache = new Map<string, GzipCacheEntry>();

interface WebAssetRouteHost {
  get(
    path: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ): unknown;
}

export async function registerWebAssetRoutes(
  app: WebAssetRouteHost,
  assetsDir: string,
): Promise<void> {
  await assertWebAssets(assetsDir);

  app.get('/', async (req, reply) => serveWebAsset(req, reply, assetsDir));
  app.get('/*', async (req, reply) => serveWebAsset(req, reply, assetsDir));
}

async function assertWebAssets(assetsDir: string): Promise<void> {
  try {
    const info = await stat(join(assetsDir, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Kimi web assets were not found at ${assetsDir}. Run the package build before starting the server.`,
    );
  }
}

async function serveWebAsset(
  req: FastifyRequest,
  reply: FastifyReply,
  assetsDir: string,
): Promise<unknown> {
  const requestUrl = new URL(req.url, 'http://kimi-web.local');
  if (isReservedPath(requestUrl.pathname)) {
    return reply.callNotFound();
  }

  const filePath = await resolveStaticFile(assetsDir, requestUrl.pathname);
  if (filePath === undefined) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }

  const fileInfo = await stat(filePath).catch(() => undefined);
  if (fileInfo === undefined || !fileInfo.isFile()) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }

  const compressible = isGzipCompressible(filePath, fileInfo.size);
  if (compressible && acceptsGzip(req)) {
    const compressed = await gzipAsset(filePath, fileInfo);
    return reply
      .type(mimeType(filePath))
      .header('Cache-Control', cacheControl(assetsDir, filePath))
      .header('Vary', 'Accept-Encoding')
      .header('Content-Encoding', 'gzip')
      .header('Content-Length', String(compressed.length))
      .send(compressed);
  }

  if (compressible) {
    reply.header('Vary', 'Accept-Encoding');
  }
  return reply
    .type(mimeType(filePath))
    .header('Cache-Control', cacheControl(assetsDir, filePath))
    .header('Content-Length', String(fileInfo.size))
    .send(createReadStream(filePath));
}

function isGzipCompressible(filePath: string, size: number): boolean {
  return size >= GZIP_MIN_BYTES && GZIP_COMPRESSIBLE_EXTENSIONS.has(extname(filePath));
}

function acceptsGzip(req: FastifyRequest): boolean {
  const header = req.headers['accept-encoding'];
  if (header === undefined) {
    return false;
  }
  return header
    .split(',')
    .some((value) => value.trim().toLowerCase().startsWith('gzip'));
}

async function gzipAsset(filePath: string, fileInfo: Stats): Promise<Buffer> {
  const cached = gzipCache.get(filePath);
  if (cached !== undefined && cached.mtimeMs === fileInfo.mtimeMs && cached.size === fileInfo.size) {
    return cached.data;
  }
  const data = await gzipBuffer(await readFile(filePath));
  gzipCache.set(filePath, { mtimeMs: fileInfo.mtimeMs, size: fileInfo.size, data });
  return data;
}

function cacheControl(assetsDir: string, filePath: string): string {
  const assetPath = relative(assetsDir, filePath);
  const fileName = filePath.slice(filePath.lastIndexOf(sep) + 1);
  if (assetPath.startsWith(`assets${sep}`) && /[-.][A-Za-z0-9_-]{8}\.[^.]+$/.test(fileName)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

async function resolveStaticFile(
  assetsDir: string,
  pathname: string,
): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  const normalized = normalize(decoded).replace(/^(\.\.(?:[/\\]|$))+/, '');
  const relative = normalized === sep ? 'index.html' : normalized.replace(/^[/\\]/, '');
  const root = resolve(assetsDir);
  const candidate = resolve(
    root,
    relative.endsWith(sep) ? join(relative, 'index.html') : relative,
  );
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return undefined;
  }

  const info = await stat(candidate).catch(() => undefined);
  if (info?.isFile() === true) {
    return candidate;
  }
  if (extname(pathname) !== '') {
    return undefined;
  }
  return join(root, 'index.html');
}

function isReservedPath(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/documentation' ||
    pathname.startsWith('/documentation/')
  );
}

function mimeType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
