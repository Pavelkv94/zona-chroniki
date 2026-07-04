/**
 * @module @zona/headless/export-2.7.test
 *
 * Гейт: РЕАЛЬНЫЙ предохранитель `assertEconomyInvariant` (D-045) держится, когда мир
 * гоняет систему Export (2.7) РЯДОМ с Economy. Export — ЕДИНСТВЕННЫЙ money-faucet
 * (D-055): поселение вывозит накопленный хабар (артефакты) за Периметр — товар
 * ФИЗИЧЕСКИ покидает мир, деньги ФИЗИЧЕСКИ входят, и ОБА факта проведены леджером
 * `item/exported` (−qty к товару, +moneyIn к деньгам). Значит формула инварианта
 * `worldTotals − baseline == ledgerDelta(0, tick)` ОБЯЗАНА держаться: money-faucet
 * учтён именно через `item/exported.moneyIn` в `ledgerDelta` (headless), а не «из
 * воздуха». Доказываем ещё, что faucet РЕАЛЬНО сработал (иначе тест проверял бы
 * статику): Σ денег мира выросла ровно на Σ moneyIn, а Σ артефактов упала до нуля.
 *
 * Export НЕ в конвейере Фазы 1 (подключит 2.16) ⇒ регистрируется в ОТДЕЛЬНОМ
 * планировщике вместе с Economy — как это сделает 2.16, изолированно от голденов.
 *
 * Фикстура: worldgen-мир не рождает артефактов на складах поселений (их принесёт цикл
 * поле→сталкер→торговля будущих фаз), поэтому тест СЕЙ артефакты на склады поселений
 * ДО снятия baseline — они становятся частью стартовой массы мира (baseline, а не
 * событие, как стартовый склад worldgen, D-045). Поселения опознаём по казне (>=
 * порога: startingTreasury 15000/20000 ≫ STARTING_MONEY сталкера 2000).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, ItemId, Seed, Tick } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  worldgen,
  Economy,
  Export,
  exportPriceOf,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import {
  worldTotals,
  ledgerDelta,
  assertEconomyInvariant,
  type EconTotals,
} from './economy-invariant';

interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Казна поселения (15000/20000) ≫ STARTING_MONEY сталкера (2000) — надёжный порог. */
const SETTLEMENT_MONEY_MIN = 10000;

/** Артефакты, засеваемые на склад каждого поселения (хабар «уже накоплен» торговлей). */
const SEED_HABAR: InventoryEntry[] = [
  { item: 'artifact_medusa' as ItemId, qty: 2 },
  { item: 'artifact_moonlight' as ItemId, qty: 1 },
];

/** eid'ы поселений (по казне) — без доступа к ECS-компонентам из headless. */
function settlementEids(world: SimWorld): EntityId[] {
  const eids: EntityId[] = [];
  for (const [eid, money] of world.resources.entries<number>('money')) {
    if (money >= SETTLEMENT_MONEY_MIN) eids.push(eid);
  }
  return eids.sort((a, b) => (a as number) - (b as number));
}

/** Досевает хабар на склад поселения (новый массив, сорт. по itemId — как хранит мир). */
function seedHabar(world: SimWorld, eid: EntityId): void {
  const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
  const merged = [...inv, ...SEED_HABAR].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, merged);
}

/** Мир из worldgen + хабар на складах поселений + планировщик с Economy И Export. */
function buildEconExport(seed: number): {
  world: SimWorld;
  scheduler: ReturnType<typeof createScheduler>;
  settlements: EntityId[];
} {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const settlements = settlementEids(world);
  for (const eid of settlements) seedHabar(world, eid);
  const scheduler = createScheduler();
  scheduler.register(Economy);
  scheduler.register(Export);
  return { world, scheduler, settlements };
}

describe('EconomyInvariant держится под Export+Economy 2.7 (money-faucet через item/exported)', () => {
  for (const seed of [42, 7, 999]) {
    it(`seed=${seed}: (Σ мира − baseline) == ledger на КАЖДОМ из 30 дней (faucet учтён)`, () => {
      const { world, scheduler, settlements } = buildEconExport(seed);
      expect(settlements.length).toBeGreaterThan(0); // фикстура нашла поселения
      const baseline: EconTotals = worldTotals(world);

      for (let day = 1; day <= 30; day++) {
        scheduler.run(world, TICKS_PER_DAY);
        expect(
          () => assertEconomyInvariant(world, world.bus, baseline, world.tick),
          `seed=${seed}: масса разошлась с леджером на дне ${day} (faucet вне леджера?)`,
        ).not.toThrow();
      }

      // Faucet РЕАЛЬНО сработал: были item/exported с положительным moneyIn.
      const exports = world.bus.log.filter((e) => e.type === 'item/exported');
      expect(exports.length).toBeGreaterThan(0);

      // Денежная дельта леджера == Σ moneyIn экспорта (Economy деньги не двигает).
      const delta = ledgerDelta(world.bus, 0 as Tick, world.tick);
      const sumMoneyIn = exports.reduce(
        (a, e) => a + (e as Extract<typeof e, { type: 'item/exported' }>).payload.moneyIn,
        0,
      );
      expect(delta.money).toBe(sumMoneyIn);
      expect(sumMoneyIn).toBeGreaterThan(0);
      // Σ денег мира ВЫРОСЛА ровно на приток faucet (деньги вошли ИЗВНЕ).
      expect(worldTotals(world).money - baseline.money).toBe(sumMoneyIn);
      // Хабар ФИЗИЧЕСКИ покинул мир: артефактов на складах не осталось.
      const now = worldTotals(world);
      expect(now.items.get('artifact_medusa' as ItemId) ?? 0).toBe(0);
      expect(now.items.get('artifact_moonlight' as ItemId) ?? 0).toBe(0);
    }, 30000);
  }

  it('faucet сходится с ценой: Σ moneyIn == Σ по exportPriceOf(item)×qty вывезенного', () => {
    const { world, scheduler } = buildEconExport(42);
    scheduler.run(world, TICKS_PER_DAY * 2);
    const exports = world.bus.log.filter(
      (e): e is Extract<typeof e, { type: 'item/exported' }> => e.type === 'item/exported',
    );
    for (const e of exports) {
      expect(e.payload.moneyIn).toBe(exportPriceOf(e.payload.item) * e.payload.qty);
      expect(e.causedBy).toBeNull(); // эндогенный корень (логистика), D-030/D-055
    }
  }, 30000);
});
