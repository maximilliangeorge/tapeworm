import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileScope, fulfillFromFile, isUrl, parseRange, wildcardToRegExp } from '../src/substitute.ts';

test('wildcardToRegExp: * spans, ? is one char, regex specials are literal', () => {
  const hero = wildcardToRegExp('*/hero.mp4');
  assert.ok(hero.test('https://cdn.example.com/media/hero.mp4'));
  assert.ok(!hero.test('https://cdn.example.com/media/hero.mp4?v=2'), 'no implicit suffix — the pattern is anchored');
  assert.ok(wildcardToRegExp('*/hero.mp4*').test('https://cdn.example.com/hero.mp4?v=2'));
  assert.ok(!hero.test('https://cdn.example.com/heroXmp4'), '. must be literal');
  assert.ok(wildcardToRegExp('https://example.com/v?.mp4').test('https://example.com/v1.mp4'));
  assert.ok(!wildcardToRegExp('https://example.com/v?.mp4').test('https://example.com/v12.mp4'));
});

test('compileScope: pathname wildcards for schemeless patterns, full URL otherwise', () => {
  const pricing = compileScope('/pricing*');
  assert.ok(pricing('https://example.com/pricing'));
  assert.ok(pricing('https://example.com/pricing/enterprise'));
  assert.ok(pricing('https://other.example/pricing?plan=pro'), 'pathname matching ignores host and query');
  assert.ok(!pricing('https://example.com/about'));

  const exact = compileScope('/');
  assert.ok(exact('https://example.com/'));
  assert.ok(!exact('https://example.com/about'), 'anchored, like from');

  const full = compileScope('https://example.com/pricing*');
  assert.ok(full('https://example.com/pricing?plan=pro'));
  assert.ok(!full('https://other.example/pricing'), 'a scheme in the pattern means full-URL matching');

  assert.ok(!pricing('not a url'), 'unparseable document URL never matches');
});

test('isUrl separates remote replacements from local paths', () => {
  assert.ok(isUrl('https://example.com/a.mp4'));
  assert.ok(isUrl('http://127.0.0.1:8000/a.mp4'));
  assert.ok(!isUrl('./assets/a.mp4'));
  assert.ok(!isUrl('/abs/a.mp4'));
});

test('parseRange: the request shapes <video> seeking produces', () => {
  assert.equal(parseRange(undefined, 10), null);
  assert.deepEqual(parseRange('bytes=0-', 10), [0, 9]);
  assert.deepEqual(parseRange('bytes=2-5', 10), [2, 5]);
  assert.deepEqual(parseRange('bytes=-3', 10), [7, 9]);
  assert.deepEqual(parseRange('bytes=8-99', 10), [8, 9], 'an end past the file is clamped, not rejected (RFC 9110)');
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,4-5', 10), null, 'multi-range answered with the whole file');
  assert.equal(parseRange('lines=0-1', 10), null);
});

test('fulfillFromFile: whole file, range slice, and 416', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tapeworm-sub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'clip.mp4');
  writeFileSync(file, 'ABCDEFGHIJ'); // 10 bytes standing in for a video
  const header = (f: { responseHeaders: Array<{ name: string; value: string }> }, name: string) =>
    f.responseHeaders.find((h) => h.name === name)?.value;

  const whole = await fulfillFromFile(file, undefined);
  assert.equal(whole.responseCode, 200);
  assert.equal(header(whole, 'Content-Type'), 'video/mp4');
  assert.equal(header(whole, 'Accept-Ranges'), 'bytes');
  assert.equal(header(whole, 'Content-Length'), '10');
  assert.equal(header(whole, 'Cache-Control'), 'public, max-age=3600');
  assert.equal(Buffer.from(whole.body, 'base64').toString(), 'ABCDEFGHIJ');

  const scoped = await fulfillFromFile(file, undefined, false);
  assert.equal(header(scoped, 'Cache-Control'), 'no-store', 'page-scoped responses must not outlive their page');

  const mid = await fulfillFromFile(file, 'bytes=2-5');
  assert.equal(mid.responseCode, 206);
  assert.equal(header(mid, 'Content-Range'), 'bytes 2-5/10');
  assert.equal(Buffer.from(mid.body, 'base64').toString(), 'CDEF');

  const open = await fulfillFromFile(file, 'bytes=7-');
  assert.equal(open.responseCode, 206);
  assert.equal(Buffer.from(open.body, 'base64').toString(), 'HIJ');

  const past = await fulfillFromFile(file, 'bytes=10-');
  assert.equal(past.responseCode, 416);
  assert.equal(header(past, 'Content-Range'), 'bytes */10');
  assert.equal(past.body, '');

  const other = join(dir, 'page.html');
  writeFileSync(other, '<p>');
  assert.equal((await fulfillFromFile(other, undefined)).responseHeaders.find((h) => h.name === 'Content-Type')?.value, 'text/html');
  await assert.rejects(fulfillFromFile(join(dir, 'gone.mp4'), undefined));
});
