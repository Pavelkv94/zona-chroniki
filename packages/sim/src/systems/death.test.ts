/**
 * @module @zona/sim/systems/death.test
 *
 * Гейт системы Death (задача 1.11, B.1). Покрывает:
 *  - ПРЕОБРАЗОВАНИЕ: hp<=0 при теге Alive → снят Alive/Needs/Task/Animal, повешен
 *    Corpse; Position+inventory+name ОСТАЛИСЬ (труп несёт лут, закон №3); entity/died
 *    опубликован РОВНО ОДИН раз;
 *  - ПРИЧИННОСТЬ БОЯ: lethalCause=encounter/resolved → entity/died.causedBy=это событие
 *    (цепочка encounter→died), cause='combat' (в т.ч. внутритиковая и через committed-лог);
 *  - ПРИЧИННОСТЬ ГОЛОДА: интеграция Needs→Death — истощение штампует lethalCause=
 *    needs/threshold → entity/died.causedBy=порог, cause='starvation'; смерть ОБЪЯСНИМА;
 *  - corpse/created: items=инвентарь покойника, causedBy=died, труп ПЕРСИСТИТ (не удалён);
 *  - ИМЯ: entity/died.name для человека; у животного name нет — не падает;
 *  - НЕТ ДУБЛЯ: после снятия Alive сущность не переопределяется; entity/died один раз,
 *    в т.ч. через save/load (тег Alive resume-safe) — split ≡ continuous по хэшу;
 *  - ДЕТЕРМИНИЗМ: два прогона → идентичный лог смертей.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, LocationId, Seed, SimEvent } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, hasComponent, existsEntity } from '../core/ecs';
import {
  Position,
  Task,
  Skills,
  Health,
  Needs,
  Animal,
  Alive,
  Corpse,
  Human,
  TaskKind,
} from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { HEALTH_MAX, HUNGER_CRITICAL, THIRST_CRITICAL, FATIGUE_CRITICAL } from '../balance/needs';
import { Death } from './death';
import { Needs as NeedsSystem } from './needs';
import { Encounters } from './encounters';
import { Weather } from './weather';
import { Perception } from './perception';
import { TaskSelection } from './task-selection';
import { TaskEffects } from './task-effects';
import { Movement } from './movement';
import { Animals } from './animals';
import { worldgen } from '../worldgen';

const DEER = 0;
const LOC = 3 as LocationId;

// ── Типизированные SoA-колонки для установки/чтения в тестах ──────────────────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const HP = Health as unknown as { hp: Float32Array; lethalCause: Uint32Array };
const NEED = Needs as unknown as { hunger: Float32Array; thirst: Float32Array };
const TSK = Task as unknown as { kind: Uint8Array; targetLoc: Uint32Array; targetEid: Uint32Array; causeEvent: Uint32Array };
const SKILL = Skills as unknown as { shooting: Float32Array };
const ANIM = Animal as unknown as { species: Uint8Array; herd: Uint32Array };

interface NameRecord {
  readonly first: string;
  readonly last: string;
  readonly nickname: string;
}
interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
}

/** Планировщик только с Death. */
function deathScheduler() {
  const s = createScheduler();
  s.register(Death);
  return s;
}

/** Селит человека-сталкера: Human/Alive/Position/Needs/Task/Health + name + inventory. */
function placeStalker(
  world: SimWorld,
  opts: { loc?: number; hunger?: number; hp?: number; inv?: InventoryEntry[]; name?: NameRecord } = {},
): EntityId {
  const eid = spawnEntity(world.ecs);
  const loc = opts.loc ?? LOC;
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  addComponent(world.ecs, Needs, eid);
  NEED.hunger[eid] = opts.hunger ?? 0;
  addComponent(world.ecs, Task, eid);
  TSK.kind[eid] = TaskKind.REST;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = opts.hp ?? HEALTH_MAX;
  world.resources.set<NameRecord>('name', eid, opts.name ?? { first: 'Иван', last: 'Стрелок', nickname: 'Тень' });
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, opts.inv ?? [{ item: 'pm', qty: 1 }]);
  return eid;
}

/** Селит живое животное (Animal/Position/Health/Alive) без имени. */
function placeAnimal(world: SimWorld, species: number, loc: number, hp = HEALTH_MAX): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Animal, eid);
  ANIM.species[eid] = species;
  ANIM.herd[eid] = 1;
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = hp;
  addComponent(world.ecs, Alive, eid);
  return eid;
}

/** Селит стоящего охотника с Task=HUNT на цель (форма как encounters.test). */
function placeHunter(world: SimWorld, loc: number, target: EntityId): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  addComponent(world.ecs, Skills, eid);
  SKILL.shooting[eid] = 0.6;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = HEALTH_MAX;
  addComponent(world.ecs, Task, eid);
  TSK.kind[eid] = TaskKind.HUNT;
  TSK.targetLoc[eid] = loc;
  TSK.targetEid[eid] = target;
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, [
    { item: 'ammo_9mm', qty: 16 },
    { item: 'pm', qty: 1 },
  ]);
  return eid;
}

/** entity/died события заданного eid из лога. */
function diedEvents(world: SimWorld, eid: EntityId): readonly SimEvent[] {
  return world.bus.log.filter(
    (e) => e.type === 'entity/died' && (e.payload as { eid: number }).eid === eid,
  );
}

describe('Death: преобразование в труп (закон №3 — лут остаётся)', () => {
  it('человек hp<=0: снят Alive/Needs/Task, повешен Corpse; Position/name/inventory остались', () => {
    const w = createSimWorld(1 as Seed);
    const eid = placeStalker(w, { hp: 0, inv: [{ item: 'pm', qty: 1 }, { item: 'vodka', qty: 2 }] });

    deathScheduler().run(w, 1);

    // Снято: Alive, Needs, Task.
    expect(hasComponent(w.ecs, Alive, eid)).toBe(false);
    expect(hasComponent(w.ecs, Needs, eid)).toBe(false);
    expect(hasComponent(w.ecs, Task, eid)).toBe(false);
    // Повешено: Corpse. Human остаётся (труп был человеком).
    expect(hasComponent(w.ecs, Corpse, eid)).toBe(true);
    expect(hasComponent(w.ecs, Human, eid)).toBe(true);
    // Осталось: Position, Health (маркер hp<=0), name, inventory (ЛУТ, закон №3).
    expect(hasComponent(w.ecs, Position, eid)).toBe(true);
    expect(hasComponent(w.ecs, Health, eid)).toBe(true);
    expect(existsEntity(w.ecs, eid)).toBe(true); // труп ПЕРСИСТИТ, не удалён
    expect(w.resources.get<NameRecord>('name', eid)).toEqual({ first: 'Иван', last: 'Стрелок', nickname: 'Тень' });
    expect(w.resources.get<readonly InventoryEntry[]>('inventory', eid)).toEqual([
      { item: 'pm', qty: 1 },
      { item: 'vodka', qty: 2 },
    ]);
  });

  it('животное hp<=0: снят Alive/Animal, повешен Corpse; имени нет — не падает', () => {
    const w = createSimWorld(1 as Seed);
    const deer = placeAnimal(w, DEER, LOC, 0);

    expect(() => deathScheduler().run(w, 1)).not.toThrow();

    expect(hasComponent(w.ecs, Alive, deer)).toBe(false);
    expect(hasComponent(w.ecs, Animal, deer)).toBe(false);
    expect(hasComponent(w.ecs, Corpse, deer)).toBe(true);
    // entity/died без name (у животного нет записи 'name').
    const died = diedEvents(w, deer);
    expect(died).toHaveLength(1);
    expect((died[0]!.payload as { name?: string }).name).toBeUndefined();
  });

  it('entity/died публикуется РОВНО ОДИН раз и несёт имя человека', () => {
    const w = createSimWorld(1 as Seed);
    const eid = placeStalker(w, { hp: -5 });
    deathScheduler().run(w, 1);
    const died = diedEvents(w, eid);
    expect(died).toHaveLength(1);
    expect((died[0]!.payload as { name?: string }).name).toBe('Иван Стрелок');
  });

  it('живой (hp>0) НЕ умирает; сущность без Health не трогается', () => {
    const w = createSimWorld(1 as Seed);
    const alive = placeStalker(w, { hp: 50 });
    // Alive без Health.
    const noHealth = spawnEntity(w.ecs);
    addComponent(w.ecs, Alive, noHealth);
    deathScheduler().run(w, 1);
    expect(hasComponent(w.ecs, Alive, alive)).toBe(true);
    expect(diedEvents(w, alive)).toHaveLength(0);
    expect(hasComponent(w.ecs, Alive, noHealth)).toBe(true);
  });
});

describe('Death: corpse/created (лут покойника, причина — died)', () => {
  it('items=инвентарь покойника (сорт. по item), causedBy=id entity/died, труп персистит', () => {
    const w = createSimWorld(2 as Seed);
    const eid = placeStalker(w, { hp: 0, inv: [{ item: 'pm', qty: 1 }, { item: 'ammo_9mm', qty: 8 }] });

    deathScheduler().run(w, 1);

    const died = w.bus.log.find((e) => e.type === 'entity/died')!;
    const corpse = w.bus.log.find((e) => e.type === 'corpse/created') as
      | Extract<SimEvent, { type: 'corpse/created' }>
      | undefined;
    expect(corpse).toBeDefined();
    expect(corpse!.causedBy).toBe(died.id);
    expect(corpse!.payload.eid).toBe(eid);
    expect(corpse!.payload.loc).toBe(LOC);
    // items = инвентарь, сорт. по itemId (ammo_9mm < pm).
    expect(corpse!.payload.items).toEqual([
      ['ammo_9mm', 8],
      ['pm', 1],
    ]);
    // Труп persists с лутом.
    expect(existsEntity(w.ecs, eid)).toBe(true);
  });

  it('покойник без инвентаря → corpse/created.items = []', () => {
    const w = createSimWorld(2 as Seed);
    const deer = placeAnimal(w, DEER, LOC, 0);
    deathScheduler().run(w, 1);
    const corpse = w.bus.log.find((e) => e.type === 'corpse/created') as
      | Extract<SimEvent, { type: 'corpse/created' }>
      | undefined;
    expect(corpse!.payload.items).toEqual([]);
  });
});

describe('Death: причинность боя (lethalCause=encounter/resolved → combat)', () => {
  it('внутритиковый пайплайн [Encounters, Death]: олень убит → died(combat), цепочка encounter→died', () => {
    const w = createSimWorld(42 as Seed);
    const deer = placeAnimal(w, DEER, LOC);
    placeHunter(w, LOC, deer);

    const s = createScheduler();
    s.register(Encounters);
    s.register(Death); // Death ПОСЛЕДНЯЯ
    s.run(w, 1);

    // Олень мёртв и стал трупом.
    expect(HP.hp[deer]).toBeLessThanOrEqual(0);
    expect(hasComponent(w.ecs, Corpse, deer)).toBe(true);
    expect(hasComponent(w.ecs, Alive, deer)).toBe(false);

    const resolved = w.bus.log.find((e) => e.type === 'encounter/resolved')!;
    const started = w.bus.log.find((e) => e.type === 'encounter/started')!;
    const died = w.bus.log.find((e) => e.type === 'entity/died') as
      | Extract<SimEvent, { type: 'entity/died' }>
      | undefined;
    expect(died).toBeDefined();
    // Причинность: died.causedBy = resolved; resolved.causedBy = started → цепочка резолвится.
    expect(died!.causedBy).toBe(resolved.id);
    expect(resolved.causedBy).toBe(started.id);
    expect(died!.payload.cause).toBe('combat');
  });

  it('через committed-лог (Death тик спустя kill): lethalCause найден → combat', () => {
    const w = createSimWorld(42 as Seed);
    const deer = placeAnimal(w, DEER, LOC);
    placeHunter(w, LOC, deer);

    // Тик 0: только Encounters — олень убит, resolved зафиксирован в логе.
    const s1 = createScheduler();
    s1.register(Encounters);
    s1.run(w, 1);
    const resolved = w.bus.log.find((e) => e.type === 'encounter/resolved')!;
    expect(HP.lethalCause[deer]).toBe(resolved.id);
    expect(hasComponent(w.ecs, Alive, deer)).toBe(true); // ещё не снят

    // Тик 1: Death читает lethalCause из committed-лога → combat.
    deathScheduler().run(w, 1);
    const died = w.bus.log.find((e) => e.type === 'entity/died') as
      | Extract<SimEvent, { type: 'entity/died' }>
      | undefined;
    expect(died!.causedBy).toBe(resolved.id);
    expect(died!.payload.cause).toBe('combat');
  });

  it('lethalCause=0 → causedBy=null, cause=unknown', () => {
    const w = createSimWorld(3 as Seed);
    const eid = placeStalker(w, { hp: 0 }); // lethalCause не проштампован
    deathScheduler().run(w, 1);
    const died = w.bus.log.find((e) => e.type === 'entity/died') as
      | Extract<SimEvent, { type: 'entity/died' }>
      | undefined;
    expect(died!.causedBy).toBeNull();
    expect(died!.payload.cause).toBe('unknown');
  });
});

describe('Death: интеграция голода (Needs→Death, смерть ОБЪЯСНИМА)', () => {
  it('голодный сталкер без еды → истощение → died(starvation), causedBy=needs/threshold', () => {
    const w = createSimWorld(4 as Seed);
    // Голод чуть ниже критического; hp мал → умрёт за несколько тиков истощения.
    const eid = placeStalker(w, { hunger: HUNGER_CRITICAL - 0.01, hp: 0.05 });

    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(Death); // Death ПОСЛЕДНЯЯ
    s.run(w, 30);

    // Умер и стал трупом.
    expect(hasComponent(w.ecs, Corpse, eid)).toBe(true);
    expect(hasComponent(w.ecs, Alive, eid)).toBe(false);

    const threshold = w.bus.log.find(
      (e) => e.type === 'needs/threshold' && (e.payload as { need: string }).need === 'hunger',
    )!;
    const died = diedEvents(w, eid);
    expect(died).toHaveLength(1);
    const d = died[0] as Extract<SimEvent, { type: 'entity/died' }>;
    // Смерть наследует причину от порога голода: цепочка needs/threshold → died.
    expect(d.causedBy).toBe(threshold.id);
    expect(d.payload.cause).toBe('starvation');
    // Полностью объяснима: causedBy указывает на корневое (needs/threshold.causedBy=null).
    expect(threshold.causedBy).toBeNull();
  });
});

describe('Death: НЕТ повторной смерти (resume-safe детекция по тегу Alive, P0)', () => {
  it('после снятия Alive сущность не переигрывается: entity/died ровно один раз за долгий прогон', () => {
    const w = createSimWorld(5 as Seed);
    const eid = placeStalker(w, { hp: 0 });
    deathScheduler().run(w, 100); // много тиков после смерти
    expect(diedEvents(w, eid)).toHaveLength(1);
  });

  it('split save/load ПОСЛЕ смерти ≡ непрерывный: хэш идентичен, entity/died без дубля', () => {
    // Непрерывный прогон: голодная смерть где-то в середине.
    const vitals = { hunger: HUNGER_CRITICAL - 0.01, hp: 0.05 } as const;
    const cont = createSimWorld(6 as Seed);
    const cEid = placeStalker(cont, vitals);
    const sched = () => {
      const s = createScheduler();
      s.register(NeedsSystem);
      s.register(Death);
      return s;
    };
    sched().run(cont, 40);
    const contHash = hashSnapshot(serialize(cont));
    const contDied = diedEvents(cont, cEid).length;
    expect(contDied).toBe(1); // умер в пределах прогона

    // Split: 10 тиков (ДО смерти) → snapshot → deserialize → ещё 30.
    const split = createSimWorld(6 as Seed);
    const sEid = placeStalker(split, vitals);
    sched().run(split, 10);
    const resumed = deserialize(serialize(split));
    sched().run(resumed, 30);

    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    expect(diedEvents(resumed, sEid).length).toBe(contDied); // ровно 1, без дубля на границе
  });

  it('split save/load СРАЗУ ПОСЛЕ смерти → после load НЕТ повторного entity/died', () => {
    const w = createSimWorld(7 as Seed);
    const eid = placeStalker(w, { hp: 0 });
    deathScheduler().run(w, 1); // умер на тике 0
    expect(diedEvents(w, eid)).toHaveLength(1);
    expect(hasComponent(w.ecs, Alive, eid)).toBe(false);

    // Снапшот покойника (Alive снят, Corpse повешен — сериализуется) → load.
    const resumed = deserialize(serialize(w));
    expect(hasComponent(resumed.ecs, Alive, eid)).toBe(false);
    expect(hasComponent(resumed.ecs, Corpse, eid)).toBe(true);
    deathScheduler().run(resumed, 50);
    // Ни одного НОВОГО entity/died: тег Alive снят и переживает load (resume-safe).
    expect(diedEvents(resumed, eid)).toHaveLength(1);
  });
});

describe('Death: детерминизм (закон №8)', () => {
  it('два прогона одного сценария → идентичный лог entity/died', () => {
    function scenario(seed: number): readonly unknown[] {
      const w = createSimWorld(seed as Seed);
      placeStalker(w, { hp: 0 }); // eid 1
      placeAnimal(w, DEER, LOC, 0); // eid 2
      placeStalker(w, { hp: -3 }); // eid 3
      deathScheduler().run(w, 3);
      return w.bus.log
        .filter((e) => e.type === 'entity/died' || e.type === 'corpse/created')
        .map((e) => ({ type: e.type, causedBy: e.causedBy, payload: { ...e.payload } }));
    }
    expect(scenario(9)).toEqual(scenario(9));
  });

  it('несколько смертей на одном тике идут в порядке возрастания eid', () => {
    const w = createSimWorld(10 as Seed);
    const a = placeStalker(w, { hp: 0 });
    const b = placeStalker(w, { hp: 0 });
    const c = placeAnimal(w, DEER, LOC, 0);
    deathScheduler().run(w, 1);
    const order = w.bus.log
      .filter((e) => e.type === 'entity/died')
      .map((e) => (e.payload as { eid: number }).eid);
    expect(order).toEqual([a, b, c].sort((x, y) => x - y));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// РАСШИРЕНИЕ ГЕЙТА (QA, задача 1.11): жажда, боевая смерть человека, инертность
// трупа, ретрофит-границы, перештамп при восстановлении, split ровно на смерти,
// мини-интеграция полного конвейера. Сценарии читаются как истории мира.
// ─────────────────────────────────────────────────────────────────────────────

const BOAR = 1;

/** needs/threshold события заданного eid и вида нужды из лога (в порядке публикации). */
function thresholdEvents(w: SimWorld, eid: EntityId, need: string): readonly SimEvent[] {
  return w.bus.log.filter(
    (e) => e.type === 'needs/threshold'
      && (e.payload as { eid: number; need: string }).eid === eid
      && (e.payload as { need: string }).need === need,
  );
}

/** Колонка fatigue компонента Needs (в основном NEED-хелпере её нет). */
const NEED_FATIGUE = Needs as unknown as { fatigue: Float32Array };

/** Полный конвейер Фазы 1 в каноничном порядке B.1 (Death — ПОСЛЕДНЯЯ). */
function fullPipeline() {
  const s = createScheduler();
  s.register(Weather);
  s.register(NeedsSystem);
  s.register(Perception);
  s.register(TaskSelection);
  s.register(TaskEffects);
  s.register(Movement);
  s.register(Encounters);
  s.register(Animals);
  s.register(Death); // всегда последняя
  return s;
}

describe('Death: жаждущая смерть (Needs→Death, cause=thirst)', () => {
  it('сталкер без воды: жажда пересекает порог → обезвоживание → died(thirst), causedBy=needs/threshold(thirst)', () => {
    const w = createSimWorld(21 as Seed);
    // Голод низкий (не мешает), жажда чуть ниже критической, hp мал → умрёт от жажды.
    const eid = placeStalker(w, { hunger: 0, hp: 0.05 });
    NEED.thirst[eid] = THIRST_CRITICAL - 0.01;

    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(Death);
    s.run(w, 30);

    expect(hasComponent(w.ecs, Corpse, eid)).toBe(true);
    expect(hasComponent(w.ecs, Alive, eid)).toBe(false);

    const thirstThreshold = thresholdEvents(w, eid, 'thirst');
    expect(thirstThreshold).toHaveLength(1);
    // Голод порога НЕ давал (держался на 0) → причина смерти = жажда, не голод.
    expect(thresholdEvents(w, eid, 'hunger')).toHaveLength(0);

    const died = diedEvents(w, eid);
    expect(died).toHaveLength(1);
    const d = died[0] as Extract<SimEvent, { type: 'entity/died' }>;
    expect(d.causedBy).toBe(thirstThreshold[0]!.id);
    expect(d.payload.cause).toBe('thirst');
    expect(thirstThreshold[0]!.causedBy).toBeNull(); // корень цепочки — физиология
  });
});

describe('Death: боевая смерть ЧЕЛОВЕКА (кабан убил охотника, цепочка combat)', () => {
  it('внутритиковый [Encounters, Death]: безоружный подранок vs кабан → человек-труп, died(combat), имя+лут целы', () => {
    const w = createSimWorld(77 as Seed);
    const boar = placeAnimal(w, BOAR, LOC); // кабан: power 8, melee 14 — убивает с одного удара
    // Охотник почти мёртв и БЕЗ ОРУЖИЯ (в инвентаре только лут): кабан гарантированно добивает.
    const hunter = placeHunter(w, LOC, boar);
    HP.hp[hunter] = 1;
    w.resources.set<readonly InventoryEntry[]>('inventory', hunter, [{ item: 'bandage', qty: 2 }]);
    w.resources.set<NameRecord>('name', hunter, { first: 'Пётр', last: 'Бедолага', nickname: 'Фарт' });

    const s = createScheduler();
    s.register(Encounters);
    s.register(Death);
    s.run(w, 1);

    // Кабан выжил, охотник пал и стал ЧЕЛОВЕЧЕСКИМ трупом.
    expect(hasComponent(w.ecs, Alive, boar)).toBe(true);
    expect(hasComponent(w.ecs, Corpse, hunter)).toBe(true);
    expect(hasComponent(w.ecs, Alive, hunter)).toBe(false);
    expect(hasComponent(w.ecs, Human, hunter)).toBe(true);

    const started = w.bus.log.find((e) => e.type === 'encounter/started')!;
    const resolved = w.bus.log.find((e) => e.type === 'encounter/resolved')!;
    const died = diedEvents(w, hunter);
    expect(died).toHaveLength(1);
    const d = died[0] as Extract<SimEvent, { type: 'entity/died' }>;
    // Цепочка: started → resolved → died; combat; имя покойника в летописи.
    expect(d.causedBy).toBe(resolved.id);
    expect(resolved.causedBy).toBe(started.id);
    expect(d.payload.cause).toBe('combat');
    expect(d.payload.name).toBe('Пётр Бедолага');

    // Труп несёт СВОЙ лут (закон №3): bandage остался на трупе, не испарился.
    const corpse = w.bus.log.find((e) => e.type === 'corpse/created') as
      | Extract<SimEvent, { type: 'corpse/created' }>
      | undefined;
    expect(corpse!.payload.items).toEqual([['bandage', 2]]);
    expect(w.resources.get<readonly InventoryEntry[]>('inventory', hunter)).toEqual([
      { item: 'bandage', qty: 2 },
    ]);
  });
});

describe('Death: труп ИНЕРТЕН (не воскресает, не копит нужды — законы №3/№4)', () => {
  it('после смерти Needs/TaskSelection/TaskEffects НЕ трогают труп: нет Alive/Needs/Task, нет новых событий, нужды не растут', () => {
    const w = createSimWorld(31 as Seed);
    const eid = placeStalker(w, { hp: 0, hunger: 10, inv: [{ item: 'pm', qty: 1 }] });

    // Тик 0: труп образован.
    deathScheduler().run(w, 1);
    expect(hasComponent(w.ecs, Corpse, eid)).toBe(true);
    const logLenAfterDeath = w.bus.log.length;

    // Гоняем ЖИВОЙ конвейер физиологии/задач вокруг трупа много тиков.
    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(TaskSelection);
    s.register(TaskEffects);
    s.register(Death);
    s.run(w, 200);

    // Труп остался трупом: НЕ воскрешён (нет Alive), физиология/задача НЕ навешаны.
    expect(hasComponent(w.ecs, Corpse, eid)).toBe(true);
    expect(hasComponent(w.ecs, Alive, eid)).toBe(false);
    expect(hasComponent(w.ecs, Needs, eid)).toBe(false);
    expect(hasComponent(w.ecs, Task, eid)).toBe(false);
    expect(hasComponent(w.ecs, Human, eid)).toBe(true); // маркер «был человеком»
    // Нужды заморожены (колонка не растёт — систему обходит стороной).
    expect(NEED.hunger[eid]).toBe(10);
    // Ни одного НОВОГО события об этом трупе (ни died, ни task/selected, ни threshold).
    expect(diedEvents(w, eid)).toHaveLength(1);
    const eventsAboutCorpse = w.bus.log
      .slice(logLenAfterDeath)
      .filter((e) => (e.payload as { eid?: number }).eid === eid);
    expect(eventsAboutCorpse).toHaveLength(0);
  });
});

describe('Death: границы ретрофита Needs (штамп ТОЛЬКО hunger/thirst у носителей Health)', () => {
  it('усталость пересекает порог, но НЕ штампует lethalCause → смерть при обнулённом hp = unknown', () => {
    const w = createSimWorld(41 as Seed);
    const eid = placeStalker(w, { hunger: 0, hp: HEALTH_MAX });
    NEED.thirst[eid] = 0;
    // Усталость чуть ниже критической → на первом тике пересечёт порог вверх.
    NEED_FATIGUE.fatigue[eid] = FATIGUE_CRITICAL - 0.01;

    const s = createScheduler();
    s.register(NeedsSystem);
    s.run(w, 1);

    // Порог усталости был (событие есть), но lethalCause НЕ проштампован усталостью.
    expect(thresholdEvents(w, eid, 'fatigue')).toHaveLength(1);
    expect(HP.lethalCause[eid]).toBe(0);

    // Кто-то обнуляет hp вне Needs/Encounters (нет штампа причины) → смерть unknown.
    HP.hp[eid] = 0;
    deathScheduler().run(w, 1);
    const d = diedEvents(w, eid)[0] as Extract<SimEvent, { type: 'entity/died' }>;
    expect(d.causedBy).toBeNull();
    expect(d.payload.cause).toBe('unknown');
  });

  it('носитель Needs БЕЗ Health: пересечение голода не падает и не штампует (некому наследовать)', () => {
    const w = createSimWorld(42 as Seed);
    const eid = spawnEntity(w.ecs);
    addComponent(w.ecs, Needs, eid);
    NEED.hunger[eid] = HUNGER_CRITICAL - 0.01;
    // Health НЕТ намеренно.

    const s = createScheduler();
    s.register(NeedsSystem);
    expect(() => s.run(w, 1)).not.toThrow();

    // Порог голода опубликован (физиология работает и без Health)…
    expect(thresholdEvents(w, eid, 'hunger')).toHaveLength(1);
    // …но сущность без Health не умирает никогда (нечему уходить в hp<=0).
    deathScheduler().run(w, 10);
    expect(diedEvents(w, eid)).toHaveLength(0);
    expect(hasComponent(w.ecs, Corpse, eid)).toBe(false);
  });
});

describe('Death: восстановление ПЕРЕД смертью → causedBy = ПОСЛЕДНИЙ порог (перештамп)', () => {
  it('пересёк голод → «поел» (упал ниже) → снова голодает → новый порог; умер по ПОСЛЕДНЕМУ', () => {
    const w = createSimWorld(51 as Seed);
    const eid = placeStalker(w, { hunger: HUNGER_CRITICAL - 0.01, hp: 0.2 });

    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(Death);

    // Фаза 1: пересекает порог голода (E1), чуть голодает (жив: hp велик относительно урона).
    s.run(w, 3);
    const firstHunger = thresholdEvents(w, eid, 'hunger');
    expect(firstHunger).toHaveLength(1);
    expect(hasComponent(w.ecs, Alive, eid)).toBe(true);
    expect(HP.lethalCause[eid]).toBe(firstHunger[0]!.id); // штамп = E1

    // «Поел»: голод упал ниже критического (штамп E1 остаётся в поле до нового пересечения).
    NEED.hunger[eid] = HUNGER_CRITICAL - 0.1;

    // Фаза 2: снова копит → НОВОЕ пересечение (E2) → перештамп → добивает истощением.
    s.run(w, 30);

    const hungerThresholds = thresholdEvents(w, eid, 'hunger');
    expect(hungerThresholds).toHaveLength(2); // ровно два пересечения вверх
    const e1 = hungerThresholds[0]!;
    const e2 = hungerThresholds[1]!;
    expect(e2.id).not.toBe(e1.id);

    const died = diedEvents(w, eid);
    expect(died).toHaveLength(1);
    const d = died[0] as Extract<SimEvent, { type: 'entity/died' }>;
    // Наследует ПОСЛЕДНИЙ порог, не первый: перештамп победил.
    expect(d.causedBy).toBe(e2.id);
    expect(d.payload.cause).toBe('starvation');
  });
});

describe('Death: RESUME ровно на тике смерти (split на границе entity/died)', () => {
  it('split на ТОЧНОМ тике смерти ≡ непрерывный: хэш и лог смертей совпадают', () => {
    const vitals = { hunger: HUNGER_CRITICAL - 0.01, hp: 0.05 } as const;
    const sched = () => {
      const s = createScheduler();
      s.register(NeedsSystem);
      s.register(Death);
      return s;
    };

    // Непрерывный прогон, чтобы узнать ТОЧНЫЙ тик смерти.
    const probe = createSimWorld(61 as Seed);
    const pEid = placeStalker(probe, vitals);
    sched().run(probe, 60);
    const deathTick = (diedEvents(probe, pEid)[0] as SimEvent).tick as number;
    expect(deathTick).toBeGreaterThan(0);

    const contHash = hashSnapshot(serialize(probe));

    // Split РОВНО на тике смерти: прогон до deathTick, snapshot/load, дальше до 60.
    const split = createSimWorld(61 as Seed);
    const sEid = placeStalker(split, vitals);
    sched().run(split, deathTick);
    const resumed = deserialize(serialize(split));
    sched().run(resumed, 60 - deathTick);

    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    expect(diedEvents(resumed, sEid)).toHaveLength(1); // без дубля на границе save/load
  });
});

describe('Death: НАХОДКА — метка cause на СОВПАДАЮЩЕМ тике (порог = тик смерти)', () => {
  it('истощение добивает В ТОТ ЖЕ тик, когда порог пересечён → causedBy верен, но метка вырождается в combat', () => {
    // hp настолько мал, что урон истощения убивает НА ТОМ ЖЕ тике пересечения порога.
    // Тогда needs/threshold ещё в буфере тика (D-005: лог отдаётся на endTick), Death
    // не находит его в committed-логе и по Фаза-1-допущению помечает cause='combat'.
    const w = createSimWorld(71 as Seed);
    const eid = placeStalker(w, { hunger: HUNGER_CRITICAL - 0.01, hp: 0.01 });

    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(Death);
    s.run(w, 1);

    const hungerThreshold = thresholdEvents(w, eid, 'hunger');
    expect(hungerThreshold).toHaveLength(1);
    const died = diedEvents(w, eid);
    expect(died).toHaveLength(1);
    const d = died[0] as Extract<SimEvent, { type: 'entity/died' }>;

    // АВТОРИТЕТНАЯ связь причинности ЦЕЛА: causedBy указывает на голод-порог.
    expect(d.causedBy).toBe(hungerThreshold[0]!.id);
    // ХАРАКТЕРИЗАЦИЯ (см. НАХОДКУ в отчёте QA): вторичная метка вырождается в
    // 'combat' на совпадающем тике — голодная смерть выглядит боевой в летописи.
    expect(d.payload.cause).toBe('combat');
  });
});

describe('Death: мини-интеграция полного конвейера (worldgen + весь пайплайн)', () => {
  it('заселённый мир + обречённый безоружный охотник у кабана → кто-то умирает ОБЪЯСНИМО, труп есть', () => {
    const w = createSimWorld(88 as Seed);
    worldgen(w); // 20 сталкеров + стада + WorldClock

    // Инъекция обречённого: голодный безоружный охотник СТОИТ на кабане (loc 4, game 0.8).
    const huntLoc = 4;
    const boar = placeAnimal(w, BOAR, huntLoc);
    const hunter = placeHunter(w, huntLoc, boar);
    HP.hp[hunter] = 1; // подранок: любой удар кабана летален
    NEED.hunger[hunter] = HUNGER_CRITICAL - 10; // голоден → HUNT в argmax; порог не задет
    // Безоружен (только лут) → сам кабана не убьёт, но охоту начнёт.
    w.resources.set<readonly InventoryEntry[]>('inventory', hunter, [{ item: 'bandage', qty: 1 }]);
    w.resources.set<NameRecord>('name', hunter, { first: 'Гриша', last: 'Невезучий', nickname: 'Компас' });

    const pipeline = fullPipeline();
    pipeline.run(w, 4);

    // Кто-то умер — и это НАШ обречённый охотник (эмерджентно, через весь конвейер).
    const died = diedEvents(w, hunter);
    expect(died).toHaveLength(1);
    const d = died[0] as Extract<SimEvent, { type: 'entity/died' }>;

    // Труп ФИЗИЧЕСКИ существует и несёт лут (закон №3).
    expect(existsEntity(w.ecs, hunter)).toBe(true);
    expect(hasComponent(w.ecs, Corpse, hunter)).toBe(true);
    expect(hasComponent(w.ecs, Alive, hunter)).toBe(false);
    expect(w.resources.get<readonly InventoryEntry[]>('inventory', hunter)).toEqual([
      { item: 'bandage', qty: 1 },
    ]);

    // Смерть ОБЪЯСНИМА: причинная цепочка causedBy разрешается до КОРНЯ (null),
    // без разрывов и циклов (закон №6). Каждое звено найдено в логе.
    const byId = new Map(w.bus.log.map((e) => [e.id, e] as const));
    let cursor: number | null = d.causedBy;
    const seen = new Set<number>();
    let root: SimEvent | null = null;
    while (cursor !== null) {
      expect(seen.has(cursor)).toBe(false); // нет циклов
      seen.add(cursor);
      const ev = byId.get(cursor as never);
      expect(ev).toBeDefined(); // звено существует в летописи
      root = ev as SimEvent;
      cursor = (ev as SimEvent).causedBy;
    }
    expect(root).not.toBeNull(); // цепочка непуста
    expect(root!.causedBy).toBeNull(); // и упирается в корень
    expect(d.payload.cause).toBe('combat'); // погиб в бою с кабаном
  });
});
