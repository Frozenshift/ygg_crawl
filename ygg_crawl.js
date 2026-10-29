#!/usr/bin/env node
'use strict';

/**
 * Yggdrasil node discovery through a LOCAL yggdrasilctl (Node.js 18+, no npm).
 * Uses only getself/getpeers/gettree and debug_remotegetpeers/debug_remotegettree.
 * Run on the computer running Yggdrasil; no remote admin port is needed.
 * Workers are concurrent node inspections, not CPU worker threads.
 * All CLI time values are SECONDS. Two requests per node run sequentially.
 * A discovered address is not proof that a node is online or a separate device.
 * Sources: https://yggdrasil-network.github.io/faq.html
 * https://pkg.go.dev/github.com/yggdrasil-network/yggdrasil-go/src/address#AddrForKey
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const COMMANDS = ['debug_remotegetpeers', 'debug_remotegettree'];
const KEY = /^[0-9a-f]{64}$/i;
const isKey = value => typeof value === 'string' && KEY.test(value) && !/^0+$/.test(value);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function publicKeys(value) {
  const found = new Set();
  function visit(item) {
    if (isKey(item)) found.add(item.toLowerCase());
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') {
      for (const [name, child] of Object.entries(item)) { visit(name); visit(child); }
    }
  }
  visit(value);
  return found;
}

function keyAddress(key) {
  if (!isKey(key)) throw new Error('Invalid public key');
  const bits = [...Buffer.from(key, 'hex')]
    .map(byte => (byte ^ 255).toString(2).padStart(8, '0')).join('');
  const leading = bits.indexOf('0');
  const suffix = bits.slice(leading + 1).padEnd(112, '0').slice(0, 112);
  const hex = '02' + leading.toString(16).padStart(2, '0') +
    BigInt('0b' + suffix).toString(16).padStart(28, '0');
  const groups = hex.match(/.{4}/g).map(group => parseInt(group, 16).toString(16));
  let bestStart = -1, bestLength = 1;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== '0') { i++; continue; }
    let end = i;
    while (end < groups.length && groups[end] === '0') end++;
    if (end - i > bestLength) { bestStart = i; bestLength = end - i; }
    i = end;
  }
  if (bestStart < 0) return groups.join(':');
  return groups.slice(0, bestStart).join(':') + '::' +
    groups.slice(bestStart + bestLength).join(':');
}

function parseReply(stdout) {
  let data = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (['error', 'failed'].includes(String(data.status || '').toLowerCase())) {
      throw new Error(JSON.stringify(data.error || data.response || 'API error'));
    }
    if (Object.hasOwn(data, 'response')) data = data.response;
    if (data && typeof data === 'object' && data.error) {
      throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    }
  }
  return data;
}

function help() {
  console.log(`Usage: node ygg_crawl.js [options]
  --workers N       Concurrent node inspections, 1-64 (default: 16)
  --timeout S       Timeout PER yggdrasilctl command, seconds (default: 10)
  --interval S      Minimum spacing between node starts, seconds (default: 0.01)
  --max-nodes N     Maximum recorded identities (default: 1000000)
  --max-seconds S   Maximum run time, seconds (default: 86400)
  --output PREFIX   Output PREFIX.json and PREFIX.txt (default: ygg-nodes-js)
  --ctl PATH        Local yggdrasilctl executable; paths with spaces are supported
  --endpoint URI    Optional LOCAL admin endpoint passed to yggdrasilctl
  --resume FILE     Continue a previous Python/JS JSON snapshot; skip completed nodes
  --help            Show this help

Requires a running local Yggdrasil daemon. On Windows, run PowerShell as
administrator if required to access its local admin endpoint. No npm packages.
Ctrl+C stops new work, waits for current requests, then saves both outputs.
Statuses: local; discovered (not yet inspected); responded (at least one
successful debug reply); unresponsive (no successful debug replies).
The TXT file includes ALL discovered addresses, not just responding nodes.
Resume reuses old results; it is continuation, not a fresh availability check.`);
}

function parseArgs(argv) {
  const args = { workers: 16, timeout: 10, interval: 0.01, maxNodes: 1000000,
    maxSeconds: 86400, output: 'ygg-nodes-js',
    ctl: process.platform === 'win32' ? 'yggdrasilctl.exe' : 'yggdrasilctl' };
  const options = { '--workers': 'workers', '--timeout': 'timeout', '--interval': 'interval',
    '--max-nodes': 'maxNodes', '--max-seconds': 'maxSeconds', '--output': 'output',
    '--ctl': 'ctl', '--endpoint': 'endpoint', '--resume': 'resume' };
  const numeric = new Set(['workers', 'timeout', 'interval', 'maxNodes', 'maxSeconds']);
  for (let i = 0; i < argv.length; i++) {
    if (['--help', '-h'].includes(argv[i])) return null;
    const name = options[argv[i]];
    if (!name) throw new Error('Unknown option: ' + argv[i]);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error('Missing value for ' + argv[i - 1]);
    args[name] = numeric.has(name) ? Number(value) : value;
  }
  for (const name of numeric) {
    if (!Number.isFinite(args[name])) throw new Error(name + ' must be a finite number');
  }
  if (!Number.isSafeInteger(args.workers) || args.workers < 1)
    throw new Error('--workers must be a positive integer');
  if (!Number.isSafeInteger(args.maxNodes) || args.maxNodes < 2)
    throw new Error('--max-nodes must be an integer >= 2');
  if (args.timeout <= 0 || args.maxSeconds <= 0 || args.interval < 0)
    throw new Error('Timeout and time limit must be positive; interval must be >= 0');
  if (!args.output || !args.ctl) throw new Error('Output and executable path cannot be empty');
  return args;
}

function query(args, command, key, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.reject(new Error('Crawl time limit reached'));
  const argv = args.endpoint ? ['-endpoint', args.endpoint] : [];
  argv.push('-json', command);
  if (key) argv.push('key=' + key);
  const timeout = Math.max(1, Math.ceil(Math.min(args.timeout * 1000, remaining, 2147483647)));
  return new Promise((resolve, reject) => {
    execFile(args.ctl, argv, { encoding: 'utf8', timeout, killSignal: 'SIGKILL',
      windowsHide: true, shell: false, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = error.killed ? `Command timed out after ${timeout / 1000}s` :
          (stderr || stdout || error.message);
        reject(new Error(String(message).trim().slice(0, 500)));
      } else {
        try { resolve(parseReply(stdout)); } catch (err) { reject(err); }
      }
    });
  });
}

function snapshot(prefix, records, stats) {
  const nodes = [...records.values()].sort((a, b) => a.public_key.localeCompare(b.public_key));
  const metadata = { ...stats, updated_utc: new Date().toISOString(), discovered: nodes.length,
    responded: nodes.filter(row => ['local', 'responded'].includes(row.status)).length,
    note: 'Discovered public keys; some nodes may be offline. Completeness is not guaranteed.', nodes };
  const outputs = [[prefix + '.json', JSON.stringify(metadata, null, 2) + '\n'],
    [prefix + '.txt', nodes.map(row => row.ipv6 + '\n').join('')]];
  for (const [filename, content] of outputs) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = filename + '.tmp';
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, filename);
  }
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (err) { console.error(err.message); return 1; }
  if (!args) { help(); return 0; }
  const started = performance.now(), deadline = started + args.maxSeconds * 1000;
  const records = new Map(), queue = [], pending = new Set();
  const stats = { queried: 0, elapsed_seconds: 0, reason: 'running' };
  let head = 0, capped = false, stopped = false, interrupted = false, timer;
  let fatal;
  const stop = () => {
    if (!interrupted) console.log('Stopping; waiting for active commands and saving...');
    interrupted = stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const add = keys => {
    for (const key of keys) {
      if (records.has(key)) continue;
      if (records.size >= args.maxNodes) { capped = true; continue; }
      records.set(key, { public_key: key, ipv6: keyAddress(key), status: 'discovered',
        successful_requests: [], errors: {} });
      queue.push(key);
    }
  };
  const save = () => {
    stats.elapsed_seconds = Math.round((performance.now() - started) / 10) / 100;
    snapshot(args.output, records, stats);
  };
  const progress = () => console.log(`Discovered: ${records.size}; queried: ${stats.queried}; ` +
    `queued: ${queue.length - head}; active: ${pending.size}`);
  const inspect = async key => {
    const row = records.get(key), discovered = new Set(), replies = [], errors = {};
    for (const command of COMMANDS) {
      if (stopped || performance.now() >= deadline) break;
      try {
        for (const found of publicKeys(await query(args, command, key, deadline))) discovered.add(found);
        replies.push(command);
      } catch (err) { errors[command] = String(err.message).slice(0, 500); }
    }
    // Partial inspections are queued again when resuming the saved snapshot.
    const complete = replies.length + Object.keys(errors).length === COMMANDS.length;
    Object.assign(row, { status: replies.length ? 'responded' : complete ? 'unresponsive' : 'discovered',
      successful_requests: replies, errors, inspection_complete: complete });
    if (complete) stats.queried++;
    add(discovered);
  };
  try {
    if (args.resume) {
      const previous = JSON.parse(fs.readFileSync(args.resume, 'utf8'));
      if (!Array.isArray(previous.nodes)) throw new Error('Resume file must contain a nodes array');
      for (const row of previous.nodes) {
        if (!isKey(row.public_key)) throw new Error('Invalid public key in resume file');
        const key = row.public_key.toLowerCase();
        const complete = row.inspection_complete !== false && ['responded', 'unresponsive'].includes(row.status);
        records.set(key, { public_key: key, ipv6: keyAddress(key),
          status: complete ? row.status : 'discovered', successful_requests: row.successful_requests || [],
          errors: row.errors || {}, inspection_complete: complete });
      }
      if (records.size >= args.maxNodes) throw new Error('--max-nodes must exceed the number of resumed nodes');
      stats.resumed_from = path.resolve(args.resume);
      stats.resumed_at = new Date().toISOString();
    }
    const own = publicKeys(await query(args, 'getself', null, deadline));
    if (own.size !== 1) throw new Error('Expected one public key from getself; inspect yggdrasilctl -json getself');
    const ownKey = [...own][0];
    add(own);
    records.get(ownKey).status = 'local';
    queue.length = 0;
    for (const [key, row] of records) {
      if (key !== ownKey && !row.inspection_complete) queue.push(key);
      if (key !== ownKey && row.inspection_complete) stats.queried++;
    }
    for (const command of ['getpeers', 'gettree']) {
      if (stopped) break;
      add(publicKeys(await query(args, command, null, deadline)));
    }
    save();
    console.log(`Seed nodes: ${records.size} (including this node); workers: ${args.workers}`);
    timer = setInterval(() => {
      try { save(); progress(); }
      catch (err) { fatal = err; stopped = true; clearInterval(timer); }
    }, 5000);
    let nextStart = performance.now();
    while ((head < queue.length || pending.size) && !stopped && performance.now() < deadline) {
      while (head < queue.length && pending.size < args.workers &&
             !stopped && performance.now() < deadline && performance.now() >= nextStart) {
        const key = queue[head++];
        let task;
        task = inspect(key).catch(err => { fatal = err; stopped = true; })
          .finally(() => pending.delete(task));
        pending.add(task);
        nextStart = performance.now() + args.interval * 1000;
        if (args.interval > 0) break;
      }
      if (head > 10000 && head * 2 > queue.length) { queue.splice(0, head); head = 0; }
      let wait = Math.min(100, Math.max(1, deadline - performance.now()));
      if (head < queue.length && pending.size < args.workers)
        wait = Math.min(wait, Math.max(1, nextStart - performance.now()));
      await Promise.race([...pending, sleep(wait)]);
    }
    stopped = true;
    await Promise.all(pending);
    if (fatal) throw fatal;
    stats.reason = interrupted ? 'interrupted' : performance.now() >= deadline ? 'time_limit' :
      capped ? 'node_limit' : 'no_more_discoveries';
  } catch (err) {
    stopped = true;
    await Promise.all(pending);
    fatal = err;
    stats.reason = interrupted ? 'interrupted' : 'error';
    stats.error = String(err.message);
    console.error('Error: ' + err.message);
  } finally {
    clearInterval(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (records.size) {
      try { save(); progress(); console.log(`Saved ${args.output}.json and ${args.output}.txt; reason: ${stats.reason}`); }
      catch (err) { fatal = err; console.error('Cannot save outputs: ' + err.message); }
    }
  }
  return fatal ? 1 : interrupted ? 130 : 0;
}

module.exports = { publicKeys, keyAddress, parseReply, parseArgs, snapshot, main };
if (require.main === module) main().then(code => { process.exitCode = code; })
  .catch(err => { console.error(err.stack || err.message); process.exitCode = 1; });
