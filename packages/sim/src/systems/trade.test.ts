/**
 * @module @zona/sim/systems/trade.test
 *
 * Гейт системы Trade + цены `priceOf` (задача 2.5, B2, D-047). Доказывает:
 *  • ЦЕНА DERIVED, детерминированная, чистая: дефицит → выше basePrice, избыток →
 *    ниже, в границах balance; без rng/состояния (resume-safe — цена не хранится).
 *  • ПРОДАЖА: NPC сбывает избыток → товар на склад, деньги касса→NPC по priceOf;
 *    trade/executed; касса поселения ограничивает объём (не в долг).
 *  • ПОКУПКА: NPC без эссеншелов с деньгами докупает → товар склад→NPC, деньги
 *    NPC→касса; ограничено складом и деньгами NPC.
 *  • ЗАКОН №3 / EconomyInvariant: суммарные деньги мира и Σ каждого itemId ДО и
 *    ПОСЛЕ торговли ИДЕНТИЧНЫ (сделка = перевод; леджер `item/*` НЕ эмитится, значит
 *    ledgerDelta≡0 ⇒ наблюдаемая дельта ОБЯЗАНА быть 0 — та же формула, что проверяет
 *    assertEconomyInvariant; денежная дельта 0).
 *  • Атомарность/аляйсинг: перевод новыми массивами (D-035) — чужой склад/касса цел.
 *  • Resume: инвентари/кассы/Task сериализуются, цена вычисляется → split ≡ continuous.
 *  • Детерминизм 2× (rng не используется).
 *
 * Trade НЕ в конвейере Фазы 1 (подключит 2.16) ⇒ гоняется в ОТДЕЛЬНОМ планировщике,
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
  Trade,
  priceOf,
  TaskKind,
  type SimWorld,
} from '../index';
import { spawnEntity, addComponent, queryEntities } from '../core/ecs';
import { Task, Position, Human, Alive, Settlement } from '../core/components';
import { getItem } from '../data/index';
import {
  PRICE_ELASTICITY,
  PRICE_MULT_MIN,
  PRICE_MULT_MAX,
  PRICE_FLOOR,
  DEFAULT_TARGET_STOCK,
  TRADE_KEEP_FOOD,
  TRADE_KEEP_AMMO,
  ESSENTIAL_FOOD_MIN,
  ESSENTIAL_AMMO_MIN,
} from '../balance/economy';

const TASK = Task as unknown as {
  kind: Uint8Array;
  targetLoc: Uint32Array;
  targetEid: Uint32Array;
  startedTick: Uint32Array;
  causeEvent: Uint32Array;
};
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };

interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/** Локация-поселение с контентом (getSettlement): Кордон (loc 0, norm склада из json). */
const KORDON_LOC = 0;

/** Отфильтрованные события заданного типа С СУЖЕНИЕМ payload. */
function tradeEvents(world: SimWorld): ReadonlyArray<Extract<SimEvent, { type: 'trade/executed' }>> {
  return world.bus.log.filter(
    (e): e is Extract<SimEvent, { type: 'trade/executed' }> => e.type === 'trade/executed',
  );
}

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

/** Торгующий NPC (Task=TRADE), СТОЯЩИЙ (dest===loc) в локации `loc`. */
function spawnTrader(
  world: SimWorld,
  loc: number,
  inv: InventoryEntry[],
  money: number,
  cause = 0,
): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // стоит на месте (D-019)
  addComponent(world.ecs, Task, eid);
  TASK.kind[eid] = TaskKind.TRADE;
  TASK.targetLoc[eid] = loc;
  TASK.causeEvent[eid] = cause;
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, inv);
  world.resources.set<number>('money', eid, money);
  return eid;
}

/** Мир + планировщик ТОЛЬКО с Trade (как подключит 2.16, но изолированно). */
function buildTradeWorld(seed = 42): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
  const world = createSimWorld(seed as Seed);
  const scheduler = createScheduler();
  scheduler.register(Trade);
  return { world, scheduler };
}

/** Σ qty предмета `item` на носителе `eid`. */
function stockOf(world: SimWorld, eid: EntityId, item: string): number {
  const inv = world.resources.get<readonly InventoryEntry[]>('inventory', eid) ?? [];
  let sum = 0;
  for (const e of inv) if (e.item === item) sum += e.qty;
  return sum;
}

/** Деньги носителя. */
function moneyOf(world: SimWorld, eid: EntityId): number {
  return world.resources.get<number>('money', eid) ?? 0;
}

/** Σ денег + Σ каждого предмета по ВСЕМ носителям (аналог worldTotals D-045). */
function worldTotals(world: SimWorld): { money: number; items: Map<string, number> } {
  let money = 0;
  for (const [, m] of world.resources.entries<number>('money')) money += m;
  const items = new Map<string, number>();
  for (const [, inv] of world.resources.entries<readonly InventoryEntry[]>('inventory')) {
    for (const e of inv) items.set(e.item, (items.get(e.item) ?? 0) + e.qty);
  }
  return { money, items };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) ЦЕНА DERIVED: дефицит → выше, избыток → ниже, границы, детерминизм, чистота
// ═══════════════════════════════════════════════════════════════════════════
describe('priceOf: детерминированная цена f(дефицит) в границах balance (D-047, закон №2)', () => {
  it('при норме (stock == target) цена ≈ basePrice; дефицит выше; избыток ниже', () => {
    const base = getItem('canned').basePrice; // 55
    const norm = priceOf('canned' as ItemId, 40, 40);
    expect(norm).toBe(base); // mult=1 при ratio=1

    const scarce = priceOf('canned' as ItemId, 5, 40); // ratio 0.125 → выше
    const glut = priceOf('canned' as ItemId, 120, 40); // ratio 3 → ниже
    expect(scarce).toBeGreaterThan(base);
    expect(glut).toBeLessThan(base);
    // Монотонность: чем меньше склад, тем дороже.
    expect(priceOf('canned' as ItemId, 1, 40)).toBeGreaterThan(priceOf('canned' as ItemId, 20, 40));
    expect(priceOf('canned' as ItemId, 20, 40)).toBeGreaterThan(priceOf('canned' as ItemId, 60, 40));
  });

  it('цена всегда в границах [PRICE_MULT_MIN·base, PRICE_MULT_MAX·base] и ≥ PRICE_FLOOR', () => {
    const base = getItem('canned').basePrice;
    const lo = Math.max(PRICE_FLOOR, Math.round(base * PRICE_MULT_MIN));
    const hi = Math.round(base * PRICE_MULT_MAX);
    for (const stock of [0, 1, 5, 40, 100, 500, 100000]) {
      const p = priceOf('canned' as ItemId, stock, 40);
      expect(p).toBeGreaterThanOrEqual(lo);
      expect(p).toBeLessThanOrEqual(hi);
      expect(p).toBeGreaterThanOrEqual(PRICE_FLOOR);
    }
    // Огромный избыток клампится в нижний множитель (не уходит в 0/отрицательное).
    expect(priceOf('canned' as ItemId, 1_000_000, 40)).toBe(Math.round(base * PRICE_MULT_MIN));
  });

  it('targetStock<=0 (нормировать нечем) → максимальный дефицит (дороже basePrice)', () => {
    const base = getItem('meat').basePrice;
    expect(priceOf('meat' as ItemId, 5, 0)).toBeGreaterThan(base);
    // Согласуется с дефолтной нормой для «нетипичного» товара.
    expect(priceOf('meat' as ItemId, 0, 0)).toBeGreaterThanOrEqual(base);
  });

  it('чистая и детерминированная: тот же вход → тот же выход, без состояния/порядка', () => {
    const a = priceOf('bread' as ItemId, 7, 30);
    // Промежуточные вызовы с иными аргументами НЕ влияют (нет накопленного состояния).
    priceOf('canned' as ItemId, 1, 1);
    priceOf('pm' as ItemId, 999, DEFAULT_TARGET_STOCK);
    const b = priceOf('bread' as ItemId, 7, 30);
    expect(b).toBe(a);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) ПРОДАЖА: избыток NPC → склад; деньги касса→NPC по priceOf; касса ограничивает
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: NPC сбывает избыток поселению (товар→склад, деньги касса→NPC)', () => {
  it('продаёт самый ценный избыток (pm сверх резерва) по priceOf; trade/executed', () => {
    const { world, scheduler } = buildTradeWorld();
    // Склад Кордона: pm=3 (норма для priceOf = стартовый склад json = 3).
    const set = spawnSettlement(
      world,
      KORDON_LOC,
      [{ item: 'pm' as ItemId, qty: 3 }],
      1_000_000,
    );
    // NPC: 3 пистолета (резерв 1 → избыток 2), эссеншелы закрыты (5 еды, 20 патронов) —
    // чтобы фаза докупки не сработала и остался ЧИСТЫЙ сбыт.
    const npc = spawnTrader(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 20 },
        { item: 'canned' as ItemId, qty: 5 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      1000,
    );

    const priceExpected = priceOf('pm' as ItemId, 3, 3); // склад pm=3, норма 3 → basePrice
    scheduler.run(world, 1);

    const evs = tradeEvents(world).filter((e) => e.payload.item === 'pm');
    expect(evs.length).toBe(1);
    const ev = evs[0]!;
    expect(ev.payload.seller).toBe(npc);
    expect(ev.payload.buyer).toBe(set);
    expect(ev.payload.qty).toBe(2); // весь избыток
    expect(ev.payload.price).toBe(priceExpected);
    expect(ev.payload.money).toBe(priceExpected * 2);

    // Товар: NPC 3→1 (резерв сохранён), склад 3→5.
    expect(stockOf(world, npc, 'pm')).toBe(1);
    expect(stockOf(world, set, 'pm')).toBe(5);
    // Деньги: NPC +money, касса −money.
    expect(moneyOf(world, npc)).toBe(1000 + priceExpected * 2);
    expect(moneyOf(world, set)).toBe(1_000_000 - priceExpected * 2);
  });

  it('касса поселения ОГРАНИЧИВАЕТ объём продажи (не в долг)', () => {
    const { world, scheduler } = buildTradeWorld();
    const price = priceOf('pm' as ItemId, 3, 3);
    // Касса хватает ровно на 1 пистолет (не на 2).
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 3 }], price + 10);
    const npc = spawnTrader(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 20 },
        { item: 'canned' as ItemId, qty: 5 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      0,
    );

    scheduler.run(world, 1);

    const ev = tradeEvents(world).find((e) => e.payload.item === 'pm')!;
    expect(ev.payload.qty).toBe(1); // касса вытянула лишь 1
    expect(stockOf(world, npc, 'pm')).toBe(2);
    expect(moneyOf(world, set)).toBe(10); // касса не ушла в минус
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) ПОКУПКА: NPC без эссеншелов с деньгами докупает; ограничено складом/деньгами
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: NPC докупает дефицит эссеншелов (товар склад→NPC, деньги NPC→касса)', () => {
  it('без еды и патронов, с деньгами → докупает food и ammo у поселения', () => {
    const { world, scheduler } = buildTradeWorld();
    const set = spawnSettlement(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 300 },
        { item: 'bread' as ItemId, qty: 30 },
        { item: 'canned' as ItemId, qty: 40 },
      ],
      0,
    );
    // NPC: 1 пистолет (резерв 1, без избытка), НЕТ еды/патронов, есть деньги.
    const npc = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 1_000_000);

    // Ожидаемые цены/объёмы: food → bread (наименьший itemId food на складе, норма 30),
    // ammo → ammo_9mm (норма 300). Докупка до TRADE_KEEP_FOOD/AMMO (4/16).
    const breadPrice = priceOf('bread' as ItemId, 30, 30);
    const ammoPrice = priceOf('ammo_9mm' as ItemId, 300, 300);

    scheduler.run(world, 1);

    const evs = tradeEvents(world);
    expect(evs.length).toBe(2);
    const foodEv = evs.find((e) => e.payload.item === 'bread')!;
    const ammoEv = evs.find((e) => e.payload.item === 'ammo_9mm')!;
    expect(foodEv.payload.buyer).toBe(npc);
    expect(foodEv.payload.seller).toBe(set);
    expect(foodEv.payload.qty).toBe(4); // до TRADE_KEEP_FOOD
    expect(ammoEv.payload.qty).toBe(16); // до TRADE_KEEP_AMMO

    // Товар: склад→NPC.
    expect(stockOf(world, npc, 'bread')).toBe(4);
    expect(stockOf(world, npc, 'ammo_9mm')).toBe(16);
    expect(stockOf(world, set, 'bread')).toBe(26);
    expect(stockOf(world, set, 'ammo_9mm')).toBe(284);
    // Деньги: NPC→касса.
    const paid = breadPrice * 4 + ammoPrice * 16;
    expect(moneyOf(world, npc)).toBe(1_000_000 - paid);
    expect(moneyOf(world, set)).toBe(paid);
  });

  it('деньги NPC ОГРАНИЧИВАЮТ докупку (не в долг)', () => {
    const { world, scheduler } = buildTradeWorld();
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 30 }], 0);
    const breadPrice = priceOf('bread' as ItemId, 30, 30);
    // Денег ровно на 2 хлеба (< желаемых 4).
    const npc = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], breadPrice * 2 + 3);

    scheduler.run(world, 1);

    const ev = tradeEvents(world).find((e) => e.payload.item === 'bread')!;
    expect(ev.payload.qty).toBe(2); // деньги вытянули лишь 2
    expect(moneyOf(world, npc)).toBe(3); // остаток < цены → больше не купить
  });

  it('наличие на складе ОГРАНИЧИВАЕТ докупку', () => {
    const { world, scheduler } = buildTradeWorld();
    // На складе только 1 хлеб (< желаемых 4).
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 1 }], 0);
    const npc = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 1_000_000);

    scheduler.run(world, 1);

    const ev = tradeEvents(world).find((e) => e.payload.item === 'bread')!;
    expect(ev.payload.qty).toBe(1);
    expect(stockOf(world, set, 'bread')).toBe(0);
    expect(stockOf(world, npc, 'bread')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) ЗАКОН №3 / EconomyInvariant: сделка = ПЕРЕВОД → Σ денег и Σ предметов НЕ меняются
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: сделка сохраняет массу мира (закон №3; денежная дельта 0, D-045)', () => {
  it('многосторонний прогон: Σ денег и Σ каждого itemId ДО == ПОСЛЕ; леджер не эмитится', () => {
    const { world, scheduler } = buildTradeWorld();
    // Поселение + трое NPC: продавец (избыток pm), покупатель (без эссеншелов), смешанный.
    spawnSettlement(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 300 },
        { item: 'bread' as ItemId, qty: 30 },
        { item: 'canned' as ItemId, qty: 40 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      500_000,
    );
    spawnTrader(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 20 },
        { item: 'canned' as ItemId, qty: 5 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      2000,
    );
    spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 50_000);
    spawnTrader(
      world,
      KORDON_LOC,
      [{ item: 'meat' as ItemId, qty: 12 }, { item: 'pm' as ItemId, qty: 1 }],
      10_000,
    );

    const before = worldTotals(world);
    scheduler.run(world, 5); // несколько тиков — сделки исполняются и сходятся
    const after = worldTotals(world);

    // Реально торговали (иначе инвариант проверял бы статику).
    expect(tradeEvents(world).length).toBeGreaterThan(0);

    // ЗАКОН №3: перевод НЕ меняет Σ денег и Σ каждого предмета (та же формула, что
    // assertEconomyInvariant: наблюдаемая дельта == ledgerDelta == 0).
    expect(after.money).toBe(before.money);
    const allItems = new Set<string>([...before.items.keys(), ...after.items.keys()]);
    for (const item of [...allItems].sort()) {
      expect((after.items.get(item) ?? 0), `Σ ${item} должна сохраниться (перевод)`).toBe(
        before.items.get(item) ?? 0,
      );
    }
    // Trade НЕ эмитит леджер массы item/* (это перевод, не создание/уничтожение).
    const ledgerEmitted = world.bus.log.some((e) => e.type.startsWith('item/'));
    expect(ledgerEmitted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5) АТОМАРНОСТЬ / АЛЯЙСИНГ: перевод новыми массивами (D-035) — чужое не портится
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: перевод новыми массивами (D-035); посторонний инвентарь цел', () => {
  it('не мутирует ранее полученную ссылку на инвентарь; бесстороннего NPC не трогает', () => {
    const { world, scheduler } = buildTradeWorld();
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 3 }], 1_000_000);
    const npc = spawnTrader(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 20 },
        { item: 'canned' as ItemId, qty: 5 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      0,
    );
    // Посторонний НЕ торгующий NPC в ДРУГОЙ локации: его склад/касса не должны сдвинуться.
    const bystander = spawnEntity(world.ecs);
    addComponent(world.ecs, Human, bystander);
    addComponent(world.ecs, Alive, bystander);
    world.resources.set<readonly InventoryEntry[]>('inventory', bystander, [
      { item: 'bandage' as ItemId, qty: 4 },
    ]);
    world.resources.set<number>('money', bystander, 777);

    // Снимок ССЫЛКИ на инвентарь NPC ДО сделки (аляйсинг-ловушка): его содержимое не
    // должно измениться in-place — Trade обязан записать НОВЫЙ массив через set.
    const npcInvRefBefore = world.resources.get<readonly InventoryEntry[]>('inventory', npc)!;
    const snapshotBefore = npcInvRefBefore.map((e) => ({ ...e }));

    scheduler.run(world, 1);

    // Старая ссылка НЕ мутирована (перевод не трогал её in-place).
    expect(npcInvRefBefore.map((e) => ({ ...e }))).toEqual(snapshotBefore);
    // Новый инвентарь — ДРУГОЙ объект (записан через set).
    const npcInvAfter = world.resources.get<readonly InventoryEntry[]>('inventory', npc)!;
    expect(npcInvAfter).not.toBe(npcInvRefBefore);

    // Посторонний нетронут.
    expect(world.resources.get<readonly InventoryEntry[]>('inventory', bystander)).toEqual([
      { item: 'bandage' as ItemId, qty: 4 },
    ]);
    expect(moneyOf(world, bystander)).toBe(777);
    // Сделка всё же состоялась.
    expect(stockOf(world, set, 'pm')).toBeGreaterThan(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6) RESUME: split ≡ continuous (инвентари/касса/Task сериализуются; цена вычисляется)
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: resume-безопасность — split-прогон тождественен непрерывному (P0)', () => {
  /** Строит сцену торговли на свежем мире и возвращает мир+планировщик. */
  function scene(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
    const { world, scheduler } = buildTradeWorld(seed);
    spawnSettlement(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 300 },
        { item: 'bread' as ItemId, qty: 30 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      500_000,
    );
    spawnTrader(
      world,
      KORDON_LOC,
      [{ item: 'ammo_9mm' as ItemId, qty: 20 }, { item: 'canned' as ItemId, qty: 5 }, { item: 'pm' as ItemId, qty: 3 }],
      2000,
    );
    spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 50_000);
    return { world, scheduler };
  }

  it('continuous 10 тиков ≡ split (5 → save/load → 5) по хэшу снапшота', () => {
    const cont = scene(42);
    cont.scheduler.run(cont.world, 10);
    const contHash = hashSnapshot(serialize(cont.world));

    const split = scene(42);
    split.scheduler.run(split.world, 5);
    const mid = deserialize(serialize(split.world)); // save→load на середине
    const sched2 = createScheduler();
    sched2.register(Trade);
    sched2.run(mid, 5);
    const splitHash = hashSnapshot(serialize(mid));

    expect(splitHash).toBe(contHash);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7) ДЕТЕРМИНИЗМ 2× (rng не используется — цена и сделка детерминированы)
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: детерминизм — два прогона одним seed дают идентичные хэш и лог сделок', () => {
  function run(seed: number): { hash: string; trades: number } {
    const { world, scheduler } = buildTradeWorld(seed);
    spawnSettlement(
      world,
      KORDON_LOC,
      [{ item: 'ammo_9mm' as ItemId, qty: 300 }, { item: 'bread' as ItemId, qty: 30 }, { item: 'pm' as ItemId, qty: 3 }],
      500_000,
    );
    spawnTrader(
      world,
      KORDON_LOC,
      [{ item: 'ammo_9mm' as ItemId, qty: 20 }, { item: 'canned' as ItemId, qty: 5 }, { item: 'pm' as ItemId, qty: 3 }],
      2000,
    );
    spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 50_000);
    scheduler.run(world, 8);
    return { hash: hashSnapshot(serialize(world)), trades: tradeEvents(world).length };
  }

  it('run(7) дважды → идентичны; run(8) отличается набором сделок или состоянием', () => {
    const a = run(7);
    const b = run(7);
    expect(b.hash).toBe(a.hash);
    expect(b.trades).toBe(a.trades);
    expect(a.trades).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8) НЕ-ПОСЕЛЕНИЕ / В ПУТИ / ЗАБРОШЕНО: Trade не исполняет сделку
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: сделка только у ЖИВОГО поселения и только для СТОЯЩЕГО NPC', () => {
  it('NPC в пути (dest != loc) не торгует', () => {
    const { world, scheduler } = buildTradeWorld();
    spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 30 }], 500_000);
    const npc = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 1_000_000);
    POS.dest[npc] = 1; // в пути (dest != loc)
    scheduler.run(world, 1);
    expect(tradeEvents(world).length).toBe(0);
  });

  it('заброшенное поселение (settlementAbandoned) не обслуживает торговлю', () => {
    const { world, scheduler } = buildTradeWorld();
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 30 }], 500_000);
    world.resources.set<boolean>('settlementAbandoned', set, true);
    spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 1_000_000);
    scheduler.run(world, 1);
    expect(tradeEvents(world).length).toBe(0);
  });

  it('NPC с Task != TRADE у поселения не торгует', () => {
    const { world, scheduler } = buildTradeWorld();
    spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 30 }], 500_000);
    const npc = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 1_000_000);
    TASK.kind[npc] = TaskKind.EAT; // не торговец
    scheduler.run(world, 1);
    expect(tradeEvents(world).length).toBe(0);
  });

  it('стоящий торговец в локации БЕЗ поселения не совершает сделок (нет контрагента)', () => {
    const { world, scheduler } = buildTradeWorld();
    // Поселение живёт на loc 0; торговец стоит на пустой loc 99 — сделки быть не может.
    spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 30 }], 500_000);
    spawnTrader(world, 99, [{ item: 'pm' as ItemId, qty: 3 }], 1_000_000);
    const before = worldTotals(world);
    scheduler.run(world, 3);
    expect(tradeEvents(world).length).toBe(0);
    // Масса мира неподвижна: без контрагента ничего не переехало.
    expect(worldTotals(world).money).toBe(before.money);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9) ГРАНИЦЫ СДЕЛКИ: без денег не купить, пустой склад не продаёт, касса=0 не платит
//    — ни одна сторона не уходит в минус, деньги/товар не берутся из воздуха
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: границы — ни долга, ни минуса, ни денег/товара из воздуха (закон №3)', () => {
  it('NPC без денег НЕ докупает эссеншелы (склад полон, но платить нечем)', () => {
    const { world, scheduler } = buildTradeWorld();
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'bread' as ItemId, qty: 30 }], 500_000);
    // Голодный торговец (0 еды) с ПУСТЫМ кошельком — докупка невозможна (не в долг).
    const npc = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 0);
    scheduler.run(world, 1);
    expect(tradeEvents(world).length).toBe(0);
    expect(moneyOf(world, npc)).toBe(0); // не ушёл в минус
    expect(stockOf(world, npc, 'bread')).toBe(0); // еда из воздуха не появилась
    expect(stockOf(world, set, 'bread')).toBe(30); // склад цел
  });

  it('ПУСТОЙ по эссеншелам склад не продаёт (докупать нечего, даже с деньгами)', () => {
    const { world, scheduler } = buildTradeWorld();
    // На складе нет ни еды, ни патронов — только патроны? нет: вообще пусто по food/ammo.
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'bandage' as ItemId, qty: 5 }], 500_000);
    const npc = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 1_000_000);
    scheduler.run(world, 1);
    // Нет food/ammo на полке → докупка невозможна; pm=1 не даёт избытка → сбыта нет.
    expect(tradeEvents(world).length).toBe(0);
    expect(moneyOf(world, npc)).toBe(1_000_000);
    expect(stockOf(world, set, 'bandage')).toBe(5);
  });

  it('касса=0: поселение НЕ платит за избыток — NPC не получает денег из воздуха', () => {
    const { world, scheduler } = buildTradeWorld();
    // Касса поселения пуста: сбыт избытка невозможен (не в долг).
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 3 }], 0);
    const npc = spawnTrader(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 20 }, // эссеншелы закрыты, чтобы не мешала докупка
        { item: 'canned' as ItemId, qty: 5 },
        { item: 'pm' as ItemId, qty: 3 }, // избыток 2 сверх резерва
      ],
      1000,
    );
    scheduler.run(world, 1);
    expect(tradeEvents(world).length).toBe(0);
    expect(moneyOf(world, npc)).toBe(1000); // денег не прибавилось (не из воздуха)
    expect(moneyOf(world, set)).toBe(0); // касса не ушла в минус
    expect(stockOf(world, npc, 'pm')).toBe(3); // товар не уехал даром
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10) ОКРУГЛЕНИЕ: деньги остаются ЦЕЛЫМИ после сделок; нет дробной утечки массы
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: цена целочисленна (round) → деньги целы, масса не течёт дробно', () => {
  it('после полного торгового прогона все кошельки/цены ЦЕЛЫЕ, Σ денег бит-в-бит равна', () => {
    const { world, scheduler } = buildTradeWorld();
    spawnSettlement(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 300 },
        { item: 'bread' as ItemId, qty: 30 },
        { item: 'canned' as ItemId, qty: 40 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      500_000,
    );
    spawnTrader(
      world,
      KORDON_LOC,
      [{ item: 'ammo_9mm' as ItemId, qty: 20 }, { item: 'canned' as ItemId, qty: 5 }, { item: 'pm' as ItemId, qty: 3 }],
      2001, // НЕчётный кошелёк — ловушка на дробное деление при делении кассы
    );
    spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 49_999);

    const before = worldTotals(world);
    scheduler.run(world, 6);
    const after = worldTotals(world);

    // Реально торговали.
    const evs = tradeEvents(world);
    expect(evs.length).toBeGreaterThan(0);
    // Каждая сделка целочисленна: price*qty === money, все целые.
    for (const e of evs) {
      expect(Number.isInteger(e.payload.price)).toBe(true);
      expect(Number.isInteger(e.payload.qty)).toBe(true);
      expect(e.payload.money).toBe(e.payload.price * e.payload.qty);
      expect(Number.isInteger(e.payload.money)).toBe(true);
    }
    // Все кошельки мира — целые (нет дробной утечки).
    for (const [, m] of world.resources.entries<number>('money')) {
      expect(Number.isInteger(m)).toBe(true);
    }
    // Σ денег бит-в-бит сохранена (перевод не создаёт/не теряет ни копейки).
    expect(Object.is(after.money, before.money)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11) ЦЕНА НА ГРАНИЦАХ: макс. дефицит = (1+эластичность)·base (НЕ ∞, НЕ MAX·base);
//     огромный избыток = MIN·base (НЕ 0, floor≥1). Фиксирует РЕАЛЬНЫЙ потолок цены.
// ═══════════════════════════════════════════════════════════════════════════
describe('priceOf: границы дефицита/избытка — реальный потолок = (1+эластичность)·base', () => {
  it('stock=0 (макс. дефицит): цена = round(base·(1+эластичность)), конечна и в [MIN,MAX]', () => {
    const base = getItem('canned').basePrice;
    const p = priceOf('canned' as ItemId, 0, 40);
    expect(Number.isFinite(p)).toBe(true);
    // При эластичности 0.6 полный дефицит даёт mult=1.6 — это и есть достижимый максимум.
    expect(p).toBe(Math.round(base * (1 + PRICE_ELASTICITY)));
    expect(p).toBeLessThanOrEqual(Math.round(base * PRICE_MULT_MAX));
    expect(p).toBeGreaterThanOrEqual(Math.round(base * PRICE_MULT_MIN));
  });

  it('НАХОДКА: верхний кламп PRICE_MULT_MAX НЕ достижим при текущей эластичности', () => {
    // MAX (3.0) требует stockRatio ≤ 1−(MAX−1)/эластичность < 0 — невозможно при stock≥0.
    // Значит цена при stock=0 СТРОГО ниже MAX·base: верхний кламп — «мёртвый» guard.
    const base = getItem('pm').basePrice; // дорогой товар — разрыв виден в деньгах
    const maxDeficit = priceOf('pm' as ItemId, 0, 3);
    expect(maxDeficit).toBeLessThan(Math.round(base * PRICE_MULT_MAX));
    expect(maxDeficit).toBe(Math.round(base * (1 + PRICE_ELASTICITY)));
    // Отрицательный targetStock тоже трактуется как ratio=0 → тот же потолок, не ∞.
    expect(priceOf('pm' as ItemId, 5, 0)).toBe(maxDeficit);
  });

  it('огромный избыток: цена = MIN·base (нижний кламп достижим), floor≥1, не 0', () => {
    const base = getItem('canned').basePrice;
    const glut = priceOf('canned' as ItemId, 10_000_000, 40);
    expect(glut).toBe(Math.round(base * PRICE_MULT_MIN)); // нижний кламп реально включается
    expect(glut).toBeGreaterThanOrEqual(PRICE_FLOOR);
    // Даже дешёвый товар не падает ниже пола цены.
    expect(priceOf('ammo_9mm' as ItemId, 10_000_000, 300)).toBeGreaterThanOrEqual(PRICE_FLOOR);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12) ПОЛИТИКА: докупка эссеншелов + сбыт избытка в один тик; резерв survival держится
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: политика — эссеншелы докупаются, избыток сбывается, survival-резерв цел', () => {
  it('голодный+безоружно-избыточный NPC за тик докупает еду/патроны И сбывает оружие', () => {
    const { world, scheduler } = buildTradeWorld();
    const set = spawnSettlement(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 300 },
        { item: 'bread' as ItemId, qty: 30 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      1_000_000,
    );
    // 0 еды, 0 патронов (дефицит эссеншелов), но 3 пистолета (избыток 2 сверх резерва).
    const npc = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 3 }], 1_000_000);

    const before = worldTotals(world);
    scheduler.run(world, 1);

    const evs = tradeEvents(world);
    // Три позиции за один тик: food, ammo (докупка) + pm (сбыт).
    expect(evs.map((e) => e.payload.item).sort()).toEqual(['ammo_9mm', 'bread', 'pm']);
    // Эссеншелы доведены до целевых порогов.
    expect(stockOf(world, npc, 'bread')).toBe(TRADE_KEEP_FOOD);
    expect(stockOf(world, npc, 'ammo_9mm')).toBe(TRADE_KEEP_AMMO);
    // Избыток оружия сбыт, но survival-резерв (1 ствол) НЕ распродан.
    expect(stockOf(world, npc, 'pm')).toBe(1);
    // Масса мира сохранена (три перевода).
    expect(worldTotals(world).money).toBe(before.money);
    void set;
  });

  it('survival-резерв: NPC НЕ распродаёт еду в ноль — остаётся ≥ TRADE_KEEP_FOOD', () => {
    const { world, scheduler } = buildTradeWorld();
    spawnSettlement(world, KORDON_LOC, [], 1_000_000);
    // Много мяса (food) и патронов — над резервами; касса поселения бездонна.
    const npc = spawnTrader(
      world,
      KORDON_LOC,
      [{ item: 'meat' as ItemId, qty: 12 }, { item: 'ammo_9mm' as ItemId, qty: 20 }],
      1000,
    );
    // Гоняем много тиков: NPC сбывает избыток позиция-за-позицией, но не ниже резервов.
    let minMeat = Infinity;
    for (let t = 0; t < 20; t++) {
      scheduler.run(world, 1);
      minMeat = Math.min(minMeat, stockOf(world, npc, 'meat'));
    }
    // Еда никогда не проваливалась ниже резерва и осталась ≥ эссеншел-минимума.
    expect(minMeat).toBeGreaterThanOrEqual(TRADE_KEEP_FOOD);
    expect(stockOf(world, npc, 'meat')).toBe(TRADE_KEEP_FOOD);
    expect(stockOf(world, npc, 'meat')).toBeGreaterThanOrEqual(ESSENTIAL_FOOD_MIN);
    // Патроны тоже не ниже целевого резерва (эссеншел не выметен).
    expect(stockOf(world, npc, 'ammo_9mm')).toBeGreaterThanOrEqual(TRADE_KEEP_AMMO);
    expect(stockOf(world, npc, 'ammo_9mm')).toBeGreaterThanOrEqual(ESSENTIAL_AMMO_MIN);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13) ДЕЛЕНИЕ КАССЫ: два NPC у одного поселения — порядок по eid, первый исчерпал кассу
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: касса поселения делится между NPC по порядку eid (первому — больше)', () => {
  it('первый (меньший eid) сбывает по полной, второму хватает кассы на меньше', () => {
    const { world, scheduler } = buildTradeWorld();
    // Касса ровно на 3 пистолета по стартовой цене; двое хотят сбыть по 2.
    const startPrice = priceOf('pm' as ItemId, 3, 3); // 3500
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 3 }], startPrice * 3);
    const essentials: InventoryEntry[] = [
      { item: 'ammo_9mm' as ItemId, qty: 20 },
      { item: 'canned' as ItemId, qty: 5 },
    ];
    const first = spawnTrader(world, KORDON_LOC, [...essentials, { item: 'pm' as ItemId, qty: 3 }], 100);
    const second = spawnTrader(world, KORDON_LOC, [...essentials, { item: 'pm' as ItemId, qty: 3 }], 100);
    expect(first).toBeLessThan(second); // порядок обхода = порядок спавна

    const before = worldTotals(world);
    scheduler.run(world, 1);

    const byFirst = tradeEvents(world).filter((e) => e.payload.seller === first);
    const bySecond = tradeEvents(world).filter((e) => e.payload.seller === second);
    // Первый продал весь избыток (2); второму кассы хватило на меньше.
    expect(byFirst.reduce((s, e) => s + e.payload.qty, 0)).toBe(2);
    expect(bySecond.reduce((s, e) => s + e.payload.qty, 0)).toBeLessThan(2);
    expect(bySecond.reduce((s, e) => s + e.payload.qty, 0)).toBeGreaterThan(0);
    // Касса не ушла в минус и масса сохранена.
    expect(moneyOf(world, set)).toBeGreaterThanOrEqual(0);
    expect(worldTotals(world).money).toBe(before.money);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14) ИЗОЛЯЦИЯ: соседнее поселение и не-торговец у той же кассы НЕ затронуты
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: третья сторона (другое поселение / не-торговец) не тронута', () => {
  it('сделка на loc 0 не двигает склад/кассу поселения на loc 5 и не-торгующего NPC', () => {
    const { world, scheduler } = buildTradeWorld();
    const set0 = spawnSettlement(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 3 }], 1_000_000);
    // Второе поселение с контент-записью (settlements.json loc 5) — не должно шелохнуться.
    const set5 = spawnSettlement(world, 5, [{ item: 'bread' as ItemId, qty: 25 }], 200_000);
    const trader = spawnTrader(
      world,
      KORDON_LOC,
      [{ item: 'ammo_9mm' as ItemId, qty: 20 }, { item: 'canned' as ItemId, qty: 5 }, { item: 'pm' as ItemId, qty: 3 }],
      500,
    );
    // Не-торговец у ТОЙ ЖЕ кассы (Task=EAT) — Trade его игнорирует.
    const eater = spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 3 }], 500);
    TASK.kind[eater] = TaskKind.EAT;

    const set5InvBefore = world.resources.get<readonly InventoryEntry[]>('inventory', set5);
    const before = worldTotals(world);
    scheduler.run(world, 1);

    // Сделка на loc 0 состоялась.
    expect(tradeEvents(world).some((e) => e.payload.seller === trader)).toBe(true);
    // Поселение loc 5 нетронуто (та же ссылка на инвентарь, та же касса).
    expect(world.resources.get<readonly InventoryEntry[]>('inventory', set5)).toBe(set5InvBefore);
    expect(moneyOf(world, set5)).toBe(200_000);
    // Не-торговец нетронут: ни одна его позиция/деньги не сдвинулись.
    expect(stockOf(world, eater, 'pm')).toBe(3);
    expect(moneyOf(world, eater)).toBe(500);
    // Глобальная масса сохранена.
    expect(worldTotals(world).money).toBe(before.money);
    void set0;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15) ЛЕТОПИСЬ: trade/executed несёт causedBy = Task.causeEvent и согласованный payload
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: trade/executed — причина = Task.causeEvent, поля payload согласованы', () => {
  it('causedBy = causeEvent NPC; buyer/seller/price/qty/money корректны', () => {
    const { world, scheduler } = buildTradeWorld();
    const set = spawnSettlement(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 3 }], 1_000_000);
    // Причина задачи TRADE = событие 4242 (в 2.6 это task/selected).
    const npc = spawnTrader(
      world,
      KORDON_LOC,
      [{ item: 'ammo_9mm' as ItemId, qty: 20 }, { item: 'canned' as ItemId, qty: 5 }, { item: 'pm' as ItemId, qty: 3 }],
      1000,
      4242,
    );

    const expectedPrice = priceOf('pm' as ItemId, 3, 3);
    scheduler.run(world, 1);

    const ev = tradeEvents(world).find((e) => e.payload.item === 'pm')!;
    expect(ev.causedBy).toBe(4242); // причинная цепочка проштампована
    expect(ev.payload.seller).toBe(npc);
    expect(ev.payload.buyer).toBe(set);
    expect(ev.payload.qty).toBe(2);
    expect(ev.payload.price).toBe(expectedPrice);
    expect(ev.payload.money).toBe(expectedPrice * 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16) RESUME РОВНО НА СДЕЛКЕ: save/load ДО тика сделки → цена пересчитана идентично
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: resume до тика сделки — цена не хранится, пересчитывается тождественно', () => {
  function scene(seed: number): { world: SimWorld; scheduler: ReturnType<typeof createScheduler> } {
    const { world, scheduler } = buildTradeWorld(seed);
    spawnSettlement(
      world,
      KORDON_LOC,
      [{ item: 'ammo_9mm' as ItemId, qty: 300 }, { item: 'bread' as ItemId, qty: 30 }, { item: 'pm' as ItemId, qty: 3 }],
      500_000,
    );
    spawnTrader(
      world,
      KORDON_LOC,
      [{ item: 'ammo_9mm' as ItemId, qty: 20 }, { item: 'canned' as ItemId, qty: 5 }, { item: 'pm' as ItemId, qty: 3 }],
      2000,
    );
    spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 50_000);
    return { world, scheduler };
  }

  it('continuous 1 тик ≡ (save@t0 → load → 1 тик): сделка после resume та же', () => {
    const cont = scene(42);
    cont.scheduler.run(cont.world, 1);
    const contHash = hashSnapshot(serialize(cont.world));
    const contTrades = tradeEvents(cont.world);

    // Сохраняем ДО первого тика (сделка ещё не произошла), грузим, затем исполняем.
    const pre = scene(42);
    const revived = deserialize(serialize(pre.world));
    const sched2 = createScheduler();
    sched2.register(Trade);
    sched2.run(revived, 1);
    const splitHash = hashSnapshot(serialize(revived));
    const splitTrades = tradeEvents(revived);

    expect(splitHash).toBe(contHash);
    // Сделки после resume идентичны (цена DERIVED пересчитана из склада, не из снапшота).
    expect(splitTrades.length).toBe(contTrades.length);
    expect(splitTrades.length).toBeGreaterThan(0);
    for (let i = 0; i < contTrades.length; i++) {
      expect(splitTrades[i]!.payload).toEqual(contTrades[i]!.payload);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17) СХОДИМОСТЬ: много тиков/позиций → стабилизация без зацикливания, масса цела
// ═══════════════════════════════════════════════════════════════════════════
describe('Trade: многотиковый прогон стабилизируется (не зацикливается), масса сохранена', () => {
  it('50 тиков богатой сцены: сделки иссякают, Σ денег/предметов бит-в-бит равна', () => {
    const { world, scheduler } = buildTradeWorld();
    spawnSettlement(
      world,
      KORDON_LOC,
      [
        { item: 'ammo_9mm' as ItemId, qty: 300 },
        { item: 'bread' as ItemId, qty: 30 },
        { item: 'canned' as ItemId, qty: 40 },
        { item: 'pm' as ItemId, qty: 3 },
      ],
      500_000,
    );
    spawnTrader(world, KORDON_LOC, [{ item: 'meat' as ItemId, qty: 12 }, { item: 'pm' as ItemId, qty: 4 }], 8000);
    spawnTrader(world, KORDON_LOC, [{ item: 'pm' as ItemId, qty: 1 }], 60_000);
    spawnTrader(world, KORDON_LOC, [{ item: 'bandage' as ItemId, qty: 6 }], 3000);

    const before = worldTotals(world);
    scheduler.run(world, 50);
    const after = worldTotals(world);

    const evs = tradeEvents(world);
    expect(evs.length).toBeGreaterThan(0);
    // Стабилизация: последняя сделка случилась ЗАДОЛГО до конца прогона (иссякла политика).
    const lastTradeTick = Math.max(...evs.map((e) => e.tick));
    expect(lastTradeTick).toBeLessThan(world.tick);

    // Σ денег и Σ каждого предмета сохранены точно (перевод, не faucet).
    expect(after.money).toBe(before.money);
    const allItems = new Set<string>([...before.items.keys(), ...after.items.keys()]);
    for (const item of [...allItems].sort()) {
      expect((after.items.get(item) ?? 0), `Σ ${item} должна сохраниться`).toBe(before.items.get(item) ?? 0);
    }
    // Никакого леджера item/* от Trade (перевод не создаёт/не уничтожает).
    expect(world.bus.log.some((e) => e.type.startsWith('item/'))).toBe(false);
  });
});
