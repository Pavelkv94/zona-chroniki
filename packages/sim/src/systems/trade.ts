/**
 * @module @zona/sim/systems/trade
 *
 * Система Trade (задача 2.5, B2, D-047) — ИСПОЛНЕНИЕ сделок между стоящим у поселения
 * NPC (`Task.kind === TRADE`) и складом/кассой этого поселения. Торговля есть ПЕРЕВОД
 * (закон №3): предметы и деньги ФИЗИЧЕСКИ меняют владельца, СУММАРНАЯ масса мира (Σ
 * денег + Σ каждого предмета) НЕ меняется — поэтому Trade НЕ эмитит леджер `item/*`
 * (это не создание/уничтожение), а EconomyInvariant держится с денежной/товарной
 * дельтой 0. Цена — DERIVED (`priceOf`, pricing.ts, D-047): детерминированная функция
 * дефицитности склада, НЕ «X% шанс» (закон №2), не хранится (resume-safe).
 *
 * Главный тест закона №1: всё работает БЕЗ игрока — NPC с задачей TRADE (её выберет
 * 2.6) приходит к поселению и торгует по состоянию своего инвентаря и склада, даже
 * если ни одного игрока нет. Trade НЕ решает, КОГДА торговать (это 2.6 через выбор
 * задачи) — лишь ИСПОЛНЯЕТ при уже выбранном Task=TRADE.
 *
 * ── ЧТО ЧИТАЕТ/ПИШЕТ (только своё, закон №6) ─────────────────────────────────────
 * Читает Task(kind/targetLoc/causeEvent), Position(loc/dest) NPC; Settlement+Position
 * поселения; склад/кассу ('inventory'/'money', D-046) NPC и поселения; КОНТЕНТ
 * поселения (startingWarehouse как «норму» для priceOf) через getSettlement. Пишет
 * склад/кассу обеих сторон (перевод новыми массивами через resources.set, НЕ in-place
 * чужой ссылки — D-035). Публикует `trade/executed` (causedBy = Task.causeEvent NPC,
 * D-047/D-030). rng НЕ используется (цена и решение детерминированы).
 *
 * ── СЕМАНТИКА ИСПОЛНЕНИЯ (детерминированная политика 2.5) ─────────────────────────
 * Для каждого NPC (Human, Alive, Task, Position; сорт. по eid, закон №8) с
 * `Task.kind === TRADE`, СТОЯЩЕГО (`Position.dest === loc`) в локации ПОСЕЛЕНИЯ
 * (getSettlement(loc) существует; контрагент — не-заброшенная сущность-поселение на
 * этой loc): исполнить сделку в ДВЕ фазы (обе — переводы, каждая ≤1 позиция):
 *  1) ДОКУПКА эссеншелов: если food-единиц < ESSENTIAL_FOOD_MIN — докупить food до
 *     TRADE_KEEP_FOOD (товар склад→NPC, деньги NPC→касса); затем то же для ammo
 *     (ESSENTIAL_AMMO_MIN/TRADE_KEEP_AMMO). Ограничения: наличие на складе И деньги
 *     NPC (`qty ≤ floor(npcMoney / price)`).
 *  2) СБЫТ избытка: среди предметов NPC сверх РЕЗЕРВА по виду (TRADE_KEEP_*) выбрать
 *     самый ЦЕННЫЙ по basePrice×избыток (тай-брейк — меньший itemId) и продать
 *     поселению (товар NPC→склад, деньги касса→NPC). Ограничение: касса поселения
 *     (`qty ≤ floor(setMoney / price)`) — не в долг.
 * Порядок фаз (докупка до сбыта) и выбор позиции ДЕТЕРМИНИРОВАНЫ; цикла нет.
 *
 * 2.6 уточнит НАМЕРЕНИЕ (когда/зачем NPC берёт TRADE); экспорт за Периметр — 2.7;
 * грабёж — 2.12. Trade НЕ в registerPhase1Systems/worldgen (подключит 2.16) ⇒ голдены
 * Фазы 1 не сдвигаются.
 */

import type { EntityId, EventId, ItemId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import type { ResourceStore } from '../core/world';
import { queryEntities } from '../core/ecs';
import { Task, Position, Human, Alive, Settlement, TaskKind } from '../core/components';
import { getSettlement, getItem } from '../data/index';
import { priceOf } from './pricing';
import {
  DEFAULT_TARGET_STOCK,
  ESSENTIAL_FOOD_MIN,
  ESSENTIAL_AMMO_MIN,
  TRADE_KEEP_FOOD,
  TRADE_KEEP_AMMO,
  TRADE_KEEP_WEAPON,
  TRADE_KEEP_DRINK,
  TRADE_KEEP_MEDICAL,
} from '../balance/economy';

/** Склад/личный инвентарь под ключом 'inventory' (D-046). */
const INVENTORY_KEY = 'inventory';
/** Касса/деньги под ключом 'money' (D-046). */
const MONEY_KEY = 'money';
/**
 * Флаг заброшенности поселения (сериализуемый; ставит Economy, systems/economy.ts).
 * Trade НЕ торгует с покинутым поселением (его никто не обслуживает).
 */
const ABANDONED_KEY = 'settlementAbandoned';

/** Единица склада (форма worldgen 2.2 / систем, сорт. по item). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const TASK = Task as unknown as { kind: Uint8Array; causeEvent: Uint32Array };
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };

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

/** Резерв «на руках» по виду при продаже (сверх него — избыток на сбыт). */
function reserveForKind(kind: string): number {
  switch (kind) {
    case 'weapon':
      return TRADE_KEEP_WEAPON;
    case 'food':
      return TRADE_KEEP_FOOD;
    case 'drink':
      return TRADE_KEEP_DRINK;
    case 'ammo':
      return TRADE_KEEP_AMMO;
    case 'medical':
      return TRADE_KEEP_MEDICAL;
    default:
      return 0;
  }
}

/** «Норма» склада поселения по предмету = стартовый запас (settlements.json) или дефолт. */
function targetStockOf(warehouseNorm: ReadonlyMap<string, number>, item: string): number {
  return warehouseNorm.get(item) ?? DEFAULT_TARGET_STOCK;
}

/** Σ qty предметов заданного вида в складе-Map. */
function sumOfKind(stock: Map<string, number>, kind: string): number {
  let sum = 0;
  for (const [item, qty] of stock) if (getItem(item).kind === kind) sum += qty;
  return sum;
}

/**
 * Рабочее состояние одной стороны сделки: склад-Map (item→qty) и касса. Переводы
 * идут по этим копиям, в конце `flush` пишет их обратно НОВЫМИ массивами (D-035).
 */
interface Party {
  readonly eid: EntityId;
  stock: Map<string, number>;
  money: number;
  changed: boolean;
}

function loadParty(resources: ResourceStore, eid: EntityId): Party {
  const inv = resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
  const money = resources.get<number>(MONEY_KEY, eid) ?? 0;
  return { eid, stock: toStock(inv), money, changed: false };
}

function flushParty(resources: ResourceStore, p: Party): void {
  if (!p.changed) return;
  resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, p.eid, toInventory(p.stock));
  resources.set<number>(MONEY_KEY, p.eid, p.money);
}

/**
 * Атомарный перевод `qty` единиц `item` от `from` к `to` и `money` денег ОБРАТНО
 * (от `to` к `from`). Мутирует ТОЛЬКО рабочие копии сторон (не хранимые ссылки) —
 * СУММА денег и предметов сохраняется (закон №3). Публикует `trade/executed`.
 * `buyer`/`seller` — стороны сделки в терминах «кто платит деньги / кто отдаёт товар».
 */
function transfer(
  bus: EventBus,
  goodsFrom: Party,
  goodsTo: Party,
  item: string,
  qty: number,
  unitPrice: number,
  cause: EventId | null,
): void {
  const money = unitPrice * qty;
  // Товар: goodsFrom → goodsTo.
  goodsFrom.stock.set(item, (goodsFrom.stock.get(item) ?? 0) - qty);
  goodsTo.stock.set(item, (goodsTo.stock.get(item) ?? 0) + qty);
  // Деньги: goodsTo (покупатель) → goodsFrom (продавец).
  goodsTo.money -= money;
  goodsFrom.money += money;
  goodsFrom.changed = true;
  goodsTo.changed = true;
  bus.publish({
    type: 'trade/executed',
    causedBy: cause,
    payload: {
      buyer: goodsTo.eid,
      seller: goodsFrom.eid,
      item: item as ItemId,
      qty,
      price: unitPrice,
      money,
    },
  });
}

/**
 * ДОКУПКА эссеншелов (еда/патроны): если у NPC вида `kind` меньше `min`, докупить у
 * поселения до `keep`, ограничившись наличием на складе и деньгами NPC. Покупается
 * ОДИН предмет вида — наименьший по itemId на складе поселения (детерминизм). Товар
 * склад→NPC, деньги NPC→касса.
 */
function buyEssential(
  bus: EventBus,
  npc: Party,
  settle: Party,
  warehouseNorm: ReadonlyMap<string, number>,
  kind: string,
  min: number,
  keep: number,
  cause: EventId | null,
): void {
  const have = sumOfKind(npc.stock, kind);
  if (have >= min) return;
  const want = keep - have;
  if (want <= 0) return;
  // Наименьший по itemId предмет нужного вида, реально лежащий на складе поселения.
  let pick: string | undefined;
  for (const item of Array.from(settle.stock.keys()).sort()) {
    if ((settle.stock.get(item) as number) > 0 && getItem(item).kind === kind) {
      pick = item;
      break;
    }
  }
  if (pick === undefined) return; // склад пуст по этому виду
  const onShelf = settle.stock.get(pick) as number;
  const price = priceOf(pick as ItemId, onShelf, targetStockOf(warehouseNorm, pick));
  const affordable = Math.floor(npc.money / price); // не в долг: qty ≤ деньги/цена
  const qty = Math.min(want, onShelf, affordable);
  if (qty <= 0) return;
  transfer(bus, settle, npc, pick, qty, price, cause); // товар склад→NPC, деньги NPC→касса
}

/**
 * СБЫТ избытка: среди предметов NPC сверх резерва по виду выбрать самый ценный по
 * basePrice×избыток (тай-брейк — меньший itemId) и продать поселению, ограничившись
 * кассой поселения. Товар NPC→склад, деньги касса→NPC. Максимум одна позиция.
 */
function sellSurplus(
  bus: EventBus,
  npc: Party,
  settle: Party,
  warehouseNorm: ReadonlyMap<string, number>,
  cause: EventId | null,
): void {
  // Выбор самой ценной избыточной позиции (обход по возрастанию itemId → тай-брейк
  // на меньший itemId при строгом сравнении по ценности).
  let bestItem: string | undefined;
  let bestSurplus = 0;
  let bestValue = -1;
  for (const item of Array.from(npc.stock.keys()).sort()) {
    const qty = npc.stock.get(item) as number;
    const surplus = qty - reserveForKind(getItem(item).kind);
    if (surplus <= 0) continue;
    const value = getItem(item).basePrice * surplus;
    if (value > bestValue) {
      bestValue = value;
      bestItem = item;
      bestSurplus = surplus;
    }
  }
  if (bestItem === undefined) return; // нечего сбывать
  const onShelf = settle.stock.get(bestItem) ?? 0;
  const price = priceOf(bestItem as ItemId, onShelf, targetStockOf(warehouseNorm, bestItem));
  const affordable = Math.floor(settle.money / price); // касса ограничивает (не в долг)
  const qty = Math.min(bestSurplus, affordable);
  if (qty <= 0) return;
  transfer(bus, npc, settle, bestItem, qty, price, cause); // товар NPC→склад, деньги касса→NPC
}

/**
 * Система Trade (`every: 1`). Каждый тик исполняет сделки стоящих у поселений
 * торгующих NPC. Порядок в конвейере (B2): после Movement (NPC прибыл), до/около
 * Encounters. Детерминирована, rng не использует.
 */
export const Trade: System = {
  name: 'Trade',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const ecs = world.ecs;
    const resources = world.resources;

    // loc → eid НЕ-заброшенного поселения (обход Settlement по eid, закон №8).
    const settlementByLoc = new Map<number, EntityId>();
    for (const s of queryEntities(ecs, [Settlement])) {
      if (resources.get<boolean>(ABANDONED_KEY, s) === true) continue;
      settlementByLoc.set(POS.loc[s] as number, s);
    }
    if (settlementByLoc.size === 0) return;

    // Торгующие NPC, стоящие у поселения (сорт. по eid). Поселение читается СВЕЖИМ на
    // каждого NPC (последовательные сделки одного тика видят обновлённый склад/кассу).
    for (const npcEid of queryEntities(ecs, [Human, Alive, Task, Position])) {
      if ((TASK.kind[npcEid] as number) !== TaskKind.TRADE) continue;
      const loc = POS.loc[npcEid] as number;
      if ((POS.dest[npcEid] as number) !== loc) continue; // ещё в пути — не стоит
      const setEid = settlementByLoc.get(loc);
      if (setEid === undefined) continue; // на локации нет (живого) поселения
      const data = getSettlement(loc);
      if (data === undefined) continue; // страховка: носитель без контент-записи

      // «Норма» склада по предмету = стартовый запас поселения (settlements.json).
      const warehouseNorm = new Map<string, number>(
        data.startingWarehouse.map((w) => [w.item, w.qty] as const),
      );

      const causeRaw = TASK.causeEvent[npcEid] as number;
      const cause: EventId | null = causeRaw > 0 ? (causeRaw as EventId) : null;

      const npc = loadParty(resources, npcEid);
      const settle = loadParty(resources, setEid);

      // Фаза 1: докупка эссеншелов (еда, затем патроны).
      buyEssential(bus, npc, settle, warehouseNorm, 'food', ESSENTIAL_FOOD_MIN, TRADE_KEEP_FOOD, cause);
      buyEssential(bus, npc, settle, warehouseNorm, 'ammo', ESSENTIAL_AMMO_MIN, TRADE_KEEP_AMMO, cause);
      // Фаза 2: сбыт избытка (одна самая ценная позиция).
      sellSurplus(bus, npc, settle, warehouseNorm, cause);

      flushParty(resources, npc);
      flushParty(resources, settle);
    }
  },
};
