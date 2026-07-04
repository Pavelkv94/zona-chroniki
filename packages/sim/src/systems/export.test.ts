/**
 * @module @zona/sim/systems/export.test
 *
 * Гейт системы Export + цены `exportPriceOf` (задача 2.7, D-055). Доказывает:
 *  • ЦЕНА ЭКСПОРТА DERIVED/детерминирована: exportPriceOf = round(basePrice ×
 *    EXPORT_PRICE_FACTOR), не ниже PRICE_FLOOR; без rng/состояния (resume-safe).
 *  • ЭКСПОРТ ФАЙРИТСЯ ПО СОСТОЯНИЮ (закон №2): поселение с накопленным хабаром >=
 *    порога вывозит его весь; `item/exported` на каждую позицию; касса += moneyIn.
 *  • MONEY-FAUCET РОВНО ПО ЛЕДЖЕРУ (закон №3, D-045): Σ денег мира выросла ровно на
 *    Σ moneyIn, Σ каждого артефакта упала ровно на Σ qty — та же формула, что
 *    проверяет assertEconomyInvariant (headless). Деньги СОЗДАНЫ только здесь.
 *  • ТОЛЬКО САНКЦИОНИРОВАННЫЙ хабар (kind 'artifact'): еда/оружие/патроны на складе
 *    НЕ трогаются.
 *  • СКЛАД НЕ В МИНУС / атомарность / аляйсинг (D-035): вывозится лишь наличие; чужие
 *    инвентари (сталкер, второе поселение) целы; перевод новыми массивами.
 *  • ПОРОГ и ЗАБРОШЕННОСТЬ: ниже EXPORT_SURPLUS_THRESHOLD — не отправляет; заброшенное
 *    поселение инертно.
 *  • ДЕТЕРМИНИЗМ 2× (rng не используется) и RESUME (split ≡ continuous по хэшу).
 *
 * Export НЕ в конвейере Фазы 1 (подключит 2.16) ⇒ гоняется в ОТДЕЛЬНОМ планировщике,
 * голдены Фазы 1 не затрагиваются.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, ItemId, Seed, SimEvent } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  serialize,
  deserialize,
  hashSnapshot,
  Export,
  exportPriceOf,
  type SimWorld,
} from '../index';
import { spawnEntity, addComponent } from '../core/ecs';
import { Position, Settlement, Human, Alive } from '../core/components';
import { getItem } from '../data/index';
import { EXPORT_PRICE_FACTOR } from '../balance/economy';

const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };

interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Артефакты из items.json (задача 2.9): id → basePrice. Опорные значения теста. */
const ARTIFACTS = ['artifact_medusa', 'artifact_stone_flower', 'artifact_moonlight'] as const;

/** Поселение-сущность на loc со складом `inv` и кассой `money`. */
function spawnSettlement(world: SimWorld, loc: number, inv: InventoryEntry[], money: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Settlement, eid);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, inv);
  world.resources.set<number>('money', eid, money);
  return eid;
}

/** Сталкер (Human, НЕ Settlement) с инвентарём — контроль «Export трогает только поселения». */
function spawnStalker(world: SimWorld, loc: number, inv: InventoryEntry[], money: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, inv);
  world.resources.set<number>('money', eid, money);
  return eid;
}

/** Мир + планировщик ТОЛЬКО с Export (как подключит 2.16, изолированно). */
function buildExportWorld(seed = 42): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  const scheduler = createScheduler();
  scheduler.register(Export);
  return { world, scheduler };
}

function stockOf(world: SimWorld, eid: EntityId, item: string): number {
  const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
  let sum = 0;
  for (const e of inv) if (e.item === item) sum += e.qty;
  return sum;
}

function moneyOf(world: SimWorld, eid: EntityId): number {
  return world.resources.get<number>('money', eid) ?? 0;
}

function exportedEvents(world: SimWorld): ReadonlyArray<Extract<SimEvent, { type: 'item/exported' }>> {
  return world.bus.log.filter(
    (e): e is Extract<SimEvent, { type: 'item/exported' }> => e.type === 'item/exported',
  );
}

/** Σ денег мира по всем носителям 'money' (та же формула, что worldTotals headless). */
function worldMoney(world: SimWorld): number {
  let money = 0;
  for (const [, m] of world.resources.entries<number>('money')) money += m;
  return money;
}

/** Σ qty предмета `item` по всем инвентарям мира (worldTotals по item). */
function worldItem(world: SimWorld, item: string): number {
  let sum = 0;
  for (const [, inv] of world.resources.entries<readonly InventoryEntry[]>('inventory')) {
    for (const e of inv) if (e.item === item) sum += e.qty;
  }
  return sum;
}

describe('exportPriceOf — DERIVED цена за Периметром (D-055)', () => {
  it('= round(basePrice × EXPORT_PRICE_FACTOR), не ниже PRICE_FLOOR; чистая/детерминированная', () => {
    for (const id of ARTIFACTS) {
      const base = getItem(id).basePrice;
      const expected = Math.max(1, Math.round(base * EXPORT_PRICE_FACTOR));
      expect(exportPriceOf(id as ItemId)).toBe(expected);
      // Чистота: повторный вызов даёт тот же результат (без состояния/rng).
      expect(exportPriceOf(id as ItemId)).toBe(exportPriceOf(id as ItemId));
    }
  });
});

describe('Export — money-faucet за Периметр (закон №3, D-045/D-055)', () => {
  it('вывозит ВЕСЬ хабар, эмитит item/exported, зачисляет выручку; эссеншелы целы', () => {
    const { world, scheduler } = buildExportWorld();
    // Склад: 2 медузы + 1 лунный свет (хабар) + еда/оружие (эссеншел, НЕ экспорт).
    const inv: InventoryEntry[] = [
      { item: 'artifact_medusa' as ItemId, qty: 2 },
      { item: 'artifact_moonlight' as ItemId, qty: 1 },
      { item: 'canned' as ItemId, qty: 5 },
      { item: 'pm' as ItemId, qty: 2 },
    ];
    const set = spawnSettlement(world, 0, inv, 15000);

    scheduler.run(world, 1); // Export due на тике 0

    const priceMedusa = exportPriceOf('artifact_medusa' as ItemId);
    const priceMoon = exportPriceOf('artifact_moonlight' as ItemId);
    const expectedIn = priceMedusa * 2 + priceMoon * 1;

    // Хабар ФИЗИЧЕСКИ ушёл из мира.
    expect(stockOf(world, set, 'artifact_medusa')).toBe(0);
    expect(stockOf(world, set, 'artifact_moonlight')).toBe(0);
    // Эссеншелы не тронуты (только санкционированный хабар).
    expect(stockOf(world, set, 'canned')).toBe(5);
    expect(stockOf(world, set, 'pm')).toBe(2);
    // Деньги ФИЗИЧЕСКИ вошли в кассу.
    expect(moneyOf(world, set)).toBe(15000 + expectedIn);

    // Леджер: по позиции на артефакт, moneyIn = price × qty, causedBy null (корень).
    const evs = exportedEvents(world);
    expect(evs.length).toBe(2);
    const byItem = new Map(evs.map((e) => [e.payload.item, e]));
    expect(byItem.get('artifact_medusa' as ItemId)!.payload.qty).toBe(2);
    expect(byItem.get('artifact_medusa' as ItemId)!.payload.moneyIn).toBe(priceMedusa * 2);
    expect(byItem.get('artifact_moonlight' as ItemId)!.payload.qty).toBe(1);
    expect(byItem.get('artifact_moonlight' as ItemId)!.payload.moneyIn).toBe(priceMoon * 1);
    for (const e of evs) {
      expect(e.payload.who).toBe(set);
      expect(e.causedBy).toBeNull();
    }
  });

  it('Σ денег мира растёт РОВНО на Σ moneyIn, Σ артефакта падает РОВНО на Σ qty (ledger)', () => {
    const { world, scheduler } = buildExportWorld();
    const set = spawnSettlement(
      world,
      0,
      [
        { item: 'artifact_medusa' as ItemId, qty: 3 },
        { item: 'artifact_stone_flower' as ItemId, qty: 2 },
      ],
      15000,
    );
    // Второе поселение с хабаром — faucet срабатывает на обоих независимо.
    const set2 = spawnSettlement(world, 5, [{ item: 'artifact_moonlight' as ItemId, qty: 1 }], 20000);

    const moneyBefore = worldMoney(world);
    const medusaBefore = worldItem(world, 'artifact_medusa');
    const flowerBefore = worldItem(world, 'artifact_stone_flower');
    const moonBefore = worldItem(world, 'artifact_moonlight');

    scheduler.run(world, 1);

    const evs = exportedEvents(world);
    const sumMoneyIn = evs.reduce((a, e) => a + e.payload.moneyIn, 0);
    const sumQty = (item: string) =>
      evs.filter((e) => e.payload.item === item).reduce((a, e) => a + e.payload.qty, 0);

    // Денежная дельта мира == Σ moneyIn леджера (деньги созданы ТОЛЬКО экспортом).
    expect(worldMoney(world) - moneyBefore).toBe(sumMoneyIn);
    // Товарная дельта мира == −Σ qty леджера (хабар ушёл из мира).
    expect(medusaBefore - worldItem(world, 'artifact_medusa')).toBe(sumQty('artifact_medusa'));
    expect(flowerBefore - worldItem(world, 'artifact_stone_flower')).toBe(sumQty('artifact_stone_flower'));
    expect(moonBefore - worldItem(world, 'artifact_moonlight')).toBe(sumQty('artifact_moonlight'));
    // Оба поселения обнулили хабар.
    expect(worldItem(world, 'artifact_medusa')).toBe(0);
    expect(stockOf(world, set2, 'artifact_moonlight')).toBe(0);
    expect(stockOf(world, set, 'artifact_stone_flower')).toBe(0);
  });

  it('трогает ТОЛЬКО поселения: хабар в инвентаре сталкера не вывозится (аляйсинг D-035)', () => {
    const { world, scheduler } = buildExportWorld();
    spawnSettlement(world, 0, [{ item: 'artifact_medusa' as ItemId, qty: 1 }], 15000);
    const stalkerInv: InventoryEntry[] = [{ item: 'artifact_moonlight' as ItemId, qty: 2 }];
    const stalker = spawnStalker(world, 0, stalkerInv, 2000);
    const storedRef = world.resources.get<readonly InventoryEntry[]>('inventory', stalker);

    scheduler.run(world, 1);

    // Сталкер (не Settlement) не экспортирует — его хабар цел, ссылка не мутирована.
    expect(stockOf(world, stalker, 'artifact_moonlight')).toBe(2);
    expect(moneyOf(world, stalker)).toBe(2000);
    expect(world.resources.get<readonly InventoryEntry[]>('inventory', stalker)).toBe(storedRef);
    // Экспортное событие — только на поселение.
    const evs = exportedEvents(world);
    expect(evs.length).toBe(1);
    expect(evs[0]!.payload.item).toBe('artifact_medusa');
  });

  it('НИЖЕ порога (нет хабара) — не отправляет; заброшенное поселение инертно', () => {
    const { world, scheduler } = buildExportWorld();
    // Поселение без хабара (только эссеншелы) — sumExportable 0 < порога.
    const noHabar = spawnSettlement(world, 0, [{ item: 'canned' as ItemId, qty: 5 }], 15000);
    // Поселение с хабаром, но помечено заброшенным — Export его не обслуживает.
    const abandoned = spawnSettlement(world, 5, [{ item: 'artifact_medusa' as ItemId, qty: 3 }], 100);
    world.resources.set<boolean>('settlementAbandoned', abandoned, true);

    scheduler.run(world, 1);

    expect(exportedEvents(world).length).toBe(0);
    expect(moneyOf(world, noHabar)).toBe(15000);
    expect(stockOf(world, abandoned, 'artifact_medusa')).toBe(3);
    expect(moneyOf(world, abandoned)).toBe(100);
  });
});

describe('Export — детерминизм и resume (закон №8)', () => {
  it('2× одинаковый прогон → идентичные события/склад/касса (rng не используется)', () => {
    const build = (): SimWorld => {
      const { world, scheduler } = buildExportWorld(7);
      spawnSettlement(world, 0, [{ item: 'artifact_medusa' as ItemId, qty: 4 }], 15000);
      spawnSettlement(world, 5, [{ item: 'artifact_moonlight' as ItemId, qty: 2 }], 20000);
      scheduler.run(world, 1500); // фаер на 0 и 1440
      return world;
    };
    const a = build();
    const b = build();
    expect(hashSnapshot(serialize(a))).toBe(hashSnapshot(serialize(b)));
    const evA = exportedEvents(a).map((e) => `${e.payload.who}:${e.payload.item}:${e.payload.qty}:${e.payload.moneyIn}`);
    const evB = exportedEvents(b).map((e) => `${e.payload.who}:${e.payload.item}:${e.payload.qty}:${e.payload.moneyIn}`);
    expect(evA).toEqual(evB);
  });

  it('resume: split (save/load через фаер) ≡ continuous по хэшу', () => {
    const seed = 999 as Seed;
    const seedWorld = (): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } => {
      const { world, scheduler } = buildExportWorld(seed);
      spawnSettlement(world, 0, [{ item: 'artifact_stone_flower' as ItemId, qty: 5 }], 15000);
      return { world, scheduler };
    };
    // Непрерывный: 1441 тик (Export фаерит на 0 и 1440).
    const cont = seedWorld();
    cont.scheduler.run(cont.world, 1441);
    const contHash = hashSnapshot(serialize(cont.world));

    // Split: 720 → save → load → ещё 721 (итого 1441), пересечь фаер на 1440.
    const split = seedWorld();
    split.scheduler.run(split.world, 720);
    const mid = deserialize(serialize(split.world));
    const sched2 = createScheduler();
    sched2.register(Export);
    sched2.run(mid, 721);
    const splitHash = hashSnapshot(serialize(mid));

    expect(splitHash).toBe(contHash);
  });
});
