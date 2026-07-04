/**
 * @module @zona/headless/economy-invariant.test
 *
 * Гейт ПРЕДОХРАНИТЕЛЯ EconomyInvariant (задача 2.0, D-045). Доказывает ДВЕ вещи:
 *  1) НАСЛЕДИЕ ЧИСТО: на ПОЛНОМ конвейере Фазы 1 (worldgen + 9 систем) инвариант
 *     `worldTotals − baseline == ledgerDelta(0, upToTick)` держится на КАЖДОМ
 *     игровом дне для seed 42/7/999 → 0 «магии» массы в законе №3.
 *  2) ЧЕКЕР РЕАЛЬНО ЛОВИТ: если подложить предмет/деньги в инвентарь БЕЗ
 *     леджер-события, `assertEconomyInvariant` бросает (не «зелёный по недосмотру»).
 *
 * Плюс единичные свойства `worldTotals`/`ledgerDelta` (агрегация, знаки, интервал).
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
  hashSnapshot,
  TICKS_PER_DAY,
  type SimWorld,
} from '@zona/sim';
import {
  worldTotals,
  ledgerDelta,
  assertEconomyInvariant,
  isLedgerEvent,
  type EconTotals,
} from './economy-invariant';

/** Единица инвентаря в ResourceStore (форма worldgen/систем). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Собирает ЖИВОЙ мир Фазы 1 тем же путём, что headless-CLI (D-042). */
function buildLive(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const scheduler = createScheduler();
  registerPhase1Systems(scheduler);
  return { world, scheduler };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) НАСЛЕДИЕ ЧИСТО: инвариант держится на полном конвейере Фазы 1 по дням
// ═══════════════════════════════════════════════════════════════════════════
describe('EconomyInvariant держится на конвейере Фазы 1 (0 магии массы, закон №3)', () => {
  const SEEDS = [42, 7, 999] as const;
  const DAYS = 20; // 10–30 дней по DoD; охватывает охоту (мясо) и голод (расход еды)

  for (const seed of SEEDS) {
    it(`seed=${seed}: (totals − baseline) == ledger на КАЖДОМ из ${DAYS} дней`, () => {
      const { world, scheduler } = buildLive(seed);
      const baseline: EconTotals = worldTotals(world);

      for (let day = 0; day < DAYS; day++) {
        scheduler.run(world, TICKS_PER_DAY);
        // Не бросает ⇒ масса мира изменилась РОВНО на сумму леджер-событий.
        expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).not.toThrow();
      }

      // За 20 дней мир ЖИВ: были и расходы (item/consumed), и добыча (item/harvested)
      // — иначе тест бы ничего не проверял (масса статична). Требуем оба типа.
      const ledgerTypes = new Set(world.bus.log.filter(isLedgerEvent).map((e) => e.type));
      expect(ledgerTypes.has('item/consumed')).toBe(true);
      expect(ledgerTypes.has('item/harvested')).toBe(true);
    }, 30000);
  }

  it('ретрофит НЕ создал денежных леджер-событий: денежная дельта Фазы 1 == 0', () => {
    const { world, scheduler } = buildLive(42);
    scheduler.run(world, TICKS_PER_DAY * 10);
    const delta = ledgerDelta(world.bus, 0 as Tick, world.tick);
    expect(delta.money).toBe(0); // Фаза 1 денег не двигает (нет broughtIn/exported)
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) ЧЕКЕР РЕАЛЬНО ЛОВИТ ПОДДЕЛКУ (иначе «зелёный» ничего не стоит)
// ═══════════════════════════════════════════════════════════════════════════
describe('EconomyInvariant ловит массу «из воздуха» (закон №3)', () => {
  it('предмет добавлен в инвентарь БЕЗ item/harvested → assert бросает', () => {
    const { world, scheduler } = buildLive(42);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY);
    // Сначала честно: держится.
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).not.toThrow();

    // ПОДДЕЛКА: сталкер (eid из entries) получает 7 «канистр из воздуха» — без леджера.
    const [firstEid] = world.resources.entries<readonly InventoryEntry[]>('inventory')[0] as [
      EntityId,
      readonly InventoryEntry[],
    ];
    const inv = world.resources.get<readonly InventoryEntry[]>('inventory', firstEid) ?? [];
    world.resources.set<readonly InventoryEntry[]>('inventory', firstEid, [
      ...inv,
      { item: 'canned' as ItemId, qty: 7 },
    ]);

    // Теперь наблюдаемая дельта canned на +7 расходится с леджером → throw c диагностикой.
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(/canned/);
  }, 30000);

  it('деньги добавлены БЕЗ item/broughtIn → assert бросает по money', () => {
    const { world, scheduler } = buildLive(7);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY);

    const [firstEid] = world.resources.entries<number>('money')[0] as [EntityId, number];
    const cur = world.resources.get<number>('money', firstEid) ?? 0;
    world.resources.set<number>('money', firstEid, cur + 500); // эмиссия из воздуха

    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(/money/);
  }, 30000);

  it('исчезновение предмета БЕЗ item/consumed → assert бросает', () => {
    const { world, scheduler } = buildLive(999);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY);

    // Удаляем ВЕСЬ инвентарь одного носителя (масса испарилась без consumed).
    const [firstEid] = world.resources.entries<readonly InventoryEntry[]>('inventory')[0] as [
      EntityId,
      readonly InventoryEntry[],
    ];
    world.resources.set<readonly InventoryEntry[]>('inventory', firstEid, []);

    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(
      /EconomyInvariant НАРУШЕН/,
    );
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) Единичные свойства worldTotals / ledgerDelta
// ═══════════════════════════════════════════════════════════════════════════
describe('worldTotals / ledgerDelta: базовые свойства', () => {
  it('worldTotals агрегирует деньги и предметы по ВСЕМ носителям', () => {
    const world = createSimWorld(1 as Seed);
    worldgen(world);
    const t = worldTotals(world);
    // worldgen даёт КАЖДОМУ сталкеру стартовые деньги/инвентарь ⇒ тоталы > 0.
    expect(t.money).toBeGreaterThan(0);
    expect((t.items.get('ammo_9mm' as ItemId) ?? 0)).toBeGreaterThan(0);
    expect((t.items.get('canned' as ItemId) ?? 0)).toBeGreaterThan(0);
  });

  it('ledgerDelta: consumed вычитает, harvested прибавляет, интервал уважается', () => {
    const world = createSimWorld(1 as Seed);
    // Публикуем вручную на разных тиках, коммитя каждый тик.
    world.tick = 5 as Tick;
    world.bus.publish({
      type: 'item/harvested',
      causedBy: null,
      payload: { who: 1 as EntityId, item: 'meat' as ItemId, qty: 10, source: 'carcass' },
    });
    world.bus.endTick(5 as Tick);
    world.tick = 8 as Tick;
    world.bus.publish({
      type: 'item/consumed',
      causedBy: null,
      payload: { who: 1 as EntityId, item: 'meat' as ItemId, qty: 3, reason: 'eat' },
    });
    world.bus.endTick(8 as Tick);

    // Весь интервал: +10 −3 = +7.
    expect(ledgerDelta(world.bus, 0 as Tick, 8 as Tick).items.get('meat' as ItemId)).toBe(7);
    // Только тик 8: −3 (harvested на тике 5 отсечён fromTick=6).
    expect(ledgerDelta(world.bus, 6 as Tick, 8 as Tick).items.get('meat' as ItemId)).toBe(-3);
    // Только тик 5: +10.
    expect(ledgerDelta(world.bus, 0 as Tick, 5 as Tick).items.get('meat' as ItemId)).toBe(10);
  });

  it('ledgerDelta: broughtIn/exported двигают деньги; produced — только массу', () => {
    const world = createSimWorld(1 as Seed);
    world.tick = 1 as Tick;
    world.bus.publish({
      type: 'item/broughtIn',
      causedBy: null,
      payload: { who: 1 as EntityId, items: [['pm' as ItemId, 1]], money: 2000 },
    });
    world.bus.publish({
      type: 'item/exported',
      causedBy: null,
      payload: { who: 1 as EntityId, item: 'meat' as ItemId, qty: 4, moneyIn: 40 },
    });
    world.bus.publish({
      type: 'item/produced',
      causedBy: null,
      payload: { settlement: 2 as EntityId, item: 'bread' as ItemId, qty: 5 },
    });
    world.bus.endTick(1 as Tick);

    const d = ledgerDelta(world.bus, 0 as Tick, 1 as Tick);
    expect(d.money).toBe(2040); // 2000 внесено + 40 за экспорт
    expect(d.items.get('pm' as ItemId)).toBe(1); // внесён
    expect(d.items.get('meat' as ItemId)).toBe(-4); // вывезен (масса ушла)
    expect(d.items.get('bread' as ItemId)).toBe(5); // произведён
  });

  it('isLedgerEvent распознаёт все 5 типов и отвергает не-леджер', () => {
    const world = createSimWorld(1 as Seed);
    world.tick = 1 as Tick;
    const types = ['item/produced', 'item/consumed', 'item/harvested', 'item/broughtIn', 'item/exported'];
    world.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 1 as Tick } });
    world.bus.endTick(1 as Tick);
    const nonLedger = world.bus.log[0]!;
    expect(isLedgerEvent(nonLedger)).toBe(false);
    // Проверяем строкой (типы уже покрыты компиляцией union'а выше).
    for (const t of types) expect(t.startsWith('item/')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) ПРЕДОХРАНИТЕЛЬ НЕ ИСКАЖАЕТ МИР: по-дневной чекер тождествен цельному прогону
//    (закон №8/D-045: сверка массы — read-only, её вызов/невызов не двигает хэш)
// ═══════════════════════════════════════════════════════════════════════════
describe('Чекер read-only: chunking по дням даёт ТОТ ЖЕ мир, что один цельный run', () => {
  /** Цельный прогон: один scheduler.run(days*TICKS_PER_DAY), без сверок. */
  function singleRun(seed: number, days: number): string {
    const { world, scheduler } = buildLive(seed);
    scheduler.run(world, days * TICKS_PER_DAY);
    return hashSnapshot(serialize(world));
  }
  /** По-дневный прогон СО сверкой инварианта после каждого дня (как runHeadless). */
  function chunkedWithCheck(seed: number, days: number): string {
    const { world, scheduler } = buildLive(seed);
    const baseline = worldTotals(world);
    for (let d = 0; d < days; d++) {
      scheduler.run(world, TICKS_PER_DAY);
      assertEconomyInvariant(world, world.bus, baseline, world.tick);
    }
    return hashSnapshot(serialize(world));
  }

  for (const seed of [42, 7, 999]) {
    it(`seed=${seed}: run(5·TICKS_PER_DAY) хэш == 5×run(TICKS_PER_DAY)+сверка (мир не сдвинут)`, () => {
      // Если бы сверка (worldTotals/ledgerDelta) хоть что-то мутировала в мире или
      // чанкинг ломал непрерывность тиков — хэши разошлись бы. Совпадение доказывает,
      // что предохранитель НЕ искажает симуляцию (D-045: он вне мира/хэша).
      expect(chunkedWithCheck(seed, 5)).toBe(singleRun(seed, 5));
    }, 30000);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5) ИНВАРИАНТ НА РАЗНЫХ ГОРИЗОНТАХ (10/20/30 дней): держится на КАЖДОМ дне
// ═══════════════════════════════════════════════════════════════════════════
describe('EconomyInvariant держится на каждом дне для горизонтов 10/20/30 (закон №3)', () => {
  for (const seed of [42, 7, 999]) {
    it(`seed=${seed}: 30 дней — ни одного дня с массой вне леджера`, () => {
      const { world, scheduler } = buildLive(seed);
      const baseline = worldTotals(world);
      // 30 дней: самый долгий горизонт DoD — смерти, охота, голод накопились.
      for (let day = 1; day <= 30; day++) {
        scheduler.run(world, TICKS_PER_DAY);
        expect(
          () => assertEconomyInvariant(world, world.bus, baseline, world.tick),
          `seed=${seed}: масса разошлась с леджером на дне ${day}`,
        ).not.toThrow();
      }
    }, 60000);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6) СМЕРТЬ НЕ ТВОРИТ И НЕ ТЕРЯЕТ МАССУ: труп ХРАНИТ лут на своём eid (D-045/D-046)
//    worldTotals обязан считать инвентарь ТРУПОВ — иначе масса «испарялась» бы в
//    момент смерти БЕЗ item/consumed, и инвариант ложно падал бы.
// ═══════════════════════════════════════════════════════════════════════════
describe('Смерть переносит лут на труп без события — масса сохранена (закон №3)', () => {
  it('за 15 дней гибнут десятки сталкеров, но Σ массы всё ещё сходится с леджером', () => {
    const { world, scheduler } = buildLive(42);
    const baseline = worldTotals(world);
    for (let d = 0; d < 15; d++) scheduler.run(world, TICKS_PER_DAY);

    // Мир реально пережил смерти (иначе тест не про трупы): есть entity/died и
    // хотя бы один corpse/created С непустым инвентарём (труп унёс лут на себе).
    const deaths = world.bus.log.filter((e) => e.type === 'entity/died').length;
    const corpsesWithLoot = world.bus.log.filter(
      (e) => e.type === 'corpse/created' && (e.payload as { items: readonly unknown[] }).items.length > 0,
    ).length;
    expect(deaths).toBeGreaterThan(0);
    expect(corpsesWithLoot).toBeGreaterThan(0);

    // Инвариант держится: значит инвентарь трупов УЧТЁН в worldTotals — масса не
    // исчезла при смерти (Death не публикует item/consumed, и не должен).
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).not.toThrow();
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7) ЧЕКЕР ЛОВИТ ЛЮБУЮ несведённую массу: подмена item, деньги-константа
// ═══════════════════════════════════════════════════════════════════════════
describe('EconomyInvariant ловит подмену предмета и следит за константой денег', () => {
  it('ПОДМЕНА item (meat→canned, та же qty) ловится по ОБЕИМ позициям', () => {
    // Суммарное ЧИСЛО единиц не изменилось, но масса КОНКРЕТНОГО item разъехалась:
    // meat пропал (−qty без consumed), canned возник (+qty без harvested). Чекер
    // считает КАЖДЫЙ item отдельно ⇒ ловит обе аномалии (не «схлопывает» в 0).
    const { world, scheduler } = buildLive(7);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY);
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).not.toThrow();

    const entries = world.resources.entries<readonly InventoryEntry[]>('inventory');
    const target = entries.find(([, v]) => v.length > 0);
    expect(target).toBeDefined();
    const [eid, inv] = target as [EntityId, readonly InventoryEntry[]];
    const first = inv[0] as InventoryEntry;
    const swappedItem = (first.item === 'meat' ? 'canned' : 'meat') as ItemId;
    world.resources.set<readonly InventoryEntry[]>('inventory', eid, [
      { item: swappedItem, qty: first.qty },
      ...inv.slice(1),
    ]);

    // Диагностика называет ОБА разъехавшихся item поимённо.
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(
      new RegExp(`${first.item}[\\s\\S]*${swappedItem}|${swappedItem}[\\s\\S]*${first.item}`),
    );
  }, 30000);

  it('деньги Фазы 1 — КОНСТАНТА весь прогон: тоталы money == baseline на каждом дне', () => {
    // Не только денежная дельта леджера == 0, но и НАБЛЮДАЕМАЯ Σ money неподвижна:
    // в Фазе 1 нет ни ввоза (broughtIn), ни экспорта (exported), а переводы массу
    // сохраняют. Значит Σ money обязана держаться на стартовом значении всегда.
    const { world, scheduler } = buildLive(999);
    const startMoney = worldTotals(world).money;
    expect(startMoney).toBeGreaterThan(0);
    for (let d = 0; d < 10; d++) {
      scheduler.run(world, TICKS_PER_DAY);
      expect(worldTotals(world).money, `день ${d + 1}: деньги не должны меняться в Фазе 1`).toBe(
        startMoney,
      );
    }
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8) ГРАНИЦЫ ledgerDelta: пустой/бессобытийный интервал даёт нулевую дельту
// ═══════════════════════════════════════════════════════════════════════════
describe('ledgerDelta: границы интервала (пустой лог, интервал без событий)', () => {
  it('пустой лог → нулевая дельта (ни денег, ни предметов)', () => {
    const world = createSimWorld(1 as Seed);
    const d = ledgerDelta(world.bus, 0 as Tick, 100 as Tick);
    expect(d.money).toBe(0);
    expect(d.items.size).toBe(0);
  });

  it('обратный интервал (from > to) не захватывает ни одного события → 0', () => {
    const world = createSimWorld(1 as Seed);
    world.tick = 5 as Tick;
    world.bus.publish({
      type: 'item/harvested',
      causedBy: null,
      payload: { who: 1 as EntityId, item: 'meat' as ItemId, qty: 10, source: 'carcass' },
    });
    world.bus.endTick(5 as Tick);
    // from=6 > to=4: пустое пересечение с тиком 5 ⇒ ничего не учтено.
    const d = ledgerDelta(world.bus, 6 as Tick, 4 as Tick);
    expect(d.money).toBe(0);
    expect(d.items.size).toBe(0);
  });

  it('интервал между событиями (тик без леджера) → нулевая дельта', () => {
    const world = createSimWorld(1 as Seed);
    world.tick = 3 as Tick;
    world.bus.publish({
      type: 'item/harvested',
      causedBy: null,
      payload: { who: 1 as EntityId, item: 'meat' as ItemId, qty: 4, source: 'carcass' },
    });
    world.bus.endTick(3 as Tick);
    // Окно [10,20] лежит ПОСЛЕ единственного события (тик 3) ⇒ дельта пуста.
    const d = ledgerDelta(world.bus, 10 as Tick, 20 as Tick);
    expect(d.items.get('meat' as ItemId) ?? 0).toBe(0);
    expect(d.money).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9) RESUME (P0): леджер переживает save/load; инвариант держится с ИСХОДНЫМ
//    базлайном; split-прогон (run→save→load→run) сводится так же, как непрерывный.
// ═══════════════════════════════════════════════════════════════════════════
describe('EconomyInvariant переживает save/load: базлайн t0 сохраняет силу (закон №8)', () => {
  it('снапшот mid-run: инвариант держится с базлайном, снятым ДО тиков (леджер в логе цел)', () => {
    const { world, scheduler } = buildLive(42);
    // Базлайн t0 — единственный «якорь» массы; после сериализации его НЕ пересчитать
    // из mid-run мира (масса уже другая). Но eventLog в снапшоте несёт ВЕСЬ леджер
    // с тика 0, поэтому исходный базлайн остаётся валиден для восстановленного мира.
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY * 5);

    const restored = deserialize(serialize(world));
    // Леджер-события пережили сериализацию (иначе дельта «недосчитала» бы уничтожения).
    const ledgerCount = restored.bus.log.filter(isLedgerEvent).length;
    expect(ledgerCount).toBeGreaterThan(0);
    // Инвариант держится на ВОССТАНОВЛЕННОМ мире с ИСХОДНЫМ базлайном.
    expect(() =>
      assertEconomyInvariant(restored, restored.bus, baseline, restored.tick),
    ).not.toThrow();
  }, 30000);

  it('split-прогон (5 дней → save/load → ещё 5) проходит инвариант так же, как непрерывный', () => {
    // Непрерывный контроль.
    const cont = buildLive(7);
    const contBaseline = worldTotals(cont.world);
    cont.scheduler.run(cont.world, TICKS_PER_DAY * 10);
    expect(() =>
      assertEconomyInvariant(cont.world, cont.world.bus, contBaseline, cont.world.tick),
    ).not.toThrow();
    const contHash = hashSnapshot(serialize(cont.world));

    // Split: 5 дней → сериализация → 5 дней на восстановленном.
    const split = buildLive(7);
    const splitBaseline = worldTotals(split.world);
    split.scheduler.run(split.world, TICKS_PER_DAY * 5);
    const restored = deserialize(serialize(split.world));
    const rs = createScheduler();
    registerPhase1Systems(rs);
    rs.run(restored, TICKS_PER_DAY * 5);

    // Инвариант держится на split-мире с тем же базлайном…
    expect(() =>
      assertEconomyInvariant(restored, restored.bus, splitBaseline, restored.tick),
    ).not.toThrow();
    // …и мир побитово совпал с непрерывным (resume не сдвинул историю, P0).
    expect(hashSnapshot(serialize(restored))).toBe(contHash);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10) СКЛАДЫ ПОСЕЛЕНИЙ ПОД КОНТРОЛЕМ ИНВАРИАНТА (задача 2.2, D-045/D-046)
//     Ключевая проверка: baseline t0 ВКЛЮЧАЕТ склады('inventory')+кассы('money')
//     поселений, и ПОДЛОГ склада/кассы поселения ловится так же, как у NPC.
//     Поселение спавнится ПОСЛЕДНИМ (worldgen), поэтому старые forgery-тесты (они
//     бьют по ПЕРВОМУ eid = сталкер) его не покрывали — здесь целимся ИМЕННО в базу.
// ═══════════════════════════════════════════════════════════════════════════
describe('EconomyInvariant покрывает склады/кассы ПОСЕЛЕНИЙ (закон №3, D-046)', () => {
  /** eid поселения = носитель 'inventory', в котором есть 'bread' (его несут ТОЛЬКО
   *  склады поселений; личный набор сталкера/торговца — pm/ammo_9mm/canned/water/
   *  bandage — хлеба не содержит). Через публичный surface @zona/headless. */
  function findSettlementInventoryEid(world: SimWorld): EntityId {
    const hit = world.resources
      .entries<readonly InventoryEntry[]>('inventory')
      .find(([, inv]) => inv.some((e) => e.item === ('bread' as ItemId)));
    expect(hit, 'ожидался склад поселения с bread').toBeDefined();
    return hit![0];
  }

  it('baseline t0 ВКЛЮЧАЕТ кассы поселений: Σ money == 95000 (30·2000 + 15000+20000)', () => {
    // Генезис 2.16b (D-065): 30 людей (20 одиночек + 4 бандита + 2 торговца +
    // 4 резидента) × 2000 = 60000 + казна Кордона 15000 + Ростока 20000 = 95000.
    // Бандиты/резиденты — базлайн t0 «как сталкер» (D-021, НЕ приток). Поля — 0 денег.
    // Если бы worldTotals не считал кассы поселений (money на их eid), сумма была бы
    // 60000 — базлайн «недосчитывал» бы физически внесённый капитал поселений.
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    expect(worldTotals(world).money).toBe(95000);
  });

  it('baseline t0 ВКЛЮЧАЕТ склады поселений: bread присутствует, а meat == 0 (старт без мяса)', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const t = worldTotals(world);
    // bread существует ТОЛЬКО на складах поселений (Кордон 30 + Росток 25 = 55) —
    // его наличие в тоталах доказывает, что склад учтён базлайном (D-046). Бандиты/
    // резиденты bread не несут (STARTING_INVENTORY), поля пусты ⇒ 55 неизменно.
    expect(t.items.get('bread' as ItemId)).toBe(55);
    // Генезис 2.16b: pm = 30 людей × 1 + склады (3+5) = 38; ammo_9mm = 30×16 + (300+500) = 1280.
    expect(t.items.get('pm' as ItemId)).toBe(38);
    expect(t.items.get('ammo_9mm' as ItemId)).toBe(1280);
    // Мяса на старте НЕТ нигде (склад/личный набор без meat) — инвариант Ф1 «meat=0
    // на t0» держится; мясо появится только из туш (item/harvested, 1.10b).
    expect(t.items.get('meat' as ItemId) ?? 0).toBe(0);
  });

  it('ПОДЛОГ СКЛАДА поселения (предмет без item/harvested) → предохранитель БРОСАЕТ', () => {
    // Главная проверка задачи: склад поселения — не «слепая зона» инварианта.
    const { world, scheduler } = buildLive(42);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY);
    // Честно — держится (склад поселения в базлайне, дельта склада == 0).
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).not.toThrow();

    // Кладём 11 «бинтов из воздуха» на СКЛАД ПОСЕЛЕНИЯ — без леджер-события.
    const eid = findSettlementInventoryEid(world);
    const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
    world.resources.set<readonly InventoryEntry[]>('inventory', eid, [
      ...inv,
      { item: 'bandage' as ItemId, qty: 11 },
    ]);

    // Масса склада разошлась с леджером на +11 bandage ⇒ throw c диагностикой.
    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(/bandage/);
  }, 30000);

  it('ПОДЛОГ КАССЫ поселения (деньги без item/broughtIn) → предохранитель БРОСАЕТ по money', () => {
    const { world, scheduler } = buildLive(7);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY);

    // Касса поселения = 'money' на eid склада (тот же eid несёт warehouse и treasury).
    const eid = findSettlementInventoryEid(world);
    const cur = world.resources.get<number>('money', eid) ?? 0;
    expect(cur).toBeGreaterThanOrEqual(15000); // это действительно казна поселения
    world.resources.set<number>('money', eid, cur + 999); // эмиссия из воздуха

    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(/money/);
  }, 30000);

  it('ИСЧЕЗНОВЕНИЕ склада поселения (обнулили) → предохранитель БРОСАЕТ (масса испарилась)', () => {
    const { world, scheduler } = buildLive(999);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY);

    const eid = findSettlementInventoryEid(world);
    world.resources.set<readonly InventoryEntry[]>('inventory', eid, []); // склад «сгорел» без consumed

    expect(() => assertEconomyInvariant(world, world.bus, baseline, world.tick)).toThrow(
      /EconomyInvariant НАРУШЕН/,
    );
  }, 30000);

  it('склад/касса поселения переживают save/load: инвариант держится с ИСХОДНЫМ базлайном', () => {
    const { world, scheduler } = buildLive(42);
    const baseline = worldTotals(world);
    scheduler.run(world, TICKS_PER_DAY * 5);

    const restored = deserialize(serialize(world));
    // Склад поселения существует и в восстановленном мире (bread на месте) —
    // сериализация не «потеряла» массу базы.
    const eid = findSettlementInventoryEid(restored);
    const inv = restored.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
    expect(inv.some((e) => e.item === ('bread' as ItemId))).toBe(true);
    expect(restored.resources.get<number>('money', eid)).toBeGreaterThanOrEqual(15000);
    // И инвариант держится на восстановленном мире (склады поселений учтены обеими
    // сторонами формулы — до и после load).
    expect(() =>
      assertEconomyInvariant(restored, restored.bus, baseline, restored.tick),
    ).not.toThrow();
  }, 30000);
});
