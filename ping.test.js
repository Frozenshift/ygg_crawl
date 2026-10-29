'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const p = require('./ping');

test('Windows replies: English, Russian OEM, bounds, summary and errors', () => {
  const text = 'Reply from 200::1: time=42ms\r\nReply from 200::1: time<1ms\r\n' +
    '\x8e\xe2\xa2\xa5\xe2 \xae\xe2 200::1: \xa2\xe0\xa5\xac\xef=23\xac\xe1\r\n' +
    'Reply from 200::2: Destination unreachable.\nPing statistics for 200::1:\n' +
    'Packets: Sent = 3, Received = 2, Lost = 1 (33% loss)\nMinimum = 1ms, Maximum = 42ms';
  assert.deepEqual(p.parsePingOutput(text, 'win32'), [
    { ms: 42, bounded: false }, { ms: 1, bounded: true }, { ms: 23, bounded: false }]);
});
test('Linux replies exclude errors and summary', () => {
  assert.deepEqual(p.parsePingOutput('64 bytes from 200::1: icmp_seq=1 ttl=64 time=12.34 ms\n' +
    'From 200::2 icmp_seq=2 Destination unreachable\nrtt min/avg/max/mdev = 1/2/3/4 ms', 'linux'),
  [{ ms: 12.34, bounded: false }]);
});
test('Selection excludes local/unresponsive and deduplicates equivalent IPv6', () => {
  const nodes = [{ ipv6: '200::1', status: 'local' }, { ipv6: '200::2', status: 'responded' },
    { ipv6: '0200:0:0:0:0:0:0:2', status: 'responded' }, { ipv6: '200::3', status: 'unresponsive' }];
  assert.deepEqual(p.selectNodes({ nodes }), [nodes[1]]);
  assert.throws(() => p.selectNodes({ nodes: [{ ipv6: '--help', status: 'responded' }] }));
});
test('Numeric sorting, missing replies last, loss visible, partial report', () => {
  const row = (ipv6, avg, received) => ({ ipv6, avg, min: avg, max: avg, received });
  const report = p.renderReport([row('200::1', null, 0), row('200::2', 100, 3), row('200::3', 9, 1)],
    p.parseArgs([]), { available: 4, selected: 4, updated: 'now', elapsed: 1, reason: 'test' });
  assert.ok(report.indexOf('`200::3`') < report.indexOf('`200::2`'));
  assert.ok(report.indexOf('`200::2`') < report.indexOf('`200::1`'));
  assert.match(report, /66\.7/);
  assert.match(report, /осталось: 1/);
  assert.match(report, /\| — \| — \| — \| 0\/3/);
});
test('Invalid options', () => {
  for (const argv of [['--workers', '0'], ['--count', '1.5'], ['--timeout', 'NaN'],
    ['--limit', '-1'], ['--input'], ['--bad'], ['--input', 'same', '--output', 'same']]) assert.throws(() => p.parseArgs(argv));
});
test('Concurrency, limit, final report and fatal error preservation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ygg-ping-test-'));
  try {
    const args = { ...p.parseArgs([]), output: path.join(directory, 'ping.md'), workers: 2, limit: 3 };
    let active = 0, peak = 0, calls = 0;
    const probe = async node => {
      calls++;
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return { ipv6: node.ipv6, avg: 3, min: 2, max: 4, received: 3 };
    };
    const nodes = Array.from({ length: 5 }, (_, i) => ({ ipv6: '200::' + (i + 1) }));
    assert.equal(await p.run(nodes, args, probe), 0);
    assert.equal(calls, 3);
    assert.equal(peak, 2);
    assert.match(fs.readFileSync(args.output, 'utf8'), /Проверено: 3; ответили: 3/);
    await assert.rejects(p.run(nodes, args, async () => { throw new Error('probe failed'); }), /probe failed/);
    assert.match(fs.readFileSync(args.output, 'utf8'), /ошибка: probe failed/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('Real native IPv6 loopback response is parsed', async () => {
  const result = await p.pingNode({ ipv6: '::1' }, { ...p.parseArgs([]), count: 1, timeout: 1 });
  assert.equal(result.received, 1);
  assert.ok(result.avg >= 0);
});
