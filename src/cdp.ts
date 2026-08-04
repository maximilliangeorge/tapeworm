/**
 * Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 *
 * Why a pipe rather than a WebSocket: frames come back as base64 PNG, and at
 * 2560x1440 that is a few hundred KB each. The pipe has no message-size limits
 * and no handshake, and it means this file has zero dependencies.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Writable, Readable } from 'node:stream';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

export class PageError extends Error {
  detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'PageError';
    this.detail = detail;
  }
}

export class CdpError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

export class Connection extends EventEmitter {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf: Buffer = Buffer.alloc(0);
  private write: Writable;
  private closed = false;

  constructor(proc: ChildProcess) {
    super();
    this.setMaxListeners(0);
    this.proc = proc;
    // fd 3 = browser reads our commands, fd 4 = browser writes events/replies
    this.write = proc.stdio[3] as Writable;
    const read = proc.stdio[4] as Readable;

    read.on('data', (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      let i: number;
      while ((i = this.buf.indexOf(0)) !== -1) {
        const raw = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 1);
        if (raw.length > 0) this.dispatch(raw);
      }
    });

    proc.on('exit', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`browser exited during ${p.method}`));
      this.pending.clear();
      this.emit('disconnected');
    });
  }

  private dispatch(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // a truncated or non-JSON line; nothing useful to do
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message}`, msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit(msg.method, msg.params ?? {}, msg.sessionId);
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`connection closed (${method})`));
    const id = this.nextId++;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.write.write(JSON.stringify(payload) + '\0');

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** Resolve on the next occurrence of `event`, or reject on timeout. */
  once_(event: string, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`timeout waiting for ${event}`));
      }, timeoutMs);
      const handler = (params: any) => { clearTimeout(timer); resolve(params); };
      this.once(event, handler);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

export function connect(executable: string, args: string[]): Connection {
  const proc = spawn(executable, ['--remote-debugging-pipe', ...args], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  if (process.env.SCROLLREC_DEBUG) {
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write('[chrome] ' + d.toString()));
  } else {
    proc.stderr?.resume(); // drain, or the pipe fills and Chrome blocks
  }
  return new Connection(proc);
}

/** A CDP session attached to one page target. */
export class Session {
  conn: Connection;
  id: string;
  targetId: string;

  constructor(conn: Connection, sessionId: string, targetId: string) {
    this.conn = conn;
    this.id = sessionId;
    this.targetId = targetId;
  }

  send<T = any>(method: string, params: object = {}, timeoutMs?: number): Promise<T> {
    return this.conn.send<T>(method, params, this.id, timeoutMs);
  }

  /** Evaluate an expression in the page and return its value. Throws on page exceptions. */
  async eval<T = any>(expression: string, awaitPromise = false, timeoutMs = 30_000): Promise<T> {
    const r = await this.send<any>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const full = String(d.exception?.description ?? d.text ?? 'unknown error');
      // Keep the message, drop the "    at <anonymous>:295:18" stack — it refers to
      // injected source the user has never seen and can't act on.
      const message = full.split('\n')[0].replace(/^(Uncaught )?(Error|TypeError):\s*/, '');
      throw new PageError(message, full);
    }
    return r.result?.value as T;
  }

  on(event: string, handler: (params: any) => void): void {
    this.conn.on(event, (params: any, sessionId?: string) => {
      if (!sessionId || sessionId === this.id) handler(params);
    });
  }
}

export async function newPage(conn: Connection, url = 'about:blank'): Promise<Session> {
  const { targetId } = await conn.send<{ targetId: string }>('Target.createTarget', { url });
  const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  return new Session(conn, sessionId, targetId);
}
