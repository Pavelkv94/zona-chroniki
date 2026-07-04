/**
 * @module @zona/sim/systems/export
 *
 * Система Export (задача 2.7, D-055) — ЭКСПОРТ ЗА ПЕРИМЕТР, ЕДИНСТВЕННЫЙ
 * санкционированный money-faucet замкнутой экономики. Мир замкнут по массе (закон
 * №3): Economy (2.3) сводит массу потреблением, Trade (2.5) её ПЕРЕВОДИТ между
 * владельцами — ни один не создаёт денег. Но касса поселений безвозвратно истощается
 * (они платят сталкерам за хабар). Экспорт восполняет её ИЗВНЕ: поселение отправляет
 * накопленный ценный ХАБАР (артефакты) «за Периметр» (наружу, за пределы
 * симулируемого мира) и получает деньги. Предмет ФИЗИЧЕСКИ покидает мир, деньги
 * ФИЗИЧЕСКИ входят — оба факта проведены ЛЕДЖЕРОМ `item/exported` (D-045): `−qty` к
 * товарной массе, `+moneyIn` к денежной. Это ЕДИНСТВЕННОЕ легитимное создание денег;
 * EconomyInvariant (headless) учитывает его через `ledgerDelta` (money += moneyIn,
 * item -= qty), поэтому `worldTotals − baseline == ledgerDelta` держится.
 *
 * Главный тест закона №1: всё работает БЕЗ игрока — поселение САМО отправляет колонну
 * по состоянию своего склада на детерминированном логистическом тике, даже если ни
 * одного игрока (и ни одной внешней команды) нет.
 *
 * ── ПРИЧИННАЯ ПОЛИТИКА (закон №2: по СОСТОЯНИЮ, НЕ «X% шанс отправки») ─────────────
 * Export исполняется каждые `EXPORT_CADENCE_DAYS × TICKS_PER_DAY` тиков —
 * ДЕТЕРМИНИРОВАННАЯ тик-фаза «логистического цикла» (колонна за Периметр — крупная
 * операция, а не по-тиковый поток; аналог `every`, не бросок). На каждом таком тике
 * поселение отправляет груз ТОЛЬКО ЕСЛИ накопило экспортного хабара на складе НЕ
 * МЕНЬШЕ `EXPORT_SURPLUS_THRESHOLD` единиц (порог по СОСТОЯНИЮ склада — колонна не
 * гоняется полупустой). Обе части причинны и детерминированы: rng НЕ используется.
 * Никакого «шанса» нападения/отправки — чистая арифметика порога над состоянием.
 *
 * ── ЧТО ЭКСПОРТИРУЕТСЯ (закон №10: КАТЕГОРИЯ данных, не хардкод id) ────────────────
 * «Экспортный» предмет = `getItem(id).kind === 'artifact'` (`isExportable`, зеркально
 * `isFood`/`isDrink` в Economy). Артефакт — ценный хабар, рождаемый аномальными
 * полями (2.9), а НЕ эссеншел выживания/резерва поселения (еда/патроны/медикаменты).
 * Поэтому поселение держит НУЛЕВОЙ резерв артефактов и вывозит их ВЕСЬ накопленный
 * запас (в отличие от Trade, где резерв на руках у NPC защищает survival-товар).
 * Расширение набора экспортных товаров — правка ТОЛЬКО данных (новая категория/флаг),
 * код читает признак абстрактно.
 *
 * ── ЦЕНА ЭКСПОРТА (DERIVED, детерминирована) ─────────────────────────────────────
 * `exportPriceOf(item)` (pricing.ts, D-047-стиль) = `round(basePrice ×
 * EXPORT_PRICE_FACTOR)` — за Периметром ВНЕШНИЙ рынок без локального «дефицита»,
 * поэтому цена зависит только от контент-якоря basePrice и balance-множителя, не от
 * склада. `moneyIn = exportPriceOf(item) × qty`. Цена не хранится (resume-safe).
 *
 * ── АТОМАРНОСТЬ / НЕ-В-ДОЛГ (закон №3, D-035) ────────────────────────────────────
 * Экспортируется ТОЛЬКО реально имеющийся хабар: qty = наличие на складе; склад НЕ
 * уходит в минус. Перевод идёт по рабочей копии-Map, в конце записывается ОБРАТНО
 * НОВЫМИ массивами через `resources.set` (не мутируем хранимую чужую ссылку, D-035).
 * Каждая позиция вывоза — своё `item/exported` (леджер на единицу товара позиции).
 *
 * ── ПРИЧИННОСТЬ СОБЫТИЯ (D-030) ──────────────────────────────────────────────────
 * `item/exported.causedBy = null`: отправка колонны — ЭНДОГЕННЫЙ КОРЕНЬ (накопленный
 * склад + логистическая тик-фаза), у неё нет события-причины в мире (нет
 * «settlement-tick»-события; логистика — драйв самого поселения, как эндогенны
 * `item/produced`/`item/consumed(upkeep)` в Economy, D-045). Обоснование корня —
 * тот же принцип, что физиология Needs и генерация Weather.
 *
 * ── ДЕТЕРМИНИЗМ (закон №8) ────────────────────────────────────────────────────────
 * Обход поселений — `queryEntities([Settlement])` (сорт. по eid). Внутри склада
 * позиции вывоза — по ВОЗРАСТАНИЮ itemId. rng не участвует. Склад/касса сериализуемы
 * ⇒ split ≡ continuous. Система НЕ входит в registerPhase1Systems/worldgen (подключит
 * 2.16), поэтому голдены Фазы 1 не сдвигаются.
 */

import type { EntityId, ItemId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import type { ResourceStore } from '../core/world';
import { queryEntities } from '../core/ecs';
import { Settlement } from '../core/components';
import { getItem } from '../data/index';
import { TICKS_PER_DAY } from '../balance/time';
import { exportPriceOf } from './pricing';
import { EXPORT_CADENCE_DAYS, EXPORT_SURPLUS_THRESHOLD } from '../balance/economy';

/** Склад поселения под ключом 'inventory' (D-046). */
const INVENTORY_KEY = 'inventory';
/** Касса поселения под ключом 'money' (D-046). */
const MONEY_KEY = 'money';
/** Флаг заброшенности поселения (ставит Economy). Заброшенное не экспортирует. */
const ABANDONED_KEY = 'settlementAbandoned';

/** Единица склада (форма worldgen 2.2 / систем, сорт. по item). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/**
 * true, если предмет — ЭКСПОРТНЫЙ хабар (kind 'artifact'). Категория данных
 * (закон №10), не хардкод id: зеркально `isFood`/`isDrink` в Economy.
 */
function isExportable(item: string): boolean {
  return getItem(item).kind === 'artifact';
}

/** Строит Map(item→qty) из массива инвентаря (чтение чужой ссылки БЕЗ мутации). */
function toStock(inv: readonly InventoryEntry[]): Map<string, number> {
  const stock = new Map<string, number>();
  for (const e of inv) stock.set(e.item, (stock.get(e.item) ?? 0) + e.qty);
  return stock;
}

/** Сериализует Map(item→qty) в массив: только qty>0, ОТСОРТИРОВАН по itemId (закон №8). */
function toInventory(stock: Map<string, number>): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  for (const item of Array.from(stock.keys()).sort()) {
    const qty = stock.get(item) as number;
    if (qty > 0) out.push({ item: item as ItemId, qty });
  }
  return out;
}

/** Σ qty экспортного хабара в складе-Map (порог отправки колонны считается по нему). */
function sumExportable(stock: Map<string, number>): number {
  let sum = 0;
  for (const [item, qty] of stock) if (isExportable(item)) sum += qty;
  return sum;
}

/**
 * Система Export (`every: EXPORT_CADENCE_DAYS × TICKS_PER_DAY`). На каждый носитель
 * Settlement (сорт. по eid, не заброшенный) с накопленным хабаром >= порога:
 * вывозит ВЕСЬ экспортный хабар за Периметр, эмитит `item/exported` на каждую
 * позицию и зачисляет выручку в кассу. Детерминирована, rng не использует.
 */
export const Export: System = {
  name: 'Export',
  schedule: { every: EXPORT_CADENCE_DAYS * TICKS_PER_DAY },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const ecs = world.ecs;
    const resources = world.resources;

    const settlements = queryEntities(ecs, [Settlement]);
    if (settlements.length === 0) return;

    for (const eid of settlements) {
      // Заброшенное поселение инертно (его больше никто не обслуживает).
      if (resources.get<boolean>(ABANDONED_KEY, eid) === true) continue;

      const inv = resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
      const stock = toStock(inv);

      // Порог отправки колонны по СОСТОЯНИЮ склада (закон №2, не «шанс»).
      if (sumExportable(stock) < EXPORT_SURPLUS_THRESHOLD) continue;

      let money = resources.get<number>(MONEY_KEY, eid) ?? 0;
      let dispatched = false;

      // Вывоз по ВОЗРАСТАНИЮ itemId (детерминизм, закон №8). Резерв артефактов = 0:
      // хабар не эссеншел, поселение вывозит его весь.
      for (const item of Array.from(stock.keys()).sort()) {
        if (!isExportable(item)) continue;
        const qty = stock.get(item) as number;
        if (qty <= 0) continue; // страховка: не в долг (закон №3)
        const unit = exportPriceOf(item as ItemId);
        const moneyIn = unit * qty;
        // Товар ФИЗИЧЕСКИ покидает мир, деньги ФИЗИЧЕСКИ входят.
        stock.set(item, 0);
        money += moneyIn;
        dispatched = true;
        bus.publish({
          type: 'item/exported',
          causedBy: null, // эндогенный корень (логистика поселения), D-030/D-045
          payload: { who: eid, item: item as ItemId, qty, moneyIn },
        });
      }

      // Запись обратно НОВЫМИ массивами (D-035) — только если реально вывезли.
      if (dispatched) {
        resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, eid, toInventory(stock));
        resources.set<number>(MONEY_KEY, eid, money);
      }
    }
  },
};
