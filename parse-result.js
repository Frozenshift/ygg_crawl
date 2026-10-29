#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { input: 'ygg-nodes-js.json', output: 'result.md' };
  const options = { '--input': 'input', '--output': 'output', '--command': 'command' };
  for (let i = 0; i < argv.length; i++) {
    if (['--help', '-h'].includes(argv[i])) return null;
    const name = options[argv[i]];
    if (!name) throw new Error('Неизвестный параметр: ' + argv[i]);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Не задано значение для ' + argv[i - 1]);
    args[name] = value;
  }
  if (path.resolve(args.input) === path.resolve(args.output)) {
    throw new Error('Входной и выходной файлы должны различаться');
  }
  return args;
}

function summarize(data) {
  if (!data || !Array.isArray(data.nodes)) throw new Error('JSON должен содержать массив nodes');
  const counts = { local: 0, responded: 0, unresponsive: 0, discovered: 0, other: 0 };
  const keys = new Set();
  for (const [index, node] of data.nodes.entries()) {
    if (!node || typeof node.public_key !== 'string' || !/^[0-9a-f]{64}$/i.test(node.public_key) || /^0+$/.test(node.public_key)) {
      throw new Error('Некорректный публичный ключ в nodes[' + index + ']');
    }
    const key = node.public_key.toLowerCase();
    if (keys.has(key)) throw new Error('Повторяющийся публичный ключ: ' + key);
    keys.add(key);
    const status = ['local', 'responded', 'unresponsive', 'discovered'].includes(node.status)
      ? node.status : 'other';
    counts[status]++;
  }
  return { total: data.nodes.length, active: counts.local + counts.responded, ...counts };
}

function renderReport(data, args) {
  const s = summarize(data);
  const percent = count => s.total ? (count / s.total * 100).toFixed(2).replace('.', ',') + ' %' : '0,00 %';
  const inline = value => String(value).replace(/[\r\n`]/g, ' ');
  const lines = [
    '# Результат обхода Yggdrasil', '',
    'Источник: `' + inline(args.input) + '`. Подсчёт выполнен по массиву `nodes`, включая локальную ноду.', '',
    '| Показатель | Количество | Доля |',
    '| --- | ---: | ---: |',
    `| Всего найдено уникальных нод | ${s.total} | ${percent(s.total)} |`,
    `| Активные (local + responded) | ${s.active} | ${percent(s.active)} |`,
    `| Неактивные по результатам опроса (unresponsive) | ${s.unresponsive} | ${percent(s.unresponsive)} |`,
    `| Обнаружены, проверка не завершена (discovered) | ${s.discovered} | ${percent(s.discovered)} |`,
    `| Неизвестный или отсутствующий статус | ${s.other} | ${percent(s.other)} |`, '',
    `Из активных: ${s.responded} удалённых нод ответили хотя бы на один debug-запрос; ${s.local} — локальных.`, '',
    'Активность здесь означает успешный ответ на `debug_remotegetpeers` или `debug_remotegettree`; локальная нода учитывается как активная. Статус `unresponsive` означает, что ни один из двух запросов не завершился успешно. Это не доказывает отключение ноды: возможны тайм-ауты, ошибки маршрутизации или недоступность debug-команд.', '',
    'Ноды со статусом `discovered` и неизвестными статусами не отнесены к неактивным. Один публичный ключ считается одной нодой, а не обязательно отдельным физическим устройством. Полнота охвата сети не гарантируется.', '',
    '## Данные запуска', ''
  ];
  if (data.updated_utc != null) lines.push('- Время сохранения снимка (UTC): `' + inline(data.updated_utc) + '`.');
  if (Number.isFinite(data.elapsed_seconds)) lines.push('- Продолжительность: ' + data.elapsed_seconds + ' с.');
  if (Number.isFinite(data.queried)) lines.push('- Завершённых проверок удалённых нод (`queried` из JSON): ' + data.queried + '.');
  const reasons = {
    no_more_discoveries: 'очередь исчерпана, новых ключей не найдено',
    interrupted: 'остановлено пользователем', time_limit: 'достигнут лимит времени',
    node_limit: 'достигнут лимит количества нод', error: 'ошибка', running: 'обход ещё выполнялся'
  };
  if (data.reason != null) lines.push('- Причина сохранения: `' + inline(data.reason) + '`' +
    (reasons[data.reason] ? ' — ' + reasons[data.reason] : '') + '.');
  if (data.resumed_from) lines.push('- Продолжение снимка: `' + inline(data.resumed_from) + '`. Результаты могут относиться к разным запускам.');
  if (args.command) lines.push('', 'Команда запуска, указанная при генерации отчёта (сам JSON её не хранит):', '',
    '```powershell', String(args.command).replace(/`/g, ''), '```');
  lines.push('', 'Отчёт создан `parse-result.js` по сохранённым данным, без повторного опроса сети.', '');
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (!args) {
      console.log(`Генерация Markdown-отчёта по снимку Yggdrasil.
Использование: node parse-result.js [параметры]
  --input FILE     Входной JSON (по умолчанию: ygg-nodes-js.json)
  --output FILE    Выходной Markdown (по умолчанию: result.md)
  --command TEXT   Необязательная команда запуска для включения в отчёт
  --help, -h       Справка
Существующий выходной файл перезаписывается.`);
      return 0;
    }
    const data = JSON.parse(fs.readFileSync(args.input, 'utf8').replace(/^\uFEFF/, ''));
    const report = renderReport(data, args);
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, report, 'utf8');
    console.log('Отчёт сохранён: ' + args.output);
    return 0;
  } catch (err) {
    console.error('Ошибка: ' + err.message);
    return 1;
  }
}

module.exports = { parseArgs, summarize, renderReport, main };
if (require.main === module) process.exitCode = main();
