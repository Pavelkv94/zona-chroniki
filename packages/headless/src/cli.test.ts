/**
 * Тесты headless-CLI (задача 0.6). Читаются как сценарии запуска мира из
 * консоли: оператор отдаёт приказы флагами, ядро прогоняется, наружу выходит
 * ОДИН детерминированный хэш истории.
 *
 * Три закона под прицелом:
 *  - №8 (детерминизм): один seed → одна история, в т.ч. МЕЖДУ процессами.
 *  - D-006: замер времени и флаг `--metrics` живут только в headless и НЕ
 *    трогают состояние мира — хэш от них не шевелится.
 *  - №7: длина суток берётся из `TICKS_PER_DAY`, а не из «1440» в коде.
 *
 * Фаза 0: реальных систем нет, поэтому лог событий пуст (`events === 0`).
 * Это зафиксировано намеренно — когда системы появятся, эти якоря должны
 * осознанно измениться, а не тихо разъехаться.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseArgs, runHeadless, type CliOptions } from './cli';

// ── Разбор приказов оператора ────────────────────────────────────────────────
describe('parseArgs: оператор задаёт условия прогона', () => {
  it('без флагов мир стартует на дефолтах: 1 день, seed 42, без метрик, без хроники', () => {
    expect(parseArgs([])).toEqual({ days: 1, seed: 42, metrics: false, logMode: 'none' });
  });

  it('полный приказ "--days 3 --seed 7 --metrics" читается целиком', () => {
    expect(parseArgs(['--days', '3', '--seed', '7', '--metrics'])).toEqual({
      days: 3,
      seed: 7,
      metrics: true,
      logMode: 'none',
    });
  });

  it('порядок флагов не меняет смысл приказа: прямой и обратный дают одно', () => {
    const forward = parseArgs(['--metrics', '--days', '3', '--seed', '7']);
    const reversed = parseArgs(['--seed', '7', '--days', '3', '--metrics']);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual({ days: 3, seed: 7, metrics: true, logMode: 'none' });
  });

  // ── Флаг --log (презентация, D-006) ────────────────────────────────────────
  it('--log verbose переключает режим хроники; дефолт — none', () => {
    expect(parseArgs(['--log', 'verbose']).logMode).toBe('verbose');
    expect(parseArgs(['--log', 'none']).logMode).toBe('none');
    expect(parseArgs([]).logMode).toBe('none');
  });

  it('--log с неизвестным режимом отвергается', () => {
    expect(() => parseArgs(['--log', 'loud'])).toThrow(/log/);
    expect(() => parseArgs(['--log'])).toThrow(/log/);
  });

  it('булев --metrics срабатывает и в начале, и в хвосте приказа', () => {
    const head = parseArgs(['--metrics', '--days', '2']);
    const tail = parseArgs(['--days', '2', '--metrics']);
    expect(head.metrics).toBe(true);
    expect(tail.metrics).toBe(true);
    expect(head).toEqual(tail);
  });

  it('повторный флаг: последнее значение побеждает ("--days 2 --days 5" → 5)', () => {
    // Зафиксировано поведение «последний выигрывает» (switch перезаписывает opts).
    expect(parseArgs(['--days', '2', '--days', '5']).days).toBe(5);
    expect(parseArgs(['--seed', '1', '--seed', '9']).seed).toBe(9);
  });

  // ── Границы seed (uint32) ──────────────────────────────────────────────────
  it('seed на нижней и верхней границе uint32 (0 и 4294967295) допустим', () => {
    expect(parseArgs(['--seed', '0']).seed).toBe(0);
    expect(parseArgs(['--seed', '4294967295']).seed).toBe(0xffffffff);
  });

  it('seed за границами uint32 (-1 и 2^32) отвергается', () => {
    expect(() => parseArgs(['--seed', '-1'])).toThrow(/seed/);
    expect(() => parseArgs(['--seed', '4294967296'])).toThrow(/seed/);
  });

  // ── Валидация days ─────────────────────────────────────────────────────────
  it('дни не бывают отрицательными: "--days -1" отвергается', () => {
    expect(() => parseArgs(['--days', '-1'])).toThrow(/days/);
  });

  it('дни не бывают дробными: "--days 1.5" отвергается', () => {
    expect(() => parseArgs(['--days', '1.5'])).toThrow(/days/);
  });

  it('дни не бывают буквами: "--days abc" отвергается', () => {
    expect(() => parseArgs(['--days', 'abc'])).toThrow(/days/);
  });

  // ── Оборванные и битые приказы ─────────────────────────────────────────────
  it('оборванный "--days" в хвосте бросает, а не молча даёт NaN', () => {
    expect(() => parseArgs(['--days'])).toThrow(/days/);
    // Убеждаемся, что это именно ошибка, а не тихий NaN в результате.
    let opts: CliOptions | undefined;
    try {
      opts = parseArgs(['--days']);
    } catch {
      opts = undefined;
    }
    expect(opts).toBeUndefined();
  });

  it('оборванный "--seed" в хвосте бросает, а не молча даёт NaN', () => {
    expect(() => parseArgs(['--seed'])).toThrow(/seed/);
  });

  it('форма "--days=3" через "=" НЕ поддерживается → неизвестный аргумент', () => {
    // Документируем контракт парсера: значение отделяется только пробелом.
    // "--days=3" целиком не совпадает ни с одним case → падаем как на неизвестном флаге.
    expect(() => parseArgs(['--days=3'])).toThrow(/неизвестн/i);
    expect(() => parseArgs(['--seed=7'])).toThrow(/неизвестн/i);
  });

  it('незнакомый флаг отвергается с человекочитаемой подсказкой', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/неизвестн/i);
  });

  // ── Верхняя граница days (ЗАКРЫТАЯ дыра, findings QA / MEDIUM) ─────────────
  it('--days без верхней границы больше НЕ проходит: переполняющее значение отвергается', () => {
    // Прежде seed был ограничен uint32, а days — нет: астрономический ввод
    // (или опечатка в sim:100days) давал ticks = days*TICKS_PER_DAY сверх
    // Number.MAX_SAFE_INTEGER → тихое округление и бесконечный scheduler.run.
    // Теперь parseArgs бросает ДО умножения. Проверяем throw на переполнении:
    expect(() => parseArgs(['--days', '99999999999999999999'])).toThrow(/days/);
    // Ровно на 1 сверх безопасного максимума floor(MAX_SAFE/1440) — тоже throw.
    const maxDays = Math.floor(Number.MAX_SAFE_INTEGER / 1440);
    expect(() => parseArgs(['--days', String(maxDays + 1)])).toThrow(/days/);
  });

  it('большое-но-безопасное days (ровно на границе) валидируется без throw', () => {
    // Граница floor(MAX_SAFE/TICKS_PER_DAY): days*1440 ещё в пределах MAX_SAFE.
    // Прогон НЕ запускаем (он был бы неподъёмным) — проверяем ТОЛЬКО разбор.
    const maxDays = Math.floor(Number.MAX_SAFE_INTEGER / 1440);
    expect(parseArgs(['--days', String(maxDays)])).toEqual({
      days: maxDays,
      seed: 42,
      metrics: false,
      logMode: 'none',
    });
  });
});

// ── Детерминизм прогона ──────────────────────────────────────────────────────
describe('runHeadless: одна история из одного seed (закон №8)', () => {
  const base: CliOptions = { days: 1, seed: 42, metrics: false, logMode: 'none' };

  it('два прогона одного мира дают побитово один и тот же хэш', () => {
    expect(runHeadless(base).snapshotHash).toBe(runHeadless(base).snapshotHash);
  });

  it('ЖИВОЙ мир: days=1/seed=42 порождает события (мир что-то делает, events > 0)', () => {
    // Фаза 1 (1.12): worldgen + 9 систем. Лог больше НЕ пуст — сталкеры выбирают
    // задачи, ходят, охотятся, гибнут; погода меняется; стада плодятся.
    const r = runHeadless(base);
    expect(r.events).toBeGreaterThan(0);
  });

  it('days=2 воспроизводим и лог живого мира непуст', () => {
    const a = runHeadless({ ...base, days: 2, seed: 7 });
    const b = runHeadless({ ...base, days: 2, seed: 7 });
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.events).toBeGreaterThan(0);
    expect(a.events).toBe(b.events);
  });

  it('четыре разных seed дают четыре разных истории (попарно различны)', () => {
    const seeds = [1, 2, 7, 99];
    const hashes = seeds.map((seed) => runHeadless({ ...base, seed }).snapshotHash);
    expect(new Set(hashes).size).toBe(seeds.length);
  });

  it('days=0 → ноль тиков планировщика, но worldgen уже населил мир (хэш валиден и стабилен)', () => {
    // days=0: систем НЕ прогоняем (0 тиков), но worldgen отработал при сборке —
    // события шины он не публикует (генезис — корень причинности, D-021), так что
    // лог пуст, а хэш детерминирован населённым, но ещё не «ожившим» миром.
    const r = runHeadless({ ...base, days: 0 });
    expect(r.events).toBe(0);
    expect(r.snapshotHash).toMatch(/^[0-9a-f]{8}$/);
    expect(r.snapshotHash).toBe(runHeadless({ ...base, days: 0 }).snapshotHash);
  });

  it('десять дней (14400 тиков) прогоняются без NaN и дают валидный хэш живого мира', () => {
    const r = runHeadless({ ...base, days: 10 });
    expect(r.snapshotHash).toMatch(/^[0-9a-f]{8}$/);
    expect(Number.isNaN(r.ms)).toBe(false);
    expect(r.events).toBeGreaterThan(0);
  });

  // ── ГОЛДЕНЫ живого CLI (закреплены задачей 1.12; core-голден 481914ae не тронут) ─
  it('ГОЛДЕН: day=1 seed=42 → 8a8faff4 (тот же прогон, что npm run smoke)', () => {
    // Якорь истории живого мира за один день. Смена значит: поведение систем
    // ИЛИ порядок ИЛИ worldgen изменились — обновлять ОСОЗНАННО, не молча.
    // Пере-закреплён balance-analyst-сессией (Фаза 1): смягчение спирали смерти
    // сменило константы (THIRST_PER_TICK, boar melee, gestationTicks) → новый
    // живой мир, новый хэш (e04c0d77 → 8a8faff4). См. docs/reports/phase1-balance.md.
    expect(runHeadless({ ...base, days: 1, seed: 42 }).snapshotHash).toBe('8a8faff4');
  });

  it(
    'ГОЛДЕН: day=100 seed=42 → f4cc990d (тот же прогон, что npm run sim:100days)',
    () => {
      // Пере-закреплён balance-analyst-сессией (см. day=1 голден выше):
      // 925aa279 → f4cc990d, events≈409424 (мир живее — приплод/охота идут дольше).
      expect(runHeadless({ ...base, days: 100, seed: 42 }).snapshotHash).toBe('f4cc990d');
    },
    30000,
  );

  // ── Детерминизм живого мира на НЕСКОЛЬКИХ seed ──────────────────────────────
  it('каждый seed воспроизводим: два прогона (42,7,999) за 10 дней идентичны', () => {
    for (const seed of [42, 7, 999]) {
      const a = runHeadless({ ...base, days: 10, seed });
      const b = runHeadless({ ...base, days: 10, seed });
      expect(a.snapshotHash, `seed=${seed}: два прогона обязаны совпасть`).toBe(b.snapshotHash);
      expect(a.events).toBe(b.events);
    }
  }, 30000);

  it('РАЗНЫЕ seed → РАЗНЫЕ истории: мир реально зависит от seed (42≠7≠999)', () => {
    const hashes = [42, 7, 999].map((seed) => runHeadless({ ...base, days: 10, seed }).snapshotHash);
    expect(new Set(hashes).size).toBe(3);
  }, 20000);

  it('НАДЁЖНОСТЬ: прогоны не делят изменяемое состояние — результат не зависит от предыстории', () => {
    // Прогоняем чужой seed, затем целевой; сравниваем с «чистым» целевым прогоном.
    const clean = runHeadless({ ...base, days: 2, seed: 7 }).snapshotHash;
    runHeadless({ ...base, days: 5, seed: 123 }); // «шум» между вызовами
    runHeadless({ ...base, days: 1, seed: 999 });
    const afterNoise = runHeadless({ ...base, days: 2, seed: 7 }).snapshotHash;
    expect(afterNoise).toBe(clean);
  });
});

// ── Детерминизм МЕЖДУ процессами ─────────────────────────────────────────────
describe('runHeadless: одинаковый хэш и в новом процессе (закон №8)', () => {
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const tsxBin = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

  const runCli = (args: string[]): string =>
    execFileSync(tsxBin, [cliPath, ...args], { encoding: 'utf8' }).trim();

  it(
    'CLI, запущенный дважды в отдельных процессах, печатает идентичный хэш',
    () => {
      const first = runCli(['--days', '2', '--seed', '7']);
      const second = runCli(['--days', '2', '--seed', '7']);
      expect(first).toMatch(/^[0-9a-f]{8}$/);
      expect(first).toBe(second);
    },
    30000,
  );

  it(
    'хэш из отдельного процесса совпадает с in-process runHeadless (нет скрытой зависимости от процесса)',
    () => {
      const inProcess = runHeadless({ days: 2, seed: 7, metrics: false, logMode: 'none' }).snapshotHash;
      const subprocess = runCli(['--days', '2', '--seed', '7']);
      expect(subprocess).toBe(inProcess);
    },
    30000,
  );
});

// ── Инвариант D-006 ──────────────────────────────────────────────────────────
describe('D-006: метрики, замер времени и режим лога не касаются состояния мира', () => {
  it('metrics=true и metrics=false дают ОДИН И ТОТ ЖЕ хэш и одинаковый лог', () => {
    const withM = runHeadless({ days: 2, seed: 7, metrics: true, logMode: 'none' });
    const without = runHeadless({ days: 2, seed: 7, metrics: false, logMode: 'none' });
    expect(withM.snapshotHash).toBe(without.snapshotHash);
    expect(withM.events).toBe(without.events);
  });

  it('логи verbose и none дают ОДИН И ТОТ ЖЕ хэш (презентация не влияет, D-006)', () => {
    const verbose = runHeadless({ days: 2, seed: 7, metrics: false, logMode: 'verbose' });
    const none = runHeadless({ days: 2, seed: 7, metrics: false, logMode: 'none' });
    expect(verbose.snapshotHash).toBe(none.snapshotHash);
    expect(verbose.events).toBe(none.events);
    // verbose даёт строки хроники, none — нет.
    expect(verbose.logLines).toBeDefined();
    expect(none.logLines).toBeUndefined();
    expect((verbose.logLines ?? []).length).toBeGreaterThan(0);
  });

  it('инвариант держится на наборе (days, seed): {(0,42),(1,42),(2,7),(3,99),(5,999)}', () => {
    const cases: Array<[number, number]> = [
      [0, 42],
      [1, 42],
      [2, 7],
      [3, 99],
      [5, 999],
    ];
    for (const [days, seed] of cases) {
      // Три презентационных профиля обязаны дать ОДИН И ТОТ ЖЕ хэш: чистый,
      // с метриками и с verbose-хроникой (D-006 — вывод/тайминг вне мира).
      const plain = runHeadless({ days, seed, metrics: false, logMode: 'none' });
      const metrics = runHeadless({ days, seed, metrics: true, logMode: 'none' });
      const verbose = runHeadless({ days, seed, metrics: false, logMode: 'verbose' });
      const tag = `days=${days} seed=${seed}`;
      expect(metrics.snapshotHash, `${tag}: --metrics не должен менять мир`).toBe(plain.snapshotHash);
      expect(verbose.snapshotHash, `${tag}: --log verbose не должен менять мир`).toBe(plain.snapshotHash);
      // ms — презентационная величина: неотрицательна и в любом профиле.
      expect(plain.ms, `${tag}: ms>=0`).toBeGreaterThanOrEqual(0);
      expect(verbose.ms, `${tag}: ms>=0`).toBeGreaterThanOrEqual(0);
    }
  }, 20000);

  it('ms — неотрицательное число и не участвует в хэше', () => {
    const r = runHeadless({ days: 1, seed: 42, metrics: true, logMode: 'none' });
    expect(typeof r.ms).toBe('number');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.snapshotHash).toBe(
      runHeadless({ days: 1, seed: 42, metrics: false, logMode: 'none' }).snapshotHash,
    );
  });
});
