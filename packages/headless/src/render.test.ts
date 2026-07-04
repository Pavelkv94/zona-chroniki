/**
 * @module @zona/headless/render.test
 *
 * Тесты человекочитаемой хроники (`--log verbose`, задача 1.12) и RESUME живого
 * мира через весь конвейер. Два закона под прицелом:
 *  - D-006: рендер — ПРЕЗЕНТАЦИЯ, читает мир и его не меняет (хэш verbose == none
 *    проверен в cli.test.ts; здесь — что строки формируются и читаемы).
 *  - №8 (детерминизм/resume): непрерывный прогон N тиков == split save/load
 *    через тот же конвейер (идентичный хэш И идентичная хроника).
 */

import { describe, it, expect } from 'vitest';
import {
  createSimWorld,
  createScheduler,
  registerPhase1Systems,
  worldgen,
  serialize,
  deserialize,
  hashSnapshot,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import type { SimEvent } from '@zona/shared';
import { runHeadless } from './cli';
import { renderEventLog } from './render';

/** Собирает живой мир (worldgen + все системы) — как buildWorld в cli.ts. */
function build(seed: number): { world: SimWorld; run: (ticks: number) => void } {
  const world = createSimWorld(seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase1Systems(scheduler);
  return { world, run: (ticks) => scheduler.run(world, ticks) };
}

/** Список eid, несущих компонент `name`, из снапшота (для метрик здоровья мира). */
function eidsWith(world: SimWorld, name: string): number[] {
  const snap = serialize(world) as unknown as {
    components?: Record<string, { eids?: number[] } | undefined>;
  };
  return snap.components?.[name]?.eids ?? [];
}

/** Число событий каждого типа в логе мира (для сравнения хроник по составу). */
function countByType(log: readonly SimEvent[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const ev of log) c[ev.type] = (c[ev.type] ?? 0) + 1;
  return c;
}

// ── Формат хроники ────────────────────────────────────────────────────────────
describe('renderEventLog: читаемая хроника живого мира (seed=42, 1 день)', () => {
  const r = runHeadless({ days: 1, seed: 42, metrics: false, logMode: 'verbose' });
  const lines = r.logLines ?? [];

  it('порождает непустую хронику', () => {
    expect(lines.length).toBeGreaterThan(0);
  });

  it('каждая строка начинается с «Тик N:»', () => {
    for (const line of lines) expect(line).toMatch(/^Тик \d+: /);
  });

  it('покрывает выбор задачи с целью (task/selected)', () => {
    expect(lines.some((l) => /выбрал задачу «[^»]+», цель — .+/.test(l))).toBe(true);
  });

  it('покрывает прибытие в локацию (move/arrived)', () => {
    expect(lines.some((l) => /пришёл в .+/.test(l))).toBe(true);
  });

  it('покрывает смену погоды человекочитаемо (weather/changed)', () => {
    expect(lines.some((l) => /погода сменилась — .+ → .+/.test(l))).toBe(true);
  });

  it('покрывает исход стычки и смерть (encounter/resolved, entity/died)', () => {
    expect(lines.some((l) => /победил в стычке/.test(l) || /окончилась вничью/.test(l))).toBe(true);
    expect(lines.some((l) => /умер от .+/.test(l))).toBe(true);
  });

  it('имена локаций — из данных (map.json), не сырые id', () => {
    // Кордон — стартовая локация сталкеров; в хронике фигурирует по имени.
    expect(lines.some((l) => l.includes('Кордон'))).toBe(true);
  });

  it('имена сталкеров — фамилии из ResourceStore (не «сущность #eid» для людей)', () => {
    // Хотя бы одна строка выбора задачи несёт человеческую фамилию (кириллица),
    // а не только числовой id.
    const taskLines = lines.filter((l) => l.includes('выбрал задачу'));
    expect(taskLines.length).toBeGreaterThan(0);
    expect(taskLines.some((l) => /Тик \d+: [А-ЯЁ][а-яё]+ выбрал/.test(l))).toBe(true);
  });
});

// ── RESUME через весь конвейер (мини-гейт; полный — 1.13) ─────────────────────
describe('resume живого мира: непрерывно == split save/load (закон №8)', () => {
  const SEED = 7;
  const TOTAL = TICKS_PER_DAY; // 1 день
  const SPLIT = Math.floor(TOTAL / 3); // разрез посреди дня

  it('идентичный хэш и идентичная хроника при разрезе через save/load', () => {
    // A) Непрерывный прогон.
    const a = build(SEED);
    a.run(TOTAL);
    const hashCont = hashSnapshot(serialize(a.world));
    const linesCont = renderEventLog(a.world);

    // B) Split: прогнать SPLIT → сериализовать → десериализовать → доиграть остаток
    // на ВОССТАНОВЛЕННОМ мире через ТОТ ЖЕ конвейер (новый scheduler, те же системы).
    const b = build(SEED);
    b.run(SPLIT);
    const mid = serialize(b.world);
    const resumed = deserialize(mid);
    const scheduler2 = createScheduler();
    registerPhase1Systems(scheduler2);
    scheduler2.run(resumed, TOTAL - SPLIT);
    const hashSplit = hashSnapshot(serialize(resumed));
    const linesSplit = renderEventLog(resumed);

    expect(hashSplit).toBe(hashCont);
    expect(linesSplit).toEqual(linesCont);
  });
});

// ── renderEventLog — ЧИСТОЕ ЧТЕНИЕ (D-006, строго) ───────────────────────────
describe('renderEventLog: рендер не касается мира (презентация, D-006)', () => {
  it('вызов рендера НЕ меняет мир: хэш до == хэш после (сериализуем обе стороны)', () => {
    const { world, run } = build(42);
    run(TICKS_PER_DAY); // живой мир с непустым логом
    const before = hashSnapshot(serialize(world));
    const lines = renderEventLog(world);
    const after = hashSnapshot(serialize(world));
    expect(after, 'рендер обязан быть чистым чтением').toBe(before);
    expect(lines.length).toBeGreaterThan(0);
    // Повторный рендер того же мира даёт те же строки (идемпотентно, без побочек).
    expect(renderEventLog(world)).toEqual(lines);
  });

  it('рендерит основные типы в читаемом виде (task/move/encounter/died/weather)', () => {
    const { world, run } = build(42);
    run(TICKS_PER_DAY);
    const lines = renderEventLog(world);
    // task/selected
    expect(lines.some((l) => /выбрал задачу «[^»]+»/.test(l))).toBe(true);
    // move/arrived → имя локации из map.json (не сырой id)
    expect(lines.some((l) => /пришёл в \D+/.test(l))).toBe(true);
    // encounter/resolved
    expect(lines.some((l) => /победил в стычке|окончилась вничью/.test(l))).toBe(true);
    // entity/died с причиной
    expect(lines.some((l) => /умер от .+/.test(l))).toBe(true);
    // weather/changed
    expect(lines.some((l) => /погода сменилась — .+ → .+/.test(l))).toBe(true);
    // Ни одна строка не течёт «код N»/«локация #id» вместо человекочитаемого имени
    // погоды/локации там, где данные ЕСТЬ (регресс на потерю справочников).
    expect(lines.some((l) => /погода сменилась — код \d/.test(l))).toBe(false);
  });
});

// ── RESUME на РАЗНЫХ горизонтах живого мира (P0, весь конвейер разом) ─────────
describe('resume живого мира на горизонтах 500/2000/5000 == непрерывный (закон №8)', () => {
  const SEED = 42;
  const TOTAL = 7000; // за пределами одного дня (1440) — резюме через границы суток
  // Эталон: непрерывный прогон TOTAL тиков.
  const cont = build(SEED);
  cont.run(TOTAL);
  const hashCont = hashSnapshot(serialize(cont.world));
  const countsCont = countByType((serialize(cont.world) as unknown as { eventLog: SimEvent[] }).eventLog);
  // Типы событий, чьё ЧИСЛО обязано совпасть (структура истории, не только хэш).
  const TYPES = [
    'task/selected',
    'move/departed',
    'move/arrived',
    'encounter/started',
    'encounter/resolved',
    'entity/died',
    'animal/born',
  ] as const;

  for (const split of [500, 2000, 5000]) {
    it(`split на ${split} тиках ≡ непрерывному: хэш И число событий каждого типа`, () => {
      const b = build(SEED);
      b.run(split);
      const mid = serialize(b.world);
      const resumed = deserialize(mid);
      const scheduler2 = createScheduler();
      registerPhase1Systems(scheduler2);
      scheduler2.run(resumed, TOTAL - split);

      const hashSplit = hashSnapshot(serialize(resumed));
      expect(hashSplit, `split=${split}: хэш обязан совпасть с непрерывным`).toBe(hashCont);

      const countsSplit = countByType(
        (serialize(resumed) as unknown as { eventLog: SimEvent[] }).eventLog,
      );
      for (const t of TYPES) {
        expect(countsSplit[t] ?? 0, `split=${split}: число событий ${t}`).toBe(countsCont[t] ?? 0);
      }
    });
  }
});

// ── ЖИВОЙ МИР РЕАЛЬНО ЖИВЁТ за 10 дней (не деградирует до дампа) ──────────────
describe('живой мир за 10 дней: события растут, есть охота/смерти/погода (seed=42)', () => {
  const { world, run } = build(42);
  const afterDay1 = (() => {
    run(TICKS_PER_DAY);
    return (serialize(world) as unknown as { eventLog: SimEvent[] }).eventLog.length;
  })();
  run(9 * TICKS_PER_DAY); // добираем до 10 дней на ТОМ ЖЕ мире
  const log = (serialize(world) as unknown as { eventLog: SimEvent[] }).eventLog;
  const counts = countByType(log);

  it('лог растёт со временем (мир продолжает действовать, а не замирает)', () => {
    expect(afterDay1).toBeGreaterThan(0);
    expect(log.length).toBeGreaterThan(afterDay1);
  });

  it('идёт охота: есть разрешённые стычки (encounter/resolved > 0)', () => {
    expect(counts['encounter/resolved'] ?? 0).toBeGreaterThan(0);
  });

  it('есть смерти, и КАЖДАЯ смерть прослеживается по causedBy до корня (null)', () => {
    const byId = new Map<number, SimEvent>();
    for (const ev of log) byId.set((ev as { id: number }).id, ev);
    const deaths = log.filter((e) => e.type === 'entity/died');
    expect(deaths.length).toBeGreaterThan(0);
    for (const death of deaths) {
      let cur: SimEvent | undefined = death;
      const seen = new Set<number>();
      // Идём по цепочке причин; каждая ссылка обязана существовать, цепочка —
      // конечна и заканчивается корнем (causedBy === null), без циклов и висяков.
      while (cur !== undefined) {
        const cb = (cur as { causedBy: number | null }).causedBy;
        if (cb === null) break; // достигли корня причинности (генезис/среда)
        expect(seen.has(cb), 'цепочка causedBy не должна зацикливаться').toBe(false);
        seen.add(cb);
        const parent = byId.get(cb);
        expect(parent, `causedBy=${cb} обязан существовать в логе (нет висячих ссылок)`).toBeDefined();
        cur = parent;
      }
      expect((cur as { causedBy: number | null }).causedBy).toBeNull();
    }
  });

  it('погода меняется в течение 10 дней (weather/changed > 0)', () => {
    expect(counts['weather/changed'] ?? 0).toBeGreaterThan(0);
  });

  it('население МЕНЯЕТСЯ: часть сталкеров гибнет (живых людей < стартовых)', () => {
    const humans = new Set(eidsWith(world, 'human'));
    const alive = new Set(eidsWith(world, 'alive'));
    const aliveHumans = [...alive].filter((e) => humans.has(e)).length;
    // worldgen заселил 20 сталкеров + по торговцу на поселение (2.2): 20 + 2 = 22
    // носителя тега Human (торговцы тоже Human+Alive, D-051).
    expect(humans.size).toBe(22);
    // Мир прожил: были потери среди сталкеров (торговцы при поселениях безопаснее,
    // но общее число живых людей всё равно упало ниже стартового).
    expect(aliveHumans).toBeLessThan(22);
  });

  it('ИНВАРИАНТ (закон №4): ни один ЖИВОЙ сталкер не сидит без задачи (не idle)', () => {
    const humans = new Set(eidsWith(world, 'human'));
    const alive = new Set(eidsWith(world, 'alive'));
    const withTask = new Set(eidsWith(world, 'task'));
    const idle = [...alive].filter((e) => humans.has(e) && !withTask.has(e));
    expect(idle, `живые без Task (idle): ${idle.join(',')}`).toEqual([]);
  });
});

// ── БАЛАНС-WATCH (наблюдение, НЕ инвариант 1.12) ─────────────────────────────
// Пере-закреплён balance-analyst-сессией (Фаза 1, смягчение спирали смерти,
// docs/reports/phase1-balance.md). Раньше пиннил ТОТАЛЬНОЕ вымирание («кладбище»
// к дню 100). После тюнинга констант (THIRST_PER_TICK 0.07→0.05, boar melee
// 14→8, gestationTicks →7200) спираль СМЯГЧЕНА: за 10 дней выживает 40–70%, и к
// дню 100 остаётся ОСТАТОК людей (не ноль). Что НЕ закрылось константами и
// остаётся якорем для Фазы 2:
//   1) прей-база всё ещё выбивается охотой (стада → 0 к дню 30) — корень в
//      ЛОГИКЕ (min-eid ганг охотников D-033, отсутствие «недоохоты»), не в
//      константах: приплод не догоняет 20 охотников (доказано в отчёте);
//   2) долгий хвост: население людей медленно тает к дню 100 (нет притока/
//      размножения людей, GDD 4.7) — economy+narrative Фазы 2.
describe('БАЛАНС Фаза1: спираль смягчена (остаток выживает), прей-хвост для Фазы 2', () => {
  it('прей-база всё ещё выбивается к 30 дню (seed 42/7/999) — ЛОГИКА-хвост Фазы 2', () => {
    // Приплод ускорен (gestation 7200), но 20 охотников + min-eid ганг всё ещё
    // выбивают стада к дню 30. Это ЛОГИКА-хвост (таргетинг/недоохота) — Фаза 2.
    // После задачи 2.2 (поселения+торговцы сдвинули общий поток world.rng — 2 лишних
    // актёра) прей-хвост слегка колеблется по seed: 42→0, 7→0, 999→7 (небольшой
    // остаток вместо полного нуля). Балансовое НАБЛЮДЕНИЕ (не инвариант, см. заголовок
    // блока): фиксируем «стада ДЕЦИМИРОВАНЫ к дню 30» (≤ горстки), а не строго ноль.
    const DECIMATED_MAX = 8; // «горстка» — стада практически выбиты
    for (const seed of [42, 7, 999]) {
      const { world, run } = build(seed);
      run(30 * TICKS_PER_DAY);
      const animals = new Set(eidsWith(world, 'animal'));
      const alive = new Set(eidsWith(world, 'alive'));
      const aliveAnimals = [...alive].filter((e) => animals.has(e)).length;
      expect(
        aliveAnimals,
        `seed=${seed}: стада децимированы к 30 дню (прей-хвост Фазы 2)`,
      ).toBeLessThanOrEqual(DECIMATED_MAX);
    }
  }, 120000);

  it('спираль смягчена: к 100 дню seed=42 остаётся ОСТАТОК людей (не «кладбище»)', () => {
    const { world, run } = build(42);
    run(100 * TICKS_PER_DAY);
    const humans = new Set(eidsWith(world, 'human'));
    const alive = new Set(eidsWith(world, 'alive'));
    const aliveHumans = [...alive].filter((e) => humans.has(e)).length;
    // РАНЬШЕ было 0 («кладбище»). После смягчения — остаток жив (2 на дне 100).
    // Долгий спад к дню 100 (нет притока людей, GDD 4.7) — это хвост Фазы 2, а
    // не спираль смерти Фазы 1 (которая на горизонте 10 дней теперь в коридоре).
    expect(aliveHumans, 'seed=42: остаток сталкеров жив к 100 дню (спираль смягчена)').toBeGreaterThan(0);
  }, 120000);
});
