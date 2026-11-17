#!/usr/bin/env node
/**
 * Замер скорости скачивания: N последовательных запросов к одному адресу.
 *
 * Использование:
 *   node speedtest.mjs <url> [--requests N]
 *
 * Единицы: время — секунды, объём — МиБ (1 МиБ = 1 048 576 байт),
 * скорость — Мбит/с (1 Мбит/с = 1 000 000 бит/с).
 */

const DEFAULT_REQUESTS = 10;

// --- разбор аргументов командной строки ---
const args = process.argv.slice(2);
const url = args[0];

const requestsIdx = args.indexOf("--requests");
let requests = DEFAULT_REQUESTS;
if (requestsIdx !== -1) {
  const parsed = Number(args[requestsIdx + 1]);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    console.error("--requests: ожидается целое число от 1 до 1000");
    process.exit(1);
  }
  requests = parsed;
}

if (!url) {
  console.error('Использование: node speedtest.mjs <url> [--requests N]\nПример: node speedtest.mjs "https://speed.cloudflare.com/__down?bytes=25000000"');
  process.exit(1);
}

const average = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

async function main() {
  console.log(`Адрес: ${url}`);
  console.log(`Запросов: ${requests}, последовательно\n`);

  const perRequestMs = [];
  let totalBytes = 0;
  const wallStart = performance.now(); // общее время меряем от первого запроса до последнего ответа

  for (let i = 1; i <= requests; i++) {
    const start = performance.now();

    let response;
    try {
      response = await fetch(url);
    } catch (err) {
      console.error(`Запрос ${i}: ошибка сети (${err.cause?.code || err.message})`);
      process.exit(1);
    }
    if (!response.ok) {
      console.error(`Запрос ${i}: сервер вернул HTTP ${response.status}`);
      process.exit(1);
    }

    // arrayBuffer() разрешается только когда тело скачано целиком
    const body = await response.arrayBuffer();
    const elapsedMs = performance.now() - start;

    perRequestMs.push(elapsedMs);
    totalBytes += body.byteLength;

    console.log(`#${i}: ${(elapsedMs / 1000).toFixed(2)} с, ${(body.byteLength / 1048576).toFixed(2)} МиБ`);
  }

  const wallSec = (performance.now() - wallStart) / 1000;
  // скорость = весь скачанный объём (в битах) / всё затраченное время (wall time)
  const mbitPerSec = (totalBytes * 8) / 1_000_000 / wallSec;

  console.log("\n— Итог —");
  console.log(`Среднее время запроса: ${(average(perRequestMs) / 1000).toFixed(2)} с`);
  console.log(`Скачано: ${(totalBytes / 1048576).toFixed(2)} МиБ`);
  console.log(`Общее время: ${wallSec.toFixed(2)} с`);
  console.log(`Скорость: ${mbitPerSec.toFixed(2)} Мбит/с`);
}

main();
