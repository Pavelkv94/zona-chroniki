/**
 * @module @zona/sim/systems/population-influx.test
 *
 * Гейт PopulationInflux (задача 2.14, D-061). Доказывает:
 *  1) ПРИВЛЕКАТЕЛЬНОСТЬ причинна: растёт от притягивающих событий (артефакты/экспорт),
 *     падает от смертей и бандитизма (человек-vs-человек) — чистая свёртка окна лога.
 *  2) ПОРОГ → ГРУППА 1–3: при attractiveness>=порог приходят новички в ENTRY_LOCATION
 *     с валидными компонентами; ниже порога — притока НЕТ (закон №2).
 *  3) ИСТОЧНИК массы: на каждого новичка эмитится item/broughtIn; Σ массы мира растёт
 *     РОВНО на дельту леджера (предметы+деньги) — EconomyInvariant держится (закон №3).
 *  4) ИМЕНА: новичок не совпадает полным именем с ЖИВУЩИМ NPC (usedNames — индексы).
 *  5) ДЕТЕРМИНИЗМ: seed+история → тот же приток. RESUME: split ≡ continuous.
 *  6) ГОЛДЕНЫ Фазы 1 целы: PopulationInflux НЕ в конвейере.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, FactionId, ItemId, LocationId, Seed, Tick } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  worldgen,
  serialize,
  deserialize,
  hashSnapshot,
  PHASE1_SYSTEMS,
  PopulationInflux,
  computeAttractiveness,
  spawnStalker,
  type SimWorld,
  type SystemCtx,
} from '../index';
import { Human, Alive, Position, Needs, Health, Skills, Home, Task } from '../core/components';
import { hasComponent, queryEntities } from '../core/ecs';
import { ENTRY_LOCATION, STARTING_INVENTORY, STARTING_MONEY } from '../balance/worldgen';
import {
  INFLUX_CADENCE,
  INFLUX_WINDOW_TICKS,
  INFLUX_THRESHOLD,
  W_ARTIFACT_SPAWNED,
  W_EXPORT,
  W_DEATH,
  GROUP_MIN,
  GROUP_MAX,
} from '../balance/population';

const HOME = Home as unknown as { loc: Uint32Array };

const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };

interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}
interface NameRecord {
  readonly first: string;
  readonly last: string;
  readonly nickname: string;
}

/** Σ массы мира (деньги + предметы по item), как worldTotals предохранителя (D-045). */
function worldMass(world: SimWorld): { money: number; items: Map<string, number> } {
  let money = 0;
  for (const [, m] of world.resources.entries<number>('money')) money += m;
  const items = new Map<string, number>();
  for (const [, inv] of world.resources.entries<readonly InventoryEntry[]>('inventory')) {
    for (const e of inv) items.set(e.item, (items.get(e.item) ?? 0) + e.qty);
  }
  return { money, items };
}

/** Дельта леджера item/broughtIn (единственный тип, который эмитит эта система). */
function broughtInDelta(world: SimWorld): { money: number; items: Map<string, number> } {
  let money = 0;
  const items = new Map<string, number>();
  for (const ev of world.bus.log) {
    if (ev.type !== 'item/broughtIn') continue;
    money += ev.payload.money;
    for (const [item, qty] of ev.payload.items) items.set(item, (items.get(item) ?? 0) + qty);
  }
  return { money, items };
}

/** Публикует событие на текущем тике и коммитит его в лог (как один тик мира). */
function commitAt(world: SimWorld, tick: number, publish: () => void): void {
  world.tick = tick as Tick;
  publish();
  world.bus.endTick(tick as Tick);
}

/** Ручной ctx для прямого вызова update (метка форка — как у планировщика). */
function ctxAt(world: SimWorld, tick: number): SystemCtx {
  world.tick = tick as Tick;
  return {
    world,
    bus: world.bus,
    rng: world.rng.fork(`PopulationInflux@${tick}`),
    tick: tick as Tick,
  };
}

/** Набивает окно перед due-тиком CADENCE `n` событиями artifact/spawned (не-леджер). */
function seedArtifacts(world: SimWorld, n: number): void {
  commitAt(world, 0, () => {
    for (let i = 0; i < n; i++) {
      world.bus.publish({
        type: 'artifact/spawned',
        causedBy: null,
        payload: { field: 1 as EntityId, item: 'artifact_medusa' as ItemId, tier: 0, loc: 3 as LocationId },
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) ПРИВЛЕКАТЕЛЬНОСТЬ ПРИЧИННА (свёртка окна)
// ═══════════════════════════════════════════════════════════════════════════
describe('attractiveness: растёт от притягивающих, падает от смертей/бандитизма', () => {
  it('пустое окно → 0; артефакты/экспорт поднимают; смерти опускают score', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);

    // Пустой лог (worldgen событий не эмитит) → привлекательность 0.
    expect(computeAttractiveness(world, world.bus, 0 as Tick, 100 as Tick).score).toBe(0);

    // Притягивающие: 2 artifact/spawned + 1 item/exported.
    commitAt(world, 1, () => {
      world.bus.publish({ type: 'artifact/spawned', causedBy: null, payload: { field: 1 as EntityId, item: 'a' as ItemId, tier: 0, loc: 3 as LocationId } });
      world.bus.publish({ type: 'artifact/spawned', causedBy: null, payload: { field: 1 as EntityId, item: 'a' as ItemId, tier: 0, loc: 3 as LocationId } });
      world.bus.publish({ type: 'item/exported', causedBy: null, payload: { who: 2 as EntityId, item: 'meat' as ItemId, qty: 1, moneyIn: 10 } });
    });
    const attracted = computeAttractiveness(world, world.bus, 0 as Tick, 100 as Tick);
    expect(attracted.artifactsSpawned).toBe(2);
    expect(attracted.exports).toBe(1);
    expect(attracted.score).toBeGreaterThan(0);

    // Смерти тянут ВНИЗ: добавим волну entity/died — score падает.
    commitAt(world, 2, () => {
      for (let i = 0; i < 5; i++) {
        world.bus.publish({ type: 'entity/died', causedBy: null, payload: { eid: (10 + i) as EntityId, cause: 'starvation' } });
      }
    });
    const afterDeaths = computeAttractiveness(world, world.bus, 0 as Tick, 100 as Tick);
    expect(afterDeaths.deaths).toBe(5);
    expect(afterDeaths.score).toBeLessThan(attracted.score);
  });

  it('бандитизм считается ТОЛЬКО для человек-vs-человек (охота не отпугивает)', () => {
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    const rng = world.rng.fork('test');
    // Два человека (spawnStalker) и «зверь» — синтетический eid без Human.
    const usedNames = new Set<string>();
    const h1 = spawnStalker(world, rng, {
      loc: 0 as LocationId, home: 0 as LocationId, faction: 'loners' as FactionId,
      profession: { kind: 'pick', from: ['stalker'] }, money: 0,
      inventory: () => [], usedNames,
    });
    const h2 = spawnStalker(world, rng, {
      loc: 0 as LocationId, home: 0 as LocationId, faction: 'loners' as FactionId,
      profession: { kind: 'pick', from: ['stalker'] }, money: 0,
      inventory: () => [], usedNames,
    });
    const beast = 99999 as EntityId; // не существует ⇒ не Human

    // Охота: человек vs зверь (люди на ОДНОЙ стороне) — НЕ бандитизм.
    commitAt(world, 1, () => {
      world.bus.publish({ type: 'encounter/started', causedBy: null, payload: { sides: [[h1], [beast]], loc: 0 as LocationId } });
    });
    expect(computeAttractiveness(world, world.bus, 0 as Tick, 100 as Tick).banditry).toBe(0);

    // Грабёж: человек vs человек (люди по ОБЕ стороны) — бандитизм, score вниз.
    commitAt(world, 2, () => {
      world.bus.publish({ type: 'encounter/started', causedBy: null, payload: { sides: [[h1], [h2]], loc: 0 as LocationId } });
    });
    const a = computeAttractiveness(world, world.bus, 0 as Tick, 100 as Tick);
    expect(a.banditry).toBe(1);
    expect(a.score).toBeLessThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) ПОРОГ → ГРУППА 1–3; НИЖЕ ПОРОГА — НЕТ ПРИТОКА
// ═══════════════════════════════════════════════════════════════════════════
describe('порог привлекательности → приток группы новичков', () => {
  it('score>=порог → приходит 1–3 новичка в ENTRY_LOCATION с валидными компонентами', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    // 3 artifact/spawned → score выше порога (W_ARTIFACT_SPAWNED=3 ⇒ 9 >= 6).
    seedArtifacts(world, 3);

    const humansBefore = queryEntities(world.ecs, [Human, Alive]).length;
    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    const arrived = world.bus.log.filter((e) => e.type === 'population/arrived');
    expect(arrived.length).toBeGreaterThanOrEqual(1);
    expect(arrived.length).toBeLessThanOrEqual(3);
    // Население выросло ровно на число прибывших.
    expect(queryEntities(world.ecs, [Human, Alive]).length).toBe(humansBefore + arrived.length);

    // Каждый новичок валиден: Human/Alive/Position(Кордон)/Needs/Health, имя, reason.
    for (const ev of arrived) {
      const eid = (ev.payload as { eid: EntityId }).eid;
      expect(hasComponent(world.ecs, Human, eid)).toBe(true);
      expect(hasComponent(world.ecs, Alive, eid)).toBe(true);
      expect(hasComponent(world.ecs, Needs, eid)).toBe(true);
      expect(hasComponent(world.ecs, Health, eid)).toBe(true);
      expect(POS.loc[eid]).toBe(ENTRY_LOCATION);
      expect(POS.dest[eid]).toBe(ENTRY_LOCATION); // стоит (D-019), не «в пути»
      const name = world.resources.get<NameRecord>('name', eid);
      expect(name?.first.length).toBeGreaterThan(0);
      expect(name?.last.length).toBeGreaterThan(0);
      expect((ev.payload as { reason: string }).reason).toContain('привлекательность');
    }
  });

  it('score<порог → притока НЕТ (закон №2: не «фоновый спавн»)', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    seedArtifacts(world, 1); // score 3 < порог 6
    expect(computeAttractiveness(world, world.bus, 0 as Tick, INFLUX_CADENCE as Tick).score).toBeLessThan(INFLUX_THRESHOLD);

    const humansBefore = queryEntities(world.ecs, [Human, Alive]).length;
    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    expect(world.bus.log.some((e) => e.type === 'population/arrived')).toBe(false);
    expect(queryEntities(world.ecs, [Human, Alive]).length).toBe(humansBefore);
  });

  it('пустой мир без событий → приток не идёт (attractiveness ~0)', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);
    expect(world.bus.log.some((e) => e.type === 'population/arrived')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) ИСТОЧНИК МАССЫ: item/broughtIn держит EconomyInvariant
// ═══════════════════════════════════════════════════════════════════════════
describe('новичок приходит С ИСТОЧНИКОМ: Σ массы растёт ровно на леджер (закон №3)', () => {
  it('на каждого новичка есть item/broughtIn; масса выросла == дельта broughtIn', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const baseline = worldMass(world); // t0 (artifact/spawned не-леджер, массу не двигает)
    seedArtifacts(world, 3);
    expect(worldMass(world).money).toBe(baseline.money); // окно-события массу не тронули

    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    const arrived = world.bus.log.filter((e) => e.type === 'population/arrived');
    const brought = world.bus.log.filter((e) => e.type === 'item/broughtIn');
    // Ровно по одному item/broughtIn на прибывшего, причина = его population/arrived.
    expect(brought.length).toBe(arrived.length);
    for (const b of brought) {
      const who = (b.payload as { who: EntityId }).who;
      const cause = world.bus.log.find((e) => e.id === b.causedBy);
      expect(cause?.type).toBe('population/arrived');
      expect((cause?.payload as { eid: EntityId }).eid).toBe(who);
    }

    // Σ массы мира выросла РОВНО на дельту леджера broughtIn (предметы И деньги).
    const now = worldMass(world);
    const ledger = broughtInDelta(world);
    expect(now.money - baseline.money).toBe(ledger.money);
    expect(ledger.money).toBeGreaterThan(0); // новички принесли деньги из-за Периметра
    const keys = new Set<string>([...now.items.keys(), ...baseline.items.keys(), ...ledger.items.keys()]);
    for (const k of keys) {
      const observed = (now.items.get(k) ?? 0) - (baseline.items.get(k) ?? 0);
      expect(observed, `предмет ${k}: масса вне леджера`).toBe(ledger.items.get(k) ?? 0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) ИМЕНА: новичок не дублирует полное имя ЖИВУЩЕГО NPC (usedNames — индексы)
// ═══════════════════════════════════════════════════════════════════════════
describe('usedNames: новичок не сталкивается полным именем с живущим NPC (закон №4)', () => {
  it('полные имена новичков дизъюнктны с именами живших ДО притока', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const livingBefore = new Set<string>();
    for (const eid of queryEntities(world.ecs, [Human, Alive])) {
      const n = world.resources.get<NameRecord>('name', eid);
      if (n) livingBefore.add(`${n.first} ${n.last}`);
    }
    seedArtifacts(world, 3);
    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    const newFull: string[] = [];
    for (const ev of world.bus.log.filter((e) => e.type === 'population/arrived')) {
      const n = world.resources.get<NameRecord>('name', (ev.payload as { eid: EntityId }).eid);
      newFull.push(`${n!.first} ${n!.last}`);
    }
    // Ни один новичок не совпал полным именем с ранее живущим…
    for (const full of newFull) expect(livingBefore.has(full)).toBe(false);
    // …и новички уникальны между собой (общий usedNames в spawnStalker).
    expect(new Set(newFull).size).toBe(newFull.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5) ДЕТЕРМИНИЗМ + RESUME
// ═══════════════════════════════════════════════════════════════════════════
describe('детерминизм и resume (закон №8)', () => {
  /** Свежий мир + окно артефактов, прогнанный планировщиком через due-тик притока. */
  function runInflux(seed: number, ticks: number): SimWorld {
    const world = createSimWorld(seed as Seed);
    worldgen(world);
    seedArtifacts(world, 3);
    const sched = createScheduler();
    sched.register(PopulationInflux);
    sched.run(world, ticks);
    return world;
  }

  it('тот же seed+история → тот же приток (хэш и reason совпадают)', () => {
    const a = runInflux(42, INFLUX_CADENCE + 1);
    const b = runInflux(42, INFLUX_CADENCE + 1);
    expect(hashSnapshot(serialize(a))).toBe(hashSnapshot(serialize(b)));
    const arrA = a.bus.log.filter((e) => e.type === 'population/arrived').length;
    expect(arrA).toBeGreaterThanOrEqual(1); // приток реально состоялся (тест не пуст)
  });

  it('split (save/load на середине) ≡ непрерывный прогон', () => {
    const total = INFLUX_CADENCE + INFLUX_CADENCE; // покрывает due-тик CADENCE
    const cont = runInflux(7, total);
    const contHash = hashSnapshot(serialize(cont));

    // Split: половина → сериализация → восстановление → вторая половина.
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    seedArtifacts(world, 3);
    const s1 = createScheduler();
    s1.register(PopulationInflux);
    s1.run(world, INFLUX_CADENCE + 1); // due-тик CADENCE уже пройден (приток случился)
    const restored = deserialize(serialize(world));
    const s2 = createScheduler();
    s2.register(PopulationInflux);
    s2.run(restored, total - (INFLUX_CADENCE + 1));

    expect(hashSnapshot(serialize(restored))).toBe(contHash);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6) ГОЛДЕНЫ ФАЗЫ 1 ЦЕЛЫ: система НЕ в конвейере
// ═══════════════════════════════════════════════════════════════════════════
describe('изоляция: PopulationInflux не в конвейере Фазы 1 (голдены целы)', () => {
  it('PHASE1_SYSTEMS не содержит PopulationInflux', () => {
    expect(PHASE1_SYSTEMS.some((s) => s.name === 'PopulationInflux')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7) ГРАНИЦЫ ОКНА [t−W, t−1]: каждое событие учитывается РОВНО РАЗ (нет двойного
//    счёта на стыке окон, закон №2/№8). Окно == шаг ⇒ соседние окна стыкуются
//    без нахлёста и без «дыр».
// ═══════════════════════════════════════════════════════════════════════════
describe('окно привлекательности: обе границы, каждое событие ровно раз', () => {
  it('computeAttractiveness([from,to]) включает РОВНО from..to, отсекает from−1 и to+1', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const from = 240;
    const to = from + INFLUX_WINDOW_TICKS - 1; // ширина окна == шаг

    // По одному artifact/spawned на четырёх ключевых тиках вокруг границ окна.
    for (const t of [from - 1, from, to, to + 1]) {
      commitAt(world, t, () => {
        world.bus.publish({
          type: 'artifact/spawned',
          causedBy: null,
          payload: { field: 1 as EntityId, item: 'a' as ItemId, tier: 0, loc: 3 as LocationId },
        });
      });
    }

    // Учтены РОВНО события на нижней (from) и верхней (to) границах — не сосед за краем.
    const a = computeAttractiveness(world, world.bus, from as Tick, to as Tick);
    expect(a.artifactsSpawned).toBe(2); // from и to — да; from−1 и to+1 — нет
  });

  it('система на due-тике читает окно [tick−W, tick−1]: событие на tick−1 учтено, на tick — НЕТ', () => {
    // Ровно на пороге: событие на ПОСЛЕДНЕМ тике окна (tick−1) обязано попасть внутрь.
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    const nAtThreshold = INFLUX_THRESHOLD / W_ARTIFACT_SPAWNED; // 2 при текущем балансе
    expect(Number.isInteger(nAtThreshold)).toBe(true);

    // Кладём притягивающие на САМУЮ верхнюю границу окна tick−1 = CADENCE−1…
    commitAt(world, INFLUX_CADENCE - 1, () => {
      for (let i = 0; i < nAtThreshold; i++) {
        world.bus.publish({
          type: 'artifact/spawned',
          causedBy: null,
          payload: { field: 1 as EntityId, item: 'a' as ItemId, tier: 0, loc: 3 as LocationId },
        });
      }
    });
    // …и ОДНО событие на самом due-тике CADENCE (== tick), которое окно [.., tick−1] НЕ видит.
    commitAt(world, INFLUX_CADENCE, () => {
      world.bus.publish({
        type: 'artifact/spawned',
        causedBy: null,
        payload: { field: 1 as EntityId, item: 'a' as ItemId, tier: 0, loc: 3 as LocationId },
      });
    });

    const attr = computeAttractiveness(world, world.bus, 0 as Tick, (INFLUX_CADENCE - 1) as Tick);
    expect(attr.artifactsSpawned).toBe(nAtThreshold); // событие на tick НЕ просочилось
    expect(attr.score).toBe(INFLUX_THRESHOLD); // ровно порог — не выше

    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);
    // Приток есть (>=), причём вызван событиями окна, а не тем, что на due-тике.
    expect(world.bus.log.some((e) => e.type === 'population/arrived')).toBe(true);
  });

  it('событие живёт в РОВНО одном окне: приток на первом due-тике, тишина на втором', () => {
    // Притягивающие только в первом окне [0, CADENCE−1]. Второй due-тик (2·CADENCE)
    // смотрит [CADENCE, 2·CADENCE−1] — там их НЕТ ⇒ второго притока нет (не «двоятся»).
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    seedArtifacts(world, 4); // на тике 0, с запасом выше порога

    const sched = createScheduler();
    sched.register(PopulationInflux);
    sched.run(world, INFLUX_CADENCE * 2); // проходит ОБА due-тика: CADENCE и 2·CADENCE

    const arrived = world.bus.log.filter((e) => e.type === 'population/arrived');
    expect(arrived.length).toBeGreaterThanOrEqual(1);
    // ВСЕ прибытия случились на первом due-тике — событие тика 0 не «переехало» во 2-е окно.
    for (const ev of arrived) expect(ev.tick).toBe(INFLUX_CADENCE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8) ПОРОГ — ГРАНИЦА `>=`: ровно на пороге приток есть, на волос ниже — нет.
// ═══════════════════════════════════════════════════════════════════════════
describe('порог `>=`: ровно на пороге — приток; на единицу ниже — тишина', () => {
  it('score == INFLUX_THRESHOLD → приток (группа 1..3)', () => {
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    const nAtThreshold = INFLUX_THRESHOLD / W_ARTIFACT_SPAWNED;
    expect(Number.isInteger(nAtThreshold)).toBe(true);
    seedArtifacts(world, nAtThreshold);
    expect(computeAttractiveness(world, world.bus, 0 as Tick, INFLUX_CADENCE as Tick).score).toBe(
      INFLUX_THRESHOLD,
    );

    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    const arrived = world.bus.log.filter((e) => e.type === 'population/arrived');
    expect(arrived.length).toBeGreaterThanOrEqual(GROUP_MIN);
    expect(arrived.length).toBeLessThanOrEqual(GROUP_MAX);
  });

  it('score == INFLUX_THRESHOLD − 1 → притока НЕТ (смешанное окно артефакт+экспорт)', () => {
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    // 1·artifact/spawned (W_ARTIFACT_SPAWNED) + 1·item/exported (W_EXPORT) = порог − 1.
    expect(W_ARTIFACT_SPAWNED + W_EXPORT).toBe(INFLUX_THRESHOLD - 1);
    commitAt(world, 1, () => {
      world.bus.publish({
        type: 'artifact/spawned',
        causedBy: null,
        payload: { field: 1 as EntityId, item: 'a' as ItemId, tier: 0, loc: 3 as LocationId },
      });
      world.bus.publish({
        type: 'item/exported',
        causedBy: null,
        payload: { who: 2 as EntityId, item: 'meat' as ItemId, qty: 1, moneyIn: 10 },
      });
    });
    expect(
      computeAttractiveness(world, world.bus, 0 as Tick, INFLUX_CADENCE as Tick).score,
    ).toBe(INFLUX_THRESHOLD - 1);

    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);
    expect(world.bus.log.some((e) => e.type === 'population/arrived')).toBe(false);
  });

  it('перевес смертей топит притягивающие: 4 артефакта (+12) − 8 смертей (−16) < порог → тишина', () => {
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    // Много находок, но ещё больше гибели — Зона «выглядит смертельной», приток замирает.
    commitAt(world, 1, () => {
      for (let i = 0; i < 4; i++) {
        world.bus.publish({
          type: 'artifact/spawned',
          causedBy: null,
          payload: { field: 1 as EntityId, item: 'a' as ItemId, tier: 0, loc: 3 as LocationId },
        });
      }
      for (let i = 0; i < 8; i++) {
        world.bus.publish({
          type: 'entity/died',
          causedBy: null,
          payload: { eid: (100 + i) as EntityId, cause: 'starvation' },
        });
      }
    });
    const attr = computeAttractiveness(world, world.bus, 0 as Tick, INFLUX_CADENCE as Tick);
    expect(attr.score).toBe(4 * W_ARTIFACT_SPAWNED - 8 * W_DEATH); // отрицательный
    expect(attr.score).toBeLessThan(INFLUX_THRESHOLD);

    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);
    expect(world.bus.log.some((e) => e.type === 'population/arrived')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9) НОВИЧОК = СТАРТОВЫЙ СТАЛКЕР: полный набор компонентов, НЕ idle, инвентарь —
//    независимая копия (не aliasing, закон №3).
// ═══════════════════════════════════════════════════════════════════════════
describe('spawn новичка: полный человек, НЕ idle, инвентарь без aliasing', () => {
  it('каждый новичок несёт Skills+Home(Кордон), но НЕ несёт Task (не idle, закон №4)', () => {
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    seedArtifacts(world, 4);
    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    const arrived = world.bus.log.filter((e) => e.type === 'population/arrived');
    expect(arrived.length).toBeGreaterThanOrEqual(1);
    for (const ev of arrived) {
      const eid = (ev.payload as { eid: EntityId }).eid;
      expect(hasComponent(world.ecs, Skills, eid)).toBe(true);
      expect(hasComponent(world.ecs, Home, eid)).toBe(true);
      expect(HOME.loc[eid]).toBe(ENTRY_LOCATION); // база — Кордон (закон №1)
      // НЕ idle: Task не навешан — его выдаст TaskSelection на первом тике (D-020, закон №4).
      expect(hasComponent(world.ecs, Task, eid)).toBe(false);
    }
  });

  it('инвентари новичков — независимые копии: правка одного не течёт на других и на STARTING_INVENTORY', () => {
    // seed 7 гарантирует группу из нескольких новичков (несколько инвентарей рядом).
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    seedArtifacts(world, 4);
    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    const newcomers = world.bus.log
      .filter((e) => e.type === 'population/arrived')
      .map((e) => (e.payload as { eid: EntityId }).eid);
    expect(newcomers.length).toBeGreaterThanOrEqual(2); // достаточно инвентарей для сравнения

    const invs = newcomers.map(
      (eid) => world.resources.get<InventoryEntry[]>('inventory', eid)!,
    );
    // Все ссылки на массивы РАЗНЫЕ (не общий ref) — иначе расход у одного тёк бы на всех.
    expect(new Set(invs).size).toBe(invs.length);
    const a = invs[0]!;
    const b = invs[1]!;
    // И элементы {item,qty} — тоже разные объекты (не общий ref внутри массивов).
    for (let i = 1; i < invs.length; i++) {
      const inv = invs[i]!;
      for (let k = 0; k < a.length; k++) {
        expect(inv[k]).not.toBe(a[k]);
      }
    }
    // Каждый набор совпадает по СОДЕРЖИМОМУ со стартовым (тот же контент, своя копия).
    const startTotal = STARTING_INVENTORY.reduce((s, e) => s + e.qty, 0);
    for (const inv of invs) {
      expect(inv.reduce((s, e) => s + e.qty, 0)).toBe(startTotal);
    }
    // Мутация инвентаря ОДНОГО новичка не задевает содержимое другого (физически разные).
    const before = b.map((e) => ({ ...e }));
    a[0] = { item: a[0]!.item, qty: a[0]!.qty + 999 };
    for (let k = 0; k < b.length; k++) {
      expect(b[k]!.qty).toBe(before[k]!.qty);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10) ЛЕДЖЕР — ПОЛНАЯ формула инварианта: (Σ мира − baseline) == дельта ВСЕХ
//     item/*-событий; broughtIn — ЕДИНСТВЕННЫЙ faucet этой системы; item/broughtIn
//     несёт РОВНО то, что лежит на eid новичка (закон №3, D-045).
// ═══════════════════════════════════════════════════════════════════════════
describe('леджер массы: полная формула инварианта держится, broughtIn — единственный источник', () => {
  /** Дельта массы по ВСЕМ 5 типам item/* (зеркало headless ledgerDelta, D-045). */
  function ledgerDeltaAll(world: SimWorld): { money: number; items: Map<string, number> } {
    let money = 0;
    const items = new Map<string, number>();
    const add = (it: string, q: number): void => {
      items.set(it, (items.get(it) ?? 0) + q);
    };
    for (const ev of world.bus.log) {
      switch (ev.type) {
        case 'item/produced':
        case 'item/harvested':
          add(ev.payload.item, ev.payload.qty);
          break;
        case 'item/broughtIn':
          for (const [it, q] of ev.payload.items) add(it, q);
          money += ev.payload.money;
          break;
        case 'item/consumed':
          add(ev.payload.item, -ev.payload.qty);
          break;
        case 'item/exported':
          add(ev.payload.item, -ev.payload.qty);
          money += ev.payload.moneyIn;
          break;
        default:
          break;
      }
    }
    return { money, items };
  }

  it('(Σ мира − baseline) бит-в-бит == дельта ВСЕХ item/*; иных леджер-типов система не эмитит', () => {
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    const baseline = worldMass(world); // t0 — базлайн (worldgen не леджерит, D-045)
    seedArtifacts(world, 4); // artifact/spawned — НЕ леджер, массу не двигает

    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    // Единственный леджер-тип, эмитнутый системой, — item/broughtIn (faucet «из-за Периметра»).
    const ledgerTypes = new Set(
      world.bus.log
        .filter((e) =>
          ['item/produced', 'item/harvested', 'item/consumed', 'item/exported', 'item/broughtIn'].includes(
            e.type,
          ),
        )
        .map((e) => e.type),
    );
    expect([...ledgerTypes]).toEqual(['item/broughtIn']);

    // Полная формула инварианта headless: (now − baseline) == ledgerDelta(все item/*).
    const now = worldMass(world);
    const ledger = ledgerDeltaAll(world);
    expect(now.money - baseline.money).toBe(ledger.money);
    const keys = new Set<string>([...now.items.keys(), ...baseline.items.keys(), ...ledger.items.keys()]);
    for (const k of keys) {
      const observed = (now.items.get(k) ?? 0) - (baseline.items.get(k) ?? 0);
      expect(observed, `предмет ${k}: масса вне леджера (faucet-дыра?)`).toBe(ledger.items.get(k) ?? 0);
    }
  });

  it('item/broughtIn несёт РОВНО инвентарь+деньги, лежащие на eid новичка (не «из воздуха»)', () => {
    const world = createSimWorld(7 as Seed);
    worldgen(world);
    seedArtifacts(world, 4);
    PopulationInflux.update(ctxAt(world, INFLUX_CADENCE));
    world.bus.endTick(INFLUX_CADENCE as Tick);

    const brought = world.bus.log.filter((e) => e.type === 'item/broughtIn');
    expect(brought.length).toBeGreaterThanOrEqual(1);
    for (const b of brought) {
      const who = (b.payload as { who: EntityId }).who;
      const onEid = world.resources.get<readonly InventoryEntry[]>('inventory', who) ?? [];
      const money = world.resources.get<number>('money', who) ?? 0;
      // Деньги в леджере == деньги на eid == стартовые (внесены из-за Периметра, D-021).
      expect((b.payload as { money: number }).money).toBe(money);
      expect(money).toBe(STARTING_MONEY);
      // Предметы леджера == предметы на eid, шт-в-шт по каждому item.
      const ledgerItems = new Map<string, number>();
      for (const [it, q] of (b.payload as { items: ReadonlyArray<readonly [ItemId, number]> }).items) {
        ledgerItems.set(it, (ledgerItems.get(it) ?? 0) + q);
      }
      const eidItems = new Map<string, number>();
      for (const e of onEid) eidItems.set(e.item, (eidItems.get(e.item) ?? 0) + e.qty);
      expect(ledgerItems).toEqual(eidItems);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11) RESUME без ХРАНИМОГО ТАЙМЕРА: сейв ДО срабатывания → загрузка → due-тик
//     решается из ОДНОГО лишь восстановленного лога; итог ≡ непрерывному.
// ═══════════════════════════════════════════════════════════════════════════
describe('resume: решение о притоке восстанавливается из committed-лога (нет хранимого таймера)', () => {
  /** Свежий мир + окно артефактов + планировщик, прогнанный на `ticks`. */
  function build(seed: number): SimWorld {
    const world = createSimWorld(seed as Seed);
    worldgen(world);
    seedArtifacts(world, 4);
    return world;
  }
  function runOn(world: SimWorld, ticks: number): void {
    const sched = createScheduler();
    sched.register(PopulationInflux);
    sched.run(world, ticks);
  }
  function influx(world: SimWorld): Array<{ eid: number; reason: string }> {
    return world.bus.log
      .filter((e) => e.type === 'population/arrived')
      .map((e) => ({
        eid: (e.payload as { eid: EntityId }).eid as unknown as number,
        reason: (e.payload as { reason: string }).reason,
      }));
  }

  it('сейв на тике 100 (ДО due-тика 240) → load → due-тик ≡ непрерывный прогон (хэш+payload)', () => {
    const total = INFLUX_CADENCE + 1; // покрывает due-тик CADENCE
    const cont = build(7);
    runOn(cont, total);
    const contHash = hashSnapshot(serialize(cont));
    const contInflux = influx(cont);
    expect(contInflux.length).toBeGreaterThanOrEqual(1); // приток реально был

    // Split: сейв СТРОГО ДО due-тика (решение притока ещё НЕ принято) → load → добег.
    const split = build(7);
    runOn(split, 100); // 100 < 240 ⇒ due-тик впереди
    expect(influx(split).length).toBe(0); // до сейва притока ещё не случилось
    const restored = deserialize(serialize(split));
    runOn(restored, total - 100); // due-тик отрабатывает уже на ВОССТАНОВЛЕННОМ мире

    // Хэш (ECS+ресурсы+лог) совпал — приток решён из одного лишь восстановленного лога.
    expect(hashSnapshot(serialize(restored))).toBe(contHash);
    // И payload прибытий (eid+reason) идентичен непрерывному — никакого «дрейфа личности».
    expect(influx(restored)).toEqual(contInflux);
    // broughtIn-леджер тоже бит-в-бит (кто/деньги/предметы).
    const norm = (w: SimWorld): unknown =>
      w.bus.log
        .filter((e) => e.type === 'item/broughtIn')
        .map((e) => e.payload);
    expect(norm(restored)).toEqual(norm(cont));
  });
});
