#!/usr/bin/env node
/**
 * download-speed-test — последовательный замер скорости скачивания.
 *
 * Использование:
 *   node speedtest.mjs <url> [--requests N] [--timeout SECONDS]
 *
 * Единицы:
 *   время    — секунды;
 *   объём    — МиБ (1 МиБ = 1 048 576 байт);
 *   скорость — Мбит/с (1 Мбит/с = 1 000 000 бит/с).
 */

const DEFAULT_REQUESTS = 10;
const MAX_REQUESTS = 1000;
const MAX_TIMEOUT_SECONDS = 86_400; // сутки
const MIB = 1024 * 1024;
const MBIT = 1_000_000;

const HELP = `Замер скорости скачивания: N последовательных запросов к одному URL.

Использование:
  node speedtest.mjs <url> [параметры]

Параметры:
  -n, --requests N   число запросов, целое от 1 до ${MAX_REQUESTS} (по умолчанию ${DEFAULT_REQUESTS})
      --timeout SEC  таймаут одного запроса в секундах (по умолчанию без ограничения)
  -h, --help         показать эту справку

Единицы:
  объём    — МиБ (1 МиБ = 1 048 576 байт);
  скорость — Мбит/с (1 Мбит/с = 1 000 000 бит/с).

Пример:
  node speedtest.mjs "https://speed.cloudflare.com/__down?bytes=25000000"`;

class UsageError extends Error {}

/**
 * Разбирает аргументы командной строки.
 * Флаги можно ставить до или после URL, поддерживаются формы --flag value и --flag=value.
 */
function parseArgs(argv) {
  const options = {
    url: null,
    requests: DEFAULT_REQUESTS,
    timeoutMs: 0,
    help: false,
  };

  if (argv.includes("-h") || argv.includes("--help")) {
    options.help = true;
    return options;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-n" || arg === "--requests" || arg.startsWith("--requests=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const requests = Number(value);

      if (!Number.isInteger(requests) || requests < 1 || requests > MAX_REQUESTS) {
        throw new UsageError(
          `--requests: нужно целое число от 1 до ${MAX_REQUESTS}, получено «${value ?? ""}»`
        );
      }
      options.requests = requests;
      continue;
    }

    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const seconds = Number(value);

      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_TIMEOUT_SECONDS) {
        throw new UsageError(
          `--timeout: нужно число секунд больше 0 и не больше ${MAX_TIMEOUT_SECONDS}, ` +
            `получено «${value ?? ""}»`
        );
      }
      options.timeoutMs = Math.max(1, Math.round(seconds * 1000));
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageError(`неизвестный параметр «${arg}»`);
    }

    if (options.url !== null) {
      throw new UsageError("адрес можно указать только один раз");
    }
    options.url = arg;
  }

  if (options.url === null) {
    throw new UsageError("не указан адрес");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(options.url);
  } catch {
    throw new UsageError(
      `некорректный URL: «${options.url}» (нужен полный адрес с http:// или https://)`
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new UsageError(
      `поддерживаются только http:// и https://, получено «${parsedUrl.protocol}»`
    );
  }

  options.url = parsedUrl;
  return options;
}

/**
 * Делает один GET-запрос и полностью вычитывает тело ответа.
 * Тело не сохраняется в памяти: байты считаются по мере прихода чанков.
 *
 * @returns {Promise<{bytes: number, seconds: number}>}
 */
async function downloadOnce(url, timeoutMs) {
  const startedAt = performance.now();
  const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

  const response = await fetch(url, {
    signal,
    // Просим не сжимать ответ: иначе Node.js распакует тело,
    // и мы посчитаем больше байт, чем реально пришло по сети.
    headers: { "accept-encoding": "identity" },
  });

  if (!response.ok) {
    if (response.body) {
      await response.body.cancel().catch(() => {});
    }
    const status = response.statusText
      ? `HTTP ${response.status} ${response.statusText}`
      : `HTTP ${response.status}`;
    throw new Error(status);
  }

  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }

  return {
    bytes,
    seconds: (performance.now() - startedAt) / 1000,
  };
}

/** Превращает ошибку fetch в короткое понятное сообщение. */
function describeError(error) {
  if (error?.name === "TimeoutError") return "истёк таймаут запроса";
  if (error?.name === "AbortError") return "запрос прерван";

  const cause = error?.cause;
  if (cause?.code) {
    return cause.message ? `${cause.code} (${cause.message})` : cause.code;
  }
  if (cause?.message) return cause.message;
  return error?.message ?? String(error);
}

const formatSeconds = (seconds) => seconds.toFixed(2);
const formatMib = (bytes) => (bytes / MIB).toFixed(2);
const formatSpeed = (mbitPerSecond) => mbitPerSecond.toFixed(2);

/** Выполняет замер и печатает результат. */
async function run({ url, requests, timeoutMs }) {
  console.log("Замер скорости скачивания");
  console.log(`Адрес: ${url.href}`);
  console.log(`Запросов: ${requests} (последовательно)`);
  console.log(
    timeoutMs > 0
      ? `Таймаут запроса: ${timeoutMs / 1000} с`
      : "Таймаут запроса: без ограничения"
  );
  console.log("");

  const durations = [];
  let totalBytes = 0;

  for (let i = 1; i <= requests; i++) {
    let result;
    try {
      result = await downloadOnce(url, timeoutMs);
    } catch (error) {
      throw new Error(`запрос ${i} из ${requests}: ${describeError(error)}`);
    }

    if (result.bytes === 0) {
      throw new Error(`запрос ${i} из ${requests}: сервер вернул 0 байт`);
    }

    durations.push(result.seconds);
    totalBytes += result.bytes;

    const speed = (result.bytes * 8) / MBIT / result.seconds;
    console.log(
      `#${i}: ${formatSeconds(result.seconds)} с, ` +
        `${formatMib(result.bytes)} МиБ, ` +
        `${formatSpeed(speed)} Мбит/с`
    );
  }

  // Скорость считаем по сумме времён самих запросов, без пауз на печать
  // и прочую локальную работу между запросами.
  const totalSeconds = durations.reduce((sum, value) => sum + value, 0);
  const averageSeconds = totalSeconds / durations.length;
  const totalSpeed = (totalBytes * 8) / MBIT / totalSeconds;

  console.log("\n— Итог —");
  console.log(`Среднее время запроса: ${formatSeconds(averageSeconds)} с`);
  console.log(
    `Скачано всего: ${formatMib(totalBytes)} МиБ ` +
      `(${totalBytes.toLocaleString("ru-RU")} байт)`
  );
  console.log(`Суммарное время запросов: ${formatSeconds(totalSeconds)} с`);
  console.log(`Скорость скачивания: ${formatSpeed(totalSpeed)} Мбит/с`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(HELP);
    return;
  }

  await run(options);
}

if (typeof fetch !== "function") {
  console.error("Ошибка: нужен Node.js 18 или новее (встроенный fetch не найден).");
  process.exit(1);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`Ошибка: ${error.message}\n`);
    console.error(HELP);
  } else {
    console.error(`Ошибка: ${error.message}`);
  }
  process.exitCode = 1;
});
