/**
 * @module @zona/sim/systems/encounters-rob.test
 *
 * Гейт человек-vs-человек грабежа в системе Encounters (задача 2.11, D-060/D-049).
 * Детекция ДРЕМЛЕТ в живом мире (никто не выбирает ROB до 2.12) — здесь синтетические
 * ROB-сетапы. Покрывает:
 *  - ГРАБЁЖ: грабитель (Task=ROB) бьёт слабую цель, побеждает, лут (деньги+инвентарь)
 *    ПЕРЕХОДИТ победителю; масса мира (Σ money + Σ каждого предмета) ДО==ПОСЛЕ (перевод,
 *    дельта 0 — закон №3, НЕ faucet);
 *  - ЗАЩИТА: цель отстреливается и может ПОБЕДИТЬ (грабит уже напавшего);
 *  - БЕЗОРУЖНЫЙ атакующий: power=0, дерётся melee, ammoSpent пуст;
 *  - ПАТРОНЫ: расход физический (item/consumed combat);
 *  - СМЕРТЬ ЦЕЛИ: lethalCause = id resolved; после Death труп несёт ПУСТОЙ инвентарь
 *    (лут не задвоился — он у победителя), масса сохранена;
 *  - ПРИЧИННОСТЬ: started.causedBy (spotted→task→null), resolved.causedBy=started,
 *    loot/transferred.causedBy=resolved;
 *  - ДЕТЕРМИНИЗМ: 2 прогона идентичны; RESUME: split≡continuous.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, LocationId, Seed, SimEvent } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, queryEntities, hasComponent } from '../core/ecs';
import { Position, Task, Skills, Health, Alive, Human, Corpse, TaskKind } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { HEALTH_MAX } from '../balance/needs';
import { Encounters } from './encounters';
import { Death } from './death';

const LOC = 3 as LocationId;

// ── Типизированные SoA-колонки для установки/чтения в тестах ──────────────────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const TSK = Task as unknown as {
  kind: Uint8Array;
  targetLoc: Uint32Array;
  targetEid: Uint32Array;
  causeEvent: Uint32Array;
};
const SKILL = Skills as unknown as { shooting: Float32Array };
const HP = Health as unknown as { hp: Float32Array; lethalCause: Uint32Array };

interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
}

/** Инвентарь вооружённого человека (ПМ + патроны + опц. добро), сорт. по item. */
function armedInventory(ammo: number, extra: readonly InventoryEntry[] = []): InventoryEntry[] {
  const inv = [
    { item: 'ammo_9mm', qty: ammo },
    { item: 'pm', qty: 1 },
    ...extra,
  ];
  inv.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  return inv;
}

interface HumanOpts {
  readonly shooting?: number;
  readonly hp?: number;
  readonly inventory?: readonly InventoryEntry[];
  readonly money?: number;
}

/** Селит стоящего живого человека (без задачи). Возвращает eid. */
function placeHuman(world: SimWorld, loc: number, opts: HumanOpts = {}): EntityId {
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
  if (opts.inventory !== undefined) {
    world.resources.set<readonly InventoryEntry[]>('inventory', eid, opts.inventory);
  }
  if (opts.money !== undefined) {
    world.resources.set<number>('money', eid, opts.money);
  }
  return eid;
}

/** Навешивает на человека задачу ROB на цель `target`. */
function makeRobber(world: SimWorld, eid: EntityId, target: EntityId, causeEvent = 0): void {
  addComponent(world.ecs, Task, eid);
  TSK.kind[eid] = TaskKind.ROB;
  TSK.targetLoc[eid] = POS.loc[eid] as number;
  TSK.targetEid[eid] = target;
  TSK.causeEvent[eid] = causeEvent;
}

/** Кол-во конкретного предмета в инвентаре сущности. */
function qtyOf(world: SimWorld, eid: EntityId, item: string): number {
  const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
  return inv.find((e) => e.item === item)?.qty ?? 0;
}

/** Деньги сущности (0, если нет ключа). */
function moneyOf(world: SimWorld, eid: EntityId): number {
  return world.resources.get<number>('money', eid) ?? 0;
}

/** Σ массы мира: Σ money + Σ каждого item по ВСЕМ eid (как EconomyInvariant). */
function worldMass(world: SimWorld): { money: number; items: Map<string, number> } {
  let money = 0;
  for (const [, m] of world.resources.entries<number>('money')) money += m;
  const items = new Map<string, number>();
  for (const [, inv] of world.resources.entries<readonly InventoryEntry[]>('inventory')) {
    for (const e of inv) items.set(e.item, (items.get(e.item) ?? 0) + e.qty);
  }
  return { money, items };
}

/** Утверждает бит-в-бит равенство двух снимков массы (деньги + каждый предмет). */
function expectMassEqual(
  before: { money: number; items: Map<string, number> },
  after: { money: number; items: Map<string, number> },
): void {
  expect(after.money).toBe(before.money);
  const keys = new Set<string>([...before.items.keys(), ...after.items.keys()]);
  for (const k of keys) {
    expect(after.items.get(k) ?? 0).toBe(before.items.get(k) ?? 0);
  }
}

/** Прогоняет только Encounters `ticks` тиков. */
function runEncounters(world: SimWorld, ticks: number): void {
  const s = createScheduler();
  s.register(Encounters);
  s.run(world, ticks);
}

/** Прогоняет Encounters→Death (порядок B.1) `ticks` тиков. */
function runEncountersDeath(world: SimWorld, ticks: number): void {
  const s = createScheduler();
  s.register(Encounters);
  s.register(Death);
  s.run(world, ticks);
}

describe('Encounters ROB: грабитель обчищает слабую цель (перевод лута, закон №3)', () => {
  it('лут проигравшего → победителю; масса мира ДО==ПОСЛЕ (дельта 0)', () => {
    const world = createSimWorld(42 as Seed);
    // Сильный вооружённый грабитель.
    const robber = placeHuman(world, LOC, {
      shooting: 0.9,
      hp: HEALTH_MAX,
      inventory: armedInventory(16),
      money: 100,
    });
    // Слабая безоружная жертва с добром и деньгами.
    const victim = placeHuman(world, LOC, {
      shooting: 0.1,
      hp: 15,
      inventory: [
        { item: 'bandage', qty: 2 },
        { item: 'canned', qty: 3 },
      ],
      money: 250,
    });
    makeRobber(world, robber, victim);

    const massBefore = worldMass(world);
    runEncounters(world, 1);
    const massAfter = worldMass(world);

    // Жертва повержена.
    expect(HP.hp[victim]).toBeLessThanOrEqual(0);
    expect(HP.hp[robber]).toBeGreaterThan(0);

    // Лут перешёл: у грабителя теперь добро жертвы, у жертвы — пусто.
    expect(qtyOf(world, robber, 'bandage')).toBe(2);
    expect(qtyOf(world, robber, 'canned')).toBe(3);
    expect(moneyOf(world, robber)).toBe(100 + 250);
    expect(qtyOf(world, victim, 'bandage')).toBe(0);
    expect(qtyOf(world, victim, 'canned')).toBe(0);
    expect(moneyOf(world, victim)).toBe(0);

    // ЗАКОН №3: масса мира сохранена бит-в-бит (перевод, не создание/уничтожение).
    // Замечание: патроны боя уменьшают ammo_9mm — это ЛЕДЖЕРится (item/consumed),
    // поэтому Σ ammo может упасть. Сверяем массу БЕЗ ammo (перевод лута не трогает
    // патроны как faucet), а расход патронов проверяем отдельным тестом.
    massBefore.items.delete('ammo_9mm');
    massAfter.items.delete('ammo_9mm');
    expectMassEqual(massBefore, massAfter);
  });

  it('loot/transferred: from=жертва, to=грабитель, items+money, causedBy=resolved', () => {
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16), money: 0 });
    const victim = placeHuman(world, LOC, {
      shooting: 0.1,
      hp: 15,
      inventory: [{ item: 'canned', qty: 4 }],
      money: 300,
    });
    makeRobber(world, robber, victim);

    runEncounters(world, 1);

    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved')!;
    const loot = world.bus.log.find((e) => e.type === 'loot/transferred') as
      | Extract<SimEvent, { type: 'loot/transferred' }>
      | undefined;
    expect(loot).toBeDefined();
    expect(loot!.payload.from).toBe(victim);
    expect(loot!.payload.to).toBe(robber);
    expect(loot!.payload.money).toBe(300);
    expect(loot!.payload.items).toEqual([['canned', 4]]);
    expect(loot!.payload.loc).toBe(LOC);
    expect(loot!.causedBy).toBe(resolved.id);
  });

  it('лут НЕ леджерится (нет item/* по добыче лута): EconomyInvariant дельта товара 0', () => {
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16), money: 0 });
    const victim = placeHuman(world, LOC, {
      shooting: 0.1,
      hp: 15,
      inventory: [{ item: 'bandage', qty: 5 }],
      money: 0,
    });
    makeRobber(world, robber, victim);

    runEncounters(world, 1);

    // По луту (bandage/деньги) НЕТ ни одного леджер-события item/* — только по патронам.
    const ledgerNonAmmo = world.bus.log.filter(
      (e) =>
        (e.type === 'item/produced' ||
          e.type === 'item/harvested' ||
          e.type === 'item/broughtIn' ||
          e.type === 'item/exported' ||
          e.type === 'item/consumed') &&
        (e as Extract<SimEvent, { type: 'item/consumed' }>).payload?.item !== 'ammo_9mm',
    );
    expect(ledgerNonAmmo.length).toBe(0);
  });
});

describe('Encounters ROB: цель ЗАЩИЩАЕТСЯ (не пассивная жертва)', () => {
  it('сильная цель отстреливает слабого грабителя и ПОБЕЖДАЕТ → грабит его в ответ', () => {
    const world = createSimWorld(42 as Seed);
    // Слабый безоружный грабитель.
    const robber = placeHuman(world, LOC, {
      shooting: 0.1,
      hp: 10,
      inventory: [{ item: 'canned', qty: 1 }],
      money: 40,
    });
    // Сильная вооружённая цель.
    const victim = placeHuman(world, LOC, { shooting: 0.9, hp: HEALTH_MAX, inventory: armedInventory(16), money: 0 });
    makeRobber(world, robber, victim);

    const massBefore = worldMass(world);
    runEncounters(world, 1);

    // Победила защищающаяся цель (side1); грабитель повержен.
    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved') as
      | Extract<SimEvent, { type: 'encounter/resolved' }>
      | undefined;
    expect(resolved!.payload.winnerSide).toBe(1);
    expect(HP.hp[robber]).toBeLessThanOrEqual(0);
    expect(HP.hp[victim]).toBeGreaterThan(0);

    // Симметрия: проигравший (грабитель) обчищен, победитель (цель) забрал лут.
    expect(qtyOf(world, victim, 'canned')).toBe(1);
    expect(moneyOf(world, victim)).toBe(40);
    expect(qtyOf(world, robber, 'canned')).toBe(0);
    expect(moneyOf(world, robber)).toBe(0);

    // Масса сохранена (без ammo — расход патронов ледж.).
    const massAfter = worldMass(world);
    massBefore.items.delete('ammo_9mm');
    massAfter.items.delete('ammo_9mm');
    expectMassEqual(massBefore, massAfter);
  });
});

describe('Encounters ROB: безоружный атакующий (melee, закон №3)', () => {
  it('нет оружия → power 0, ammoSpent пуст, бой melee', () => {
    const world = createSimWorld(42 as Seed);
    // Безоружный грабитель (нет weapon/ammo) — power 0, дерётся кулаками.
    const robber = placeHuman(world, LOC, {
      shooting: 0.9,
      hp: HEALTH_MAX,
      inventory: [{ item: 'canned', qty: 1 }],
      money: 0,
    });
    // Очень слабая безоружная цель — гибнет от melee (5 урона) за раунды.
    const victim = placeHuman(world, LOC, { shooting: 0, hp: 4, inventory: [], money: 60 });
    makeRobber(world, robber, victim);

    runEncounters(world, 1);

    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved') as
      | Extract<SimEvent, { type: 'encounter/resolved' }>
      | undefined;
    // Никаких патронов не потрачено (у сторон нет ammo/оружия).
    expect(resolved!.payload.ammoSpent).toEqual([]);
    expect(world.bus.log.some((e) => e.type === 'item/consumed')).toBe(false);
    // Цель повержена melee, деньги перешли.
    expect(HP.hp[victim]).toBeLessThanOrEqual(0);
    expect(moneyOf(world, robber)).toBe(60);
  });
});

describe('Encounters ROB: патроны расходуются физически (закон №3)', () => {
  it('грабитель тратит патроны → item/consumed(combat), инвентарь уменьшается ровно на qty', () => {
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16), money: 0 });
    const victim = placeHuman(world, LOC, { shooting: 0.1, hp: 15, inventory: [], money: 0 });
    makeRobber(world, robber, victim);

    runEncounters(world, 1);

    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved') as
      | Extract<SimEvent, { type: 'encounter/resolved' }>
      | undefined;
    const spentTotal = resolved!.payload.ammoSpent.reduce((s, [, q]) => s + q, 0);
    expect(spentTotal).toBeGreaterThan(0);
    // Инвентарь уменьшился ровно на потраченное.
    expect(qtyOf(world, robber, 'ammo_9mm')).toBe(16 - spentTotal);
    // Леджер combat по ammo_9mm.
    const consumed = world.bus.log.filter(
      (e) => e.type === 'item/consumed',
    ) as Extract<SimEvent, { type: 'item/consumed' }>[];
    const robberAmmoConsumed = consumed
      .filter((e) => e.payload.who === robber && e.payload.item === 'ammo_9mm')
      .reduce((s, e) => s + e.payload.qty, 0);
    expect(robberAmmoConsumed).toBe(spentTotal);
    expect(consumed.every((e) => e.payload.reason === 'combat')).toBe(true);
  });
});

describe('Encounters ROB: смерть цели → труп без двойного учёта (D-041)', () => {
  it('после Encounters→Death труп несёт ПУСТОЙ инвентарь; масса сохранена', () => {
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16), money: 0 });
    const victim = placeHuman(world, LOC, {
      shooting: 0.1,
      hp: 15,
      inventory: [{ item: 'bandage', qty: 3 }],
      money: 500,
    });
    makeRobber(world, robber, victim);

    const massBefore = worldMass(world);
    runEncountersDeath(world, 1);
    const massAfter = worldMass(world);

    // Цель мертва → труп (Corpse, снят Alive).
    expect(hasComponent(world.ecs, Corpse, victim)).toBe(true);
    expect(hasComponent(world.ecs, Alive, victim)).toBe(false);
    // lethalCause = id resolved (Death прочитал причину).
    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved')!;
    const died = world.bus.log.find((e) => e.type === 'entity/died') as
      | Extract<SimEvent, { type: 'entity/died' }>
      | undefined;
    expect(died!.causedBy).toBe(resolved.id);
    expect(died!.payload.cause).toBe('combat');

    // ГЛАВНОЕ (нет двойного учёта): corpse/created.items ПУСТ — лут уже у грабителя.
    const corpse = world.bus.log.find((e) => e.type === 'corpse/created') as
      | Extract<SimEvent, { type: 'corpse/created' }>
      | undefined;
    expect(corpse!.payload.eid).toBe(victim);
    expect(corpse!.payload.items).toEqual([]);
    // Труп физически несёт пустой инвентарь; лут — у грабителя.
    expect(qtyOf(world, victim, 'bandage')).toBe(0);
    expect(qtyOf(world, robber, 'bandage')).toBe(3);
    expect(moneyOf(world, robber)).toBe(500);

    // Масса мира сохранена (без ammo): лут не задвоился и не исчез.
    massBefore.items.delete('ammo_9mm');
    massAfter.items.delete('ammo_9mm');
    expectMassEqual(massBefore, massAfter);
  });
});

describe('Encounters ROB: причинность started.causedBy (D-030)', () => {
  it('spottedEvent из contacts → started.causedBy = spottedEvent', () => {
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16) });
    const victim = placeHuman(world, LOC, { shooting: 0.1, hp: 15 });
    makeRobber(world, robber, victim, 999);
    world.resources.set('contacts', robber, [{ target: victim, spottedEvent: 88 }]);

    runEncounters(world, 1);
    const started = world.bus.log.find((e) => e.type === 'encounter/started')!;
    expect(started.causedBy).toBe(88);
  });

  it('нет spottedEvent → started.causedBy = Task.causeEvent', () => {
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16) });
    const victim = placeHuman(world, LOC, { shooting: 0.1, hp: 15 });
    makeRobber(world, robber, victim, 654);

    runEncounters(world, 1);
    const started = world.bus.log.find((e) => e.type === 'encounter/started')!;
    expect(started.causedBy).toBe(654);
  });

  it('ни того ни другого → started.causedBy = null; resolved.causedBy = started', () => {
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16) });
    const victim = placeHuman(world, LOC, { shooting: 0.1, hp: 15 });
    makeRobber(world, robber, victim, 0);

    runEncounters(world, 1);
    const started = world.bus.log.find((e) => e.type === 'encounter/started')!;
    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved')!;
    expect(started.causedBy).toBeNull();
    expect(resolved.causedBy).toBe(started.id);
  });
});

describe('Encounters ROB: невалидная цель ⇒ грабёж не завязывается (ветка дремлет)', () => {
  it('цель в ДРУГОЙ локации → нет боя', () => {
    const world = createSimWorld(42 as Seed);
    const victim = placeHuman(world, (LOC + 5) as LocationId, { hp: 15 });
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16) });
    makeRobber(world, robber, victim);

    runEncounters(world, 1);
    expect(world.bus.log.some((e) => e.type === 'encounter/started')).toBe(false);
  });

  it('цель — животное/несуществующий eid (не Human) → нет боя', () => {
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16) });
    makeRobber(world, robber, 9999 as EntityId); // несуществующий eid

    runEncounters(world, 1);
    expect(world.bus.log.some((e) => e.type === 'encounter/started')).toBe(false);
  });
});

describe('Encounters ROB: детерминизм и RESUME (закон №8, P0)', () => {
  function build(seed: number): { world: SimWorld; robber: EntityId; victim: EntityId } {
    const world = createSimWorld(seed as Seed);
    const robber = placeHuman(world, LOC, { shooting: 0.7, inventory: armedInventory(16), money: 100 });
    const victim = placeHuman(world, LOC, {
      shooting: 0.4,
      hp: 40,
      inventory: [{ item: 'canned', qty: 2 }],
      money: 200,
    });
    makeRobber(world, robber, victim);
    return { world, robber, victim };
  }

  it('два идентичных прогона → идентичный снапшот', () => {
    const a = build(2027);
    runEncounters(a.world, 1);
    const hashA = hashSnapshot(serialize(a.world));

    const b = build(2027);
    runEncounters(b.world, 1);
    const hashB = hashSnapshot(serialize(b.world));

    expect(hashA).toBe(hashB);
  });

  it('split save/load РОВНО на тике боя ≡ непрерывному', () => {
    const cont = build(2027);
    runEncounters(cont.world, 1);
    const contHash = hashSnapshot(serialize(cont.world));

    const src = build(2027);
    const restored = deserialize(serialize(src.world));
    runEncounters(restored, 1);
    expect(hashSnapshot(serialize(restored))).toBe(contHash);
  });
});

/**
 * Чистая дельта массы из ЛЕДЖЕР-событий лога (та же формула, что
 * `@zona/headless/economy-invariant.ledgerDelta`, воспроизведена здесь, т.к. sim не
 * зависит от headless): создано (produced/harvested/broughtIn) − уничтожено
 * (consumed/exported); деньги — broughtIn.money + exported.moneyIn.
 */
function ledgerDeltaFromLog(log: readonly SimEvent[]): { money: number; items: Map<string, number> } {
  let money = 0;
  const items = new Map<string, number>();
  const add = (item: string, qty: number): void => void items.set(item, (items.get(item) ?? 0) + qty);
  for (const ev of log) {
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

describe('Encounters ROB: EconomyInvariant (worldTotals − baseline == ledgerDelta)', () => {
  it('прогон с грабежом: наблюдаемая дельта массы РАВНА леджеру (закон №3, D-045)', () => {
    // Тот же инвариант, что проверяет headless-предохранитель assertEconomyInvariant:
    // единственное изменение Σ массы — через леджер item/*. Перевод лута массу НЕ
    // трогает (в леджере его нет), расход патронов — трогает (есть item/consumed).
    const world = createSimWorld(42 as Seed);
    const robber = placeHuman(world, LOC, {
      shooting: 0.9,
      inventory: armedInventory(16, [{ item: 'canned', qty: 2 }]),
      money: 100,
    });
    const victim = placeHuman(world, LOC, {
      shooting: 0.1,
      hp: 15,
      inventory: [
        { item: 'bandage', qty: 4 },
        { item: 'canned', qty: 1 },
      ],
      money: 400,
    });
    makeRobber(world, robber, victim);

    const baseline = worldMass(world);
    runEncountersDeath(world, 1);
    const now = worldMass(world);

    // Бой реально шёл (иначе тест статичен): патроны потрачены (леджер consumed).
    expect(world.bus.log.some((e) => e.type === 'item/consumed')).toBe(true);
    // Лут реально перешёл.
    expect(world.bus.log.some((e) => e.type === 'loot/transferred')).toBe(true);

    // ИНВАРИАНТ: (now − baseline) == ledgerDelta для КАЖДОГО предмета и денег.
    const ledger = ledgerDeltaFromLog(world.bus.log);
    const keys = new Set<string>([...baseline.items.keys(), ...now.items.keys(), ...ledger.items.keys()]);
    for (const item of keys) {
      const observed = (now.items.get(item) ?? 0) - (baseline.items.get(item) ?? 0);
      const expected = ledger.items.get(item) ?? 0;
      expect(observed, `дельта массы ${item} разошлась с леджером`).toBe(expected);
    }
    // Деньги: грабёж — перевод, леджер денег не двигает ⇒ Σ денег мира неподвижна.
    expect(now.money - baseline.money).toBe(ledger.money);
    expect(ledger.money).toBe(0);
    expect(now.money).toBe(baseline.money);
  });
});

describe('Encounters ROB: изоляция HUNT — ROB не мешает пустому/животному миру', () => {
  it('мир без ROB-целей и без животных → Encounters no-op (нет событий)', () => {
    const world = createSimWorld(42 as Seed);
    // Просто стоящий человек без задачи ROB — детекция ничего не находит.
    placeHuman(world, LOC, { inventory: armedInventory(16) });
    runEncounters(world, 1);
    expect(world.bus.log.filter((e) => e.type === 'encounter/started').length).toBe(0);
    // Санити: в мире нет живых сущностей с Task=ROB.
    const robbers = queryEntities(world.ecs, [Human, Alive, Task]).filter(
      (e) => (TSK.kind[e] as number) === TaskKind.ROB,
    );
    expect(robbers.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// УСИЛЕНИЕ 2.11 (QA): голден-якорь дремлющей ветки, недостающие исходы (безоружный
// vs вооружённый, 1v1-до-смерти, мин-eid получатель, группа грабителей), устаревшая
// цель, детерминизм лута. Всё СИНТЕТИКА — в живом мире ROB пока никто не выбирает.
// ─────────────────────────────────────────────────────────────────────────────

describe('Encounters ROB: голден-якорь — ветка ДРЕМЛЕТ, пустой мир 481914ae не тронут', () => {
  it('пустой мир = 481914ae; после N тиков Encounters — 0 событий, 0 сущностей, rng не тронут', () => {
    // Тот же голден-якорь пустого мира, что закреплён в core/snapshot.test.ts (481914ae)
    // и как core-голден CLI. Здесь ДОКАЗЫВАЕМ: постановка Encounters в конвейер и её
    // прогон над пустым миром НИЧЕГО не добавляют (детекция HUNT/ROB — чистый no-op),
    // resolveEncounter не звался ⇒ world.rng не сдвинут ⇒ поток истории мира не смещён.
    const world = createSimWorld(0 as Seed);
    expect(hashSnapshot(serialize(world))).toBe('481914ae');

    const rngBefore = world.rng.state;
    runEncounters(world, 5);

    expect(world.bus.log.length).toBe(0); // ни encounter/*, ни loot/*, ни item/*
    const snap = serialize(world);
    expect(snap.entities).toEqual([]);
    expect(snap.resources).toEqual({});
    // rng НЕ тронут — ROB/HUNT-детекция не тянет из потока (голдены Фазы 1 стабильны).
    expect(world.rng.state).toBe(rngBefore);
  });

  it('толпа co-located вооружённых людей БЕЗ Task=ROB → 0 боёв (агрессия только по ROB)', () => {
    // Проверяет docblock: blanket-агрессии по вражде тут НЕТ. Пятеро стоят стволом к
    // стволу в одной локации — но НИ У КОГО нет ROB-задачи ⇒ детекция грабежа = 0 боёв,
    // охотничий/мирный путь не тронут (ROB-задач в живом мире нет ⇒ ветка спит).
    const world = createSimWorld(7 as Seed);
    for (let i = 0; i < 5; i++) {
      placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16), money: 50 });
    }
    runEncounters(world, 3);
    expect(world.bus.log.length).toBe(0);
    expect(world.bus.log.some((e) => e.type === 'encounter/started')).toBe(false);
  });
});

describe('Encounters ROB: исход (в) — БЕЗОРУЖНЫЙ грабитель (power 0) vs ВООРУЖЁННАЯ цель', () => {
  it('голорукий налётчик гибнет от ствола цели → цель ПОБЕЖДАЕТ и грабит его (симметрия)', () => {
    const world = createSimWorld(42 as Seed);
    // Грабитель без оружия: shooting высок, но нет ни ствола, ни патронов ⇒ power 0,
    // бьёт только кулаком (melee 5). Несёт добро — оно станет трофеем ЦЕЛИ.
    const robber = placeHuman(world, LOC, {
      shooting: 0.9,
      hp: 30,
      inventory: [{ item: 'canned', qty: 2 }],
      money: 45,
    });
    // Вооружённая крепкая цель — отстреливается и валит налётчика.
    const target = placeHuman(world, LOC, {
      shooting: 0.9,
      hp: HEALTH_MAX,
      inventory: armedInventory(16),
      money: 0,
    });
    makeRobber(world, robber, target);

    const massBefore = worldMass(world);
    runEncounters(world, 1);

    const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved') as
      | Extract<SimEvent, { type: 'encounter/resolved' }>
      | undefined;
    // Победила защищающаяся цель (side1); безоружный налётчик мёртв.
    expect(resolved!.payload.winnerSide).toBe(1);
    expect(HP.hp[robber]).toBeLessThanOrEqual(0);
    expect(HP.hp[target]).toBeGreaterThan(0);
    // Безоружный НЕ жёг патроны — в ammoSpent его нет (стреляла только цель).
    expect(resolved!.payload.ammoSpent.some(([eid]) => eid === robber)).toBe(false);

    // Симметрия перевода: трофей налётчика (добро+деньги) целиком у ЦЕЛИ, у налётчика 0.
    expect(qtyOf(world, target, 'canned')).toBe(2);
    expect(moneyOf(world, target)).toBe(45);
    expect(qtyOf(world, robber, 'canned')).toBe(0);
    expect(moneyOf(world, robber)).toBe(0);

    // Масса мира сохранена бит-в-бит (без ammo — расход патронов ледж.).
    const massAfter = worldMass(world);
    massBefore.items.delete('ammo_9mm');
    massAfter.items.delete('ammo_9mm');
    expectMassEqual(massBefore, massAfter);
  });
});

describe('Encounters ROB: исход (г) — 1v1 всегда до СМЕРТИ проигравшего (порог морали)', () => {
  // Сторона из ОДНОГО бойца не «ломается живой»: чтобы доля потерь достигла порога
  // морали (0.5), одиночке нужно ПОГИБНУТЬ. Значит развязка 1v1 с победителем ⇒
  // проигравший ВСЕГДА в casualties (hp<=0), а НЕ убежал живым. Гоняем на пачке seed.
  for (const seed of [1, 3, 7, 42, 99, 777, 2027]) {
    it(`seed=${seed}: у боя есть победитель ⇒ проигравший МЁРТВ (не сбежал живым)`, () => {
      const world = createSimWorld(seed as Seed);
      const robber = placeHuman(world, LOC, {
        shooting: 0.95,
        hp: HEALTH_MAX,
        inventory: armedInventory(16),
        money: 0,
      });
      const victim = placeHuman(world, LOC, {
        shooting: 0.2,
        hp: 20,
        inventory: [{ item: 'canned', qty: 1 }],
        money: 30,
      });
      makeRobber(world, robber, victim);

      runEncounters(world, 1);
      const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved') as
        | Extract<SimEvent, { type: 'encounter/resolved' }>
        | undefined;
      expect(resolved).toBeDefined();

      // Развязка с победителем: проигравшая сторона — противоположная winnerSide;
      // её единственный боец обязан быть в casualties (мёртв), НЕ выжившим-беглецом.
      const winnerSide = resolved!.payload.winnerSide;
      expect(winnerSide).not.toBeNull(); // сильно перекошенный матч → всегда развязка
      const loser = winnerSide === 0 ? victim : robber;
      const winner = winnerSide === 0 ? robber : victim;
      expect(HP.hp[loser]).toBeLessThanOrEqual(0);
      expect(HP.hp[winner]).toBeGreaterThan(0);
      // Ключевая инварианта одиночки: проигравший в casualties (умер), а не среди живых.
      expect(resolved!.payload.casualties).toContain(loser);
      expect(resolved!.payload.casualties).not.toContain(winner);
    });
  }
});

describe('Encounters ROB: несколько грабителей на одну цель — ОДИН бой, лут мин-eid живому', () => {
  it('2 грабителя группируются в один encounter; трофей цели → мин-eid живому победителю', () => {
    const world = createSimWorld(42 as Seed);
    // Два налётчика (первый placeHuman ⇒ МЕНЬШИЙ eid) валят одну слабую цель.
    const robberLow = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16), money: 0 });
    const robberHigh = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16), money: 0 });
    expect(robberLow).toBeLessThan(robberHigh); // порядок спавна ⇒ порядок eid
    const victim = placeHuman(world, LOC, {
      shooting: 0.1,
      hp: 15,
      inventory: [{ item: 'bandage', qty: 4 }],
      money: 220,
    });
    makeRobber(world, robberLow, victim);
    makeRobber(world, robberHigh, victim);

    runEncounters(world, 1);

    // ГРУППИРОВКА: ровно ОДИН encounter/started на цель, side0 = оба налётчика (сорт.).
    const started = world.bus.log.filter((e) => e.type === 'encounter/started') as
      | Extract<SimEvent, { type: 'encounter/started' }>[];
    expect(started.length).toBe(1);
    expect(started[0]!.payload.sides[0]).toEqual([robberLow, robberHigh]);
    expect(started[0]!.payload.sides[1]).toEqual([victim]);

    // Оба налётчика уцелели, цель мертва.
    expect(HP.hp[victim]).toBeLessThanOrEqual(0);
    expect(HP.hp[robberLow]).toBeGreaterThan(0);
    expect(HP.hp[robberHigh]).toBeGreaterThan(0);

    // ПОЛУЧАТЕЛЬ ЛУТА = мин-eid ЖИВОЙ победитель (robberLow), НЕ второй налётчик.
    const loot = world.bus.log.filter((e) => e.type === 'loot/transferred') as
      | Extract<SimEvent, { type: 'loot/transferred' }>[];
    expect(loot.length).toBe(1);
    expect(loot[0]!.payload.to).toBe(robberLow);
    expect(loot[0]!.payload.from).toBe(victim);
    expect(qtyOf(world, robberLow, 'bandage')).toBe(4);
    expect(moneyOf(world, robberLow)).toBe(220);
    expect(qtyOf(world, robberHigh, 'bandage')).toBe(0);
    expect(moneyOf(world, robberHigh)).toBe(0);
    // Цель обчищена дочиста.
    expect(qtyOf(world, victim, 'bandage')).toBe(0);
    expect(moneyOf(world, victim)).toBe(0);
  });
});

describe('Encounters ROB: граничные — устаревшая/невалидная цель ⇒ грабёж не завязывается', () => {
  it('цель уже МЕРТВА (hp<=0, ещё не снят Death) → нет боя (гейт hp>0)', () => {
    const world = createSimWorld(42 as Seed);
    const victim = placeHuman(world, LOC, { hp: 0, inventory: [{ item: 'canned', qty: 1 }], money: 10 });
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16) });
    makeRobber(world, robber, victim);

    runEncounters(world, 1);
    expect(world.bus.log.some((e) => e.type === 'encounter/started')).toBe(false);
    // Мёртвая цель не обчищена (боя не было) — её лут на месте.
    expect(qtyOf(world, victim, 'canned')).toBe(1);
    expect(moneyOf(world, victim)).toBe(10);
  });

  it('цель В ПУТИ (dest≠loc, не стоит рядом) → не co-located → нет боя', () => {
    const world = createSimWorld(42 as Seed);
    const victim = placeHuman(world, LOC, { hp: 30 });
    POS.dest[victim] = (LOC + 4) as number; // цель уходит из локации (в пути)
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16) });
    makeRobber(world, robber, victim);

    runEncounters(world, 1);
    expect(world.bus.log.some((e) => e.type === 'encounter/started')).toBe(false);
  });

  it('САМ грабитель В ПУТИ (dest≠loc) → ещё не дошёл до цели → нет боя', () => {
    const world = createSimWorld(42 as Seed);
    const victim = placeHuman(world, LOC, { hp: 30 });
    const robber = placeHuman(world, LOC, { shooting: 0.9, inventory: armedInventory(16) });
    POS.dest[robber] = (LOC + 4) as number; // грабитель ещё бежит — не стоит у цели
    makeRobber(world, robber, victim);

    runEncounters(world, 1);
    expect(world.bus.log.some((e) => e.type === 'encounter/started')).toBe(false);
  });
});

describe('Encounters ROB: детерминизм лута per-battle (одинаковый сетап → тот же исход/трофей)', () => {
  it('два независимых мира с идентичным сетапом → идентичный casualties + loot payload', () => {
    function run(): { casualties: readonly EntityId[]; loot: Extract<SimEvent, { type: 'loot/transferred' }>['payload'] } {
      const world = createSimWorld(2027 as Seed);
      const robber = placeHuman(world, LOC, { shooting: 0.7, inventory: armedInventory(16), money: 100 });
      const victim = placeHuman(world, LOC, {
        shooting: 0.4,
        hp: 40,
        inventory: [{ item: 'canned', qty: 2 }],
        money: 200,
      });
      makeRobber(world, robber, victim);
      runEncounters(world, 1);
      const resolved = world.bus.log.find((e) => e.type === 'encounter/resolved') as
        Extract<SimEvent, { type: 'encounter/resolved' }>;
      const loot = world.bus.log.find((e) => e.type === 'loot/transferred') as
        Extract<SimEvent, { type: 'loot/transferred' }>;
      return { casualties: resolved.payload.casualties, loot: loot.payload };
    }
    const a = run();
    const b = run();
    // Per-battle rng-метка `encounter@tick#loc#target` детерминирована сетапом ⇒
    // исход и переведённый трофей совпадают бит-в-бит между прогонами.
    expect(a.casualties).toEqual(b.casualties);
    expect(a.loot).toEqual(b.loot);
  });
});
