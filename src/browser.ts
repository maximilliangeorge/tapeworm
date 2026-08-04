/** Finding and launching Chrome, with the flags that matter for capture. */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, type Connection } from './cdp.ts';

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** Look inside ~/.cache/puppeteer for anything installed by @puppeteer/browsers. */
function puppeteerCache(): string[] {
  const root = join(homedir(), '.cache', 'puppeteer');
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const pkg of safeReaddir(root)) {
    for (const build of safeReaddir(join(root, pkg))) {
      const base = join(root, pkg, build);
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-linux64/chrome',
        'chrome-headless-shell-linux64/chrome-headless-shell',
      ]) {
        const p = join(base, rel);
        if (existsSync(p)) found.push(p);
      }
    }
  }
  return found;
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

export function findChrome(explicit?: string | null): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`chromePath does not exist: ${explicit}`);
    return explicit;
  }
  if (process.env.SCROLLREC_CHROME && existsSync(process.env.SCROLLREC_CHROME)) {
    return process.env.SCROLLREC_CHROME;
  }
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const candidates = [
    ...puppeteerCache(),
    ...(process.platform === 'darwin' ? MAC_CANDIDATES : LINUX_CANDIDATES),
  ];
  for (const c of candidates) if (existsSync(c)) return c;

  throw new Error(
    'No Chrome found. Install one with:\n' +
      '  npx @puppeteer/browsers install chrome@stable\n' +
      'or point at an existing binary with --chrome-path / $SCROLLREC_CHROME.',
  );
}

/**
 * `chrome-headless-shell` is a different binary with different capabilities.
 * Notably it is an open-source Chromium build in some distributions, so it may
 * lack H.264/AAC — which matters if the page has an mp4 hero video.
 */
export function isHeadlessShell(path: string): boolean {
  return /headless[-_]shell/i.test(path);
}

export type LaunchOptions = {
  chromePath: string;
  headful: boolean;
  /** Extra flags, appended last so they win. */
  extraArgs?: string[];
};

export function launch(opts: LaunchOptions): Connection {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--metrics-recording-only',
    '--mute-audio',

    // capture hygiene
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    // Subpixel antialiasing produces colour fringing that survives into the encode
    // and reads as chroma noise on displays with a different subpixel layout.
    '--disable-lcd-text',
    '--font-render-hinting=none',

    // let hero videos start without a user gesture
    '--autoplay-policy=no-user-gesture-required',

    // stop Chrome throttling a window it thinks nobody is looking at
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
  ];

  if (!opts.headful) {
    if (!isHeadlessShell(opts.chromePath)) args.push('--headless=new');
  }
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  if (opts.extraArgs) args.push(...opts.extraArgs);

  return connect(opts.chromePath, args);
}
