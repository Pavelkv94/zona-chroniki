/**
 * @module @zona/headless/economy-2.3.test
 *
 * Гейт: РЕАЛЬНЫЙ предохранитель `assertEconomyInvariant` (D-045) держится, когда мир
 * гоняет систему Economy (2.3) — потребление поселений УНИЧТОЖАЕТ массу провизии, и
 * каждое уничтожение видно леджеру `item/consumed(upkeep)`. Economy НЕ в конвейере
 * Фазы 1 (подключит 2.16), поэтому здесь она регистрируется в ОТДЕЛЬНОМ планировщике
 * (только Economy) — как это сделает 2.16, но изолированно от голденов.
 *
 * Доказываем: `worldTotals − baseline == ledgerDelta(0, upToTick)` на КАЖДОМ игровом
 * дне (включая дни дефицита и заброшенности), деньги Economy не двигает (денежная
 * дельта == 0), и потребление РЕАЛЬНО шло (иначе инвариант проверял бы статику).
 */

import { describe, it, expect } from 'vitest';
import type { Seed, Tick } from '@zona/shared';
import {
  createSimWorld,
  createScheduler,
  worldgen,
  Economy,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import {
  worldTotals,
  ledgerDelta,
  assertEconomyInvariant,
  type EconTotals,
} from './economy-invariant';

/** Мир из worldgen + планировщик ТОЛЬКО с Economy (как подключит 2.16). */
function buildEcon(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  scheduler.register(Economy);
  return { world, scheduler };
}

describe('EconomyInvariant держится под системой Economy 2.3 (потребление сводит массу)', () => {
  for (const seed of [42, 7, 999]) {
    it(`seed=${seed}: (totals − baseline) == ledger на КАЖДОМ из 30 дней`, () => {
      const { world, scheduler } = buildEcon(seed);
      const baseline: EconTotals = worldTotals(world);

      for (let day = 1; day <= 30; day++) {
        scheduler.run(world, TICKS_PER_DAY);
        expect(
          () => assertEconomyInvariant(world, world.bus, baseline, world.tick),
          `seed=${seed}: масса разошлась с леджером на дне ${day}`,
        ).not.toThrow();
      }

      // Потребление РЕАЛЬНО шло: были item/consumed(upkeep) — иначе инвариант
      // проверял бы неизменную массу (пустой тест).
      const upkeep = world.bus.log.some(
        (e) => e.type === 'item/consumed' && e.payload.reason === 'upkeep',
      );
      expect(upkeep).toBe(true);
      // Поселения реально забрасывались за 30 дней (склады выедены под ноль) —
      // фиксируем, что инвариант держится и на дефицитных/пост-заброшенных днях.
      expect(world.bus.log.some((e) => e.type === 'settlement/abandoned')).toBe(true);
    }, 30000);
  }

  it('Economy НЕ двигает деньги: денежная дельта леджера == 0 (нет broughtIn/exported)', () => {
    const { world, scheduler } = buildEcon(42);
    scheduler.run(world, TICKS_PER_DAY * 10);
    const delta = ledgerDelta(world.bus, 0 as Tick, world.tick);
    expect(delta.money).toBe(0);
    // Наблюдаемая Σ money тоже неподвижна (потребление трогает только провизию).
    const start = worldTotals(createSeededWorldgen(42)).money;
    expect(worldTotals(world).money).toBe(start);
  }, 30000);
});

/** Свежий worldgen-мир того же seed (для сравнения стартовой Σ money). */
function createSeededWorldgen(seed: number): SimWorld {
  const w = createSimWorld(seed as Seed);
  worldgen(w);
  return w;
}

// ═══════════════════════════════════════════════════════════════════════════
// ПОДЛОГ: предохранитель assertEconomyInvariant — ЖИВАЯ ловушка, а не украшение.
//   (а) если МАССА возникнет без леджера (имитируем «Economy создала out без
//       item/produced») — предохранитель ОБЯЗАН бросить;
//   (б) реальная Economy за 30 дней массу без леджера НЕ создаёт (не бросает).
// ═══════════════════════════════════════════════════════════════════════════
interface InvEntry {
  readonly item: string;
  readonly qty: number;
}

describe('EconomyInvariant — предохранитель ловит подлог массы (D-045, закон №3)', () => {
  it('инъекция товара на склад БЕЗ item/produced → assertEconomyInvariant БРОСАЕТ', () => {
    const { world } = buildEcon(42);
    const baseline = worldTotals(world);
    // Имитируем БАГ: Economy якобы «создала» 7 canned на складе первого поселения,
    // НЕ опубликовав item/produced (масса из воздуха — ровно то, что запрещает закон №3).
    const settle = [...world.resources.entries<readonly InvEntry[]>('inventory')][0]!;
    const [eid, inv] = settle;
    const tampered = [...inv, { item: 'canned', qty: 7 }] as unknown as readonly InvEntry[];
    world.resources.set('inventory', eid, tampered);
    // Предохранитель обязан заметить расхождение массы с леджером.
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(/canned/);
  });

  it('исчезновение товара со склада БЕЗ item/consumed → assertEconomyInvariant БРОСАЕТ', () => {
    const { world } = buildEcon(42);
    const baseline = worldTotals(world);
    // Имитируем БАГ противоположного знака: масса «испарилась» без леджера.
    const settle = [...world.resources.entries<readonly InvEntry[]>('inventory')][0]!;
    const [eid] = settle;
    world.resources.set('inventory', eid, [] as readonly InvEntry[]);
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(/EconomyInvariant/);
  });

  it('реальная Economy за 30 дней НЕ создаёт/не уничтожает массу вне леджера (не бросает)', () => {
    const { world, scheduler } = buildEcon(42);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY * 30);
    // Контроль-позитив к подлогу выше: та же формула на НЕ тронутом мире — тихо.
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).not.toThrow();
  }, 30000);
});
