/**
 * @module @zona/headless/fame-economy-invariant.test
 *
 * ДИЗЪЮНКТНОСТЬ `fame` и МАССЫ мира (задача 3.1, D-067 §3 ↔ D-045). Доказывает
 * ГЛАВНОЕ обещание изоляции нарративного хребта: `fame` — РЕПУТАЦИОННОЕ число под
 * ключом ResourceStore `'fame'`, ДИЗЪЮНКТНЫМ с `'money'`/`'inventory'`. Значит
 * прокачка известности (`incFame`) НЕ создаёт и НЕ уничтожает массу — EconomyInvariant
 * (D-045, суммирует ТОЛЬКО money+inventory) её не видит и не срабатывает.
 *
 * Проверяется РЕАЛЬНЫМ чекером `worldTotals`/`assertEconomyInvariant` (не переизобретён)
 * на ЖИВОМ конвейере Фазы 1 — так тест ловил бы регресс, если бы `fame` случайно
 * учитывался как деньги/предмет. Читается как «слава Зоны — не хабар: летопись возвышает
 * легенду, но ни грамма массы не появляется из воздуха».
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, ItemId, Seed, Tick } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  registerPhase1Systems,
  worldgen,
  serialize,
  deserialize,
  incFame,
  getFame,
  FAME_KEY,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import { worldTotals, assertEconomyInvariant, type EconTotals } from './economy-invariant';

/** Собирает ЖИВОЙ мир Фазы 1 (worldgen + 9 систем), как headless-CLI. */
function buildLive(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase1Systems(scheduler);
  return { world, scheduler };
}

/** Все eid, у которых worldgen дал деньги — реальные NPC/сущности мира. */
function moneyBearers(world: SimWorld): EntityId[] {
  return [...world.resources.entries<number>('money')].map(([eid]) => eid);
}

/** Строгое равенство двух снимков массы (деньги + каждый item). */
function expectSameTotals(a: EconTotals, b: EconTotals): void {
  expect(a.money).toBe(b.money);
  const keys = new Set<ItemId>([...a.items.keys(), ...b.items.keys()]);
  for (const k of keys) {
    expect(a.items.get(k) ?? 0, `item ${k} разошёлся`).toBe(b.items.get(k) ?? 0);
  }
}

describe("fame ДИЗЪЮНКТЕН массе — EconomyInvariant его не видит (D-067 §3 ↔ D-045)", () => {
  it("ключ 'fame' не совпадает ни с 'money', ни с 'inventory' (контракт изоляции)", () => {
    expect(FAME_KEY).toBe('fame');
    expect(FAME_KEY).not.toBe('money');
    expect(FAME_KEY).not.toBe('inventory');
  });

  it('прокачка fame на всех NPC НЕ меняет worldTotals (масса не появляется)', () => {
    const { world } = buildLive(42);
    const before = worldTotals(world);
    const bearers = moneyBearers(world);
    expect(bearers.length, 'worldgen обязан дать носителей денег').toBeGreaterThan(0);

    // Возводим половину мира в легенды Зоны — чистая репутация, не хабар.
    for (const eid of bearers) incFame(world.resources, eid, 77);

    // fame РЕАЛЬНО записан (иначе тест бы ничего не проверял)…
    expect(getFame(world.resources, bearers[0]!)).toBe(77);
    // …но масса мира ТОЖДЕСТВЕННА до и после — fame не деньги и не предмет.
    expectSameTotals(worldTotals(world), before);
  });

  it('assertEconomyInvariant держится, ХОТЯ fame прокачан во время живого прогона', () => {
    const { world, scheduler } = buildLive(7);
    const baseline: EconTotals = worldTotals(world);

    for (let day = 0; day < 10; day++) {
      scheduler.run(world, TICKS_PER_DAY);
      // Каждый день летопись «упоминает» живых — fame растёт ПОВЕРХ обычной жизни мира.
      for (const eid of moneyBearers(world)) incFame(world.resources, eid, 3);
      // Инвариант массы держится: приток fame не подмешался в money/inventory.
      expect(
        () => assertEconomyInvariant(world, world.bus, baseline, world.tick),
        `день ${day}: fame протёк в массу`,
      ).not.toThrow();
    }

    // Итог: fame накопился (мир помнит легенд), масса — строго по леджеру.
    const someFamed = moneyBearers(world).some((eid) => getFame(world.resources, eid) > 0);
    expect(someFamed, 'ни у кого не накопился fame — тест выродился').toBe(true);
  }, 30000);

  it('fame переживает save/load И EconomyInvariant остаётся цел после round-trip', () => {
    const { world, scheduler } = buildLive(999);
    const baseline: EconTotals = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY * 3);
    for (const eid of moneyBearers(world)) incFame(world.resources, eid, 40);

    const totalsPre = worldTotals(world);
    const restored = deserialize(serialize(world));

    // Масса не изменилась сериализацией; fame — тоже сериализуемое РЕПУТАЦИОННОЕ поле.
    expectSameTotals(worldTotals(restored), totalsPre);
    const bearer = moneyBearers(restored)[0]!;
    expect(getFame(restored.resources, bearer)).toBe(40);
    // Чекер массы держится на восстановленном мире (fame не подмешался в тоталы).
    expect(
      () => assertEconomyInvariant(restored, restored.bus, baseline, restored.tick as Tick),
    ).not.toThrow();
  }, 30000);
});
