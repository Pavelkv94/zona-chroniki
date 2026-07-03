/**
 * @module @zona/sim/core/snapshot.deserialize.test
 *
 * Гейт задачи 0.5b (read-path + resume-детерминизм, D-011/D-012/D-014). Проверяет:
 *  1. round-trip хэша: hash(serialize(deserialize(serialize(w)))) === hash(serialize(w));
 *  2. allEntities(deserialize(serialize(w))) === allEntities(w) (хвост entityComponents);
 *  3. RESUME: непрерывный прогон === split-прогон через save/load (хэш + лог);
 *  4. eid+freelist: reuse после load идёт в том же порядке, что и без load;
 *  5. eventSeq/log восстановлены: publish продолжает монотонность id (C-4), endTick работает;
 *  6. GUARD: подделанный snap.entities / version !== 1 → throw (D-012);
 *  7. изоляция: мутация snap после deserialize не меняет мир (deep-clone ресурсов).
 *
 * Правки ревью 0.5b (ужесточение read-path, D-016):
 *  #11 GUARD ресурсов: ресурс на НЕ живом eid → throw (симметрия entities-GUARD, закон №3);
 *  #12 согласованность ecsIndex: maxId≠dense.length / битый sparse → throw;
 *  #13 fail-fast components: непустой snap.components → throw (Фаза 0 не восстанавливает SoA).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, JsonValue, Seed, Tick } from '@zona/shared';
import { createSimWorld, destroyEntity, type SimWorld } from './world';
import { spawnEntity, allEntities } from './ecs';
import { createScheduler, type Scheduler } from './scheduler';
import type { System, SystemCtx } from './system';
import { serialize, deserialize, hashSnapshot, canonicalize } from './snapshot';

/** Сырое число → branded EntityId. */
const eid = (n: number): EntityId => n as EntityId;

// ─────────────────────────────────────────────────────────────────────────────
// DoD #1: round-trip хэша
// ─────────────────────────────────────────────────────────────────────────────

/** Богатый мир: живые + переиспользованный eid, ресурсы, события, ненулевой rng/tick. */
function richWorld(): SimWorld {
  const w = createSimWorld(1234 as Seed);
  const a = spawnEntity(w.ecs);
  const b = spawnEntity(w.ecs);
  spawnEntity(w.ecs); // c
  destroyEntity(w, b); // freelist непуст
  const d = spawnEntity(w.ecs); // reuse eid b
  w.resources.set('name', a, 'Стрелок');
  w.resources.set('inv', a, { ammo: 5, gun: 1, tags: ['rifle'] });
  w.resources.set('name', d, 'Новичок');
  // Продвигаем КОРНЕВОЙ rng, чтобы rngState отличался от начального seed-состояния.
  w.rng.next();
  w.rng.next();
  // События на двух тиках с причинной цепочкой.
  w.tick = 0 as Tick;
  const root = w.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 as Tick } });
  w.bus.endTick(0 as Tick);
  w.tick = 1 as Tick;
  w.bus.publish({ type: 'sim/snapshotTaken', causedBy: root, payload: { hash: 'ab12' } });
  w.bus.endTick(1 as Tick);
  w.tick = 2 as Tick;
  return w;
}

describe('DoD #1: round-trip хэша serialize→deserialize→serialize', () => {
  it('hash(serialize(deserialize(serialize(w)))) === hash(serialize(w))', () => {
    const w = richWorld();
    const snap1 = serialize(w);
    const w2 = deserialize(snap1);
    const snap2 = serialize(w2);
    expect(hashSnapshot(snap2)).toBe(hashSnapshot(snap1));
    // Сильнее хэша: каноничные строки совпадают побайтно.
    expect(canonicalize(snap2)).toBe(canonicalize(snap1));
    // Поля восстановлены точно.
    expect(snap2.seed).toBe(snap1.seed);
    expect(snap2.tick).toBe(snap1.tick);
    expect(snap2.rngState).toBe(snap1.rngState);
    expect(snap2.eventSeq).toBe(snap1.eventSeq);
    expect(snap2.ecsIndex).toEqual(snap1.ecsIndex);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DoD #2: allEntities round-trip (хвост entityComponents)
// ─────────────────────────────────────────────────────────────────────────────

describe('DoD #2: allEntities(deserialize(serialize(w))) === allEntities(w)', () => {
  it('восстановленный мир видит ровно живые eid (entityComponents населён)', () => {
    const w = richWorld();
    const w2 = deserialize(serialize(w));
    // Ключевой хвост от 0.5a: без ручного населения entityComponents тут было бы [].
    expect(allEntities(w2.ecs)).toEqual(allEntities(w.ecs));
    expect(allEntities(w2.ecs).length).toBeGreaterThan(0);
    // И совпадает с производным entities снапшота.
    expect(allEntities(w2.ecs)).toEqual(serialize(w).entities);
  });

  it('пустой мир: allEntities восстановлен как [] без throw', () => {
    const w = createSimWorld(0 as Seed);
    const w2 = deserialize(serialize(w));
    expect(allEntities(w2.ecs)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DoD #3: RESUME-детерминизм (главный)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Фейк-система «рождения» (every 1): читает ПРОШЛЫЙ тик из шины (проверяет
 * восстановление лога), спавнит сущность, катит per-system rng, пишет ресурсы,
 * публикует причинно-связанное событие. Ничего не замыкает извне — чистая
 * функция состояния мира, поэтому идентична между прогонами.
 */
function birthsSystem(): System {
  return {
    name: 'births',
    schedule: { every: 1 },
    update(ctx: SystemCtx): void {
      const prev = ctx.tick > 0 ? ctx.bus.at((ctx.tick - 1) as Tick) : [];
      const causedBy: EventId | null = prev.length > 0 ? (prev[prev.length - 1] as { id: EventId }).id : null;
      const e = spawnEntity(ctx.world.ecs);
      const roll = ctx.rng.int(0, 1000); // per-system rng (D-009)
      ctx.world.resources.set('name', e, `npc-${e}`);
      ctx.world.resources.set('roll', e, roll);
      ctx.bus.publish({
        type: 'sim/snapshotTaken',
        causedBy,
        payload: { hash: `b:e${e}:r${roll}` },
      });
    },
  };
}

/**
 * Фейк-система «жнец» (every 2, phase 1 → тики 1,3,5,…): при ≥3 живых убивает
 * наименьший eid (детерминированно), создавая freelist для reuse через границу
 * save/load. Тоже катит rng и публикует событие.
 */
function reaperSystem(): System {
  return {
    name: 'reaper',
    schedule: { every: 2, phase: 1 },
    update(ctx: SystemCtx): void {
      const live = allEntities(ctx.world.ecs);
      if (live.length >= 3) {
        destroyEntity(ctx.world, live[0] as EntityId);
      }
      // Связываем событие с последним из ПРОШЛОГО тика (чтение восстановленного лога).
      const prev = ctx.tick > 0 ? ctx.bus.at((ctx.tick - 1) as Tick) : [];
      const causedBy: EventId | null = prev.length > 0 ? (prev[prev.length - 1] as { id: EventId }).id : null;
      ctx.bus.publish({ type: 'sim/tickStarted', causedBy, payload: { tick: ctx.tick } });
    },
  };
}

function resumeScheduler(): Scheduler {
  const sched = createScheduler();
  sched.register(birthsSystem());
  sched.register(reaperSystem());
  return sched;
}

/** Проекция события на сравниваемые поля (id,tick,type,causedBy,payload). */
function projectLog(log: readonly { id: EventId; tick: Tick; type: string; causedBy: EventId | null; payload: unknown }[]) {
  return log.map((e) => ({ id: e.id, tick: e.tick, type: e.type, causedBy: e.causedBy, payload: e.payload }));
}

describe('DoD #3: resume-детерминизм — split через save/load === непрерывный прогон', () => {
  it('прогон А (N непрерывно) === прогон Б (N/2 → save → load → N/2): хэш и лог', () => {
    const SEED = 42 as Seed;
    const N = 12;

    // Прогон А: непрерывно N тиков.
    const worldA = createSimWorld(SEED);
    resumeScheduler().run(worldA, N);

    // Прогон Б: N/2 → serialize → deserialize → N/2.
    const worldB = createSimWorld(SEED);
    resumeScheduler().run(worldB, N / 2);
    const midSnap = serialize(worldB);
    const world2 = deserialize(midSnap);
    // Продолжаем СВЕЖИМ планировщиком (тех же систем) — состояние живёт в мире.
    resumeScheduler().run(world2, N / 2);

    const snapA = serialize(worldA);
    const snap2 = serialize(world2);

    // Оба прошли одинаковое число тиков.
    expect(worldA.tick).toBe(N);
    expect(world2.tick).toBe(N);

    // Главный инвариант: состояния побитово идентичны.
    expect(hashSnapshot(snap2)).toBe(hashSnapshot(snapA));
    expect(canonicalize(snap2)).toBe(canonicalize(snapA));

    // Логи событий идентичны по (id,tick,type,causedBy,payload).
    expect(projectLog(snap2.eventLog)).toEqual(projectLog(snapA.eventLog));
    // Лог непуст и id монотонны/уникальны (без коллизий через границу load).
    const ids = snap2.eventLog.map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);

    // Живые сущности и ресурсы совпадают.
    expect(snap2.entities).toEqual(snapA.entities);
    expect(snap2.resources).toEqual(snapA.resources);
    expect(snap2.ecsIndex).toEqual(snapA.ecsIndex);
  });

  it('дважды выполненный split даёт тот же результат (детерминизм самого resume)', () => {
    const SEED = 7 as Seed;
    const run = (): string => {
      const w = createSimWorld(SEED);
      resumeScheduler().run(w, 5);
      const w2 = deserialize(serialize(w));
      resumeScheduler().run(w2, 5);
      return hashSnapshot(serialize(w2));
    };
    expect(run()).toBe(run());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DoD #4: eid + freelist — reuse после load совпадает с непрерывным прогоном
// ─────────────────────────────────────────────────────────────────────────────

describe('DoD #4: freelist переживает save/load — reuse eid идентичен', () => {
  it('create 3 → destroy #1 → [serialize→deserialize] → spawn даёт тот же eid, что без load', () => {
    // Непрерывно: spawn 3, destroy eid 1, следующий spawn переиспользует eid.
    const cont = createSimWorld(3 as Seed);
    const c1 = spawnEntity(cont.ecs);
    spawnEntity(cont.ecs);
    spawnEntity(cont.ecs);
    destroyEntity(cont, c1);
    const contReused = spawnEntity(cont.ecs);

    // Через save/load: тот же префикс, но между destroy и spawn — round-trip.
    const split = createSimWorld(3 as Seed);
    const s1 = spawnEntity(split.ecs);
    spawnEntity(split.ecs);
    spawnEntity(split.ecs);
    destroyEntity(split, s1);
    const restored = deserialize(serialize(split));
    const splitReused = spawnEntity(restored.ecs);

    // reuse идёт в тот же eid (freelist восстановлен verbatim, D-011).
    expect(splitReused).toBe(contReused);
    // И итоговый живой набор совпадает.
    expect(allEntities(restored.ecs)).toEqual(allEntities(cont.ecs));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DoD #5: eventSeq/log восстановлены — publish продолжает монотонность, endTick работает
// ─────────────────────────────────────────────────────────────────────────────

describe('DoD #5: восстановленная шина продолжает монотонность id (C-4)', () => {
  it('после deserialize publish даёт следующий id без коллизий, endTick коммитит', () => {
    const w = createSimWorld(3 as Seed);
    w.tick = 0 as Tick;
    const id1 = w.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 as Tick } });
    w.bus.endTick(0 as Tick);
    w.tick = 1 as Tick;
    const id2 = w.bus.publish({ type: 'sim/snapshotTaken', causedBy: id1, payload: { hash: 'x' } });
    w.bus.endTick(1 as Tick);
    w.tick = 2 as Tick;
    expect([id1, id2]).toEqual([1, 2]);

    const snap = serialize(w);
    const w2 = deserialize(snap);

    // eventSeq и лог восстановлены.
    expect(w2.bus.eventSeq).toBe(2);
    expect(w2.tick).toBe(2);
    expect(w2.bus.log.map((e) => e.id)).toEqual([1, 2]);

    // Новая публикация продолжает последовательность (id=3), без коллизии.
    const id3 = w2.bus.publish({ type: 'sim/tickStarted', causedBy: id2, payload: { tick: 2 as Tick } });
    expect(id3).toBe(3);
    // До endTick новое событие не видно в логе.
    expect(w2.bus.log.map((e) => e.id)).toEqual([1, 2]);
    // endTick коммитит; все id уникальны и монотонны.
    w2.bus.endTick(2 as Tick);
    expect(w2.bus.log.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(w2.bus.log.map((e) => e.tick)).toEqual([0, 1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DoD #6: GUARD — подделанный/битый снапшот → throw
// ─────────────────────────────────────────────────────────────────────────────

describe('DoD #6: GUARD целостности (D-012)', () => {
  it('snap.entities не совпадает с ecsIndex (лишний eid) → throw', () => {
    const w = createSimWorld(1 as Seed);
    spawnEntity(w.ecs);
    spawnEntity(w.ecs);
    const snap = serialize(w);
    const tampered = { ...snap, entities: [...snap.entities, eid(9999)] };
    expect(() => deserialize(tampered)).toThrow();
  });

  it('snap.entities короче (пропущен живой eid) → throw', () => {
    const w = createSimWorld(1 as Seed);
    spawnEntity(w.ecs);
    spawnEntity(w.ecs);
    const snap = serialize(w);
    const tampered = { ...snap, entities: snap.entities.slice(0, -1) };
    expect(() => deserialize(tampered)).toThrow();
  });

  it('snap.entities подменён (тот же размер, другой eid) → throw', () => {
    const w = createSimWorld(1 as Seed);
    spawnEntity(w.ecs);
    spawnEntity(w.ecs);
    const snap = serialize(w);
    const swapped = [...snap.entities];
    swapped[0] = eid(4242);
    const tampered = { ...snap, entities: swapped };
    expect(() => deserialize(tampered)).toThrow();
  });

  it('version !== 1 → throw', () => {
    const w = createSimWorld(1 as Seed);
    const snap = serialize(w);
    const badVer = { ...snap, version: 2 as unknown as 1 };
    expect(() => deserialize(badVer)).toThrow(/верси|version/i);
  });

  it('битый ecsIndex (не объект) → throw', () => {
    const w = createSimWorld(1 as Seed);
    const snap = serialize(w);
    const broken = { ...snap, ecsIndex: null as unknown as typeof snap.ecsIndex };
    expect(() => deserialize(broken)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DoD #7: изоляция — deep-clone ресурсов
// ─────────────────────────────────────────────────────────────────────────────

describe('DoD #7: восстановленный мир изолирован от снапшота (deep-clone)', () => {
  it('мутация snap.resources после deserialize НЕ меняет мир, и наоборот', () => {
    const w = createSimWorld(2 as Seed);
    const e = spawnEntity(w.ecs);
    w.resources.set('inv', e, { ammo: 5, tags: ['rifle'] });

    const snap = serialize(w);
    const w2 = deserialize(snap);

    // (а) Портим значение В СНАПШОТЕ после load — мир не затронут.
    const snapVal = snap.resources['inv']![0]![1] as { ammo: number; tags: string[] };
    snapVal.ammo = 999;
    snapVal.tags.push('pistol');
    expect(w2.resources.get('inv', e)).toEqual({ ammo: 5, tags: ['rifle'] });

    // (б) Портим значение В МИРЕ — снапшот не затронут.
    const worldVal = w2.resources.get<{ ammo: number; tags: string[] }>('inv', e)!;
    worldVal.ammo = 7;
    expect(snapVal.ammo).toBe(999); // снапшот держит свою копию
  });

  it('значение в мире — РАЗНЫЙ объект, но структурно равен снапшоту', () => {
    const w = createSimWorld(2 as Seed);
    const e = spawnEntity(w.ecs);
    const value = { a: [1, 2, { b: 'x' }], c: null };
    w.resources.set('deep', e, value);
    const snap = serialize(w);
    const w2 = deserialize(snap);
    const restored = w2.resources.get('deep', e);
    expect(restored).toEqual(value);
    expect(restored).not.toBe(snap.resources['deep']![0]![1]); // не общая ссылка
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// QA-УСИЛЕНИЕ 0.5b (аудит детерминизма resume). Тесты ниже читаются как сценарии
// мира: «сохрани мир на каждом тике и загрузи — история не должна дрогнуть».
// ═════════════════════════════════════════════════════════════════════════════

/** Плоская форма аллокатора bitecs в снапшоте (для прицельной подделки в guard-тестах). */
interface IndexBlob {
  aliveCount: number;
  dense: number[];
  sparse: number[];
  maxId: number;
  versioning: boolean;
  versionBits: number;
  entityMask: number;
  versionShift: number;
  versionMask: number;
}

/** Глубокая копия ecsIndex снапшота в мутируемую форму (чтобы портить в guard-тестах). */
function cloneIndex(snap: ReturnType<typeof serialize>): IndexBlob {
  return JSON.parse(JSON.stringify(snap.ecsIndex)) as IndexBlob;
}

/**
 * Система-«энтропия» (every 1): двигает КОРНЕВОЙ rng (`world.rng.next()`), а не
 * форк. Нужна, чтобы `rngState` менялся ПО ХОДУ прогона через планировщик —
 * иначе resume-тесты сравнивают миры с одинаковым начальным rngState и не
 * проверяют restoreRng на нетривиальном состоянии. Значение фиксируем в событии,
 * чтобы дрейф корневого rng прорастал и в лог, и в хэш.
 */
function entropySystem(): System {
  return {
    name: 'entropy',
    schedule: { every: 1 },
    update(ctx: SystemCtx): void {
      const v = Math.floor(ctx.world.rng.next() * 1e9);
      ctx.bus.publish({ type: 'sim/snapshotTaken', causedBy: null, payload: { hash: `root:${v}` } });
    },
  };
}

/** Планировщик рождений+смертей+энтропии: гоняет и eid/freelist, и корневой rng. */
function fullScheduler(): Scheduler {
  const sched = createScheduler();
  sched.register(birthsSystem());
  sched.register(reaperSystem());
  sched.register(entropySystem());
  return sched;
}

// ─────────────────────────────────────────────────────────────────────────────
// #3b: save/load на КАЖДОЙ границе тика === непрерывный прогон (жёстче одного load)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3b: save/load после КАЖДОГО тика === непрерывный прогон', () => {
  it('12 тиков: A непрерывно, B = tickOnce→save→load на каждой границе — хэш и лог совпали', () => {
    const SEED = 42 as Seed;
    const N = 12;

    const worldA = createSimWorld(SEED);
    fullScheduler().run(worldA, N);

    // B: после каждого тика мир проходит через serialize→deserialize и продолжает.
    let worldB = createSimWorld(SEED);
    const schedB = fullScheduler();
    for (let i = 0; i < N; i++) {
      schedB.tickOnce(worldB);
      worldB = deserialize(serialize(worldB)); // граница save/load на КАЖДОМ тике
    }

    const snapA = serialize(worldA);
    const snapB = serialize(worldB);
    expect(worldB.tick).toBe(N);
    // Побитовая идентичность состояния и логов — resume не накапливает дрейф.
    expect(canonicalize(snapB)).toBe(canonicalize(snapA));
    expect(hashSnapshot(snapB)).toBe(hashSnapshot(snapA));
    expect(projectLog(snapB.eventLog)).toEqual(projectLog(snapA.eventLog));
    // Корневой rng РЕАЛЬНО двигался (иначе тест ничего не проверяет про restoreRng).
    expect(snapA.rngState).not.toBe(createSimWorld(SEED).rng.state);
    // id событий монотонны и уникальны через N границ load.
    const ids = snapB.eventLog.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3c: save/load в РАЗНЫЕ моменты (после тика 1, 3, 7) — все дают тот же финал
// ─────────────────────────────────────────────────────────────────────────────

describe('#3c: одиночный save/load в любой момент === непрерывный прогон', () => {
  const SEED = 123 as Seed;
  const N = 10;

  function continuous(): string {
    const w = createSimWorld(SEED);
    fullScheduler().run(w, N);
    return canonicalize(serialize(w));
  }

  it.each([1, 3, 7])('save/load после тика %i совпадает с непрерывным', (splitAt) => {
    const w = createSimWorld(SEED);
    fullScheduler().run(w, splitAt);
    const resumed = deserialize(serialize(w));
    fullScheduler().run(resumed, N - splitAt);
    expect(canonicalize(serialize(resumed))).toBe(continuous());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4b: гибель у границы — freelist непуст, reuse после resume в том же порядке
// ─────────────────────────────────────────────────────────────────────────────

describe('#4b: несколько смертей → freelist переживает load, reuse в том же порядке', () => {
  it('spawn 5, destroy #2 и #4 (freelist из двух), save/load, spawn 2 → те же eid, что без load', () => {
    // Непрерывно.
    const cont = createSimWorld(5 as Seed);
    const c: EntityId[] = [];
    for (let i = 0; i < 5; i++) c.push(spawnEntity(cont.ecs));
    destroyEntity(cont, c[1]!);
    destroyEntity(cont, c[3]!);
    const contReuse = [spawnEntity(cont.ecs), spawnEntity(cont.ecs)];

    // Split: тот же префикс, затем round-trip ПОКА freelist непуст (2 покойника).
    const split = createSimWorld(5 as Seed);
    const s: EntityId[] = [];
    for (let i = 0; i < 5; i++) s.push(spawnEntity(split.ecs));
    destroyEntity(split, s[1]!);
    destroyEntity(split, s[3]!);
    // На границе: 3 живых, 2 в freelist — контролируем инвариант сценария.
    const boundary = serialize(split);
    expect(boundary.entities.length).toBe(3);
    const idxBlob = cloneIndex(boundary);
    expect(idxBlob.dense.length - idxBlob.aliveCount).toBeGreaterThanOrEqual(2); // freelist непуст

    const restored = deserialize(boundary);
    const splitReuse = [spawnEntity(restored.ecs), spawnEntity(restored.ecs)];

    // reuse идёт в ТЕ ЖЕ eid и в том же порядке (freelist verbatim, D-011).
    expect(splitReuse).toEqual(contReuse);
    expect(allEntities(restored.ecs)).toEqual(allEntities(cont.ecs));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4c: изоляция ecsIndex — восстановленный мир владеет своими массивами (clone)
// ─────────────────────────────────────────────────────────────────────────────

describe('#4c: ecsIndex изолирован — мутация snap/мира не протекает через границу', () => {
  it('(а) мутация snap.ecsIndex после load НЕ трогает восстановленный мир', () => {
    const w = createSimWorld(6 as Seed);
    for (let i = 0; i < 4; i++) spawnEntity(w.ecs);
    const snap = serialize(w);
    const w2 = deserialize(snap);
    const liveBefore = allEntities(w2.ecs);
    // Портим массивы В СНАПШОТЕ — мир владеет своими копиями (reqNumberArray клонирует).
    (snap.ecsIndex as unknown as IndexBlob).dense[0] = 777;
    (snap.ecsIndex as unknown as IndexBlob).aliveCount = 999;
    expect(allEntities(w2.ecs)).toEqual(liveBefore);
  });

  it('(б) spawn в восстановленном мире НЕ мутирует blob исходного снапшота', () => {
    const w = createSimWorld(6 as Seed);
    for (let i = 0; i < 4; i++) spawnEntity(w.ecs);
    const snap = serialize(w);
    const idxBefore = cloneIndex(snap); // снимок blob ДО операций в мире
    const w2 = deserialize(snap);
    spawnEntity(w2.ecs);
    spawnEntity(w2.ecs);
    // blob снапшота не изменился спавнами в восстановленном мире.
    expect(cloneIndex(snap)).toEqual(idxBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5b: причинные цепочки ЧЕРЕЗ resume — событие после load ссылается на событие до
// ─────────────────────────────────────────────────────────────────────────────

describe('#5b: causedBy пересекает границу save/load без разрыва и коллизий', () => {
  it('событие первого пост-resume тика ссылается на событие ДО resume (id из восстановленного лога)', () => {
    const SEED = 77 as Seed;
    const SPLIT = 4;
    const w = createSimWorld(SEED);
    fullScheduler().run(w, SPLIT);
    const preLog = serialize(w).eventLog;
    const preIds = new Set(preLog.map((e) => e.id));
    const preTicks = new Set(preLog.map((e) => e.tick));
    expect(preTicks.has(SPLIT)).toBe(false); // тик SPLIT ещё не прожит

    const resumed = deserialize(serialize(w));
    fullScheduler().run(resumed, 2); // проживаем тики SPLIT, SPLIT+1
    const fullLog = serialize(resumed).eventLog;

    // Каждая ссылка causedBy разрешается в РАНЕЕ существующее событие (цепочка цела).
    const byId = new Map(fullLog.map((e) => [e.id, e]));
    for (const ev of fullLog) {
      if (ev.causedBy === null) continue;
      const cause = byId.get(ev.causedBy);
      expect(cause).toBeDefined();
      expect(cause!.id).toBeLessThan(ev.id); // причина строго раньше следствия
    }

    // Существует событие пост-resume тика (SPLIT), чья причина — из ДО-resume лога.
    const crossing = fullLog.filter(
      (e) => e.tick === SPLIT && e.causedBy !== null && preIds.has(e.causedBy),
    );
    expect(crossing.length).toBeGreaterThan(0);

    // Никаких коллизий id между до- и после-resume: множества id не пересекаются
    // сверх самого до-resume префикса (id только растут).
    const allIds = fullLog.map((e) => e.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('восстановленный лог заморожен (append-only), а мутация snap.eventLog не трогает шину', () => {
    const w = createSimWorld(8 as Seed);
    w.tick = 0 as Tick;
    w.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 as Tick } });
    w.bus.endTick(0 as Tick);
    w.tick = 1 as Tick;
    const snap = serialize(w);
    const w2 = deserialize(snap);

    // Событие в восстановленном логе заморожено (append-only D-005 сохраняется).
    const ev = w2.bus.log[0] as { tick: number };
    expect(() => {
      'use strict';
      ev.tick = 999;
    }).toThrow();
    expect(w2.bus.log[0]!.tick).toBe(0);

    // Мутация массива snap.eventLog после load не меняет внутренний лог шины.
    (snap.eventLog as unknown as unknown[]).push({ id: 999 });
    expect(w2.bus.log.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #6b: GUARD — битый/несогласованный ecsIndex → throw (а не молча кривой мир)
// ─────────────────────────────────────────────────────────────────────────────

describe('#6b: GUARD битого ecsIndex (D-012) — падаем явно, не рожаем кривой мир', () => {
  function baseSnap(): ReturnType<typeof serialize> {
    const w = createSimWorld(1 as Seed);
    for (let i = 0; i < 4; i++) spawnEntity(w.ecs);
    return serialize(w);
  }

  it('aliveCount > dense.length → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap);
    idx.aliveCount = idx.dense.length + 1;
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow(/aliveCount/i);
  });

  it('aliveCount ЗАНИЖЕН (меньше живых) → GUARD entities≠ecsIndex → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap);
    idx.aliveCount = idx.aliveCount - 1; // одного живого «спрятали»
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow();
  });

  it('aliveCount ЗАВЫШЕН (хватает мёртвого из freelist) → GUARD entities≠ecsIndex → throw', () => {
    // Мир с непустым freelist, чтобы завышенный aliveCount оживил покойника.
    const w = createSimWorld(1 as Seed);
    const ids: EntityId[] = [];
    for (let i = 0; i < 4; i++) ids.push(spawnEntity(w.ecs));
    destroyEntity(w, ids[1]!); // freelist из одного
    const snap = serialize(w);
    const idx = cloneIndex(snap);
    idx.aliveCount = idx.aliveCount + 1; // зачерпнули покойника из dense-хвоста
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow();
  });

  it('обрезанный dense (короче, чем aliveCount) → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap);
    idx.dense = idx.dense.slice(0, 1); // теперь aliveCount > dense.length
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow();
  });

  it('дыра в dense (разреженный массив) → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap);
    delete (idx.dense as unknown as Record<number, number>)[0]; // создаём empty item
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow(/дыра|hole/i);
  });

  it('нечисловой элемент dense → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap);
    (idx.dense as unknown as unknown[])[0] = 'x';
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow();
  });

  it('отсутствует обязательное поле (maxId) → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap) as Partial<IndexBlob>;
    delete idx.maxId;
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow(/maxId/i);
  });

  it('NaN в aliveCount → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap);
    idx.aliveCount = NaN;
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow();
  });

  it('ecsIndex — массив, а не объект → throw', () => {
    const snap = baseSnap();
    expect(() => deserialize({ ...snap, ecsIndex: [1, 2, 3] as never })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #7b: ресурсы с вложенностью и eid-внутри-значения — round-trip + изоляция обе стороны
// ─────────────────────────────────────────────────────────────────────────────

describe('#7b: сложные ресурсы (вложенность, eid-в-значении) — переживают resume и изолированы', () => {
  it('инвентарь/отношения как вложенные структуры с eid-в-значении переживают round-trip', () => {
    const w = createSimWorld(11 as Seed);
    const a = spawnEntity(w.ecs);
    const b = spawnEntity(w.ecs);
    // Значение СОДЕРЖИТ чужой eid (b) — типичный «холодный» ресурс (отношения/память).
    const relations = { likes: [b as number], memory: [{ who: b as number, mood: -3, tags: ['враг', 'должник'] }] };
    w.resources.set('rel', a, relations);
    w.resources.set('inv', a, { slots: [{ item: 'gun', ammo: 5 }, { item: 'medkit', ammo: 0 }], w: 12.5 });

    const w2 = deserialize(serialize(w));
    expect(w2.resources.get('rel', a)).toEqual(relations);
    expect(w2.resources.get('inv', a)).toEqual({ slots: [{ item: 'gun', ammo: 5 }, { item: 'medkit', ammo: 0 }], w: 12.5 });
    // eid-в-значении не переписан ремапом (D-011: eid verbatim).
    expect((w2.resources.get('rel', a) as { likes: number[] }).likes[0]).toBe(b);
  });

  it('изоляция обе стороны: правка вложенного массива в мире не трогает snap, и наоборот', () => {
    const w = createSimWorld(11 as Seed);
    const a = spawnEntity(w.ecs);
    w.resources.set('inv', a, { slots: [{ item: 'gun', ammo: 5 }] });
    const snap = serialize(w);
    const w2 = deserialize(snap);

    // Мир → мутируем глубоко; snap не должен измениться.
    const invW = w2.resources.get<{ slots: { item: string; ammo: number }[] }>('inv', a)!;
    invW.slots[0]!.ammo = 0;
    invW.slots.push({ item: 'knife', ammo: 0 });
    const snapSlots = (snap.resources['inv']![0]![1] as { slots: unknown[] }).slots;
    expect(snapSlots).toEqual([{ item: 'gun', ammo: 5 }]);

    // Snap → мутируем; мир не должен измениться.
    (snap.resources['inv']![0]![1] as { slots: { ammo: number }[] }).slots[0]!.ammo = 42;
    expect(w2.resources.get<{ slots: { ammo: number }[] }>('inv', a)!.slots[0]!.ammo).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #8: восстановленный мир ПОЛНОЦЕННО РАБОТАЕТ (не только читается)
// ─────────────────────────────────────────────────────────────────────────────

describe('#8: после deserialize мир живёт дальше — spawn/destroy/publish/tickOnce', () => {
  it('ручные операции после load: spawn/destroy/purge/allEntities/publish/endTick', () => {
    const w = createSimWorld(13 as Seed);
    const keep = spawnEntity(w.ecs);
    const gone = spawnEntity(w.ecs);
    destroyEntity(w, gone);
    w.resources.set('name', keep, 'Боров');
    const w2 = deserialize(serialize(w));

    // spawn переиспользует eid покойника и НЕ наследует его данных (purge-инвариант).
    const reused = spawnEntity(w2.ecs);
    expect(reused).toBe(gone);
    expect(w2.resources.has('name', reused)).toBe(false); // не «Боров»
    w2.resources.set('name', reused, 'Новичок');

    // destroy + purge на восстановленном мире работает.
    destroyEntity(w2, reused);
    expect(w2.resources.has('name', reused)).toBe(false);
    expect(allEntities(w2.ecs)).toEqual([keep]);

    // publish/endTick на восстановленной шине продолжает id.
    const seqBefore = w2.bus.eventSeq;
    w2.tick = 5 as Tick;
    const id = w2.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 5 as Tick } });
    expect(id).toBe((seqBefore + 1) as EventId);
    w2.bus.endTick(5 as Tick);
    expect(w2.bus.log.some((e) => e.id === id)).toBe(true);
  });

  it('несколько тиков планировщика ПОСЛЕ load === те же тики без load (побитово)', () => {
    const SEED = 21 as Seed;
    // Непрерывно 8 тиков.
    const cont = createSimWorld(SEED);
    fullScheduler().run(cont, 8);
    // Load на старте (0 тиков прожито) и прогон 8 — восстановленный свежий мир
    // обязан работать как обычный.
    const loadedFresh = deserialize(serialize(createSimWorld(SEED)));
    fullScheduler().run(loadedFresh, 8);
    expect(canonicalize(serialize(loadedFresh))).toBe(canonicalize(serialize(cont)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #9: вырожденные миры — пустой и «только ресурсы» — round-trip без throw
// ─────────────────────────────────────────────────────────────────────────────

describe('#9: вырожденные миры round-trip без throw', () => {
  it('пустой мир (0 сущностей, 0 ресурсов, 0 событий)', () => {
    const w = createSimWorld(0 as Seed);
    const snap = serialize(w);
    expect(snap.entities).toEqual([]);
    expect(snap.resources).toEqual({});
    const w2 = deserialize(snap);
    expect(hashSnapshot(serialize(w2))).toBe(hashSnapshot(snap));
    // И дальше работает: первый спавн даёт валидный eid.
    expect(allEntities(w2.ecs)).toEqual([]);
    const e = spawnEntity(w2.ecs);
    expect(allEntities(w2.ecs)).toEqual([e]);
  });

  it('«ресурсы без живых сущностей» невозможны в чистом снапшоте: serialize их отбрасывает', () => {
    const w = createSimWorld(0 as Seed);
    const e = spawnEntity(w.ecs);
    w.resources.set('name', e, 'Покойник');
    destroyEntity(w, e); // purge убирает ресурс
    const snap = serialize(w);
    expect(snap.resources).toEqual({}); // ничего не утекло в снапшот (закон №3)
    expect(() => deserialize(snap)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #10: устойчивость detерминизма resume — идемпотентность двойного round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('#10: двойной round-trip не накапливает дрейф (идемпотентность)', () => {
  it('serialize=serialize∘deserialize∘serialize∘deserialize — хэш стабилен на богатом мире', () => {
    const w = richWorld();
    const s1 = serialize(w);
    const s2 = serialize(deserialize(s1));
    const s3 = serialize(deserialize(s2));
    expect(hashSnapshot(s2)).toBe(hashSnapshot(s1));
    expect(hashSnapshot(s3)).toBe(hashSnapshot(s1));
    expect(canonicalize(s3)).toBe(canonicalize(s1));
  });

  it('прогон через планировщик: serialize-сразу === serialize-после-load (матрица сидов)', () => {
    for (const seed of [1, 2, 3, 100, 65535]) {
      const w = createSimWorld(seed as Seed);
      fullScheduler().run(w, 9);
      const s1 = serialize(w);
      const s2 = serialize(deserialize(s1));
      expect(canonicalize(s2)).toBe(canonicalize(s1));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #11: GUARD resources↔живые eid (симметрия entities-GUARD, закон №3, риск C-6).
// Правка по ревью 0.5b: read-path ОБЯЗАН отбраковывать ресурс на не живом eid.
// serialize (write-path) фильтрует покойников, но подделанный/битый снапшот с
// ресурсом на мёртвом eid прорастил бы «призрак», а reuse eid унаследовал бы его
// (предмет/имя «из воздуха»). Теперь deserialize бросает — как и GUARD entities.
// ─────────────────────────────────────────────────────────────────────────────

describe('#11: deserialize бросает на ресурсе для НЕ живого eid (ghost-guard, C-6)', () => {
  it('ресурс на мёртвом eid (из freelist) → throw (призрак не прорастает)', () => {
    const w = createSimWorld(1 as Seed);
    spawnEntity(w.ecs);
    const dead = spawnEntity(w.ecs);
    destroyEntity(w, dead); // dead в freelist, НЕ среди живых
    const snap = serialize(w);
    expect(snap.entities).not.toContain(dead); // чистый снапшот покойника не несёт

    // Подделка: ресурс на мёртвом eid (мимо write-path фильтра). entities-GUARD
    // это НЕ ловит (entities не тронуты), поэтому нужен отдельный resource-GUARD.
    const tampered = {
      ...snap,
      resources: { ...snap.resources, name: [[dead, 'ПРИЗРАК'] as readonly [EntityId, JsonValue]] },
    };
    expect(() => deserialize(tampered as never)).toThrow(/не живом|eid/i);
  });

  it('ресурс на НИКОГДА-не-жившем eid → throw', () => {
    const w = createSimWorld(1 as Seed);
    spawnEntity(w.ecs);
    const snap = serialize(w);
    const tampered = {
      ...snap,
      resources: { ...snap.resources, name: [[eid(9999), 'ПРИЗРАК'] as readonly [EntityId, JsonValue]] },
    };
    expect(() => deserialize(tampered as never)).toThrow();
  });

  it('чистый снапшот (ресурсы только на живых) — НЕ бросает', () => {
    const w = createSimWorld(1 as Seed);
    const a = spawnEntity(w.ecs);
    w.resources.set('name', a, 'Жив');
    expect(() => deserialize(serialize(w))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #12: GUARD согласованности ecsIndex (правка ревью 0.5b) — type-валидный, но
// рассогласованный аллокатор → throw, а не молча кривой entityExists/spawn.
// ─────────────────────────────────────────────────────────────────────────────

describe('#12: reviveEntityIndex проверяет согласованность аллокатора → throw', () => {
  function baseSnap(): ReturnType<typeof serialize> {
    const w = createSimWorld(1 as Seed);
    for (let i = 0; i < 4; i++) spawnEntity(w.ecs);
    return serialize(w);
  }

  it('maxId != dense.length (dense валиден по форме) → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap);
    idx.maxId = idx.dense.length + 5; // форма полей ок, инвариант нарушен
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow(/maxId|рассоглас/i);
  });

  it('нарушена обратимость sparse↔dense для живого (sparse[dense[0]] != 0) → throw', () => {
    const snap = baseSnap();
    const idx = cloneIndex(snap);
    // dense[0] — первый живой eid; портим его обратную ссылку в sparse.
    const firstLive = idx.dense[0]!;
    idx.sparse[firstLive] = idx.sparse[firstLive]! + 1;
    expect(() => deserialize({ ...snap, ecsIndex: idx as never })).toThrow(/обратим|sparse|рассоглас/i);
  });

  it('согласованный индекс (из настоящего serialize) — НЕ бросает', () => {
    const snap = baseSnap();
    expect(() => deserialize(snap)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #13: FAIL-FAST по components (правка ревью 0.5b) — непустой components → throw,
// чтобы будущая фаза не потеряла SoA-состояние молча (восстановив пустые Set).
// ─────────────────────────────────────────────────────────────────────────────

describe('#13: deserialize валит на непустом components с ЧУЖИМ компонентом (не тихая потеря)', () => {
  it('снапшот с components НЕ из реестра → throw явно (D-018 сменил blanket-fail-fast на пер-компонентную валидацию)', () => {
    // Исходно (0.5b) любой непустой components бросал (blanket fail-fast). 1.0 (D-018)
    // заменил это восстановлением по реестру: неизвестное имя компонента → throw
    // «неизвестный компонент … в snap.components». С наполнением реестра 1.2 берём имя,
    // которого В РЕЕСТРЕ ТОЧНО НЕТ ('phantom'), чтобы проверять именно этот guard, а не
    // случайно столкнуться с реальным доменным компонентом.
    const w = createSimWorld(1 as Seed);
    spawnEntity(w.ecs);
    const snap = serialize(w);
    const tampered = {
      ...snap,
      components: { phantom: { fields: { x: [0], y: [0] }, eids: [1] } as unknown as JsonValue },
    };
    expect(() => deserialize(tampered as never)).toThrow(/неизвестн|components/i);
  });

  it('пустой components (как пишет serialize без носителей) — НЕ бросает', () => {
    const w = createSimWorld(1 as Seed);
    spawnEntity(w.ecs);
    const snap = serialize(w);
    expect(snap.components).toEqual({});
    expect(() => deserialize(snap)).not.toThrow();
  });
});
