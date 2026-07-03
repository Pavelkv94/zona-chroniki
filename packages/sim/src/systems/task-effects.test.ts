/**
 * @module @zona/sim/systems/task-effects.test
 *
 * Гейт системы TaskEffects (задача 1.8e). Покрывает исполнение задач:
 *  - EAT: hunger падает на nutrition, еда ФИЗИЧЕСКИ уходит из инвентаря (закон №3),
 *    самая питательная выбирается первой, несколько EAT опустошают запас, без еды —
 *    no-op; суммарно предметов меньше ровно на съеденное;
 *  - DRINK: у воды thirst падает, не у воды — нет, кламп на 0;
 *  - SLEEP: дома fatigue падает (SLEEP), вне дома — без эффекта; REST везде падает
 *    (REST < SLEEP); кламп 0;
 *  - FORAGE: hunger падает пропорц. loc.forage; в бедной локации почти ноль;
 *  - HUNT/FLEE — без восстановления;
 *  - ТОЛЬКО стоящие (dest===loc) исполняют; в транзите — нет эффекта;
 *  - детерминизм 2 прогонов; resume: непрерывный === split через save/load;
 *  - выживательный цикл: накопление нужд ПЕРЕБИВАЕТСЯ восстановлением (hunger реально
 *    падает при регулярном EAT, консервы уходят).
 *
 * Нужды в шкале 0..100; addComponent зануляет слот (D-024), значения ставим явно.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, LocationId, Seed, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, queryEntities } from '../core/ecs';
import { Position, Needs, Health, Home, Human, Alive, Task, TaskKind } from '../core/components';
import { createScheduler, type Scheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import {
  HEALTH_MAX,
  HUNGER_CRITICAL,
  NEED_MAX,
  SLEEP_RECOVERY_PER_TICK,
  REST_RECOVERY_PER_TICK,
  DRINK_RECOVERY_PER_TICK,
  FORAGE_RECOVERY_PER_TICK,
} from '../balance/needs';
import { getItem, getLocation, MAP } from '../data/index';
import { worldgen } from '../worldgen';
import { Needs as NeedsSystem } from './needs';
import { Perception } from './perception';
import { TaskSelection } from './task-selection';
import { Movement } from './movement';
import { TaskEffects } from './task-effects';

// ── Типизированные SoA-колонки для установки/чтения состояния в тестах ─────────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
const NEED = Needs as unknown as { hunger: Float32Array; thirst: Float32Array; fatigue: Float32Array; fear: Float32Array };
const HP = Health as unknown as { hp: Float32Array };
const HOME = Home as unknown as { loc: Uint32Array };
const TSK = Task as unknown as { kind: Uint8Array; targetLoc: Uint32Array; targetEid: Uint32Array; startedTick: Uint32Array };

const DAY_TICK = 600 as Tick;

interface InvEntry { readonly item: string; readonly qty: number }

interface EffOpts {
  readonly loc: number;
  readonly dest?: number; // по умолчанию = loc (стоит); != loc ⇒ в транзите
  readonly home?: number; // если задан — навешиваем Home
  readonly hunger?: number;
  readonly thirst?: number;
  readonly fatigue?: number;
  readonly kind: number;
  readonly inventory?: InvEntry[];
}

/** Селит человека с заданной задачей/нуждами/инвентарём для проверки эффекта. */
function placeActor(world: SimWorld, o: EffOpts): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = o.loc;
  POS.dest[eid] = o.dest ?? o.loc;
  addComponent(world.ecs, Needs, eid);
  NEED.hunger[eid] = o.hunger ?? 0;
  NEED.thirst[eid] = o.thirst ?? 0;
  NEED.fatigue[eid] = o.fatigue ?? 0;
  NEED.fear[eid] = 0;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = HEALTH_MAX;
  if (o.home !== undefined) {
    addComponent(world.ecs, Home, eid);
    HOME.loc[eid] = o.home;
  }
  addComponent(world.ecs, Task, eid);
  TSK.kind[eid] = o.kind;
  TSK.targetLoc[eid] = o.loc;
  TSK.targetEid[eid] = 0;
  TSK.startedTick[eid] = 0;
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  if (o.inventory !== undefined) {
    world.resources.set<readonly InvEntry[]>('inventory', eid, o.inventory);
  }
  return eid;
}

/** Планировщик с одной TaskEffects. */
function effScheduler(): Scheduler {
  const s = createScheduler();
  s.register(TaskEffects);
  return s;
}

/** Исполняет TaskEffects ровно один раз на дневном тике. */
function execOnce(world: SimWorld): void {
  world.tick = DAY_TICK;
  effScheduler().tickOnce(world);
}

function inv(world: SimWorld, eid: EntityId): readonly InvEntry[] {
  return world.resources.get<readonly InvEntry[]>('inventory', eid) ?? [];
}
function totalItems(list: readonly InvEntry[]): number {
  return list.reduce((s, e) => s + e.qty, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// EAT — расход еды из инвентаря (закон №3) + падение hunger на nutrition
// ═══════════════════════════════════════════════════════════════════════════

describe('EAT: еда физически расходуется, hunger падает на nutrition (закон №3)', () => {
  it('один EAT: hunger −= nutrition, из инвентаря ушла 1 единица', () => {
    const w = createSimWorld(1 as Seed);
    const nutrition = getItem('canned').nutrition!; // 45
    const eid = placeActor(w, { loc: 0, hunger: 85, kind: TaskKind.EAT, inventory: [{ item: 'canned', qty: 2 }] });
    execOnce(w);
    expect(NEED.hunger[eid]).toBeCloseTo(85 - nutrition, 4);
    expect(inv(w, eid)).toEqual([{ item: 'canned', qty: 1 }]); // qty−1, запись жива
  });

  it('самая ПИТАТЕЛЬНАЯ съедается первой; сортировка по item сохраняется', () => {
    const w = createSimWorld(2 as Seed);
    // Сорт. по item: bread(25) < canned(45). Самая питательная — canned.
    const eid = placeActor(w, {
      loc: 0,
      hunger: 90,
      kind: TaskKind.EAT,
      inventory: [{ item: 'bread', qty: 1 }, { item: 'canned', qty: 1 }],
    });
    execOnce(w);
    expect(NEED.hunger[eid]).toBeCloseTo(90 - getItem('canned').nutrition!, 4); // съел canned (45), не bread
    expect(inv(w, eid)).toEqual([{ item: 'bread', qty: 1 }]); // canned исчерпан → удалён, bread остался
  });

  it('несколько EAT подряд опустошают запас; закон №3: −ровно съеденное', () => {
    const w = createSimWorld(3 as Seed);
    const eid = placeActor(w, { loc: 0, hunger: 100, kind: TaskKind.EAT, inventory: [{ item: 'canned', qty: 2 }] });
    const before = totalItems(inv(w, eid)); // 2
    execOnce(w); // 1-я консерва
    execOnce(w); // 2-я консерва → запас пуст
    const after = totalItems(inv(w, eid)); // 0
    expect(before - after).toBe(2); // ушло РОВНО 2 (сколько съедено)
    expect(inv(w, eid)).toEqual([]); // записи удалены при qty→0
  });

  it('EAT без еды → hunger не меняется (устойчивость; TaskSelection так не выберет)', () => {
    const w = createSimWorld(4 as Seed);
    const eid = placeActor(w, { loc: 0, hunger: 70, kind: TaskKind.EAT, inventory: [] });
    execOnce(w);
    expect(NEED.hunger[eid]).toBe(70);
    expect(inv(w, eid)).toEqual([]);
  });

  it('EAT с не-едой в инвентаре (только патроны) → no-op (нельзя есть патроны)', () => {
    const w = createSimWorld(5 as Seed);
    const eid = placeActor(w, { loc: 0, hunger: 60, kind: TaskKind.EAT, inventory: [{ item: 'ammo_9mm', qty: 30 }] });
    execOnce(w);
    expect(NEED.hunger[eid]).toBe(60);
    expect(inv(w, eid)).toEqual([{ item: 'ammo_9mm', qty: 30 }]); // патроны на месте
  });

  it('hunger не уходит ниже 0 (кламп) при сытной еде и малом голоде', () => {
    const w = createSimWorld(6 as Seed);
    const eid = placeActor(w, { loc: 0, hunger: 10, kind: TaskKind.EAT, inventory: [{ item: 'canned', qty: 1 }] });
    execOnce(w); // nutrition 45 > 10
    expect(NEED.hunger[eid]).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DRINK — вода из среды (не из инвентаря, закон №3)
// ═══════════════════════════════════════════════════════════════════════════

describe('DRINK: у воды thirst падает; не у воды — нет; кламп 0', () => {
  it('в локации с водой (Кордон loc0) thirst −= DRINK_RECOVERY', () => {
    const w = createSimWorld(10 as Seed);
    expect(getLocation(0 as LocationId).water).toBe(true);
    const eid = placeActor(w, { loc: 0, thirst: 90, kind: TaskKind.DRINK });
    execOnce(w);
    expect(NEED.thirst[eid]).toBeCloseTo(90 - DRINK_RECOVERY_PER_TICK, 4);
  });

  it('в локации без воды (Тёмная долина loc3) thirst не меняется', () => {
    const w = createSimWorld(11 as Seed);
    expect(getLocation(3 as LocationId).water).toBe(false);
    const eid = placeActor(w, { loc: 3, thirst: 90, kind: TaskKind.DRINK });
    execOnce(w);
    expect(NEED.thirst[eid]).toBe(90);
  });

  it('кламп 0: малая жажда у воды не уходит в минус', () => {
    const w = createSimWorld(12 as Seed);
    const eid = placeActor(w, { loc: 0, thirst: 5, kind: TaskKind.DRINK });
    execOnce(w);
    expect(NEED.thirst[eid]).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SLEEP / REST — усталость; SLEEP эффективен ДОМА, REST везде и слабее
// ═══════════════════════════════════════════════════════════════════════════

describe('SLEEP дома / REST везде; REST слабее сна', () => {
  it('SLEEP дома (loc===Home) → fatigue −= SLEEP_RECOVERY', () => {
    const w = createSimWorld(20 as Seed);
    const eid = placeActor(w, { loc: 0, home: 0, fatigue: 50, kind: TaskKind.SLEEP });
    execOnce(w);
    expect(NEED.fatigue[eid]).toBeCloseTo(50 - SLEEP_RECOVERY_PER_TICK, 4);
  });

  it('SLEEP ВНЕ дома (носитель Home, loc≠Home) → БЕЗ эффекта', () => {
    const w = createSimWorld(21 as Seed);
    const eid = placeActor(w, { loc: 5, home: 0, fatigue: 50, kind: TaskKind.SLEEP });
    execOnce(w);
    expect(NEED.fatigue[eid]).toBe(50);
  });

  it('SLEEP без компонента Home → «дом» на месте, fatigue падает (бездомный спит тут)', () => {
    const w = createSimWorld(22 as Seed);
    const eid = placeActor(w, { loc: 5, fatigue: 50, kind: TaskKind.SLEEP }); // без home
    execOnce(w);
    expect(NEED.fatigue[eid]).toBeCloseTo(50 - SLEEP_RECOVERY_PER_TICK, 4);
  });

  it('REST в любой локации (вне дома) → fatigue −= REST_RECOVERY', () => {
    const w = createSimWorld(23 as Seed);
    const eid = placeActor(w, { loc: 7, fatigue: 50, kind: TaskKind.REST }); // Рыжий лес, не дом
    execOnce(w);
    expect(NEED.fatigue[eid]).toBeCloseTo(50 - REST_RECOVERY_PER_TICK, 4);
  });

  it('REST слабее SLEEP: за один тик REST снимает меньше усталости, чем SLEEP', () => {
    expect(REST_RECOVERY_PER_TICK).toBeLessThan(SLEEP_RECOVERY_PER_TICK);
    const w = createSimWorld(24 as Seed);
    const sleeper = placeActor(w, { loc: 0, home: 0, fatigue: 60, kind: TaskKind.SLEEP });
    const rester = placeActor(w, { loc: 0, fatigue: 60, kind: TaskKind.REST });
    execOnce(w);
    const sleptDrop = 60 - (NEED.fatigue[sleeper] as number);
    const restedDrop = 60 - (NEED.fatigue[rester] as number);
    expect(sleptDrop).toBeGreaterThan(restedDrop);
  });

  it('кламп 0: малая усталость при REST не уходит в минус', () => {
    const w = createSimWorld(25 as Seed);
    const eid = placeActor(w, { loc: 0, fatigue: 0.03, kind: TaskKind.REST });
    execOnce(w);
    expect(NEED.fatigue[eid]).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FORAGE — подножный корм из среды пропорц. loc.forage
// ═══════════════════════════════════════════════════════════════════════════

describe('FORAGE: hunger падает пропорц. loc.forage; в бедной локации почти ноль', () => {
  it('богатая локация (loc4 forage=0.7): hunger −= FORAGE_RECOVERY*forage', () => {
    const w = createSimWorld(30 as Seed);
    const forage = getLocation(4 as LocationId).forage;
    const eid = placeActor(w, { loc: 4, hunger: 50, kind: TaskKind.FORAGE });
    execOnce(w);
    expect(NEED.hunger[eid]).toBeCloseTo(50 - FORAGE_RECOVERY_PER_TICK * forage, 4);
  });

  it('бедная локация (Саркофаг loc9 forage=0.05): восстановление почти ноль', () => {
    const w = createSimWorld(31 as Seed);
    const eid9 = placeActor(w, { loc: 9, hunger: 50, kind: TaskKind.FORAGE });
    execOnce(w);
    const drop9 = 50 - (NEED.hunger[eid9] as number);
    expect(drop9).toBeGreaterThan(0);
    expect(drop9).toBeLessThan(0.05); // почти ноль

    // Пропорциональность: богатая loc4 снимает СИЛЬНО больше, чем бедная loc9.
    const w2 = createSimWorld(31 as Seed);
    const eid4 = placeActor(w2, { loc: 4, hunger: 50, kind: TaskKind.FORAGE });
    execOnce(w2);
    const drop4 = 50 - (NEED.hunger[eid4] as number);
    expect(drop4).toBeGreaterThan(drop9 * 5); // forage 0.7 vs 0.05 ⇒ ×14
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HUNT/FLEE — без восстановления в этой системе
// ═══════════════════════════════════════════════════════════════════════════

describe('HUNT/FLEE: TaskEffects не восстанавливает нужды', () => {
  it('HUNT стоя у дичи → hunger не меняется (мясо даёт Encounter 1.10)', () => {
    const w = createSimWorld(40 as Seed);
    const eid = placeActor(w, { loc: 4, hunger: 80, kind: TaskKind.HUNT, inventory: [{ item: 'canned', qty: 1 }] });
    execOnce(w);
    expect(NEED.hunger[eid]).toBe(80);
    expect(inv(w, eid)).toEqual([{ item: 'canned', qty: 1 }]); // и еду не трогает
  });

  it('FLEE → ни одна нужда не восстановлена (это только движение)', () => {
    const w = createSimWorld(41 as Seed);
    const eid = placeActor(w, { loc: 0, hunger: 40, thirst: 40, fatigue: 40, kind: TaskKind.FLEE });
    execOnce(w);
    expect(NEED.hunger[eid]).toBe(40);
    expect(NEED.thirst[eid]).toBe(40);
    expect(NEED.fatigue[eid]).toBe(40);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ТОЛЬКО СТОЯЩИЕ (dest===loc) исполняют; в транзите — нет эффекта (D-019)
// ═══════════════════════════════════════════════════════════════════════════

describe('только стоящие у цели исполняют задачу; в пути — нет эффекта', () => {
  it('в транзите (dest≠loc) EAT НЕ исполняется: hunger и инвентарь неизменны', () => {
    const w = createSimWorld(50 as Seed);
    const eid = placeActor(w, { loc: 0, dest: 1, hunger: 85, kind: TaskKind.EAT, inventory: [{ item: 'canned', qty: 2 }] });
    execOnce(w);
    expect(NEED.hunger[eid]).toBe(85); // шагает — не ест
    expect(inv(w, eid)).toEqual([{ item: 'canned', qty: 2 }]); // еда не расходуется в пути
  });

  it('в транзите DRINK/REST не восстанавливают', () => {
    const w = createSimWorld(51 as Seed);
    const drinker = placeActor(w, { loc: 0, dest: 1, thirst: 90, kind: TaskKind.DRINK });
    const rester = placeActor(w, { loc: 0, dest: 1, fatigue: 90, kind: TaskKind.REST });
    execOnce(w);
    expect(NEED.thirst[drinker]).toBe(90);
    expect(NEED.fatigue[rester]).toBe(90);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ДЕТЕРМИНИЗМ + RESUME (закон №8)
// ═══════════════════════════════════════════════════════════════════════════

/** Полный конвейер с восстановлением (порядок D-032). */
function fullPipeline(): Scheduler {
  const s = createScheduler();
  s.register(NeedsSystem);
  s.register(Perception);
  s.register(TaskSelection);
  s.register(Movement);
  s.register(TaskEffects); // ПОСЛЕ Movement (сущность уже переместилась/стоит)
  return s;
}

describe('детерминизм: один seed → идентичный мир на полном конвейере с восстановлением', () => {
  function run(seed: number): string {
    const w = createSimWorld(seed as Seed);
    worldgen(w);
    fullPipeline().run(w, 400);
    return hashSnapshot(serialize(w));
  }
  it('seed=333: два прогона по 400 тиков дают идентичный снапшот-хэш', () => {
    expect(run(333)).toBe(run(333));
  });
});

describe('resume: непрерывный прогон === split через save/load (Needs+инвентарь)', () => {
  it('400 тиков непрерывно vs 200+save/load+200 → идентичный хэш', () => {
    const cont = createSimWorld(77 as Seed);
    worldgen(cont);
    fullPipeline().run(cont, 400);

    const split = createSimWorld(77 as Seed);
    worldgen(split);
    fullPipeline().run(split, 200);
    const restored = deserialize(serialize(split));
    fullPipeline().run(restored, 200);

    expect(hashSnapshot(serialize(restored))).toBe(hashSnapshot(serialize(cont)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ВЫЖИВАТЕЛЬНЫЙ ЦИКЛ (мини): накопление нужд ПЕРЕБИВАЕТСЯ восстановлением
// ═══════════════════════════════════════════════════════════════════════════

describe('интеграция: голод перебивается едой — сталкер ест консерву, hunger падает', () => {
  it('голодный дома с консервами: (TaskSelection) EAT → (TaskEffects) съел, hunger упал, консерва ушла', () => {
    const w = createSimWorld(90 as Seed);
    // Сталкер дома в Кордоне (безопасно, есть вода), голоден, но с запасом еды.
    const eid = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, eid);
    POS.loc[eid] = 0; POS.dest[eid] = 0;
    addComponent(w.ecs, Needs, eid);
    NEED.hunger[eid] = 90; NEED.thirst[eid] = 10; NEED.fatigue[eid] = 10; NEED.fear[eid] = 0;
    addComponent(w.ecs, Health, eid); HP.hp[eid] = HEALTH_MAX;
    addComponent(w.ecs, Home, eid); HOME.loc[eid] = 0;
    addComponent(w.ecs, Human, eid); addComponent(w.ecs, Alive, eid);
    w.resources.set<readonly InvEntry[]>('inventory', eid, [{ item: 'canned', qty: 3 }]);

    const hungerStart = NEED.hunger[eid] as number;
    const foodStart = totalItems(inv(w, eid)); // 3

    const sched = fullPipeline();
    for (let t = 0; t < 8; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      sched.tickOnce(w);
    }

    // Накопление (Needs +0.035/тик за 8 тиков ≈ +0.28) ПЕРЕБИТО едой: hunger реально
    // упал намного ниже старта, а не только «замедлил рост».
    expect(NEED.hunger[eid] as number).toBeLessThan(hungerStart - 40);
    // Еда ФИЗИЧЕСКИ израсходована (закон №3): консерв стало меньше.
    expect(totalItems(inv(w, eid))).toBeLessThan(foodStart);
    // Сталкер выбрал именно EAT в какой-то момент (событие в летописи).
    const ate = w.bus.log.some(
      (e) => e.type === 'task/selected' && (e.payload as { eid: number; kind: number }).eid === eid && (e.payload as { kind: number }).kind === TaskKind.EAT,
    );
    expect(ate).toBe(true);
    // И не умер от голода в процессе.
    expect(HP.hp[eid] as number).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EAT — «самая питательная первой» среди РАЗНЫХ записей + детерминированный tie
// ═══════════════════════════════════════════════════════════════════════════

describe('EAT: очередь по убыванию nutrition среди разных еды; не-еда не трогается', () => {
  it('bread(25)+canned(45)+meat(35): три EAT съедают canned → meat → bread', () => {
    const w = createSimWorld(100 as Seed);
    // Инвентарь ОТСОРТИРОВАН по item: bread, canned, meat (как пишет worldgen 1.3).
    const eid = placeActor(w, {
      loc: 0,
      hunger: 100,
      kind: TaskKind.EAT,
      inventory: [{ item: 'bread', qty: 1 }, { item: 'canned', qty: 1 }, { item: 'meat', qty: 1 }],
    });
    execOnce(w); // самая питательная — canned(45): исчерпана, выпала; сортировка сохранена
    expect(inv(w, eid)).toEqual([{ item: 'bread', qty: 1 }, { item: 'meat', qty: 1 }]);
    execOnce(w); // следующая — meat(35)
    expect(inv(w, eid)).toEqual([{ item: 'bread', qty: 1 }]);
    execOnce(w); // последняя — bread(25)
    expect(inv(w, eid)).toEqual([]);
    // Суммарно съедено nutrition 45+35+25=105 (кламп в 0 — голод закрыт с запасом).
    expect(NEED.hunger[eid]).toBe(0);
  });

  it('смешанный инвентарь: EAT ест ТОЛЬКО еду; оружие/патроны/бинты нетронуты, порядок цел', () => {
    const w = createSimWorld(101 as Seed);
    // Отсортировано по item: ammo_9mm, bandage, bread, canned, meat, pm.
    const mixed = [
      { item: 'ammo_9mm', qty: 30 },
      { item: 'bandage', qty: 2 },
      { item: 'bread', qty: 1 },
      { item: 'canned', qty: 1 },
      { item: 'meat', qty: 1 },
      { item: 'pm', qty: 1 },
    ];
    const eid = placeActor(w, { loc: 0, hunger: 100, kind: TaskKind.EAT, inventory: mixed });
    execOnce(w); execOnce(w); execOnce(w); // съедены все три еды (canned, meat, bread)
    const nonFood = [
      { item: 'ammo_9mm', qty: 30 },
      { item: 'bandage', qty: 2 },
      { item: 'pm', qty: 1 },
    ];
    expect(inv(w, eid)).toEqual(nonFood); // еда ушла, снаряжение на месте, порядок сохранён
    execOnce(w); // еды нет → no-op, не-еду не «съел с голоду»
    expect(inv(w, eid)).toEqual(nonFood);
  });

  it('РАВНАЯ питательность → tie детерминирован (первая по массиву). Синтетика: в items.json nutrition РАЗНЫЕ, путь недостижим на проде', () => {
    const w = createSimWorld(102 as Seed);
    // Две записи одного предмета (nutrition 45 у обеих) моделируют равную питательность.
    // Строгое `>` при обходе ⇒ выбирается ПЕРВАЯ (меньший индекс), вторая нетронута.
    const eid = placeActor(w, {
      loc: 0,
      hunger: 100,
      kind: TaskKind.EAT,
      inventory: [{ item: 'canned', qty: 5 }, { item: 'canned', qty: 7 }],
    });
    execOnce(w);
    expect(inv(w, eid)).toEqual([{ item: 'canned', qty: 4 }, { item: 'canned', qty: 7 }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// НАХОДКА (переедание впустую) — УСТРАНЕНА в D-034: EAT масштабируется голодом
// `(W.hunger+W.food)·hunger`, поэтому сытый (hunger≈0) EAT НЕ выбирает и запас не
// жжёт. TaskEffects по-прежнему исполняет EAT ВСЛЕПУЮ (если Task=EAT — механика
// ниже), но TaskSelection больше не назначает EAT сытому. Тесты закрепляют фикс.
// ═══════════════════════════════════════════════════════════════════════════

describe('переедание устранено (D-034): сытый не выбирает EAT, запас цел', () => {
  it('механика TaskEffects: EAT при hunger=0 всё равно списывает единицу (исполнение вслепую)', () => {
    // НЕ про ВЫБОР задачи (его чинит D-034), а про ИСПОЛНЕНИЕ: если Task УЖЕ=EAT,
    // TaskEffects расходует еду безусловно. Фикс переедания живёт в TaskSelection —
    // сюда EAT сытому больше не приходит (см. следующий тест). Контракт исполнителя
    // сохранён: закон №3 не нарушен (предмет физически исчез), но пользы нет.
    const w = createSimWorld(110 as Seed);
    const eid = placeActor(w, { loc: 0, hunger: 0, kind: TaskKind.EAT, inventory: [{ item: 'canned', qty: 2 }] });
    execOnce(w);
    expect(NEED.hunger[eid]).toBe(0);
    expect(totalItems(inv(w, eid))).toBe(1);
  });

  it('РЕГРЕСС D-034: сытый (hunger=0) в СУХОЙ локации с едой НЕ выбирает EAT — запас НЕ горит', () => {
    // Раньше (плоский бонус W.food) сытый выбирал EAT и палил стек по единице/тик.
    // Теперь sEat=(W.hunger+W.food)·hunger при hunger=0 → 0, проигрывает fallback
    // (SLEEP/FORAGE/REST) — запас нетронут, пока сталкер сыт.
    const w = createSimWorld(111 as Seed);
    const eid = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, eid); POS.loc[eid] = 3; POS.dest[eid] = 3; // Тёмная долина: нет воды
    addComponent(w.ecs, Needs, eid);
    NEED.hunger[eid] = 0; NEED.thirst[eid] = 0; NEED.fatigue[eid] = 0; NEED.fear[eid] = 0;
    addComponent(w.ecs, Health, eid); HP.hp[eid] = HEALTH_MAX;
    addComponent(w.ecs, Human, eid); addComponent(w.ecs, Alive, eid); // без Home — «дом на месте»
    w.resources.set<readonly InvEntry[]>('inventory', eid, [{ item: 'canned', qty: 8 }]);

    const foodStart = totalItems(inv(w, eid)); // 8
    const sched = fullPipeline();
    for (let t = 0; t < 6; t++) { w.tick = (600 + t) as Tick; sched.tickOnce(w); }

    expect(totalItems(inv(w, eid))).toBe(foodStart); // ни одной консервы не сожжено
    expect(NEED.hunger[eid] as number).toBeLessThan(1); // сталкер всё это время СЫТ
    const ate = w.bus.log.some(
      (e) => e.type === 'task/selected'
        && (e.payload as { eid: number }).eid === eid
        && (e.payload as { kind: number }).kind === TaskKind.EAT,
    );
    expect(ate).toBe(false); // сытый EAT НЕ выбирает (переедание устранено)
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ИЗОЛЯЦИЯ инвентаря при EAT (регресс аляйсинга 1.3): resources.set(новый массив)
// не заражает соседа, делящего ссылку; общий массив НЕ мутируется на месте.
// ═══════════════════════════════════════════════════════════════════════════

describe('EAT изолирует инвентарь: общая ссылка не течёт между сталкерами', () => {
  it('двое делят ОДНУ ссылку на inventory: EAT одного не трогает запас другого', () => {
    const w = createSimWorld(120 as Seed);
    // Насильно навешиваем ОБОИМ один и тот же объект-массив (симуляция регресса 1.3).
    const shared: InvEntry[] = [{ item: 'canned', qty: 3 }, { item: 'bread', qty: 2 }];
    const eater = placeActor(w, { loc: 0, hunger: 100, kind: TaskKind.EAT });
    const bystander = placeActor(w, { loc: 0, fatigue: 50, kind: TaskKind.REST }); // не ест
    w.resources.set<readonly InvEntry[]>('inventory', eater, shared);
    w.resources.set<readonly InvEntry[]>('inventory', bystander, shared);

    execOnce(w); // eater ест canned(45); bystander только отдыхает

    // Сосед не тронут: его запас прежний, и он всё ещё указывает на исходный shared.
    expect(inv(w, bystander)).toEqual([{ item: 'canned', qty: 3 }, { item: 'bread', qty: 2 }]);
    expect(inv(w, bystander)).toBe(shared); // ссылка соседа не переписана
    // Общий массив НЕ мутирован на месте (закон изоляции): qty первой записи цел.
    expect(shared[0]).toEqual({ item: 'canned', qty: 3 });
    // Едок получил СВОЙ новый массив (де-аляйсинг), а не мутацию общего.
    expect(inv(w, eater)).toEqual([{ item: 'canned', qty: 2 }, { item: 'bread', qty: 2 }]);
    expect(inv(w, eater)).not.toBe(shared);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// КЛАМП/монотонность: эффекты только СНИЖАЮТ нужды; ни одна не растёт и не
// выходит за [0, NEED_MAX]. DRINK/FORAGE НЕ трогают инвентарь (источник — среда).
// ═══════════════════════════════════════════════════════════════════════════

describe('кламп и монотонность: восстановление не создаёт нужд из воздуха', () => {
  it('нужда=0 у своего эффекта остаётся 0 (DRINK/FORAGE/REST/SLEEP); ниже 0 не уходит', () => {
    const w = createSimWorld(140 as Seed);
    const drinker = placeActor(w, { loc: 0, thirst: 0, kind: TaskKind.DRINK });
    const forager = placeActor(w, { loc: 4, hunger: 0, kind: TaskKind.FORAGE });
    const rester = placeActor(w, { loc: 0, fatigue: 0, kind: TaskKind.REST });
    const sleeper = placeActor(w, { loc: 0, home: 0, fatigue: 0, kind: TaskKind.SLEEP });
    execOnce(w);
    expect(NEED.thirst[drinker]).toBe(0);
    expect(NEED.hunger[forager]).toBe(0);
    expect(NEED.fatigue[rester]).toBe(0);
    expect(NEED.fatigue[sleeper]).toBe(0);
  });

  it('эффект НИКОГДА не увеличивает нужду и не превышает NEED_MAX (только вниз)', () => {
    const w = createSimWorld(141 as Seed);
    const start = 40;
    const d = placeActor(w, { loc: 0, thirst: start, kind: TaskKind.DRINK });
    const f = placeActor(w, { loc: 4, hunger: start, kind: TaskKind.FORAGE });
    const r = placeActor(w, { loc: 7, fatigue: start, kind: TaskKind.REST });
    const s = placeActor(w, { loc: 0, home: 0, fatigue: start, kind: TaskKind.SLEEP });
    execOnce(w);
    for (const [need, eid] of [
      [NEED.thirst[d], d], [NEED.hunger[f], f], [NEED.fatigue[r], r], [NEED.fatigue[s], s],
    ] as const) {
      expect(need as number).toBeLessThanOrEqual(start); // не выросла
      expect(need as number).toBeGreaterThanOrEqual(0);   // не ниже 0
      expect(need as number).toBeLessThanOrEqual(NEED_MAX); // не выше потолка
    }
  });

  it('DRINK/FORAGE — из среды, а не из инвентаря: при них инвентарь неизменен (закон №3)', () => {
    const w = createSimWorld(142 as Seed);
    const drinker = placeActor(w, { loc: 0, thirst: 90, kind: TaskKind.DRINK, inventory: [{ item: 'canned', qty: 2 }] });
    const forager = placeActor(w, { loc: 4, hunger: 90, kind: TaskKind.FORAGE, inventory: [{ item: 'canned', qty: 2 }] });
    execOnce(w);
    expect(inv(w, drinker)).toEqual([{ item: 'canned', qty: 2 }]); // пил из реки, не из банки
    expect(inv(w, forager)).toEqual([{ item: 'canned', qty: 2 }]); // подножный корм, банку не трогал
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// СТОЯЩИЙ контракт для SLEEP; FORAGE всегда >0 (нет forage=0 на карте)
// ═══════════════════════════════════════════════════════════════════════════

describe('стоящий контракт SLEEP; карта не имеет мёртвого forage', () => {
  it('SLEEP в транзите (dest≠loc, дома по loc) → БЕЗ эффекта (нельзя спать шагая)', () => {
    const w = createSimWorld(150 as Seed);
    const eid = placeActor(w, { loc: 0, dest: 1, home: 0, fatigue: 50, kind: TaskKind.SLEEP });
    execOnce(w);
    expect(NEED.fatigue[eid]).toBe(50);
  });

  it('ни одна локация не имеет forage=0 ⇒ FORAGE всегда даёт строго >0 (в Саркофаге — почти ноль)', () => {
    const minForage = Math.min(...MAP.locations.map((l) => l.forage));
    expect(minForage).toBeGreaterThan(0);
    // И это «почти ноль» действительно даёт крошечное, но >0 восстановление.
    const w = createSimWorld(151 as Seed);
    const eid = placeActor(w, { loc: 9, hunger: 50, kind: TaskKind.FORAGE }); // Саркофаг forage=0.05
    execOnce(w);
    expect(50 - (NEED.hunger[eid] as number)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ПОРЯДОК D-032: TaskEffects ПОСЛЕ Movement — прибыл этим тиком ⇒ исполняет СЕЙЧАС
// ═══════════════════════════════════════════════════════════════════════════

describe('порядок Movement<TaskEffects: прибытие и исполнение в ОДИН тик', () => {
  it('в пути к воде, eta=1: Movement прибывает (loc=dest), TaskEffects пьёт в тот же тик', () => {
    const w = createSimWorld(160 as Seed);
    // loc1 (без воды) → dest0 (Кордон, вода). eta=1 ⇒ прибудет ЭТИМ тиком.
    const eid = placeActor(w, { loc: 1, dest: 0, thirst: 90, kind: TaskKind.DRINK });
    POS.etaTicks[eid] = 1;
    TSK.targetLoc[eid] = 0;

    const s = createScheduler();
    s.register(Movement);
    s.register(TaskEffects); // ПОСЛЕ Movement (D-032)
    w.tick = DAY_TICK;
    s.tickOnce(w);

    expect(POS.loc[eid]).toBe(0); // Movement прибыл
    expect(NEED.thirst[eid]).toBeCloseTo(90 - DRINK_RECOVERY_PER_TICK, 4); // и попил в тот же тик
  });

  it('обратный порядок TaskEffects<Movement: на момент эффекта ещё в пути ⇒ пьёт лишь СО СЛЕДУЮЩЕГО тика', () => {
    // Демонстрирует, ПОЧЕМУ D-032 фиксирует Movement РАНЬШЕ TaskEffects.
    const w = createSimWorld(161 as Seed);
    const eid = placeActor(w, { loc: 1, dest: 0, thirst: 90, kind: TaskKind.DRINK });
    POS.etaTicks[eid] = 1;
    TSK.targetLoc[eid] = 0;

    const s = createScheduler();
    s.register(TaskEffects); // РАНЬШЕ Movement — «неправильный» порядок
    s.register(Movement);
    w.tick = DAY_TICK;
    s.tickOnce(w);

    // TaskEffects увидел dest(0)≠loc(1) → пропустил; Movement затем прибыл.
    expect(POS.loc[eid]).toBe(0);
    expect(NEED.thirst[eid]).toBe(90); // в этот тик НЕ попил — потерянный тик восстановления
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESUME посреди еды: съел половину → save/load → доедает то же (закон №8)
// ═══════════════════════════════════════════════════════════════════════════

describe('resume посреди запаса: split через save/load === непрерывный (инвентарь+нужды)', () => {
  it('canned qty=4: 2 EAT — сериализация — ещё 2 EAT на restored ⇒ пусто, hunger как в непрерывном', () => {
    // Непрерывный прогон: 4 EAT подряд. serialize СРАЗУ (SoA-массивы bitecs глобальны —
    // снимок фиксирует значения до того, как split-мир перепишет те же eid).
    const cont = createSimWorld(170 as Seed);
    const ec = placeActor(cont, { loc: 0, hunger: 100, kind: TaskKind.EAT, inventory: [{ item: 'canned', qty: 4 }] });
    execOnce(cont); execOnce(cont); execOnce(cont); execOnce(cont);
    const contSnap = serialize(cont); // глубокая копия нужд+инвентаря

    // Split: 2 EAT, save/load, ещё 2 EAT.
    const split = createSimWorld(170 as Seed);
    const es = placeActor(split, { loc: 0, hunger: 100, kind: TaskKind.EAT, inventory: [{ item: 'canned', qty: 4 }] });
    execOnce(split); execOnce(split);
    const restored = deserialize(serialize(split));
    execOnce(restored); execOnce(restored);

    // Инвентарь (ResourceStore, per-world) и нужды (глобальный SoA после restored) сошлись.
    expect(hashSnapshot(serialize(restored))).toBe(hashSnapshot(contSnap));
    expect(inv(restored, es)).toEqual([]);       // запас доеден
    expect(NEED.hunger[es]).toBe(0);             // 4×nutrition(45)=180, кламп 0
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ВЫЖИВАТЕЛЬНЫЙ СЦЕНАРИЙ: запас КОНЕЧЕН — кончился → голод снова растёт → мотив HUNT
// ═══════════════════════════════════════════════════════════════════════════

describe('сценарий выживания: без пополнения запас кончается и сталкер снова голодает', () => {
  it('дома с конечным запасом и без дичи: еда истощается, hunger РЕБАУНДит к критическому, hp падает', () => {
    const w = createSimWorld(180 as Seed);
    const eid = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, eid); POS.loc[eid] = 0; POS.dest[eid] = 0;
    addComponent(w.ecs, Needs, eid);
    NEED.hunger[eid] = 90; NEED.thirst[eid] = 0; NEED.fatigue[eid] = 0; NEED.fear[eid] = 0;
    addComponent(w.ecs, Health, eid); HP.hp[eid] = HEALTH_MAX;
    addComponent(w.ecs, Home, eid); HOME.loc[eid] = 0;
    addComponent(w.ecs, Human, eid); addComponent(w.ecs, Alive, eid);
    w.resources.set<readonly InvEntry[]>('inventory', eid, [{ item: 'canned', qty: 3 }]);

    const sched = fullPipeline();
    let depletedTick = -1;
    let hungerAtDepletion = -1;
    let crossedCritical = false;
    // Горизонт с запасом: после D-034 сталкер ест РАЦИОНАЛЬНО (2 консервы гасят
    // старт 90→0, 3-я держится в резерве и уходит лишь когда голод отрастает выше
    // порога выбора EAT). Поэтому истощение наступает не мгновенно, а спустя ~тысячи
    // тиков — но НАСТУПАЕТ (запас конечен, охоты 1.10 нет), после чего голод
    // рибаундит к критическому и грызёт hp. Прежние <10 тиков были артефактом
    // переедания (сгорал весь стек сразу) — устранены фиксом.
    for (let t = 0; t < 8000; t++) {
      w.tick = (600 + t) as Tick;
      sched.tickOnce(w);
      if (depletedTick < 0 && totalItems(inv(w, eid)) === 0) {
        depletedTick = t;
        hungerAtDepletion = NEED.hunger[eid] as number;
      }
      if (depletedTick >= 0 && (NEED.hunger[eid] as number) >= HUNGER_CRITICAL) crossedCritical = true;
    }

    // Запас КОНЕЧЕН и в итоге исчерпан (нет охоты 1.10 — не пополнить), но РАЦИОНАЛЬНО:
    // не мгновенно (переедание устранено — резерв не сгорел впустую при сытости).
    expect(depletedTick).toBeGreaterThanOrEqual(0);
    expect(depletedTick).toBeGreaterThan(10); // не «сжёг всё за пару тиков» (D-034)
    expect(totalItems(inv(w, eid))).toBe(0);
    // После истощения голод СНОВА растёт (рибаунд), а не «заморожен»: доходит до критического.
    expect(crossedCritical).toBe(true);
    expect(NEED.hunger[eid] as number).toBeGreaterThan(hungerAtDepletion);
    // И начинает грызть здоровье — вот что МОТИВИРУЕТ HUNT (1.10): без мяса сталкер гибнет.
    expect(HP.hp[eid] as number).toBeLessThan(HEALTH_MAX);
    expect(HP.hp[eid] as number).toBeGreaterThan(0); // ещё жив — смерть эмерджентна, не по таймеру
  });
});
