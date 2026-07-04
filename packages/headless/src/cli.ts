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
 * ── Фаза 1 (1.12): ЖИВОЙ МИР ─────────────────────────────────────────────────
 * Теперь CLI собирает НАСТОЯЩИЙ прогон: `createSimWorld(seed)` → `worldgen`
 * (заселение) → `registerPhase1Systems` (все 9 систем в каноническом порядке,
 * D-032) → `scheduler.run`. Лог больше НЕ пуст (`events > 0`), хэш — хэш живого
 * мира. Порядок систем — единственный источник детерминизма причинности; он
 * фиксирован в `@zona/sim/pipeline`, CLI лишь оркестрирует.
 *
 * ── Флаг `--log verbose` (ПРЕЗЕНТАЦИЯ, D-006) ────────────────────────────────
 * Печатает человекочитаемую хронику по логу ПОСЛЕ прогона (render.ts). Это
 * чистое чтение финального мира: хэш с `--log verbose` и без ОБЯЗАН совпасть,
 * как и с `--metrics` (мир не зависит от вывода). Дефолт — `none` (только хэш).
 */

import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  createSimWorld,
  createScheduler,
  registerPhase1Systems,
  worldgen,
  serialize,
  hashSnapshot,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import { renderEventLog } from './render';
import { worldTotals, assertEconomyInvariant, type EconTotals } from './economy-invariant';

/** Режим печати лога событий (ПРЕЗЕНТАЦИЯ, D-006 — не влияет на мир/хэш). */
export type LogMode = 'none' | 'verbose';

/** Разобранные опции командной строки. */
export interface CliOptions {
  /** Сколько игровых суток прогнать (целое >= 0). Тиков = days * TICKS_PER_DAY. */
  days: number;
  /** Seed мира (uint32). Одинаковый seed → одинаковый хэш (закон №8). */
  seed: number;
  /** Печатать ли метрики (events, ms) помимо хэша. НЕ влияет на состояние мира. */
  metrics: boolean;
  /**
   * Режим рендера лога: `none` (по умолчанию — только хэш) или `verbose`
   * (человекочитаемая хроника). ЧИСТАЯ презентация: хэш от режима НЕ зависит
   * (инвариант D-006, как `metrics`).
   */
  logMode: LogMode;
}

/** Дефолты опций: один день, seed 42, без метрик, без хроники. */
const DEFAULT_OPTIONS: CliOptions = { days: 1, seed: 42, metrics: false, logMode: 'none' };

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
      case '--log': {
        const mode = argv[++i];
        if (mode !== 'none' && mode !== 'verbose') {
          throw new RangeError(
            `CLI: --log ожидает "none" или "verbose", получено "${mode ?? ''}".`,
          );
        }
        opts.logMode = mode;
        break;
      }
      default:
        throw new RangeError(
          `CLI: неизвестный аргумент "${arg}". Допустимо: ` +
            `--days <N>, --seed <N>, --metrics, --log <none|verbose>.`,
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
  /**
   * Человекочитаемая хроника (строки), если `opts.logMode === 'verbose'`, иначе
   * `undefined`. Чистая ПРЕЗЕНТАЦИЯ: строится ЧТЕНИЕМ финального мира ПОСЛЕ хэша
   * и на хэш не влияет (D-006).
   */
  logLines?: readonly string[];
}

/**
 * Собирает ЖИВОЙ мир Фазы 1: пустой `SimWorld(seed)` → `worldgen` (заселение
 * сталкерами/животными/часами) → планировщик со всеми системами в каноническом
 * порядке (`registerPhase1Systems`, инвариант D-032). Вынесено, чтобы прогон и
 * resume-тесты собирали конвейер ОДНИМ способом (порядок систем — единый).
 */
function buildWorld(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed);
  worldgen(world); // ДО первого тика: населяем Зону (1.3)
  const scheduler = createScheduler();
  registerPhase1Systems(scheduler); // все 9 систем, канон B.1/D-032
  return { world, scheduler };
}

/**
 * Прогоняет ЖИВОЙ мир на `days * TICKS_PER_DAY` тиков и возвращает хэш снапшота.
 * Замер `ms` окружает ТОЛЬКО `scheduler.run` (D-006) и не попадает в мир/хэш.
 * `metrics` тут не читается: он влияет лишь на печать в {@link main}; сам прогон
 * от него не зависит (инвариант D-006). Хроника (`logLines`) строится ПОСЛЕ хэша
 * ЧТЕНИЕМ мира — тоже вне хэша (презентация, D-006).
 *
 * ── ПРЕДОХРАНИТЕЛЬ EconomyInvariant (задача 2.0, D-045) ──────────────────────
 * `baseline` = `worldTotals` сразу ПОСЛЕ worldgen (t0), ДО первого тика (стартовая
 * масса — базлайн, не леджер). Прогон идёт ПО-ДНЕВНО (chunk = TICKS_PER_DAY): это
 * поведенчески тождественно одному `scheduler.run(ticks)` (tickOnce не хранит
 * межвызовного состояния), но даёт read-only проверку РАЗ В ИГРОВОЙ ДЕНЬ — так
 * дыра в законе №3 (масса вне леджера) ловится MID-RUN, а не только в конце.
 * Чекер вне мира/хэша (D-045/D-006): при нарушении он БРОСАЕТ (роняет процесс) и
 * не даёт молча продолжить. `ms` покрывает весь дневной цикл прогона.
 */
export function runHeadless(opts: CliOptions): RunResult {
  const { world, scheduler } = buildWorld(opts.seed);

  // БАЗЛАЙН массы: снимок Σ money + Σ inventory ПОСЛЕ worldgen, ДО тиков (D-045).
  const baseline: EconTotals = worldTotals(world);

  const start = performance.now();
  // Прогон по-дневно: после КАЖДОГО игрового дня сверяем массу мира с леджером
  // (предохранитель ловит mid-run дыру). Тождественно одному run(days*TICKS_PER_DAY).
  for (let day = 0; day < opts.days; day++) {
    scheduler.run(world, TICKS_PER_DAY);
    assertEconomyInvariant(world, world.bus, baseline, world.tick);
  }
  // Финальная сверка (покрывает days=0: тиков нет ⇒ totals == baseline, леджер пуст).
  assertEconomyInvariant(world, world.bus, baseline, world.tick);
  const ms = performance.now() - start;

  const snap = serialize(world);
  const result: RunResult = {
    snapshotHash: hashSnapshot(snap),
    events: snap.eventLog.length,
    ms,
  };
  // Рендер — чистое чтение уже зафиксированного мира (после serialize/hash),
  // поэтому на хэш не влияет (D-006). Строим только по запросу (verbose).
  if (opts.logMode === 'verbose') {
    result.logLines = renderEventLog(world);
  }
  return result;
}

/**
 * Точка входа при запуске файла как CLI. Печать: при `--metrics` — хэш, число
 * событий и длительность; без него — только детерминированная строка хэша.
 * ВАЖНО: вычисления мира от `metrics` не зависят, только вывод/замер.
 */
export function main(argv: readonly string[]): void {
  const opts = parseArgs(argv);
  const result = runHeadless(opts);
  // Хроника (verbose) печатается ПЕРВОЙ — как читаемый лог событий мира, затем
  // идёт машинная сводка/хэш. Презентация не влияет на хэш (D-006).
  if (result.logLines !== undefined) {
    for (const line of result.logLines) console.log(line);
  }
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
