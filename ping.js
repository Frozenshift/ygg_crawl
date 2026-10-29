#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { isIP } = require('node:net');
const { performance } = require('node:perf_hooks');

function parseArgs(argv) {
  const args = { input: 'ygg-nodes-js.json', output: 'ping.md', workers: 32, count: 3, timeout: 2, limit: 0 };
  const options = { '--input': 'input', '--output': 'output', '--workers': 'workers',
    '--count': 'count', '--timeout': 'timeout', '--limit': 'limit' };
  for (let i = 0; i < argv.length; i++) {
    if (['--help', '-h'].includes(argv[i])) return null;
    const name = options[argv[i]];
    if (!name) throw new Error('Неизвестный параметр: ' + argv[i]);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Не задано значение для ' + argv[i - 1]);
    args[name] = ['input', 'output'].includes(name) ? value : Number(value);
  }
  for (const name of ['workers', 'count', 'limit']) {
    if (!Number.isSafeInteger(args[name]) || args[name] < (name === 'limit' ? 0 : 1)) {
      throw new Error(name + ': требуется целое число ' + (name === 'limit' ? '≥ 0' : '> 0'));
    }
  }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > 3600) {
    throw new Error('--timeout должен быть больше 0 и не больше 3600 секунд');
  }
  if ((args.timeout * 1000 + 1000) * args.count + 5000 > 2147483647) {
    throw new Error('Слишком большое сочетание --count и --timeout');
  }
  if (path.resolve(args.input) === path.resolve(args.output)) throw new Error('Входной и выходной файлы должны различаться');
  return args;
}

function selectNodes(data) {
  if (!data || !Array.isArray(data.nodes)) throw new Error('JSON должен содержать массив nodes');
  const seen = new Set();
  return data.nodes.filter(node => node && node.status === 'responded').filter(node => {
    if (isIP(node.ipv6) !== 6) throw new Error('Некорректный IPv6 активной ноды: ' + node.ipv6);
    // Deduplicate equivalent expanded/compressed IPv6 forms without resolving DNS.
    const address = new URL('http://[' + node.ipv6 + ']/').hostname;
    if (seen.has(address)) return false;
    seen.add(address);
    return true;
  });
}

function parsePingOutput(output, platform) {
  const samples = [];
  for (const line of output.split(/\r?\n/)) {
    // Windows OEM bytes are read as latin1. Only ASCII IPv6/numbers/operators
    // are parsed, so Russian and English ping output use the same path.
    const match = platform === 'win32'
      ? (/(?:[0-9a-f]*:){2}/i.test(line) && line.match(/([=<])\s*(\d+(?:[.,]\d+)?)\s*[^\d=<>]*$/))
      : (/\bicmp_seq[= ]\d+/.test(line) && line.match(/\btime\s*([=<])\s*(\d+(?:[.,]\d+)?)\s*ms\b/));
    if (match) samples.push({ ms: Number(match[2].replace(',', '.')), bounded: match[1] === '<' });
  }
  return samples;
}

function pingNode(node, args) {
  const windows = process.platform === 'win32';
  const command = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE') : 'ping';
  const argv = windows
    ? ['-6', '-n', String(args.count), '-w', String(Math.ceil(args.timeout * 1000)), node.ipv6]
    : ['-6', '-n', '-c', String(args.count), '-W', String(Math.ceil(args.timeout)), node.ipv6];
  return new Promise((resolve, reject) => {
    execFile(command, argv, { encoding: 'buffer', windowsHide: true, shell: false,
      timeout: Math.ceil((args.timeout * 1000 + 1000) * args.count + 5000),
      maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error && error.code === 'ENOENT') return reject(new Error('Системная утилита ping не найдена'));
      const samples = parsePingOutput((stdout || Buffer.alloc(0)).toString(windows ? 'latin1' : 'utf8'), process.platform);
      const values = samples.map(sample => sample.ms);
      resolve({ ipv6: node.ipv6, received: values.length,
        min: values.length ? Math.min(...values) : null,
        avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        max: values.length ? Math.max(...values) : null,
        bounded: samples.some(sample => sample.bounded),
        error: error ? error.killed ? 'Превышено время работы ping' : 'ping завершился с ошибкой (' + error.code + ')' : '' });
    });
  });
}

function renderReport(rows, args, meta) {
  const ordered = [...rows].sort((a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity) || a.ipv6.localeCompare(b.ipv6));
  const successful = ordered.filter(row => row.received > 0);
  const inline = value => String(value).replace(/[\r\n`|]/g, ' ');
  const lines = ['# Ping активных нод Yggdrasil', '',
    '- Источник: `' + inline(args.input) + '`; время сохранения (UTC): `' + meta.updated + '`.',
    `- Активных удалённых адресов в снимке: ${meta.available}; выбрано для этого запуска: ${meta.selected}.`,
    `- Проверено: ${rows.length}; ответили: ${successful.length}; без успешного ответа: ${rows.length - successful.length}; осталось: ${meta.selected - rows.length}.`,
    `- Запросов на ноду: ${args.count}; тайм-аут одного ответа: ${args.timeout} с; параллельных проверок: ${args.workers}.`,
    `- Состояние: ${inline(meta.reason)}; длительность: ${meta.elapsed.toFixed(2)} с.`, '',
    'Измеряется задержка от текущего компьютера, а не пропускная способность сети. Выбраны только ноды со статусом `responded`; локальная нода исключена. Статус взят из старого снимка и не гарантирует ответ на ICMP сейчас.', '',
    'Сортировка по средней задержке среди полученных ответов, от меньшей к большей. Потери показаны отдельно и не влияют на порядок. Значения `<1 мс` учитываются как верхняя граница 1 мс; статистика таких нод помечена `≤`. Ноды без ответа находятся в конце и не получают нулевую задержку.', '',
    '| № | IPv6 | Средняя, мс | Мин., мс | Макс., мс | Ответов | Потери, % | Примечание |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const [index, row] of ordered.entries()) {
    const ms = value => value == null ? '—' : (row.bounded ? '≤ ' : '') + value.toFixed(2);
    const loss = ((args.count - row.received) / args.count * 100).toFixed(1);
    const note = row.error || (row.received ? '' : 'Нет ICMP-ответа');
    lines.push(`| ${index + 1} | \`${row.ipv6}\` | ${ms(row.avg)} | ${ms(row.min)} | ${ms(row.max)} | ${row.received}/${args.count} | ${loss} | ${inline(note)} |`);
  }
  lines.push('', 'Отсутствие ICMP-ответа может означать фильтрацию ICMP, проблемы маршрута или недоступность ноды. При ошибке процесса доля неполученных ответов может включать неотправленные запросы.', '');
  return lines.join('\n');
}

async function run(nodes, args, probe = pingNode) {
  const available = nodes.length;
  if (args.limit) nodes = nodes.slice(0, args.limit);
  const rows = [], started = performance.now();
  let cursor = 0, stopped = false, fatal, reason = 'выполняется', timer;
  const stop = () => {
    stopped = true;
    reason = 'прервано пользователем';
    console.log('Остановка: ожидаю текущие ping и сохраняю отчёт…');
  };
  const save = () => {
    const report = renderReport(rows, args, { available, selected: nodes.length,
      updated: new Date().toISOString(), elapsed: (performance.now() - started) / 1000, reason });
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output + '.tmp', report, 'utf8');
    fs.renameSync(args.output + '.tmp', args.output);
  };
  // Check output access before starting network work.
  save();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    timer = setInterval(() => {
      try {
        save();
        console.log(`Проверено: ${rows.length}/${nodes.length}; ответили: ${rows.filter(row => row.received).length}`);
      } catch (err) { fatal = err; stopped = true; }
    }, 5000);
    await Promise.all(Array.from({ length: Math.min(args.workers, nodes.length) }, async () => {
      while (!stopped && cursor < nodes.length) {
        const node = nodes[cursor++];
        try { rows.push(await probe(node, args)); }
        catch (err) { fatal = err; stopped = true; }
      }
    }));
    reason = fatal ? 'ошибка: ' + fatal.message : stopped ? reason : 'завершено';
  } finally {
    clearInterval(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    save();
  }
  if (fatal) throw fatal;
  console.log(`Сохранён ${args.output}; проверено: ${rows.length}; ответили: ${rows.filter(row => row.received).length}`);
  return stopped ? 130 : 0;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (!args) {
      console.log(`Использование: node ping.js [параметры]
  --input FILE    JSON обхода (по умолчанию: ygg-nodes-js.json)
  --output FILE   Отчёт с сортировкой по средней задержке (по умолчанию: ping.md)
  --workers N     Параллельные проверки нод (по умолчанию: 32)
  --count N       ICMP-запросов на ноду (по умолчанию: 3)
  --timeout S     Тайм-аут ответа в секундах (по умолчанию: 2)
  --limit N       Проверить первые N активных адресов; 0 — все (по умолчанию: 0)
  --help, -h      Справка
Нужны работающий Yggdrasil и системный ping (Windows или Linux).
Сохранение каждые 5 секунд и по завершении. Ctrl+C сохраняет частичный отчёт.
Существующий выходной файл перезаписывается; продолжение не поддерживается.`);
      return 0;
    }
    if (!['win32', 'linux'].includes(process.platform)) throw new Error('Поддерживаются Windows и Linux');
    const data = JSON.parse(fs.readFileSync(args.input, 'utf8').replace(/^\uFEFF/, ''));
    const nodes = selectNodes(data);
    console.log(`Активных удалённых адресов: ${nodes.length}; к проверке: ${args.limit ? Math.min(args.limit, nodes.length) : nodes.length}`);
    return await run(nodes, args);
  } catch (err) {
    console.error('Ошибка: ' + err.message);
    return 1;
  }
}

module.exports = { parseArgs, selectNodes, parsePingOutput, pingNode, renderReport, run, main };
if (require.main === module) main().then(code => { process.exitCode = code; });
