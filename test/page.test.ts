import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSoftNavigation } from '../src/page.ts';
import type { Session } from '../src/cdp.ts';

/**
 * waitForSoftNavigation only ever asks the page for a mutation COUNT — the
 * timing is Node's, because the injected runtime freezes the page's clock
 * during capture. So a page can be faked as a sequence of counts.
 */
function countingSession(counts: number[]): { session: Session; polls: () => number } {
  let i = 0;
  const session = {
    async eval(expr: string) {
      if (expr.includes('MutationObserver')) return undefined;
      if (expr.includes('stop()')) return undefined;
      if (expr.includes('__srQuiet ? window.__srQuiet.n')) {
        return counts[Math.min(i++, counts.length - 1)];
      }
      throw new Error(`unexpected eval: ${expr}`);
    },
  } as unknown as Session;
  return { session, polls: () => i };
}

test('a soft navigation is waited out until the DOM stops mutating', async () => {
  // Mutations, then a lull SHORTER than the quiet threshold (the outgoing view
  // finishing its exit), then the new view mounting, then real quiet.
  const { session, polls } = countingSession([10, 20, 20, 20, 40, 40, 40, 40, 40, 40]);
  const ms = await waitForSoftNavigation(session, 5_000);
  assert.ok(polls() >= 10, `returned after ${polls()} polls — it stopped in the mid-swap lull`);
  assert.ok(ms < 5_000, 'returned on quiet, not on the timeout');
});

test('a soft navigation that never settles gives up at the timeout', async () => {
  let n = 0;
  const session = {
    async eval(expr: string) {
      if (expr.includes('__srQuiet ? window.__srQuiet.n')) return ++n; // never quiet
      return undefined;
    },
  } as unknown as Session;
  const ms = await waitForSoftNavigation(session, 700);
  assert.ok(ms >= 700 && ms < 3_000, `gave up after ${ms}ms`);
});
