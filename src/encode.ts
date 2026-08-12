/** ffmpeg plumbing. PNG frames in, a master file out. */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Resolved } from './types.ts';

export type Encoder = {
  write(png: Buffer): Promise<void>;
  finish(): Promise<void>;
};

function codecArgs(cfg: Resolved): string[] {
  if (cfg.codec === 'prores') {
    // 4444 is the editor-friendly master: 12-bit, full chroma, alpha-capable.
    return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'];
  }
  // yuv444p rather than yuv420p — text is the whole point of this tool, and 4:2:0
  // is what puts coloured fringes on glyph edges.
  return [
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', String(cfg.crf),
    '-pix_fmt', 'yuv444p',
    '-movflags', '+faststart',
  ];
}

export function createEncoder(outPath: string, cfg: Resolved): Encoder {
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(cfg.fps),
    '-c:v', 'png',
    '-i', 'pipe:0',
    ...codecArgs(cfg),
    '-r', String(cfg.fps),
    outPath,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  let failed: Error | null = null;
  proc.on('error', (e) => { failed = new Error(`ffmpeg failed to start: ${e.message}. Is ffmpeg on PATH?`); });

  return {
    write(png: Buffer) {
      if (failed) return Promise.reject(failed);
      return new Promise<void>((resolve, reject) => {
        const ok = proc.stdin.write(png, (e) => { if (e) reject(e); });
        if (ok) resolve();
        else proc.stdin.once('drain', resolve);
      });
    },
    finish() {
      return new Promise<void>((resolve, reject) => {
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited ${code}\n${stderr.split('\n').slice(-12).join('\n')}`));
        });
        proc.stdin.end();
      });
    },
  };
}

/** For codec 'png': write numbered files instead of encoding. */
export function createPngWriter(dir: string, startIndex: number): Encoder {
  mkdirSync(dir, { recursive: true });
  let i = startIndex;
  const pending: Promise<void>[] = [];
  return {
    write(png: Buffer) {
      const path = join(dir, `frame_${String(i++).padStart(6, '0')}.png`);
      const p = new Promise<void>((resolve, reject) => {
        const s = createWriteStream(path);
        s.on('error', reject);
        s.on('finish', () => resolve());
        s.end(png);
      });
      pending.push(p);
      return pending.length > 8 ? Promise.all(pending.splice(0, 4)).then(() => {}) : Promise.resolve();
    },
    async finish() { await Promise.all(pending); },
  };
}

/** Write one sampled frame to a single PNG file — the `frame` mode output. */
export function createPngFileWriter(path: string): Encoder {
  let done = Promise.resolve();
  return {
    write(png: Buffer) {
      done = new Promise<void>((resolve, reject) => {
        const s = createWriteStream(path);
        s.on('error', reject);
        s.on('finish', () => resolve());
        s.end(png);
      });
      return Promise.resolve();
    },
    async finish() { await done; },
  };
}

/** Stitch per-shard segments without re-encoding. */
export async function concatSegments(segments: string[], outPath: string, tmpDir: string): Promise<void> {
  if (segments.length === 1) {
    const { renameSync, copyFileSync } = await import('node:fs');
    try { renameSync(segments[0], outPath); } catch { copyFileSync(segments[0], outPath); }
    return;
  }
  const listPath = join(tmpDir, 'segments.txt');
  writeFileSync(listPath, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`concat failed (${code})\n${err.split('\n').slice(-10).join('\n')}`));
    });
  });
  for (const s of segments) { try { rmSync(s); } catch {} }
  try { rmSync(listPath); } catch {}
}

export async function checkFfmpeg(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p: ChildProcess = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => reject(new Error('ffmpeg not found on PATH. Install it (brew install ffmpeg).')));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exited non-zero'))));
  });
}
