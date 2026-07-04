/**
 * @module @zona/sim/systems/memory-decay.test
 *
 * Гейт системы MemoryDecay (задача 2.15, D-050/D-058). Покрывает:
 *  - ЗАТУХАНИЕ salience памяти (убыль за вызов = ставка × cadence);
 *  - PRUNE памяти: ниже порога забвения ИЛИ старше ~60 дней — запись уходит; пустой
 *    ключ удаляется целиком (не сериализуется пустым массивом);
 *  - ОТНОШЕНИЯ → нейтралу: подтяжка к 0 без перелёта; коллапс почти-нейтральных к 0;
 *  - avoidLoc: истёкшие (`untilTick <= tick`) чистятся, действующие остаются;
 *  - НЕ ПУБЛИКУЕТ событий (тихое забвение) — лог пуст;
 *  - NO-OP на мире без записей: хэш снапшота НЕ сдвигается (голдены Фазы 1 целы);
 *  - RESUME (P0, закон №8): непрерывный ≡ split save/load (одинаковый хэш);
 *  - ДЕТЕРМИНИЗМ: два независимых прогона дают идентичное состояние.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, MemoryRecord, RelationEntry, AvoidEntry, Seed } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import type { SystemCtx } from '../core/system';
import { createScheduler } from '../core/scheduler';
import { spawnEntity } from '../core/ecs';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { MemoryDecay } from './memory-decay';
import { addMemory, setRelation, addAvoid, getMemory, getRelations, getRelation, getAvoids, isAvoided, MEMORY_KEY, RELATIONS_KEY, AVOID_KEY } from './memory';
import {
  MEMORY_SALIENCE_DECAY_PER_TICK,
  MEMORY_FORGET_THRESHOLD,
  MEMORY_MAX_AGE_TICKS,
  RELATION_DECAY_PER_TICK,
  RELATION_NEUTRAL_EPSILON,
} from '../balance/social';

const NPC = 5 as EntityId;
const CADENCE = MemoryDecay.schedule.every; // привязка к системе, не хардкод (робастность к смене cadence)
const SAL_STEP = MEMORY_SALIENCE_DECAY_PER_TICK * CADENCE;
const REL_STEP = RELATION_DECAY_PER_TICK * CADENCE;

/** Прямой вызов MemoryDecay на заданном тике (полный контроль над возрастом записей). */
function fireDecay(w: SimWorld, tick: number): void {
  w.tick = tick;
  MemoryDecay.update({ world: w, bus: w.bus, rng: w.rng, tick } as unknown as SystemCtx);
}

// ── ЗАТУХАНИЕ ПАМЯТИ ──────────────────────────────────────────────────────────
describe('затухание salience памяти', () => {
  it('salience убывает на ставку×cadence за вызов', () => {
    const w = createSimWorld(1 as Seed);
    addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 42, salience: 1 });
    fireDecay(w, 0);
    expect(getMemory(w.resources, NPC)[0]!.salience).toBeCloseTo(1 - SAL_STEP, 10);
    fireDecay(w, CADENCE);
    expect(getMemory(w.resources, NPC)[0]!.salience).toBeCloseTo(1 - 2 * SAL_STEP, 10);
  });

  it('PRUNE: запись ниже порога забвения выбрасывается; пустой ключ удаляется', () => {
    const w = createSimWorld(2 as Seed);
    // salience на самом пороге: один шаг уводит ниже → prune.
    addMemory(w.resources, NPC, { kind: 'seen', subject: 'e:7', tick: 0, causeEvent: 0, salience: MEMORY_FORGET_THRESHOLD });
    fireDecay(w, 0);
    expect(getMemory(w.resources, NPC)).toHaveLength(0);
    expect(w.resources.has(MEMORY_KEY, NPC)).toBe(false); // ключ удалён (не пустой массив)
  });

  it('PRUNE по ВОЗРАСТУ: запись старше ~60 дней уходит даже при высокой salience', () => {
    const w = createSimWorld(3 as Seed);
    addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 42, salience: 1 });
    fireDecay(w, MEMORY_MAX_AGE_TICKS + 1); // возраст > горизонта
    expect(getMemory(w.resources, NPC)).toHaveLength(0);
  });

  it('свежая сильная память ПЕРЕЖИВАЕТ один шаг (не мгновенная амнезия)', () => {
    const w = createSimWorld(4 as Seed);
    addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 42, salience: 1 });
    fireDecay(w, 0);
    expect(getMemory(w.resources, NPC)).toHaveLength(1);
  });
});

// ── ОТНОШЕНИЯ → НЕЙТРАЛУ ──────────────────────────────────────────────────────
describe('отношения затухают к нейтралу (0)', () => {
  it('модуль подтягивается к 0 без перелёта через нейтрал (знак сохранён)', () => {
    const w = createSimWorld(5 as Seed);
    setRelation(w.resources, NPC, 'e:7', -0.5);
    fireDecay(w, 0);
    const v = getRelation(w.resources, NPC, 'e:7');
    expect(v).toBeCloseTo(-(0.5 - REL_STEP), 10); // ближе к 0, но всё ещё отрицательное
    expect(v).toBeLessThan(0);
  });

  it('почти-нейтральное отношение коллапсирует к 0 и запись удаляется', () => {
    const w = createSimWorld(6 as Seed);
    setRelation(w.resources, NPC, 'e:7', RELATION_NEUTRAL_EPSILON); // на эпсилоне
    fireDecay(w, 0);
    expect(getRelations(w.resources, NPC)).toHaveLength(0);
    expect(w.resources.has(RELATIONS_KEY, NPC)).toBe(false);
  });

  it('положительное отношение симметрично остывает к 0', () => {
    const w = createSimWorld(7 as Seed);
    setRelation(w.resources, NPC, 'e:7', 0.5);
    fireDecay(w, 0);
    expect(getRelation(w.resources, NPC, 'e:7')).toBeCloseTo(0.5 - REL_STEP, 10);
  });
});

// ── ОБХОД ─────────────────────────────────────────────────────────────────────
describe('avoidLoc: чистка истёкших', () => {
  it('истёкшая запись (untilTick <= tick) удаляется, действующая остаётся', () => {
    const w = createSimWorld(8 as Seed);
    addAvoid(w.resources, NPC, 4, 100); // истечёт к тику 100
    addAvoid(w.resources, NPC, 9, 500); // ещё действует
    fireDecay(w, 100);
    const avoids = getAvoids(w.resources, NPC);
    expect(avoids.map((a) => a[0])).toEqual([9]); // loc 4 вычищен
    expect(isAvoided(w.resources, NPC, 9, 100)).toBe(true);
  });

  it('все записи истекли → ключ удаляется', () => {
    const w = createSimWorld(9 as Seed);
    addAvoid(w.resources, NPC, 4, 100);
    fireDecay(w, 200);
    expect(w.resources.has(AVOID_KEY, NPC)).toBe(false);
  });
});

// ── ТИХОЕ ЗАБВЕНИЕ / NO-OP / ГОЛДЕНЫ ─────────────────────────────────────────
describe('тихое забвение и no-op (голдены Фазы 1)', () => {
  it('НЕ публикует событий при затухании/prune', () => {
    const w = createSimWorld(10 as Seed);
    addMemory(w.resources, NPC, { kind: 'seen', subject: 'e:7', tick: 0, causeEvent: 0, salience: MEMORY_FORGET_THRESHOLD });
    setRelation(w.resources, NPC, 'e:7', RELATION_NEUTRAL_EPSILON);
    addAvoid(w.resources, NPC, 4, 10);
    const before = w.bus.log.length;
    fireDecay(w, 100);
    expect(w.bus.log.length).toBe(before); // ни одного нового события
  });

  it('NO-OP на мире без записей: хэш == голому продвижению тиков (без MemoryDecay)', () => {
    // С MemoryDecay 200 тиков.
    const withDecay = createSimWorld(11 as Seed);
    const sched = createScheduler();
    sched.register(MemoryDecay);
    sched.run(withDecay, 200); // MemoryDecay фаерит несколько раз, но записей нет
    // Голое продвижение тех же 200 тиков без единой системы.
    const bare = createSimWorld(11 as Seed);
    createScheduler().run(bare, 200);
    expect(hashSnapshot(serialize(withDecay))).toBe(hashSnapshot(serialize(bare)));
    expect(withDecay.resources.keys()).toEqual([]); // ключей памяти не появилось
    expect(withDecay.bus.log).toEqual([]); // и ни одного события
  });
});

// ── RESUME (P0) ───────────────────────────────────────────────────────────────
describe('resume ≡ continuous (закон №8)', () => {
  // ЖИВОЙ eid (spawnEntity), а не синтетический NPC=5: serialize вырезает ресурсы
  // не-живых eid (закон №3), иначе память не переживает save/load и тест вакуумен
  // (хэши совпали бы тривиально, ничего не перенеся). Оба мира создаются из
  // одинакового seed/пустого ECS ⇒ spawnEntity даёт один и тот же eid ⇒ хэши сравнимы.
  function seed(w: SimWorld): EntityId {
    const npc = spawnEntity(w.ecs);
    addMemory(w.resources, npc, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 42, salience: 0.8 });
    addMemory(w.resources, npc, { kind: 'seen', subject: 'f:bandits', tick: 0, causeEvent: 0, salience: 0.5, isFirsthand: false });
    setRelation(w.resources, npc, 'e:7', -0.6);
    setRelation(w.resources, npc, 'f:bandits', -0.3);
    addAvoid(w.resources, npc, 4, 300);
    return npc;
  }

  it('непрерывный прогон даёт тот же хэш, что split save/load', () => {
    // Непрерывно: 181 тик (MemoryDecay фаерит на 0/60/120/180).
    const cont = createSimWorld(20 as Seed);
    seed(cont);
    const schedC = createScheduler();
    schedC.register(MemoryDecay);
    schedC.run(cont, 181);
    const hashCont = hashSnapshot(serialize(cont));

    // Split: 100 тиков → сериализация → десериализация → ещё 81 тик.
    const a = createSimWorld(20 as Seed);
    seed(a);
    const schedA = createScheduler();
    schedA.register(MemoryDecay);
    schedA.run(a, 100);
    const revived = deserialize(serialize(a));
    const schedB = createScheduler();
    schedB.register(MemoryDecay);
    schedB.run(revived, 81);
    const hashSplit = hashSnapshot(serialize(revived));

    expect(hashSplit).toBe(hashCont);
  });
});

// ── ДЕТЕРМИНИЗМ ───────────────────────────────────────────────────────────────
describe('детерминизм (без rng)', () => {
  it('два независимых прогона — идентичное состояние памяти/отношений/обхода', () => {
    const build = (): SimWorld => {
      const w = createSimWorld(30 as Seed);
      addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 42, salience: 0.9 });
      setRelation(w.resources, NPC, 'e:7', -0.7);
      addAvoid(w.resources, NPC, 4, 500);
      const sched = createScheduler();
      sched.register(MemoryDecay);
      sched.run(w, 121);
      return w;
    };
    expect(hashSnapshot(serialize(build()))).toBe(hashSnapshot(serialize(build())));
  });
});

// ── УСИЛЕНИЕ 2.15: многошаговый детерминизм затухания ─────────────────────────
describe('затухание предсказуемо на длинном горизонте (закон №2)', () => {
  it('за N шагов salience убывает ровно на N×ставка×cadence (чистая функция)', () => {
    const w = createSimWorld(40 as Seed);
    addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 42, salience: 1 });
    const N = 10;
    for (let i = 0; i < N; i++) fireDecay(w, i * CADENCE); // возраст << горизонта → prune не срабатывает
    expect(getMemory(w.resources, NPC)[0]!.salience).toBeCloseTo(1 - N * SAL_STEP, 10);
  });

  it('отношение остывает линейно: за N шагов модуль падает на N×ставка×cadence', () => {
    const w = createSimWorld(41 as Seed);
    setRelation(w.resources, NPC, 'e:7', -0.9);
    const N = 8;
    for (let i = 0; i < N; i++) fireDecay(w, i * CADENCE);
    expect(getRelation(w.resources, NPC, 'e:7')).toBeCloseTo(-(0.9 - N * REL_STEP), 10);
  });

  it('канарейка «убыль_за_шаг < 1.0» реальна: один шаг НЕ стирает самую свежую память/вражду', () => {
    // Guard модуля MemoryDecay запрещает ставку×cadence >= 1 (мгновенная амнезия).
    // Здесь доказываем, что порог осмыслен: свежайшая (salience=1, |value|=1) запись
    // переживает шаг с заметным, но частичным остатком — не обнуляется и не растёт.
    expect(SAL_STEP).toBeLessThan(1);
    expect(REL_STEP).toBeLessThan(1);
    const w = createSimWorld(42 as Seed);
    addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 1, salience: 1 });
    setRelation(w.resources, NPC, 'e:8', -1);
    fireDecay(w, 0);
    const sal = getMemory(w.resources, NPC)[0]!.salience;
    const rel = getRelation(w.resources, NPC, 'e:8');
    expect(sal).toBeGreaterThan(MEMORY_FORGET_THRESHOLD); // пережила
    expect(sal).toBeLessThan(1); // но убыла
    expect(rel).toBeGreaterThan(-1); // остыла к нейтралу
    expect(rel).toBeLessThan(0); // но всё ещё вражда
  });
});

// ── УСИЛЕНИЕ 2.15: границы prune (ровно на пороге) ────────────────────────────
describe('prune на ГРАНИЦЕ порогов (строгие/нестрогие неравенства)', () => {
  it('salience, севшая РОВНО на порог забвения, ВЫЖИВАЕТ (строгое `< THRESHOLD`)', () => {
    const w = createSimWorld(43 as Seed);
    // seed = порог + шаг → после одного шага ровно порог → не `< порога` → остаётся.
    addMemory(w.resources, NPC, { kind: 'seen', subject: 'e:7', tick: 0, causeEvent: 0, salience: MEMORY_FORGET_THRESHOLD + SAL_STEP });
    fireDecay(w, 0);
    const mem = getMemory(w.resources, NPC);
    expect(mem).toHaveLength(1);
    expect(mem[0]!.salience).toBeCloseTo(MEMORY_FORGET_THRESHOLD, 12);
    // следующий шаг уводит ниже порога → забыта.
    fireDecay(w, CADENCE);
    expect(getMemory(w.resources, NPC)).toHaveLength(0);
  });

  it('возраст РОВНО на горизонте выживает; горизонт+1 — забыт (страховочный prune `> MAX`)', () => {
    const wEdge = createSimWorld(44 as Seed);
    addMemory(wEdge.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 1, salience: 1 });
    fireDecay(wEdge, MEMORY_MAX_AGE_TICKS); // возраст == горизонт → НЕ `> MAX` → жива
    expect(getMemory(wEdge.resources, NPC)).toHaveLength(1);

    const wOver = createSimWorld(45 as Seed);
    addMemory(wOver.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 1, salience: 1 });
    fireDecay(wOver, MEMORY_MAX_AGE_TICKS + 1); // возраст > горизонт → prune
    expect(getMemory(wOver.resources, NPC)).toHaveLength(0);
  });

  it('отношение модулем РОВНО на эпсилоне схлопывается (нестрогое `<= EPS`); чуть выше — живёт', () => {
    const wCollapse = createSimWorld(46 as Seed);
    // seed = eps + шаг → после шага модуль == eps → `<= eps` → нейтрал, запись уходит.
    setRelation(wCollapse.resources, NPC, 'e:7', RELATION_NEUTRAL_EPSILON + REL_STEP);
    fireDecay(wCollapse, 0);
    expect(getRelations(wCollapse.resources, NPC)).toHaveLength(0);

    const wSurvive = createSimWorld(47 as Seed);
    // seed = eps + 2×шаг → после шага модуль > eps → живёт.
    setRelation(wSurvive.resources, NPC, 'e:7', RELATION_NEUTRAL_EPSILON + 2 * REL_STEP);
    fireDecay(wSurvive, 0);
    expect(getRelations(wSurvive.resources, NPC)).toHaveLength(1);
  });

  it('avoidLoc с untilTick == tick+1 переживает шаг (граница `until > tick`)', () => {
    const w = createSimWorld(48 as Seed);
    addAvoid(w.resources, NPC, 4, 101);
    fireDecay(w, 100); // 101 > 100 → жива
    expect(isAvoided(w.resources, NPC, 4, 100)).toBe(true);
    fireDecay(w, 101); // 101 > 101 ложь → истекла
    expect(w.resources.has(AVOID_KEY, NPC)).toBe(false);
  });
});

// ── УСИЛЕНИЕ 2.15: сорт + новые ссылки + обход по eid (D-035, закон №8) ───────
describe('затухание держит массивы сорт. и пишет НОВЫМИ ссылками (D-035)', () => {
  it('многозаписная память остаётся отсортированной после prune, ссылка массива новая', () => {
    const w = createSimWorld(49 as Seed);
    addMemory(w.resources, NPC, { kind: 'seen', subject: 'e:3', tick: 0, causeEvent: 0, salience: MEMORY_FORGET_THRESHOLD }); // сгорит
    addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:1', tick: 0, causeEvent: 1, salience: 0.9 });
    addMemory(w.resources, NPC, { kind: 'helped', subject: 'e:2', tick: 0, causeEvent: 2, salience: 0.9 });
    const before = getMemory(w.resources, NPC);
    fireDecay(w, 0);
    const after = getMemory(w.resources, NPC);
    expect(after).not.toBe(before); // новый массив (не in-place)
    expect(after.map((r) => r.subject)).toEqual(['e:1', 'e:2']); // e:3 сгорела, сорт. сохранён
  });

  it('многозаписные отношения остаются сорт. по subject после подтяжки к нейтралу', () => {
    const w = createSimWorld(50 as Seed);
    setRelation(w.resources, NPC, 'f:bandits', -0.8);
    setRelation(w.resources, NPC, 'e:2', 0.6);
    setRelation(w.resources, NPC, 'e:1', -0.7);
    fireDecay(w, 0);
    expect(getRelations(w.resources, NPC).map((r) => r[0])).toEqual(['e:1', 'e:2', 'f:bandits']);
  });

  it('обход по eid: два NPC затухают НЕЗАВИСИМО (закон №8)', () => {
    const w = createSimWorld(51 as Seed);
    const A = 5 as EntityId;
    const B = 9 as EntityId;
    addMemory(w.resources, A, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 1, salience: MEMORY_FORGET_THRESHOLD }); // сгорит у A
    addMemory(w.resources, B, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 1, salience: 1 }); // жива у B
    fireDecay(w, 0);
    expect(w.resources.has(MEMORY_KEY, A)).toBe(false);
    expect(getMemory(w.resources, B)).toHaveLength(1);
  });
});

// ── УСИЛЕНИЕ 2.15: round-trip записей + save ДО decay (закон №8) ───────────────
describe('сериализация записей и resume от save ДО первого decay', () => {
  // Память живёт на РЕАЛЬНОМ eid (как на Human в 2.16): serialize несёт ресурсы только
  // ЖИВЫХ сущностей (закон №3, snapshot.ts). Синтетический «висячий» eid был бы вырезан
  // при serialize — поэтому round-trip обязан идти на spawnEntity, иначе тест вакуумный.
  it('round-trip: memory/relations/avoidLoc переживают serialize→deserialize пополю', () => {
    const w = createSimWorld(60 as Seed);
    const npc = spawnEntity(w.ecs);
    addMemory(w.resources, npc, { kind: 'robbed', subject: 'e:7', tick: 12, causeEvent: 42, salience: 0.77, isFirsthand: false });
    setRelation(w.resources, npc, 'f:bandits', -0.66);
    addAvoid(w.resources, npc, 4, 999);
    const revived = deserialize(serialize(w));
    expect(getMemory(revived.resources, npc)).toEqual(getMemory(w.resources, npc));
    expect(getMemory(revived.resources, npc)).toHaveLength(1); // не вакуумно: запись реально пережила
    expect(getRelations(revived.resources, npc)).toEqual(getRelations(w.resources, npc));
    expect(getAvoids(revived.resources, npc)).toEqual(getAvoids(w.resources, npc));
  });

  it('save ДО decay → load → decay-тик ≡ continuous по хэшу', () => {
    const seedWorld = (): { w: SimWorld; npc: EntityId } => {
      const w = createSimWorld(61 as Seed);
      const npc = spawnEntity(w.ecs); // одинаковый eid из одинакового seed/ECS-состояния
      addMemory(w.resources, npc, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 42, salience: 0.8 });
      setRelation(w.resources, npc, 'e:7', -0.6);
      addAvoid(w.resources, npc, 4, 300);
      return { w, npc };
    };

    const cont = seedWorld().w;
    const schedC = createScheduler();
    schedC.register(MemoryDecay);
    schedC.run(cont, 121);

    const saved = seedWorld().w;
    const revived = deserialize(serialize(saved)); // сейв ДО единого decay-тика
    const schedR = createScheduler();
    schedR.register(MemoryDecay);
    schedR.run(revived, 121);

    expect(hashSnapshot(serialize(revived))).toBe(hashSnapshot(serialize(cont)));
  });
});

// ── УСИЛЕНИЕ 2.15: закон №3 (память — не масса мира) и закон №1 (без игрока) ──
describe('память не создаёт массу мира и живёт без игрока', () => {
  it('закон №3: ключи memory/relations/avoidLoc НЕ пересекаются с money/inventory', () => {
    const w = createSimWorld(70 as Seed);
    addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 1, salience: 1 });
    setRelation(w.resources, NPC, 'e:7', -0.5);
    addAvoid(w.resources, NPC, 4, 100);
    const keys = w.resources.keys();
    // EconomyInvariant.worldTotals суммирует ТОЛЬКО 'money'+'inventory'; память — иные ключи.
    expect(keys).not.toContain('money');
    expect(keys).not.toContain('inventory');
    expect(keys).toEqual([...keys].sort()); // ключи сорт. (закон №8)
    expect(new Set(keys)).toEqual(new Set([MEMORY_KEY, RELATIONS_KEY, AVOID_KEY]));
  });

  it('закон №1: затухание идёт при ПОЛНОМ отсутствии людей/сущностей в мире', () => {
    // NPC — «висячий» eid без Human/компонентов; ни одного наблюдателя.
    const w = createSimWorld(71 as Seed);
    addMemory(w.resources, NPC, { kind: 'robbed', subject: 'e:7', tick: 0, causeEvent: 1, salience: 1 });
    const sched = createScheduler();
    sched.register(MemoryDecay);
    sched.run(w, 121); // decay на 0/60/120
    expect(getMemory(w.resources, NPC)[0]!.salience).toBeCloseTo(1 - 3 * SAL_STEP, 10);
  });
});

// Ссылки на типы записей (документируют форму значений ResourceStore).
const _m: MemoryRecord = { kind: 'k', subject: 'e:1', salience: 1, tick: 0, causeEvent: 0, isFirsthand: true };
const _r: RelationEntry = ['e:1', 0.5];
const _a: AvoidEntry = [4, 100];
void _m; void _r; void _a;
