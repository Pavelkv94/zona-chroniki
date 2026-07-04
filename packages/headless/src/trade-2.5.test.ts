/**
 * @module @zona/headless/trade-2.5.test
 *
 * Гейт: РЕАЛЬНЫЙ предохранитель `assertEconomyInvariant` (D-045) держится, когда мир
 * гоняет систему Trade (2.5) РЯДОМ с Economy. Торговля — ПЕРЕВОД (закон №3): предметы
 * и деньги меняют владельца, но Σ денег и Σ каждого предмета мира НЕ меняются, поэтому
 * Trade НЕ эмитит леджер `item/*` и «денежная/товарная дельта леджера» остаётся той,
 * что даёт одна лишь Economy (потребление). Иными словами: подключение Trade НЕ должно
 * породить массу/деньги из воздуха и не должно их испарить.
 *
 * Trade НЕ в конвейере Фазы 1 (подключит 2.16), поэтому здесь регистрируется в
 * ОТДЕЛЬНОМ планировщике вместе с Economy — как это сделает 2.16, но изолированно от
 * голденов Фазы 1. Проверяем `worldTotals − baseline == ledgerDelta(0, tick)` на КАЖДОМ
 * из 30 дней (сквозь дефицит и заброшенность поселений), плюс денежную дельту леджера.
 *
 * Тонкий сценарный тест исполнения сделки (Task=TRADE, деление кассы, границы) живёт в
 * `@zona/sim` (trade.test.ts) — там доступен ECS-API спавна; здесь — интеграционный
 * контроль, что глобальный инвариант массы держится под Trade в реальном мире worldgen.
 */

import { describe, it, expect } from 'vitest';
import type { Seed, Tick } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  worldgen,
  Economy,
  Trade,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import {
  worldTotals,
  ledgerDelta,
  assertEconomyInvariant,
  type EconTotals,
} from './economy-invariant';

/** Мир из worldgen + планировщик с Economy И Trade (как подключит 2.16, изолированно). */
function buildEconTrade(seed: number): {
  world: SimWorld;
  scheduler: ReturnType<typeof createScheduler>;
} {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  scheduler.register(Economy);
  scheduler.register(Trade);
  return { world, scheduler };
}

describe('EconomyInvariant держится под Trade+Economy 2.5 (торговля = перевод, закон №3)', () => {
  for (const seed of [42, 7, 999]) {
    it(`seed=${seed}: (Σ мира − baseline) == ledger на КАЖДОМ из 30 дней (Trade не течёт)`, () => {
      const { world, scheduler } = buildEconTrade(seed);
      const baseline: EconTotals = worldTotals(world);

      for (let day = 1; day <= 30; day++) {
        scheduler.run(world, TICKS_PER_DAY);
        expect(
          () => assertEconomyInvariant(world, world.bus, baseline, world.tick),
          `seed=${seed}: масса разошлась с леджером на дне ${day} (Trade создал/испарил массу?)`,
        ).not.toThrow();
      }

      // Trade — перевод: он НЕ добавляет леджер-денег. Денежная дельта леджера идёт
      // только от Economy (в Фазе 1 = 0: ни broughtIn, ни exported). Значит Σ денег
      // мира неподвижна, а любые сделки Trade сохраняли её точно.
      const delta = ledgerDelta(world.bus, 0 as Tick, world.tick);
      expect(delta.money).toBe(0);
      expect(worldTotals(world).money).toBe(baseline.money);
      // (Economy эмитит item/consumed/produced — они уравновешены формулой инварианта;
      // отдельная сценарная проверка «Trade НЕ эмитит своих item/*» — в sim/trade.test.ts.)
    }, 30000);
  }

  it('подключение Trade НЕ меняет исход мира-без-торговцев vs только Economy (масса та же)', () => {
    // В мире worldgen без назначенной задачи TRADE (её ставит 2.6) Trade не совершает
    // сделок, поэтому итог обязан совпасть с прогоном одной Economy — доказывает, что
    // Trade не имеет побочных эффектов на массу «на холостом ходу».
    const onlyEcon = createSimWorld(42 as Seed);
    worldgen(onlyEcon);
    const s1 = createScheduler();
    s1.register(Economy);
    s1.run(onlyEcon, TICKS_PER_DAY * 10);

    const withTrade = createSimWorld(42 as Seed);
    worldgen(withTrade);
    const s2 = createScheduler();
    s2.register(Economy);
    s2.register(Trade);
    s2.run(withTrade, TICKS_PER_DAY * 10);

    const a = worldTotals(onlyEcon);
    const b = worldTotals(withTrade);
    expect(b.money).toBe(a.money);
    const allItems = new Set([...a.items.keys(), ...b.items.keys()]);
    for (const item of [...allItems].sort()) {
      expect(b.items.get(item) ?? 0, `Σ ${item} не должна зависеть от подключения Trade`).toBe(
        a.items.get(item) ?? 0,
      );
    }
  }, 30000);
});
