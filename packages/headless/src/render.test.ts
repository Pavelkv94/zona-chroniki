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
describe('renderEventLog: читаемая хроника живого мира (seed=42, 5 дней)', () => {
  // 5.2/D-085 (FORAGE→forage_food + водопой): день 1 мирный (форедж снял голодные смерти);
  // первые смерти со дня 3, стычки со дня 4. Горизонт 5 дней, чтобы хроника покрывала И
  // смерть (entity/died), И исход стычки (encounter/resolved «победил/вничью»).
  const r = runHeadless({ days: 5, seed: 42, metrics: false, logMode: 'verbose' });
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
    run(5 * TICKS_PER_DAY); // 5.2/D-085: стычки/смерти со дня 3 (форедж снял смерти дня-1)
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
    // worldgen (2.16b, D-065) заселил 20 одиночек + 4 бандита + по поселению
    // (1 торговец + 2 резидента): 20 + 4 + 2×3 = 30 носителей тега Human. Прогон
    // на registerPhase1Systems (без притока) ⇒ Human-тег не прибывает (трупы тег
    // хранят) ⇒ ровно 30 стартовых людей.
    expect(humans.size).toBe(30);
    // Мир прожил: были потери (живых людей меньше стартовых 30).
    expect(aliveHumans).toBeLessThan(30);
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
// дню 100 остаётся ОСТАТОК людей (не ноль).
//   • ПРЕЙ-ХВОСТ ЗАКРЫТ P-5 задачей А/D-086: раньше стада выбивались в 0 к дню
//     10-30 (корень — не min-eid ганг, а БЕСПЛАТНАЯ погоня: все охотники гнали
//     дичь по всей карте). Стоимость преследования (utility·дистанция·усталость)
//     ЛОКАЛИЗОВАЛА охоту ⇒ ненаселённые охотниками угодья успевают плодиться ⇒
//     ЭМЕРДЖЕНТНОЕ равновесие хищник-жертва (дичь держится ~11-30 к дню 30, не 0).
//     Регулятор ПРИЧИННЫЙ и без чита: погоня дорога из СОСТОЯНИЯ (дистанция), NPC
//     не знает мировой численности.
//   • Долгий хвост: население людей медленно тает к дню 100 (нет притока —
//     phase1-only без PopulationInflux; полный конвейер держит остаток).
describe('БАЛАНС Фаза1: спираль смягчена + прей-равновесие (P-5/D-086 — стоимость погони)', () => {
  it('прей достигает ЖИВОГО равновесия к 30 дню (seed 42/7/999) — P-5 закрыт стоимостью погони', () => {
    // P-5 задача А/D-086: стоимость преследования локализовала охоту → стада НЕ вымирают
    // в 0 (как до фикса), а стабилизируются на живом уровне (~11-30 к дню 30 по seed).
    // Балансовое НАБЛЮДЕНИЕ: фиксируем ВЫЖИВАНИЕ стад (>5), а не вымирание.
    const EQUILIBRIUM_MIN = 5; // живое стадо (не одиночка-выживший); наблюдаемо 11-30
    for (const seed of [42, 7, 999]) {
      const { world, run } = build(seed);
      run(30 * TICKS_PER_DAY);
      const animals = new Set(eidsWith(world, 'animal'));
      const alive = new Set(eidsWith(world, 'alive'));
      const aliveAnimals = [...alive].filter((e) => animals.has(e)).length;
      expect(
        aliveAnimals,
        `seed=${seed}: стадо дожило до равновесия к 30 дню (P-5 закрыт стоимостью погони)`,
      ).toBeGreaterThan(EQUILIBRIUM_MIN);
    }
  }, 120000);

  it('спираль смягчена: seed=42 держит популяцию через ранний кризис (не мгновенное «кладбище»)', () => {
    // 5.2/D-085 (FORAGE→forage_food): фуражировка радикально смягчила РАННЮЮ спираль —
    // популяция цела через день 2 (все 30 живы: форедж кормит без охоты), первые смерти со
    // дня 3, остаток держится к дню 10. Это ПОЗИТИВНОЕ доказательство смягчения.
    // NB (честный хвост): phase1-ONLY (без притока) на seed=42 пустеет к дню ~10 (no-influx-
    // сценарий обречён по определению, GDD 4.7; на seed 7/999 держится 16-20). Долгосрочное
    // здоровье гарантирует ПРИТОК (PopulationInflux, Фаза 2+): полный конвейер seed=42 держит
    // ~8 живых к дню 100 (проверено в гейтах Ф2/Ф3). Поэтому «остаток» пиним на РАННЕМ
    // горизонте (день 5), где смягчение спирали Фазы 1 и есть предмет наблюдения.
    const early = build(42);
    early.run(2 * TICKS_PER_DAY);
    const humansE = new Set(eidsWith(early.world, 'human'));
    const aliveE = new Set(eidsWith(early.world, 'alive'));
    const heldEarly = [...aliveE].filter((e) => humansE.has(e)).length;
    expect(heldEarly, 'seed=42: форедж держит популяцию через день 2 (ранняя спираль смягчена)').toBeGreaterThanOrEqual(20);

    const mid = build(42);
    mid.run(5 * TICKS_PER_DAY);
    const humansM = new Set(eidsWith(mid.world, 'human'));
    const aliveM = new Set(eidsWith(mid.world, 'alive'));
    const remnant = [...aliveM].filter((e) => humansM.has(e)).length;
    expect(remnant, 'seed=42: остаток сталкеров пережил ранний кризис к дню 5 (не мгновенное кладбище)').toBeGreaterThan(0);
  }, 120000);
});
