import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from './http.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticOptions {
  publicDir: string;
  sharedDir: string;
  /** Resolve the signed-in user for the /admin gate (may be null). */
  getUser: (req: IncomingMessage) => Principal | null;
}

function plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extra });
  res.end(text);
}

const notFound = (res: ServerResponse): void => plain(res, 404, 'Not found');

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** True when `child` is `parent` or inside it (path.relative copes with case on Windows). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Split a raw request path into safe segments. Returns undefined for anything
 * suspicious: bad percent-encoding, NUL, backslash, drive colons, "." or ".."
 * segments, dotfiles, and segments Windows would silently rewrite (trailing
 * dot or space).
 */
export function safeSegments(rawPath: string): string[] | undefined {
  const segments: string[] = [];
  for (const raw of rawPath.split('/')) {
    if (raw === '') continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (seg.includes('\0') || seg.includes('\\') || seg.includes('/') || seg.includes(':')) return undefined;
    if (seg.startsWith('.') || seg.endsWith('.') || seg.endsWith(' ')) return undefined;
    segments.push(seg);
  }
  return segments;
}

/**
 * Serve static files for GET and HEAD: the public client, /shared/* (the
 * browser copy of shared/time.js) and the admin-only /admin area.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
  opts: StaticOptions,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    plain(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  const segments = safeSegments(rawPath);
  if (!segments) return notFound(res);

  const first = segments[0]?.toLowerCase();
  let root = opts.publicDir;
  let relSegments = segments;
  let adminArea = false;
  if (first === 'shared') {
    root = opts.sharedDir;
    relSegments = segments.slice(1);
  } else if (first === 'admin') {
    adminArea = true;
  }

  if (adminArea) {
    const user = opts.getUser(req);
    const isAdmin = user?.role === 'admin';
    const isPage =
      segments.length === 1 || (segments.length === 2 && segments[1]?.toLowerCase() === 'index.html');
    if (!isAdmin) {
      if (isPage) redirect(res, '/');
      else plain(res, 403, 'Forbidden');
      return;
    }
    // "/admin" without the slash would resolve its relative asset paths wrongly.
    if (segments.length === 1 && !rawPath.endsWith('/')) {
      redirect(res, '/admin/');
      return;
    }
  }

  if (first === 'shared' && relSegments.length === 0) return notFound(res);

  let target = path.join(root, ...relSegments);
  try {
    let stat = await fs.stat(target);
    if (stat.isDirectory()) {
      // Directories only serve their index.html, and only for a trailing slash
      // request (or the site root).
      if (!rawPath.endsWith('/') && relSegments.length > 0) return notFound(res);
      target = path.join(target, 'index.html');
      stat = await fs.stat(target);
    }
    if (!stat.isFile()) return notFound(res);
    // Resolve symlinks and canonical case, then re-check containment. The admin
    // area is decided on the real location as well as on the URL.
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(target);
    if (!isInside(realRoot, real)) return notFound(res);
    if (root === opts.publicDir && !adminArea) {
      const realAdmin = await fs.realpath(path.join(opts.publicDir, 'admin')).catch(() => undefined);
      if (realAdmin && isInside(realAdmin, real)) {
        plain(res, 403, 'Forbidden');
        return;
      }
    }
    const body = await fs.readFile(real);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      'Content-Type': MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': adminArea ? 'no-store' : 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(method === 'HEAD' ? undefined : body);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL' || code === 'ENAMETOOLONG') return notFound(res);
    throw err;
  }
}
