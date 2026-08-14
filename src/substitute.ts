/**
 * Support for `page.substitute`: URL wildcard matching for the CDP Fetch
 * interception in page.ts, and serving local replacement files as intercepted
 * responses.
 *
 * Local files are answered with Fetch.fulfillRequest — bytes read from disk and
 * handed to Chrome at the interception layer, which is what DevTools "local
 * overrides" does. The obvious alternatives both fail: file:// can't be fetched
 * from an http(s) page, and rewriting the request to a loopback HTTP server is
 * refused by Chrome as a secure→insecure downgrade (net::ERR_BLOCKED_BY_CLIENT)
 * whenever the page is https. Fulfilling means implementing HTTP Range
 * semantics ourselves — <video> seeks by issuing Range requests and expects
 * 206s — which is what most of this file is.
 */

import { promises as fsp, statSync } from 'node:fs';
import { extname } from 'node:path';

export const isUrl = (to: string): boolean => /^https?:\/\//.test(to);

/**
 * Compile a CDP-style URL wildcard (`*` = any run of characters, `?` = any one)
 * to a RegExp over the full URL — the same pattern string is handed verbatim to
 * Fetch.enable, so the two sides agree on what matches.
 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Compile a rule's page scope (`on`): a wildcard over the top document's
 * pathname when it starts with `/` (or `*`), or over the full document URL
 * when the pattern carries a scheme. Returns a predicate over the document
 * URL the request was made from.
 */
export function compileScope(on: string): (docUrl: string) => boolean {
  const re = wildcardToRegExp(on);
  if (/:\/\//.test(on)) return (docUrl) => re.test(docUrl);
  return (docUrl) => {
    try {
      return re.test(new URL(docUrl).pathname);
    } catch {
      return false;
    }
  };
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/**
 * `bytes=a-b` / `a-` / `-n`. Multi-range requests are answered with the whole
 * file (a valid response no client actually provokes for media).
 */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'unsatisfiable' {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Math.min(Number(m[2]), size);
    return suffix === 0 ? 'unsatisfiable' : [size - suffix, size - 1];
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return end < start ? 'unsatisfiable' : [start, end];
}

/** The shape Fetch.fulfillRequest takes (minus requestId). */
export type Fulfillment = {
  responseCode: number;
  responseHeaders: Array<{ name: string; value: string }>;
  body: string;
};

/**
 * Build the intercepted response for a local file: the requested byte range
 * read from disk, base64 for the CDP boundary. An open-ended `bytes=0-` (the
 * first request a <video> makes) buffers the whole file — fine for the asset
 * sizes this is for, worth knowing for anything enormous.
 */
export async function fulfillFromFile(path: string, rangeHeader: string | undefined, cacheable = true): Promise<Fulfillment> {
  const size = statSync(path).size;
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return {
      responseCode: 416,
      responseHeaders: [{ name: 'Content-Range', value: `bytes */${size}` }],
      body: '',
    };
  }
  const [start, end] = range ?? [0, size - 1];
  const length = size === 0 ? 0 : end - start + 1;
  const buf = Buffer.alloc(length);
  if (length > 0) {
    const fh = await fsp.open(path, 'r');
    try {
      await fh.read(buf, 0, length, start);
    } finally {
      await fh.close();
    }
  }
  const headers = [
    { name: 'Content-Type', value: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' },
    { name: 'Accept-Ranges', value: 'bytes' },
    { name: 'Content-Length', value: String(length) },
    // The replacement is the same bytes for every request, so let prewarm
    // 'cache' mode do its job. Page-scoped rules can answer the same URL
    // differently on another path, so their responses must never be cached.
    { name: 'Cache-Control', value: cacheable ? 'public, max-age=3600' : 'no-store' },
  ];
  if (range) headers.push({ name: 'Content-Range', value: `bytes ${start}-${end}/${size}` });
  return { responseCode: range ? 206 : 200, responseHeaders: headers, body: buf.toString('base64') };
}
