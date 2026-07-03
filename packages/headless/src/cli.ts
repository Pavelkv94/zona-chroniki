/**
 * @module @zona/headless/cli
 *
 * Headless CLI (задача 0.6) — точка входа для прогона ядра из Node без UI.
 * Разбирает флаги `--days`, `--seed`, `--metrics`, прогоняет планировщик на
 * `days * TICKS_PER_DAY` тиков и печатает детерминированный хэш снапшота.
 *
 * ── D-006 / закон №8 (детерминизм) ──────────────────────────────────────────
 * Замер времени живёт ТОЛЬКО здесь (`@zona/headless` — единственный пакет с
 * `types:["node"]`). `@zona/sim` времени не знает и решений на его основе не
 * принимает. Поэтому длительность прогона (`ms`) НЕ участвует в состоянии мира
 * и НЕ влияет на `snapshotHash`. Флаг `--metrics` меняет ТОЛЬКО печать/замер —
 * набор вычислений мира от него не зависит (инвариант D-006, покрыт тестом).
 *
 * ── Закон №7 (константы) ─────────────────────────────────────────────────────
 * «Тиков в дне» — балансовая константа `TICKS_PER_DAY` из `@zona/sim/balance`,
 * а не магическое число 1440 в коде CLI.
 *
 * ── Фаза 0 ───────────────────────────────────────────────────────────────────
 * Реальных систем ещё нет: планировщик создаётся пустым и прогоняет пустые тики.
 * Это ок — CLI прогоняет ядро (rng/шина/мир существуют) и печатает воспроизводимый
 * хэш. Настоящие системы регистрируются в следующих фазах.
 */

import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  createSimWorld,
  createScheduler,
  serialize,
  hashSnapshot,
  TICKS_PER_DAY,
} from '@zona/sim';

/** Разобранные опции командной строки. */
export interface CliOptions {
  /** Сколько игровых суток прогнать (целое >= 0). Тиков = days * TICKS_PER_DAY. */
  days: number;
  /** Seed мира (uint32). Одинаковый seed → одинаковый хэш (закон №8). */
  seed: number;
  /** Печатать ли метрики (events, ms) помимо хэша. НЕ влияет на состояние мира. */
  metrics: boolean;
}

/** Дефолты опций: один день, seed 42, без метрик. */
const DEFAULT_OPTIONS: CliOptions = { days: 1, seed: 42, metrics: false };

/** Верхняя граница uint32 для seed (включительно). */
const UINT32_MAX = 0xffffffff;

/**
 * Строгий разбор целого из аргумента флага: принимает только `^-?\d+$`
 * (никаких `1.5`, `abc`, `0x10`, пробелов). Иначе — понятный throw с именем флага.
 */
function parseIntStrict(raw: string | undefined, flag: string): number {
  if (raw === undefined) {
    throw new RangeError(`CLI: флаг ${flag} требует числовое значение.`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new RangeError(`CLI: ${flag} ожидает целое число, получено "${raw}".`);
  }
  return Number(raw);
}

/**
 * Разбирает `process.argv.slice(2)`. Флаги: `--days N`, `--seed N`,
 * `--metrics` (булев). Дефолты — {@link DEFAULT_OPTIONS}. Валидация:
 * `days` — целое >= 0; `seed` — целое в диапазоне uint32 [0, 2^32-1].
 * Неизвестный флаг → throw с подсказкой.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULT_OPTIONS };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--days': {
        opts.days = parseIntStrict(argv[++i], '--days');
        break;
      }
      case '--seed': {
        opts.seed = parseIntStrict(argv[++i], '--seed');
        break;
      }
      case '--metrics': {
        opts.metrics = true;
        break;
      }
      default:
        throw new RangeError(
          `CLI: неизвестный аргумент "${arg}". Допустимо: ` +
            `--days <N>, --seed <N>, --metrics.`,
        );
    }
  }

  if (!Number.isInteger(opts.days) || opts.days < 0) {
    throw new RangeError(
      `CLI: --days=${opts.days}; требуется целое число дней >= 0.`,
    );
  }
  // Верхняя граница days (симметрично uint32-границе seed). Без неё огромный
  // `--days` (например, опечатка в sim:100days) дал бы `ticks = days*TICKS_PER_DAY`
  // сверх Number.MAX_SAFE_INTEGER → тихое округление и практически бесконечный
  // цикл в scheduler.run. Считаем границу как floor(MAX_SAFE / TICKS_PER_DAY),
  // чтобы САМА проверка не переполнилась. `Number.isInteger` уже отсёк значения
  // > MAX_SAFE (они не целые в double), но оставляем явный смысл в сообщении.
  const MAX_DAYS = Math.floor(Number.MAX_SAFE_INTEGER / TICKS_PER_DAY);
  if (opts.days > MAX_DAYS) {
    throw new RangeError(
      `CLI: --days=${opts.days}; слишком велико — days*TICKS_PER_DAY превысит ` +
        `безопасный предел. Максимум days = ${MAX_DAYS}.`,
    );
  }
  if (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed > UINT32_MAX) {
    throw new RangeError(
      `CLI: --seed=${opts.seed}; требуется целое в диапазоне uint32 ` +
        `[0, ${UINT32_MAX}].`,
    );
  }

  return opts;
}

/** Результат прогона: хэш снапшота, число событий в логе и длительность (мс). */
export interface RunResult {
  /** Детерминированный хэш итогового снапшота (закон №8). */
  snapshotHash: string;
  /** Длина append-only лога событий (`snap.eventLog.length`). */
  events: number;
  /** Длительность `scheduler.run` в миллисекундах (D-006: НЕ в хэше). */
  ms: number;
}

/**
 * Прогоняет ядро на `days * TICKS_PER_DAY` тиков и возвращает хэш снапшота.
 * Замер `ms` окружает ТОЛЬКО `scheduler.run` (D-006) и не попадает в мир/хэш.
 * `metrics` тут не читается: он влияет лишь на печать в {@link main}; сам прогон
 * от него не зависит (инвариант D-006).
 */
export function runHeadless(opts: CliOptions): RunResult {
  const world = createSimWorld(opts.seed);
  const scheduler = createScheduler(); // Фаза 0: систем нет — пустые тики.
  const ticks = opts.days * TICKS_PER_DAY;

  const start = performance.now();
  scheduler.run(world, ticks);
  const ms = performance.now() - start;

  const snap = serialize(world);
  return {
    snapshotHash: hashSnapshot(snap),
    events: snap.eventLog.length,
    ms,
  };
}

/**
 * Точка входа при запуске файла как CLI. Печать: при `--metrics` — хэш, число
 * событий и длительность; без него — только детерминированная строка хэша.
 * ВАЖНО: вычисления мира от `metrics` не зависят, только вывод/замер.
 */
export function main(argv: readonly string[]): void {
  const opts = parseArgs(argv);
  const result = runHeadless(opts);
  if (opts.metrics) {
    console.log(`hash=${result.snapshotHash}`);
    console.log(`events=${result.events}`);
    console.log(`ms=${result.ms.toFixed(3)}`);
  } else {
    console.log(result.snapshotHash);
  }
}

/**
 * true, если модуль запущен напрямую (`tsx cli.ts`), а не импортирован тестом.
 * Сравниваем реальный путь `process.argv[1]` с путём этого модуля (учёт симлинков
 * workspaces). При любой ошибке резолва считаем, что не main (безопасно для тестов).
 */
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2));
}
