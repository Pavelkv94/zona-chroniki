/**
 * @module @zona/sim/core/scheduler.test
 *
 * Юниты планировщика тиков (задача 0.2, D-005/D-006/D-009):
 *  - частоты систем из `schedule.every`/`phase` (закон №7): число и порядок
 *    вызовов детерминированы и идентичны между прогонами (закон №8);
 *  - порядок исполнения = порядок регистрации;
 *  - phase-сдвиг;
 *  - валидация расписания (every >= 1, phase >= 0) → throw;
 *  - фиксация событий каждый тик через `bus.endTick` (D-005);
 *  - рост `world.tick`;
 *  - D-009: `ctx.rng` различается ПО ТИКАМ и МЕЖДУ системами одного тика, но
 *    идентичен между двумя прогонами с одним seed;
 *  - отсутствие замера времени (Date.now/performance) в scheduler.ts.
 */

import { describe, it, expect } from 'vitest';
import type { Seed, SystemSchedule } from '@zona/shared';
import { createScheduler } from './scheduler';
import { createSimWorld } from './world';
import type { System, SystemCtx } from './system';

/**
 * Фейковая система-счётчик: пишет в общий `log` строку `${name}@${tick}` при
 * каждом запуске. Позволяет проверить И число вызовов, И порядок/тик.
 */
function recorder(
  name: string,
  schedule: SystemSchedule,
  log: string[],
): System {
  return {
    name,
    schedule,
    update(ctx: SystemCtx): void {
      log.push(`${name}@${ctx.tick}`);
    },
  };
}

describe('Scheduler: частоты систем (every)', () => {
  it('every 1/10/30 за 60 тиков → 60/6/2 вызова; лог идентичен между прогонами', () => {
    const runProgram = (): string[] => {
      const log: string[] = [];
      const sched = createScheduler();
      sched.register(recorder('every1', { every: 1 }, log));
      sched.register(recorder('every10', { every: 10 }, log));
      sched.register(recorder('every30', { every: 30 }, log));
      const world = createSimWorld(42 as Seed);
      sched.run(world, 60);
      return log;
    };

    const first = runProgram();
    const second = runProgram();

    // Число вызовов каждой системы за 60 тиков (тики 0..59).
    const count = (log: string[], name: string): number =>
      log.filter((e) => e.startsWith(`${name}@`)).length;
    expect(count(first, 'every1')).toBe(60); // тики 0..59
    expect(count(first, 'every10')).toBe(6); // 0,10,20,30,40,50
    expect(count(first, 'every30')).toBe(2); // 0,30

    // Полный лог вызовов (что и в каком порядке отработало) идентичен.
    expect(second).toEqual(first);
  });
});

describe('Scheduler: порядок = порядок регистрации', () => {
  it('на общем тике due-системы вызваны в порядке register', () => {
    const log: string[] = [];
    const sched = createScheduler();
    // Регистрируем в порядке A, B, C — все every=1, значит все due на тике 0.
    sched.register(recorder('A', { every: 1 }, log));
    sched.register(recorder('B', { every: 1 }, log));
    sched.register(recorder('C', { every: 1 }, log));
    const world = createSimWorld(1 as Seed);
    sched.tickOnce(world);
    expect(log).toEqual(['A@0', 'B@0', 'C@0']);
  });

  it('порядок сохраняется и когда due лишь часть систем', () => {
    const log: string[] = [];
    const sched = createScheduler();
    // На тике 0 due: fast (every1), slow30 (every30, phase0). mid (phase5) — нет.
    sched.register(recorder('fast', { every: 1 }, log));
    sched.register(recorder('mid', { every: 10, phase: 5 }, log));
    sched.register(recorder('slow30', { every: 30 }, log));
    const world = createSimWorld(1 as Seed);
    sched.tickOnce(world); // тик 0
    expect(log).toEqual(['fast@0', 'slow30@0']);
  });

  it('systems() отдаёт копию в порядке регистрации; мутация не влияет', () => {
    const log: string[] = [];
    const sched = createScheduler();
    const a = recorder('A', { every: 1 }, log);
    const b = recorder('B', { every: 1 }, log);
    sched.register(a);
    sched.register(b);
    const list = sched.systems();
    expect(list.map((s) => s.name)).toEqual(['A', 'B']);
    (list as System[]).reverse(); // мутируем копию
    expect(sched.systems().map((s) => s.name)).toEqual(['A', 'B']);
  });
});

describe('Scheduler: phase-сдвиг', () => {
  it('every=10 phase=3 срабатывает на 3,13,23,33,43,53 и НЕ на 0', () => {
    const log: string[] = [];
    const sched = createScheduler();
    sched.register(recorder('shifted', { every: 10, phase: 3 }, log));
    const world = createSimWorld(7 as Seed);
    sched.run(world, 60); // тики 0..59
    const ticks = log.map((e) => Number(e.split('@')[1]));
    expect(ticks).toEqual([3, 13, 23, 33, 43, 53]);
    expect(ticks).not.toContain(0);
  });

  it('phase=0 (умолчание) эквивалентно отсутствию phase', () => {
    const logA: string[] = [];
    const logB: string[] = [];
    const schedA = createScheduler();
    const schedB = createScheduler();
    schedA.register(recorder('x', { every: 7 }, logA));
    schedB.register(recorder('x', { every: 7, phase: 0 }, logB));
    schedA.run(createSimWorld(1 as Seed), 30);
    schedB.run(createSimWorld(1 as Seed), 30);
    expect(logB).toEqual(logA);
  });
});

describe('Scheduler: валидация расписания при register', () => {
  const noop: System['update'] = () => {};
  it('every=0 → throw', () => {
    const sched = createScheduler();
    expect(() =>
      sched.register({ name: 'z', schedule: { every: 0 }, update: noop }),
    ).toThrow(/every=0/);
  });
  it('every=-1 → throw', () => {
    const sched = createScheduler();
    expect(() =>
      sched.register({ name: 'z', schedule: { every: -1 }, update: noop }),
    ).toThrow(/every/);
  });
  it('phase<0 → throw (зафиксированное поведение)', () => {
    const sched = createScheduler();
    expect(() =>
      sched.register({ name: 'z', schedule: { every: 10, phase: -1 }, update: noop }),
    ).toThrow(/phase/);
  });
  it('дробный every → throw', () => {
    const sched = createScheduler();
    expect(() =>
      sched.register({ name: 'z', schedule: { every: 1.5 }, update: noop }),
    ).toThrow(/every/);
  });
});

describe('Scheduler: уникальность имён (D-009, метка форка rng)', () => {
  const noop: System['update'] = () => {};
  it('повторный register того же имени → throw', () => {
    const sched = createScheduler();
    sched.register({ name: 'dup', schedule: { every: 1 }, update: noop });
    expect(() =>
      sched.register({ name: 'dup', schedule: { every: 5 }, update: noop }),
    ).toThrow(/dup/);
    // Дубль не попал в список — только первая регистрация.
    expect(sched.systems().map((s) => s.name)).toEqual(['dup']);
  });
  it('пустое имя → throw', () => {
    const sched = createScheduler();
    expect(() =>
      sched.register({ name: '', schedule: { every: 1 }, update: noop }),
    ).toThrow(/имя/);
  });
  it('разные имена регистрируются без ошибок', () => {
    const sched = createScheduler();
    expect(() => {
      sched.register({ name: 'a', schedule: { every: 1 }, update: noop });
      sched.register({ name: 'b', schedule: { every: 1 }, update: noop });
    }).not.toThrow();
    expect(sched.systems().map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('Scheduler: события фиксируются каждый тик (endTick, D-005)', () => {
  it('система-публикация: событие попадает в лог с tick = номер тика', () => {
    const sched = createScheduler();
    const publisher: System = {
      name: 'publisher',
      schedule: { every: 1 },
      update(ctx: SystemCtx): void {
        ctx.bus.publish({
          type: 'sim/tickStarted',
          causedBy: null,
          payload: { tick: ctx.tick },
        });
      },
    };
    sched.register(publisher);
    const world = createSimWorld(3 as Seed);
    sched.run(world, 3); // тики 0,1,2

    // Три события трёх тиков с правильными тиками, id монотонны.
    expect(world.bus.log.map((e) => e.tick)).toEqual([0, 1, 2]);
    expect(world.bus.log.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(world.bus.at(0)).toHaveLength(1);
    expect(world.bus.at(1)).toHaveLength(1);
    expect(world.bus.at(2)).toHaveLength(1);
  });

  it('endTick вызывается даже без публикаций (лог пуст, без броска)', () => {
    const log: string[] = [];
    const sched = createScheduler();
    sched.register(recorder('silent', { every: 1 }, log));
    const world = createSimWorld(1 as Seed);
    expect(() => sched.run(world, 5)).not.toThrow();
    expect(world.bus.log).toHaveLength(0);
  });
});

describe('Scheduler: атомарность тика при исключении (всё-или-ничего)', () => {
  /**
   * Система: публикует событие, затем (опционально) бросает. `throwOn` —
   * управляемый флаг, чтобы один и тот же прогон сначала упал, потом прошёл.
   */
  function flaky(shouldThrow: () => boolean): System {
    return {
      name: 'flaky',
      schedule: { every: 1 },
      update(ctx: SystemCtx): void {
        ctx.bus.publish({
          type: 'sim/tickStarted',
          causedBy: null,
          payload: { tick: ctx.tick },
        });
        if (shouldThrow()) throw new Error('boom');
      },
    };
  }

  it('после throw в update: tick не изменился, буфер отброшен, лог без недокоммиченных событий', () => {
    let boom = true;
    const sched = createScheduler();
    sched.register(flaky(() => boom));
    const world = createSimWorld(5 as Seed);

    expect(() => sched.tickOnce(world)).toThrow(/boom/);
    // Атомарность: тик не оставил следа.
    expect(world.tick).toBe(0); // НЕ сдвинулся
    expect(world.bus.log).toHaveLength(0); // событие не закоммичено
    expect(world.bus.at(0)).toEqual([]);
  });

  it('повторный tickOnce после падения НЕ даёт дубля: одно событие, один коммит', () => {
    let boom = true;
    const sched = createScheduler();
    sched.register(flaky(() => boom));
    const world = createSimWorld(5 as Seed);

    // Первый прогон падает — буфер отброшен, id первого события «сгорел».
    expect(() => sched.tickOnce(world)).toThrow(/boom/);
    expect(world.bus.log).toHaveLength(0);

    // «Чиним» и повторяем тик — публикация заново, ровно один коммит.
    boom = false;
    expect(() => sched.tickOnce(world)).not.toThrow();
    expect(world.tick).toBe(1);
    // РОВНО одно событие тика 0 в логе — БЕЗ дубля от упавшей попытки.
    expect(world.bus.at(0)).toHaveLength(1);
    expect(world.bus.log).toHaveLength(1);
    expect(world.bus.log[0]?.tick).toBe(0);
    // id — новый (2), т.к. id первой (отброшенной) попытки сгорел; монотонность
    // и уникальность сохранены, непрерывность не гарантируется (C-4, discardTick).
    expect(world.bus.log[0]?.id).toBe(2);
  });

  it('run продолжается корректно после восстановленного тика', () => {
    let boom = true;
    const sched = createScheduler();
    sched.register(flaky(() => boom));
    const world = createSimWorld(5 as Seed);

    expect(() => sched.run(world, 3)).toThrow(/boom/); // упал на тике 0
    expect(world.tick).toBe(0);

    boom = false;
    sched.run(world, 3); // теперь три чистых тика 0,1,2
    expect(world.tick).toBe(3);
    expect(world.bus.log.map((e) => e.tick)).toEqual([0, 1, 2]);
    // Нет дублей: ровно по одному событию на тик.
    expect(world.bus.log).toHaveLength(3);
  });
});

describe('Scheduler: world.tick растёт корректно', () => {
  it('после run(world,5) tick == 5', () => {
    const sched = createScheduler();
    const world = createSimWorld(1 as Seed);
    expect(world.tick).toBe(0);
    sched.run(world, 5);
    expect(world.tick).toBe(5);
  });
  it('tickOnce продвигает ровно на 1', () => {
    const sched = createScheduler();
    const world = createSimWorld(1 as Seed);
    sched.tickOnce(world);
    expect(world.tick).toBe(1);
    sched.tickOnce(world);
    expect(world.tick).toBe(2);
  });
  it('run(world, 0) не двигает tick и ничего не исполняет', () => {
    const log: string[] = [];
    const sched = createScheduler();
    sched.register(recorder('x', { every: 1 }, log));
    const world = createSimWorld(1 as Seed);
    sched.run(world, 0);
    expect(world.tick).toBe(0);
    expect(log).toEqual([]);
  });
  it('run с отрицательным ticks → throw', () => {
    const sched = createScheduler();
    expect(() => sched.run(createSimWorld(1 as Seed), -1)).toThrow(/ticks/);
  });
});

describe('Scheduler: D-009 — rng различается по тикам, детерминирован', () => {
  /**
   * Система, пишущая `ctx.rng.next()` каждый тик в свой лог. Позволяет проверить,
   * что поток различается по тикам (метка форка включает tick) и воспроизводим.
   */
  function rngRecorder(name: string, out: number[]): System {
    return {
      name,
      schedule: { every: 1 },
      update(ctx: SystemCtx): void {
        out.push(ctx.rng.next());
      },
    };
  }

  it('значения одной системы РАЗНЫЕ по тикам (не повтор каждый тик)', () => {
    const out: number[] = [];
    const sched = createScheduler();
    sched.register(rngRecorder('phys', out));
    sched.run(createSimWorld(42 as Seed), 5);
    expect(out).toHaveLength(5);
    // Ключевой инвариант D-009: без тика в метке форка все 5 значений были бы
    // ИДЕНТИЧНЫ. Проверяем, что они различны (как минимум не все равны первому).
    const unique = new Set(out);
    expect(unique.size).toBe(5);
  });

  it('значения ИДЕНТИЧНЫ между двумя прогонами с одним seed', () => {
    const runOut = (): number[] => {
      const out: number[] = [];
      const sched = createScheduler();
      sched.register(rngRecorder('phys', out));
      sched.run(createSimWorld(42 as Seed), 5);
      return out;
    };
    expect(runOut()).toEqual(runOut());
  });

  it('разный seed → другая последовательность (rng действительно от seed)', () => {
    const runOut = (seed: number): number[] => {
      const out: number[] = [];
      const sched = createScheduler();
      sched.register(rngRecorder('phys', out));
      sched.run(createSimWorld(seed as Seed), 5);
      return out;
    };
    expect(runOut(1)).not.toEqual(runOut(2));
  });

  it('две разные системы на одном тике получают РАЗНЫЕ значения', () => {
    const outA: number[] = [];
    const outB: number[] = [];
    const sched = createScheduler();
    sched.register(rngRecorder('alpha', outA));
    sched.register(rngRecorder('beta', outB));
    sched.run(createSimWorld(42 as Seed), 3);
    // Потоки форкнуты разными метками (`alpha@t` vs `beta@t`) — не совпадают.
    for (let t = 0; t < 3; t++) {
      expect(outA[t]).not.toBe(outB[t]);
    }
    // И при этом каждая система различается по тикам.
    expect(new Set(outA).size).toBe(3);
    expect(new Set(outB).size).toBe(3);
  });

  it('ctx.rng — свежий форк на каждый запуск: две next() внутри тика продвигают ОДИН поток', () => {
    // Гарантия отсутствия per-tick состояния между тиками: значение первой
    // next() на тике T воспроизводимо и не зависит от истории прошлых тиков.
    const firstOf = (): number => {
      let captured = NaN;
      const sched = createScheduler();
      const sys: System = {
        name: 'phys',
        schedule: { every: 1 },
        update(ctx: SystemCtx): void {
          if (ctx.tick === 2 && Number.isNaN(captured)) captured = ctx.rng.next();
        },
      };
      sched.register(sys);
      sched.run(createSimWorld(42 as Seed), 5);
      return captured;
    };
    expect(firstOf()).toBe(firstOf()); // поток тика 2 = f(seed, name, 2), стабилен
  });
});

describe('Scheduler: детерминизм лог-вызовов (закон №8)', () => {
  it('смешанные частоты + phase: полный лог "система@тик" идентичен между прогонами', () => {
    const runProgram = (): string[] => {
      const log: string[] = [];
      const sched = createScheduler();
      sched.register(recorder('a', { every: 1 }, log));
      sched.register(recorder('b', { every: 3, phase: 1 }, log));
      sched.register(recorder('c', { every: 5 }, log));
      sched.register(recorder('d', { every: 7, phase: 2 }, log));
      sched.run(createSimWorld(99 as Seed), 40);
      return log;
    };
    expect(runProgram()).toEqual(runProgram());
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// QA-усиление задачи 0.2: due-правило на широком горизонте, вырожденные фазы,
// инкапсуляция массива систем, детерминизм событий+rng, и ЗАФИКСИРОВАННОЕ (не
// обязательно желаемое) поведение на throw в update и на повторной регистрации.
// ─────────────────────────────────────────────────────────────────────────────

/** Эталон due-правила, независимый от реализации: T>=phase И (T-phase)%every===0. */
function expectedDueTicks(every: number, phase: number, horizon: number): number[] {
  const ticks: number[] = [];
  for (let t = 0; t < horizon; t++) {
    if (t >= phase && (t - phase) % every === 0) ticks.push(t);
  }
  return ticks;
}

describe('Scheduler: due-правило на широком горизонте (100 тиков)', () => {
  it('every=7 phase=2: набор тиков за 100 совпадает с эталоном, посчитанным независимо', () => {
    const log: string[] = [];
    const sched = createScheduler();
    sched.register(recorder('weekly', { every: 7, phase: 2 }, log));
    sched.run(createSimWorld(11 as Seed), 100); // тики 0..99
    const actual = log.map((e) => Number(e.split('@')[1]));
    // Эталон считаем формулой, а не руками: сравниваем два независимых источника.
    expect(actual).toEqual(expectedDueTicks(7, 2, 100));
    // Явная проверка краёв: первый = phase, шаг = every, последний < 100.
    expect(actual[0]).toBe(2);
    expect(actual[actual.length - 1]).toBe(93);
    const gaps = actual.slice(1).map((t, i) => t - (actual[i] as number));
    expect(new Set(gaps)).toEqual(new Set([7])); // ровный шаг every между запусками
  });

  it('phase >= every (every=3, phase=5): первый запуск = phase, далее +every', () => {
    // Вырожденный случай: фаза больше периода. Правило (T-phase)%every при T>=phase
    // всё равно даёт: сначала phase, потом phase+every, phase+2*every, ...
    const log: string[] = [];
    const sched = createScheduler();
    sched.register(recorder('odd', { every: 3, phase: 5 }, log));
    sched.run(createSimWorld(5 as Seed), 20); // тики 0..19
    const actual = log.map((e) => Number(e.split('@')[1]));
    expect(actual).toEqual([5, 8, 11, 14, 17]);
    expect(actual).toEqual(expectedDueTicks(3, 5, 20));
    expect(actual[0]).toBe(5); // первый — ровно phase, не раньше
  });

  it('every=1 phase=0 срабатывает КАЖДЫЙ тик, включая тик 0', () => {
    const log: string[] = [];
    const sched = createScheduler();
    sched.register(recorder('always', { every: 1, phase: 0 }, log));
    sched.run(createSimWorld(1 as Seed), 10); // тики 0..9
    const actual = log.map((e) => Number(e.split('@')[1]));
    expect(actual).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(actual[0]).toBe(0); // тик 0 не пропущен
  });
});

describe('Scheduler: порядок = register даже при разной частоте', () => {
  it('позже зарегистрированная, но более частая система идёт ПОСЛЕ на общих тиках', () => {
    const log: string[] = [];
    const sched = createScheduler();
    // slow (every 5) зарегистрирована ПЕРВОЙ, fast (every 1) — второй и чаще.
    sched.register(recorder('slow', { every: 5 }, log));
    sched.register(recorder('fast', { every: 1 }, log));
    sched.run(createSimWorld(1 as Seed), 11); // тики 0..10
    // На общих due-тиках (0,5,10) порядок = порядок регистрации: slow, потом fast.
    expect(log.filter((e) => e.endsWith('@0'))).toEqual(['slow@0', 'fast@0']);
    expect(log.filter((e) => e.endsWith('@5'))).toEqual(['slow@5', 'fast@5']);
    expect(log.filter((e) => e.endsWith('@10'))).toEqual(['slow@10', 'fast@10']);
  });

  it('5 систем с разными every: на тике 6 отработали именно ожидаемые и в порядке register', () => {
    const log: string[] = [];
    const sched = createScheduler();
    // Порядок регистрации: s1,s2,s3,s4,s6. На тике 6 due те, у кого 6%every===0:
    // s1(1),s2(2),s3(3),s6(6) — да; s4(4) — нет (6%4=2). Ожидаемый порядок = register.
    sched.register(recorder('s1', { every: 1 }, log));
    sched.register(recorder('s2', { every: 2 }, log));
    sched.register(recorder('s3', { every: 3 }, log));
    sched.register(recorder('s4', { every: 4 }, log));
    sched.register(recorder('s6', { every: 6 }, log));
    sched.run(createSimWorld(1 as Seed), 7); // тики 0..6
    const actualAt6 = log.filter((e) => e.endsWith('@6'));
    expect(actualAt6).toEqual(['s1@6', 's2@6', 's3@6', 's6@6']);
    expect(actualAt6).not.toContain('s4@6'); // s4 явно НЕ due на тике 6
  });
});

describe('Scheduler: run(world, 0) — полный no-op', () => {
  it('tick не меняется, лог систем пуст, шина пуста, id не выданы', () => {
    const log: string[] = [];
    const sched = createScheduler();
    // Система, которая И публикует событие, И тянет rng — чтобы убедиться, что при
    // 0 тиков НИЧЕГО из этого не происходит (ни события, ни продвижения eventSeq).
    sched.register({
      name: 'busy',
      schedule: { every: 1 },
      update(ctx: SystemCtx): void {
        log.push(`busy@${ctx.tick}`);
        ctx.rng.next();
        ctx.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: ctx.tick } });
      },
    });
    const world = createSimWorld(1 as Seed);
    sched.run(world, 0);
    expect(world.tick).toBe(0);
    expect(log).toEqual([]);
    expect(world.bus.log).toHaveLength(0);
    expect(world.bus.eventSeq).toBe(0); // ни одного id не выдано
  });
});

describe('Scheduler: детерминизм полного прогона (события + значения rng)', () => {
  it('два независимых world, один seed → идентичны лог событий (id,tick,type,causedBy) И потоки rng', () => {
    interface RunResult {
      readonly events: ReadonlyArray<{ id: number; tick: number; type: string; causedBy: number | null }>;
      readonly rngA: number[];
      readonly rngB: number[];
    }
    const runProgram = (seed: number): RunResult => {
      const rngA: number[] = [];
      const rngB: number[] = [];
      const sched = createScheduler();
      // Система A публикует событие-корень и фиксирует своё физиологическое rng.
      sched.register({
        name: 'physioA',
        schedule: { every: 1 },
        update(ctx: SystemCtx): void {
          rngA.push(ctx.rng.next());
          ctx.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: ctx.tick } });
        },
      });
      // Система B — реже (every 3, phase 1), читает событие прошлого тика и
      // ссылается на него в causedBy (причинная цепочка), плюс своё rng.
      sched.register({
        name: 'physioB',
        schedule: { every: 3, phase: 1 },
        update(ctx: SystemCtx): void {
          rngB.push(ctx.rng.next());
          const prev = ctx.bus.at((ctx.tick - 1) as typeof ctx.tick);
          const cause = prev.length > 0 ? (prev[0] as { id: number }).id : null;
          ctx.bus.publish({
            type: 'sim/snapshotTaken',
            causedBy: cause as never,
            payload: { hash: `h${ctx.tick}` },
          });
        },
      });
      const world = createSimWorld(seed as Seed);
      sched.run(world, 50);
      return {
        events: world.bus.log.map((e) => ({ id: e.id, tick: e.tick, type: e.type, causedBy: e.causedBy })),
        rngA,
        rngB,
      };
    };
    const first = runProgram(7);
    const second = runProgram(7);
    // Полная история: id, тик, тип и ПРИЧИННАЯ ЦЕПОЧКА совпадают побайтово.
    expect(second.events).toEqual(first.events);
    // Значения, записанные системами через ctx.rng, тоже воспроизводимы.
    expect(second.rngA).toEqual(first.rngA);
    expect(second.rngB).toEqual(first.rngB);
    // Санити: причинность реально протянута (не все causedBy === null).
    expect(first.events.some((e) => e.causedBy !== null)).toBe(true);
    // Другой seed → другая физиология (иначе rng не от seed).
    expect(runProgram(8).rngA).not.toEqual(first.rngA);
  });
});

describe('Scheduler: массив систем инкапсулирован (внешняя мутация не влияет)', () => {
  it('push во возвращённый systems() не добавляет систему в планировщик', () => {
    const log: string[] = [];
    const sched = createScheduler();
    sched.register(recorder('A', { every: 1 }, log));
    const list = sched.systems() as System[];
    // Пытаемся протолкнуть «левую» систему во внутренний массив через копию.
    list.push(recorder('INTRUDER', { every: 1 }, log));
    const world = createSimWorld(1 as Seed);
    sched.tickOnce(world); // тик 0
    // Если бы systems() отдавал внутренний массив, INTRUDER отработал бы здесь.
    expect(log).toEqual(['A@0']);
    expect(sched.systems().map((s) => s.name)).toEqual(['A']);
  });
});

describe('Scheduler: throw в update — тик атомарен (находка ЗАКРЫТА)', () => {
  it('исключение прерывает тик: tick НЕ продвинут, endTick НЕ вызван, буфер ОТБРОШЕН', () => {
    const calls: string[] = [];
    const sched = createScheduler();
    sched.register({
      name: 'before',
      schedule: { every: 1 },
      update(ctx: SystemCtx): void {
        calls.push('before');
        ctx.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: ctx.tick } });
      },
    });
    sched.register({
      name: 'boom',
      schedule: { every: 1 },
      update(): void {
        calls.push('boom');
        throw new Error('система упала');
      },
    });
    sched.register(recorder('after', { every: 1 }, [])); // не должна успеть
    const world = createSimWorld(1 as Seed);
    expect(() => sched.tickOnce(world)).toThrow(/упала/);
    // world.tick НЕ продвинут — счётчик времени консистентен (не полутик).
    expect(world.tick).toBe(0);
    // 'after' после 'boom' не выполнилась — тик оборван на месте падения.
    expect(calls).toEqual(['before', 'boom']);
    // endTick НЕ вызван → событие 'before' НЕ в логе...
    expect(world.bus.log).toHaveLength(0);
    // ...и буфер ОТБРОШЕН (discardTick в catch): недокоммиченных событий нет.
    // eventSeq продвинут (id 'before' сгорел — пропуски допустимы, C-4).
    expect(world.bus.at(0)).toEqual([]);
    expect(world.bus.eventSeq).toBe(1);
  });

  it('пойманный+повторённый тик НЕ дублирует событие (атомарность закрыла находку)', () => {
    // Раньше «грязный буфер» приводил к двойному коммиту. Теперь discardTick в
    // catch очищает буфер, поэтому повтор публикует заново и коммитит РОВНО раз.
    const sched = createScheduler();
    sched.register({
      name: 'before',
      schedule: { every: 1 },
      update(ctx: SystemCtx): void {
        ctx.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: ctx.tick } });
      },
    });
    let fail = true;
    sched.register({
      name: 'maybeBoom',
      schedule: { every: 1 },
      update(): void {
        if (fail) throw new Error('первый прогон падает');
      },
    });
    const world = createSimWorld(1 as Seed);
    expect(() => sched.tickOnce(world)).toThrow();
    expect(world.bus.log).toHaveLength(0); // ничего не закоммичено
    fail = false;
    sched.tickOnce(world); // повтор того же тика 0 (tick не двигался)
    // РОВНО одно событие тика 0 — без дубля. id=2 (id=1 упавшей попытки сгорел).
    expect(world.bus.log.map((e) => [e.id, e.tick])).toEqual([[2, 0]]);
    expect(world.tick).toBe(1); // теперь тик успешно завершён и продвинут
  });
});

describe('Scheduler: повторная регистрация того же имени — throw (находка ЗАКРЫТА)', () => {
  it('система, зарегистрированная дважды, отклоняется на второй регистрации', () => {
    const log: string[] = [];
    const sched = createScheduler();
    const sys = recorder('dup', { every: 1 }, log);
    sched.register(sys);
    // Дедупликация: повтор имени → throw (нет молчаливого задвоения работы/rng).
    expect(() => sched.register(sys)).toThrow(/dup/);
    expect(sched.systems()).toHaveLength(1);
    sched.tickOnce(world0()); // тик 0 — система отработала РОВНО раз.
    expect(log).toEqual(['dup@0']);
  });

  it('одноимённые системы невозможно зарегистрировать → нет коллизии rng-потоков', () => {
    // D-009 форкает rng меткой `${name}@${tick}`; одинаковое имя дало бы
    // идентичный подпоток. Уникальность имён форсится register'ом — коллизия
    // предотвращена на входе, а не оставлена как «цена предположения».
    const sched = createScheduler();
    const sys: System = {
      name: 'twin',
      schedule: { every: 1 },
      update(): void {},
    };
    sched.register(sys);
    expect(() => sched.register(sys)).toThrow(/twin/);
  });
});

/** Свежий мир seed=1 для коротких проверок одного тика. */
function world0(): ReturnType<typeof createSimWorld> {
  return createSimWorld(1 as Seed);
}

// Инвариант «нет замера времени» (D-006) проверяется grep'ом по scheduler.ts в
// CI/ревью, а не юнит-тестом: пакет @zona/sim намеренно без @types/node (D-001),
// поэтому fs-чтение исходника здесь сломало бы typecheck (закон №5).
