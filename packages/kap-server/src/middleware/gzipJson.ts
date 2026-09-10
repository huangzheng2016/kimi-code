import { gzipSync } from 'node:zlib';

import type { FastifyReply, FastifyRequest } from 'fastify';

const GZIP_MIN_BYTES = 1024;

type OnSendNext = (err: Error | null, payload?: unknown) => void;

export function createGzipJsonHook() {
  return (req: FastifyRequest, reply: FastifyReply, payload: unknown, next: OnSendNext): void => {
    if (reply.hasHeader('content-encoding')) {
      next(null, payload);
      return;
    }
    const contentType = reply.getHeader('content-type');
    if (typeof contentType !== 'string' || !contentType.includes('application/json')) {
      next(null, payload);
      return;
    }
    const accept = req.headers['accept-encoding'];
    if (
      accept === undefined ||
      !accept
        .split(',')
        .some((value) => value.trim().toLowerCase().startsWith('gzip'))
    ) {
      next(null, payload);
      return;
    }
    let body: Buffer;
    if (typeof payload === 'string') {
      body = Buffer.from(payload);
    } else if (Buffer.isBuffer(payload)) {
      body = payload;
    } else {
      next(null, payload);
      return;
    }
    if (body.length < GZIP_MIN_BYTES) {
      next(null, payload);
      return;
    }
    const compressed = gzipSync(body);
    reply.header('Content-Encoding', 'gzip');
    reply.header('Vary', 'Accept-Encoding');
    reply.removeHeader('content-length');
    next(null, compressed);
  };
}
