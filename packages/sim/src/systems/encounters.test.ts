/**
 * @module @zona/sim/systems/encounters.test
 *
 * Гейт системы Encounters (задача 1.10b, B.1). Покрывает:
 *  - ОХОТА: стоящий человек с Task=HUNT + co-located олень → бой; олень убит
 *    (hp<=0), охотник уцелел; события encounter/started+resolved;
 *  - ЗАКОН №3 ПАТРОНЫ: патроны ФИЗИЧЕСКИ списаны из инвентаря на сумму ammoSpent;
 *  - ЗАКОН №3 МЯСО: победитель получил ровно meatYield мяса из ТУШИ; БЕЗ убийства
 *    (кабан убил охотника) — мяса нет; ничего из воздуха;
 *  - РИСК: кабан убивает раненого охотника (человек в casualties, lethalCause);
 *  - ПРИЧИННОСТЬ: started.causedBy = spottedEvent (contacts) → task/selected → null;
 *    resolved.causedBy = started; убитый несёт Health.lethalCause = id resolved;
 *  - RESUME P0: непрерывный прогон ≡ split save/load (хэш снапшота идентичен);
 *  - НЕТ ДУБЛЯ: убитый олень (hp<=0, ещё не снят Death) не переигрывается на след. тик.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, LocationId, Seed, SimEvent } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent } from '../core/ecs';
import {
  Position,
  Task,
  Skills,
  Health,
  Animal,
  Alive,
  Human,
  TaskKind,
} from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { getSpecies } from '../data/index';
import { HEALTH_MAX } from '../balance/needs';
import { Encounters } from './encounters';
import { worldgen } from '../worldgen';
import { Perception } from './perception';
import { TaskSelection } from './task-selection';
import { Movement } from './movement';
import { TaskEffects } from './task-effects';
import { queryEntities } from '../core/ecs';

const DEER = 0;
const BOAR = 1;
const LOC = 3 as LocationId; // произвольная валидная локация

// ── Типизированные SoA-колонки для установки/чтения в тестах ──────────────────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const TSK = Task as unknown as {
  kind: Uint8Array;
  targetLoc: Uint32Array;
  targetEid: Uint32Array;
  startedTick: Uint32Array;
  causeEvent: Uint32Array;
};
const SKILL = Skills as unknown as { shooting: Float32Array; survival: Float32Array; stealth: Float32Array };
const HP = Health as unknown as { hp: Float32Array; lethalCause: Uint32Array };
const ANIM = Animal as unknown as { species: Uint8Array; herd: Uint32Array };

interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
}

/** Стартовый инвентарь охотника: ПМ + патроны + немного еды (форма как worldgen). */
function hunterInventory(ammo: number): InventoryEntry[] {
  // Сорт. по item (worldgen-инвариант): ammo_9mm < canned < pm.
  return [
    { item: 'ammo_9mm', qty: ammo },
    { item: 'canned', qty: 1 },
    { item: 'pm', qty: 1 },
  ];
}

/** Селит стоящего человека-охотника с Task=HUNT на `targetEid`, оружием и навыком. */
function placeHunter(
  world: SimWorld,
  loc: number,
  targetEid: EntityId,
  opts: { shooting?: number; hp?: number; ammo?: number; causeEvent?: number } = {},
): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // стоит (D-019)
  addComponent(world.ecs, Skills, eid);
  SKILL.shooting[eid] = opts.shooting ?? 0.6;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = opts.hp ?? HEALTH_MAX;
  addComponent(world.ecs, Task, eid);
  TSK.kind[eid] = TaskKind.HUNT;
  TSK.targetLoc[eid] = loc;
  TSK.targetEid[eid] = targetEid;
  TSK.causeEvent[eid] = opts.causeEvent ?? 0;
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, hunterInventory(opts.ammo ?? 16));
  return eid;
}

/** Селит стоящее живое животное (Animal/Position/Health/Alive). */
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

/** Мясо в инвентаре сущности (0, если нет). */
function meatQty(world: SimWorld, eid: EntityId): number {
  const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
  return inv.find((e) => e.item === 'meat')?.qty ?? 0;
}

/** Патроны 9mm в инвентаре сущности. */
function ammoQty(world: SimWorld, eid: EntityId): number {
  const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
  return inv.find((e) => e.item === 'ammo_9mm')?.qty ?? 0;
}

/** Прогоняет Encounters `ticks` тиков на своём планировщике. */
function runEncounters(world: SimWorld, ticks: number): void {
  const s = createScheduler();
  s.register(Encounters);
  s.run(world, ticks);
}

describe('Encounters: охота человек vs олень', () => {
  it('олень убит, охотник уцелел, патроны списаны, мясо добавлено (закон №3)', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    const hunter = placeHunter(world, LOC, deer, { ammo: 16 });

    runEncounters(world, 1);

    // Олень убит (hp<=0), но НЕ снят (Death 1.11): всё ещё существует.
    expect(HP.hp[deer]).toBeLessThanOrEqual(0);
    // Охотник уцелел.
    expect(HP.hp[hunter]).toBeGreaterThan(0);

    // Патроны ФИЗИЧЕСКИ ушли (закон №3): осталось строго меньше 16.
    const ammoLeft = ammoQty(world, hunter);
    expect(ammoLeft).toBeLessThan(16);
    expect(ammoLeft).toBeGreaterThanOrEqual(16 - 6); // не больше MAX_ROUNDS выстрелов

    // Мясо добавлено победителю ровно meatYield оленя (источник — туша).
    expect(meatQty(world, hunter)).toBe(getSpecies(DEER).meatYield);
  });

  it('события: encounter/started (sides,loc) → encounter/resolved (started как причина)', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    const hunter = placeHunter(world, LOC, deer);

    runEncounters(world, 1);

    const log = world.bus.log;
    const started = log.find((e) => e.type === 'encounter/started') as
      | Extract<SimEvent, { type: 'encounter/started' }>
      | undefined;
    const resolved = log.find((e) => e.type === 'encounter/resolved') as
      | Extract<SimEvent, { type: 'encounter/resolved' }>
      | undefined;
    expect(started).toBeDefined();
    expect(resolved).toBeDefined();
    expect(started!.payload.loc).toBe(LOC);
    expect(started!.payload.sides[0]).toContain(hunter);
    expect(started!.payload.sides[1]).toContain(deer);
    // resolved.causedBy = id started.
    expect(resolved!.causedBy).toBe(started!.id);
    // Победа side0, олень в casualties, ammoSpent>0.
    expect(resolved!.payload.winnerSide).toBe(0);
    expect(resolved!.payload.casualties).toContain(deer);
    expect(resolved!.payload.ammoSpent.reduce((s, [, q]) => s + q, 0)).toBeGreaterThan(0);
  });

  it('убитый олень несёт Health.lethalCause = id encounter/resolved (для Death 1.11)', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    placeHunter(world, LOC, deer);

    runEncounters(world, 1);

    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved')!;
    expect(HP.hp[deer]).toBeLessThanOrEqual(0);
    expect(HP.lethalCause[deer]).toBe(resolved.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ЛЕДЖЕР МАССЫ (задача 2.0, D-045): item/consumed(ammo) + item/harvested(meat)
// ═══════════════════════════════════════════════════════════════════════════
describe('Encounters: леджер массы (item/consumed ammo + item/harvested meat)', () => {
  it('расход патронов публикует item/consumed(combat), причина = encounter/resolved', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    const hunter = placeHunter(world, LOC, deer, { ammo: 16 });

    runEncounters(world, 1);

    const log = world.bus.log;
    const resolved = log.find((e) => e.type === 'encounter/resolved')!;
    const consumed = log.filter(
      (e) => e.type === 'item/consumed',
    ) as Extract<SimEvent, { type: 'item/consumed' }>[];
    // Патроны реально потрачены ⇒ ровно одно item/consumed по ammo_9mm стрелка.
    expect(consumed.length).toBe(1);
    const ev = consumed[0]!;
    expect(ev.payload.who).toBe(hunter);
    expect(ev.payload.item).toBe('ammo_9mm');
    expect(ev.payload.reason).toBe('combat');
    expect(ev.payload.qty).toBeGreaterThan(0);
    expect(ev.causedBy).toBe(resolved.id);
    // ЗАМКНУТОСТЬ: qty леджера == реальному расходу (16 − остаток).
    expect(ev.payload.qty).toBe(16 - ammoQty(world, hunter));
    // …и совпадает с ammoSpent в resolved (один источник истины).
    const spentTotal = (
      resolved as Extract<SimEvent, { type: 'encounter/resolved' }>
    ).payload.ammoSpent.reduce((s, [, q]) => s + q, 0);
    expect(ev.payload.qty).toBe(spentTotal);
  });

  it('добыча мяса публикует item/harvested(carcass), причина = encounter/resolved', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    const hunter = placeHunter(world, LOC, deer, { ammo: 16 });

    runEncounters(world, 1);

    const log = world.bus.log;
    const resolved = log.find((e) => e.type === 'encounter/resolved')!;
    const harvested = log.filter(
      (e) => e.type === 'item/harvested',
    ) as Extract<SimEvent, { type: 'item/harvested' }>[];
    expect(harvested.length).toBe(1);
    const ev = harvested[0]!;
    expect(ev.payload.who).toBe(hunter);
    expect(ev.payload.item).toBe('meat');
    expect(ev.payload.source).toBe('carcass');
    // qty леджера == реально добавленному мясу == meatYield вида.
    expect(ev.payload.qty).toBe(getSpecies(DEER).meatYield);
    expect(ev.payload.qty).toBe(meatQty(world, hunter));
    expect(ev.causedBy).toBe(resolved.id);
  });

  it('охотник ПРОИГРАЛ (кабан) → мяса нет ⇒ НЕТ item/harvested (масса не растёт)', () => {
    // Кабан (BOAR) опасен; слабый безоружный охотник гибнет — победы стороны0 нет.
    const world = createSimWorld(42 as Seed);
    const boar = placeAnimal(world, BOAR, LOC);
    const hunter = placeHunter(world, LOC, boar, { shooting: 0.05, hp: 5, ammo: 0 });

    runEncounters(world, 1);

    const harvested = world.bus.log.filter((e) => e.type === 'item/harvested');
    expect(harvested.length).toBe(0);
    expect(meatQty(world, hunter)).toBe(0);
  });

  it('патроны потрачены, но зверь НЕ убит → item/consumed(ammo) ЕСТЬ, item/harvested НЕТ', () => {
    // Раненый охотник со стволом и патронами стреляет по кабану, гибнет, кабан жив.
    // Расход патронов реален (леджер consumed), но мяса нет (harvested отсутствует —
    // масса создаётся ТОЛЬКО добычей туши, не самим фактом боя, закон №3).
    const world = createSimWorld(42 as Seed);
    const boar = placeAnimal(world, BOAR, LOC);
    const hunter = placeHunter(world, LOC, boar, { hp: 20, ammo: 16 });

    runEncounters(world, 1);

    expect(HP.hp[hunter]).toBeLessThanOrEqual(0); // охотник погиб
    expect(HP.hp[boar]).toBeGreaterThan(0); // кабан выжил (не добыт)

    const consumed = world.bus.log.filter(
      (e) => e.type === 'item/consumed',
    ) as Extract<SimEvent, { type: 'item/consumed' }>[];
    const harvested = world.bus.log.filter((e) => e.type === 'item/harvested');
    // Патроны реально израсходованы ⇒ есть consumed(combat); замкнутость по инвентарю.
    expect(consumed.length).toBe(1);
    expect(consumed[0]!.payload.item).toBe('ammo_9mm');
    expect(consumed[0]!.payload.reason).toBe('combat');
    expect(consumed[0]!.payload.qty).toBe(16 - ammoQty(world, hunter));
    // Мяса нет: без убийства туши не появляется (harvested отсутствует).
    expect(harvested.length).toBe(0);
    expect(meatQty(world, hunter)).toBe(0);
  });
});

describe('Encounters: причинность started.causedBy', () => {
  it('spottedEvent из contacts → started.causedBy = spottedEvent', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    const hunter = placeHunter(world, LOC, deer, { causeEvent: 999 });
    // contacts охотника: видит оленя, spottedEvent = 77.
    world.resources.set('contacts', hunter, [{ target: deer, spottedEvent: 77 }]);

    runEncounters(world, 1);

    const started = world.bus.log.find((e) => e.type === 'encounter/started')!;
    expect(started.causedBy).toBe(77);
  });

  it('нет spottedEvent → started.causedBy = Task.causeEvent (task/selected)', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    placeHunter(world, LOC, deer, { causeEvent: 555 });

    runEncounters(world, 1);

    const started = world.bus.log.find((e) => e.type === 'encounter/started')!;
    expect(started.causedBy).toBe(555);
  });

  it('нет ни того, ни другого → started.causedBy = null', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    placeHunter(world, LOC, deer, { causeEvent: 0 });

    runEncounters(world, 1);

    const started = world.bus.log.find((e) => e.type === 'encounter/started')!;
    expect(started.causedBy).toBeNull();
  });
});

describe('Encounters: охота на кабана РИСКОВАННА', () => {
  it('кабан убивает раненого охотника (человек в casualties, lethalCause, мяса НЕТ)', () => {
    const world = createSimWorld(42 as Seed);
    const boar = placeAnimal(world, BOAR, LOC);
    // Раненый охотник (hp 20): состояние мира ведёт к его гибели (не «X% смерти»).
    const hunter = placeHunter(world, LOC, boar, { hp: 20, ammo: 16 });

    runEncounters(world, 1);

    expect(HP.hp[hunter]).toBeLessThanOrEqual(0); // охотник погиб
    expect(HP.hp[boar]).toBeGreaterThan(0); // кабан выжил

    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved') as
      | Extract<SimEvent, { type: 'encounter/resolved' }>
      | undefined;
    expect(resolved!.payload.winnerSide).toBe(1); // победила сторона зверя
    expect(resolved!.payload.casualties).toContain(hunter);
    // lethalCause проштампован убитому человеку (Death 1.11 прочитает).
    expect(HP.lethalCause[hunter]).toBe(resolved!.id);
    // Проигравшая сторона людей мяса не получает; кабан жив — мяса нет (закон №3).
    expect(meatQty(world, hunter)).toBe(0);
  });
});

describe('Encounters: закон №3 — ничего из воздуха', () => {
  it('без убийства животного мясо НЕ появляется', () => {
    const world = createSimWorld(42 as Seed);
    const boar = placeAnimal(world, BOAR, LOC);
    const hunter = placeHunter(world, LOC, boar, { hp: 20 });

    runEncounters(world, 1);

    // Кабан жив → у охотника (даже если бы уцелел) мяса быть не может.
    expect(meatQty(world, hunter)).toBe(0);
  });

  it('убитый олень не переигрывается на следующий тик (нет дубля до Death 1.11)', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    const hunter = placeHunter(world, LOC, deer);

    runEncounters(world, 1);
    const meatAfter1 = meatQty(world, hunter);
    const ammoAfter1 = ammoQty(world, hunter);
    const startedCount1 = world.bus.log.filter((e) => e.type === 'encounter/started').length;

    // Ещё один тик: олень hp<=0 (не снят Death) — НЕ должен стать целью снова.
    runEncounters(world, 1);
    expect(meatQty(world, hunter)).toBe(meatAfter1); // мясо не удвоилось
    expect(ammoQty(world, hunter)).toBe(ammoAfter1); // патроны не тратятся повторно
    expect(world.bus.log.filter((e) => e.type === 'encounter/started').length).toBe(startedCount1);
  });
});

describe('Encounters: несколько охотников на одну дичь', () => {
  it('оба охотника в side0; мясо — победителю с МИН eid; двойного мяса нет', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    const h1 = placeHunter(world, LOC, deer, { ammo: 16 }); // мин eid
    const h2 = placeHunter(world, LOC, deer, { ammo: 16 });

    runEncounters(world, 1);

    // ОДИН бой на (loc, цель): оба охотника — одна сторона.
    const started = world.bus.log.filter((e) => e.type === 'encounter/started');
    expect(started.length).toBe(1);
    expect((started[0] as Extract<SimEvent, { type: 'encounter/started' }>).payload.sides[0]).toEqual([
      h1,
      h2,
    ]);

    // Олень убит, оба охотника уцелели (олень слаб).
    expect(HP.hp[deer]).toBeLessThanOrEqual(0);
    expect(HP.hp[h1]).toBeGreaterThan(0);
    expect(HP.hp[h2]).toBeGreaterThan(0);

    // Мясо — ТОЛЬКО победителю с мин eid (h1). У h2 мяса нет (двойного нет, закон №3).
    expect(meatQty(world, h1)).toBe(getSpecies(DEER).meatYield);
    expect(meatQty(world, h2)).toBe(0);
  });
});

describe('Encounters: охотник без патронов дерётся melee (закон №3)', () => {
  it('нет патронов → бой в упор, ammoSpent=0, мяса нет (олень уцелел)', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    // Оружие есть, но патронов 0 → power от навыка, но стреляет melee.
    const hunter = placeHunter(world, LOC, deer, { ammo: 0, hp: 30 });

    runEncounters(world, 1);

    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved') as
      | Extract<SimEvent, { type: 'encounter/resolved' }>
      | undefined;
    // ЗАКОН №3: melee-стычка не тратит патроны — ammoSpent пуст.
    expect(resolved!.payload.ammoSpent).toEqual([]);
    expect(ammoQty(world, hunter)).toBe(0); // патронов как не было, так и нет
    // За 6 раундов melee (5 урона/раунд) олень (hp 100) не добит → мяса нет.
    expect(HP.hp[deer]).toBeGreaterThan(0);
    expect(meatQty(world, hunter)).toBe(0);
  });
});

describe('Encounters: устаревшая (stale) цель', () => {
  it('цель мертва, но в локации есть другая живая дичь → бой с НЕЙ (мин eid), труп не добивается', () => {
    const world = createSimWorld(42 as Seed);
    const deer1 = placeAnimal(world, DEER, LOC); // будет убит на тике 1
    const deer2 = placeAnimal(world, DEER, LOC); // резерв
    const hunter = placeHunter(world, LOC, deer1, { ammo: 16 });

    // Тик 1: убит deer1, мясо = 1×yield.
    runEncounters(world, 1);
    expect(HP.hp[deer1]).toBeLessThanOrEqual(0);
    expect(HP.hp[deer2]).toBeGreaterThan(0);
    const yield1 = getSpecies(DEER).meatYield;
    expect(meatQty(world, hunter)).toBe(yield1);
    // Task.targetEid всё ещё указывает на мёртвого deer1 (Encounters Task не правит).
    expect(TSK.targetEid[hunter]).toBe(deer1);

    // Тик 2: targetEid устарел (deer1 мёртв) → Encounters берёт живую дичь (deer2),
    // а МЁРТВОГО deer1 НЕ добивает повторно (нет дубля мяса от одной туши).
    runEncounters(world, 1);
    expect(HP.hp[deer2]).toBeLessThanOrEqual(0);
    expect(meatQty(world, hunter)).toBe(2 * yield1); // ровно два разных зверя
    // Ровно два боя (по одному на живую цель за тик), не больше.
    expect(world.bus.log.filter((e) => e.type === 'encounter/started').length).toBe(2);
  });

  it('цель мертва и другой дичи в локации нет → бой НЕ завязывается', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    const hunter = placeHunter(world, LOC, deer, { ammo: 16 });

    runEncounters(world, 1);
    const started1 = world.bus.log.filter((e) => e.type === 'encounter/started').length;

    // Тик 2: единственная дичь — труп deer (hp<=0). Нового боя нет, ошибок нет.
    expect(() => runEncounters(world, 1)).not.toThrow();
    expect(world.bus.log.filter((e) => e.type === 'encounter/started').length).toBe(started1);
    expect(TSK.targetEid[hunter]).toBe(deer); // стейл остался; TaskSelection (1.8) сменит
  });
});

describe('Encounters: изоляция инвентарей (новый массив, не in-place)', () => {
  it('списание патронов/добавление мяса не мутирует исходный массив; чужой инвентарь цел', () => {
    const world = createSimWorld(42 as Seed);
    const deer = placeAnimal(world, DEER, LOC);
    // Два независимых боя в РАЗНЫХ локациях, чтобы у каждого свой инвентарь.
    const otherLoc = (LOC + 1) as LocationId;
    const deer2 = placeAnimal(world, DEER, otherLoc);
    const shooter = placeHunter(world, LOC, deer, { ammo: 16 });
    const bystander = placeHunter(world, otherLoc, deer2, { ammo: 16 });

    // Держим ССЫЛКИ на исходные массивы инвентарей.
    const shooterInvBefore = world.resources.get<readonly InventoryEntry[]>('inventory', shooter)!;
    const bystanderInvBefore = world.resources.get<readonly InventoryEntry[]>('inventory', bystander)!;

    runEncounters(world, 1);

    // Исходный массив стрелка НЕ тронут in-place (закон №3: списание = новый массив).
    expect(shooterInvBefore.find((e) => e.item === 'ammo_9mm')!.qty).toBe(16);
    expect(shooterInvBefore.find((e) => e.item === 'meat')).toBeUndefined();
    // В хранилище лежит ДРУГОЙ (новый) массив с уже списанными патронами и мясом.
    const shooterInvAfter = world.resources.get<readonly InventoryEntry[]>('inventory', shooter)!;
    expect(shooterInvAfter).not.toBe(shooterInvBefore);
    expect(ammoQty(world, shooter)).toBeLessThan(16);
    expect(meatQty(world, shooter)).toBe(getSpecies(DEER).meatYield);

    // Чужой инвентарь второго стрелка своим боем не испорчен (его массив — свой).
    expect(bystanderInvBefore.find((e) => e.item === 'ammo_9mm')!.qty).toBe(16);
    expect(shooterInvAfter).not.toBe(bystanderInvBefore);
  });
});

describe('Encounters: несколько независимых боёв за тик (детерминизм по loc)', () => {
  it('бои в разных локациях независимы и детерминированы (2 прогона идентичны)', () => {
    function build(): SimWorld {
      const w = createSimWorld(2027 as Seed);
      // Локация A: олень + охотник; локация B: олень + охотник.
      const dA = placeAnimal(w, DEER, LOC);
      placeHunter(w, LOC, dA, { ammo: 16 });
      const dB = placeAnimal(w, DEER, (LOC + 1) as LocationId);
      placeHunter(w, (LOC + 1) as LocationId, dB, { ammo: 16 });
      return w;
    }
    // Прогоняем ПОСЛЕДОВАТЕЛЬНО: SoA-колонки bitecs — глобальные синглтоны, общие
    // для миров с одинаковыми eid, поэтому строим+гоняем один мир до конца перед
    // построением следующего (иначе второй мир затрётся первым прогоном).
    const a = build();
    runEncounters(a, 1);
    const startedA = a.bus.log.filter((e) => e.type === 'encounter/started').length;
    const hashA = hashSnapshot(serialize(a));

    const b = build();
    runEncounters(b, 1);
    const hashB = hashSnapshot(serialize(b));

    // Два боя за тик, порядок сорт. по loc — оба прогона побитово совпадают.
    expect(startedA).toBe(2);
    expect(hashA).toBe(hashB);
  });
});

describe('Encounters: независимость одновременных боёв в ОДНОЙ локации', () => {
  it('два боя в одной loc с РАЗНОЙ дичью → независимые потоки разброса', () => {
    // Метка rng включает target (encounter@tick#loc#target): при общем label оба
    // боя делили бы ОДИН stateless-поток разброса → идентичные исходы при равных
    // статах. С target потоки независимы, поэтому исходы расходятся (seed 42).
    const world = createSimWorld(42 as Seed);
    const deerA = placeAnimal(world, DEER, LOC); // мин eid
    const deerB = placeAnimal(world, DEER, LOC);
    const hunterA = placeHunter(world, LOC, deerA, { ammo: 16 });
    const hunterB = placeHunter(world, LOC, deerB, { ammo: 16 });

    runEncounters(world, 1);

    // Оба боя завязались (две пары started/resolved).
    expect(world.bus.log.filter((e) => e.type === 'encounter/started').length).toBe(2);
    // Обе дичи убиты, оба охотника уцелели.
    expect(HP.hp[deerA]).toBeLessThanOrEqual(0);
    expect(HP.hp[deerB]).toBeLessThanOrEqual(0);
    expect(HP.hp[hunterA]).toBeGreaterThan(0);
    expect(HP.hp[hunterB]).toBeGreaterThan(0);
    // Потоки разброса РАЗНЫЕ ⇒ расход патронов/итоговое hp расходятся (при равных
    // статах общий label дал бы идентичные значения — тест поймал бы регрессию).
    const diverged = ammoQty(world, hunterA) !== ammoQty(world, hunterB) || HP.hp[hunterA] !== HP.hp[hunterB];
    expect(diverged).toBe(true);
  });
});

describe('Encounters: RESUME P0 (бой в одном тике, без межтикового состояния)', () => {
  it('непрерывный прогон ≡ split save/load по хэшу снапшота', () => {
    /** Строит идентичный стартовый мир (одинаковые eid — миры создаются подряд). */
    function build(): SimWorld {
      const w = createSimWorld(2026 as Seed);
      const deer = placeAnimal(w, DEER, LOC);
      placeHunter(w, LOC, deer, { ammo: 16 });
      return w;
    }

    // Непрерывно: 3 тика подряд.
    const cont = build();
    runEncounters(cont, 3);
    const contHash = hashSnapshot(serialize(cont));

    // Split: 1 тик → save → load → ещё 2 тика.
    const a = build();
    runEncounters(a, 1);
    const mid = serialize(a);
    const b = deserialize(mid);
    runEncounters(b, 2);
    const splitHash = hashSnapshot(serialize(b));

    expect(splitHash).toBe(contHash);
  });

  it('split РОВНО на тике боя (save до тика → load → тик) ≡ непрерывному', () => {
    function build(): SimWorld {
      const w = createSimWorld(2026 as Seed);
      const deer = placeAnimal(w, DEER, LOC);
      placeHunter(w, LOC, deer, { ammo: 16 });
      return w;
    }
    // Непрерывно: один тик, в котором и происходит бой.
    const cont = build();
    runEncounters(cont, 1);
    const contHash = hashSnapshot(serialize(cont));

    // Split: сохраняем СВЕЖИЙ мир (tick 0, до боя) → грузим → прогоняем тик боя.
    // rng форка stateless (метка tick+loc), боевого состояния между тиками нет ⇒
    // резолв на восстановленном мире побитово совпадает (P0). Сверяем и лог
    // encounter/* (eventLog входит в снапшот, поэтому его равенство — часть хэша).
    const b = deserialize(serialize(build()));
    runEncounters(b, 1);
    expect(hashSnapshot(serialize(b))).toBe(contHash);
  });
});

describe('Encounters: полный мини-сценарий через планировщик (детерминизм 2 прогонов)', () => {
  it('worldgen + Perception+TaskSelection+Movement+TaskEffects+Encounters: охотник добывает дичь, 2 прогона идентичны', () => {
    // Полный конвейер систем над сгенерированным миром (реальный граф локаций),
    // в который посажены стоящий охотник и co-located олень. Два ИДЕНТИЧНЫХ
    // прогона обязаны дать один и тот же снапшот (закон №8) — и олень должен быть
    // добыт (закон №1: без игрока сталкер сам стреляет по дичи).
    function build(): { world: SimWorld; deer: EntityId } {
      const world = createSimWorld(2026 as Seed);
      worldgen(world);
      // Берём валидную локацию из уже существующей сущности с Position.
      const loc = POS.loc[queryEntities(world.ecs, [Position])[0]!] as number;
      const deer = placeAnimal(world, DEER, loc);
      placeHunter(world, loc, deer, { ammo: 16 });
      return { world, deer };
    }
    function pipeline(): ReturnType<typeof createScheduler> {
      const s = createScheduler();
      s.register(Perception);
      s.register(TaskSelection);
      s.register(Movement);
      s.register(TaskEffects);
      s.register(Encounters);
      return s;
    }

    const a = build();
    pipeline().run(a.world, 2);
    const b = build();
    pipeline().run(b.world, 2);

    // Детерминизм всего конвейера: снапшоты (с eventLog) совпадают.
    expect(hashSnapshot(serialize(a.world))).toBe(hashSnapshot(serialize(b.world)));
    // Охотник действительно добыл дичь через связку восприятие→задача→бой.
    expect(HP.hp[a.deer]).toBeLessThanOrEqual(0);
    expect(a.world.bus.log.some((e) => e.type === 'encounter/resolved')).toBe(true);
  });
});
