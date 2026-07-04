/**
 * @module @zona/headless/economy-invariant
 *
 * EconomyInvariant (задача 2.0, ПРЕДОХРАНИТЕЛЬ, D-045) — read-only чекер закона №3
 * («ничего из воздуха») в глобальном масштабе ОДНОЙ формулой. Он НЕ система
 * (не публикует событий, не мутирует мир, не входит в хэш/лог — D-045): живёт в
 * `@zona/headless` рядом с CLI как determinism-gate (аналогично замеру времени
 * D-006 — вне бюджета D-006 и вне состояния мира).
 *
 * ── ФОРМУЛА ─────────────────────────────────────────────────────────────────
 * Пусть «масса мира» = Σ денег + Σ количеств КАЖДОГО предмета по ВСЕМ eid
 * (`worldTotals`). Единственный легальный способ изменить массу замкнутой
 * экономики — ЛЕДЖЕР-события `item/*` (5 типов, D-045). Значит для любого
 * момента `upToTick`:
 *
 *     worldTotals(now) − baseline  ==  ledgerDelta(0, upToTick)
 *
 * где `baseline` = `worldTotals` сразу ПОСЛЕ worldgen (t0), ДО первого тика.
 * Стартовый инвентарь/деньги worldgen — БАЗЛАЙН, а не событие (D-045): worldgen
 * НЕ эмитит леджер. Если равенство нарушено — где-то масса появилась/исчезла БЕЗ
 * леджер-события (дыра закона №3): `assertEconomyInvariant` бросает с диагностикой
 * (какой предмет/деньги и на сколько разошлись).
 *
 * ── ЧТО СЧИТАЕТСЯ СОЗДАНИЕМ/УНИЧТОЖЕНИЕМ (ledgerDelta) ────────────────────────
 * СОЗДАНО (+): `item/produced.qty`, `item/harvested.qty`, `item/broughtIn.items`.
 * УНИЧТОЖЕНО (−): `item/consumed.qty`, `item/exported.qty`.
 * ДЕНЬГИ: `+item/broughtIn.money`, `+item/exported.moneyIn` (продажа за Периметр
 * даёт приток денег). Переводы (торговля/грабёж между eid) массу СОХРАНЯЮТ и
 * леджером НЕ логируются — они не меняют Σ, поэтому не участвуют в формуле.
 * В Фазе 1 деньги не меняются ⇒ денежная дельта леджера = 0.
 *
 * ── ДЕТЕРМИНИЗМ (закон №8) ────────────────────────────────────────────────────
 * `worldTotals` обходит `resources.entries('money')`/`('inventory')` — те сорт.
 * по eid (контракт ResourceStore). Агрегация по item складывается в Map, но
 * СРАВНЕНИЕ/диагностика идут по ОТСОРТИРОВАННОМУ списку item (детерминизм вывода).
 * `ledgerDelta` идёт по `bus.log` (порядок = порядок публикаций). Чекер чист —
 * его вызов/невызов не влияет на мир и хэш (проверяется тестами CLI).
 *
 * Пример:
 * ```ts
 * const baseline = worldTotals(world);      // сразу после worldgen
 * scheduler.run(world, ticks);
 * assertEconomyInvariant(world, world.bus, baseline, world.tick); // throw при дыре
 * ```
 */

import type { ItemId, SimEvent, Tick } from '@zona/shared';
import type { SimWorld, EventBus } from '@zona/sim';

/** Ключи ResourceStore учёта массы (D-046: единообразны для NPC/трупов/поселений). */
const MONEY_KEY = 'money';
const INVENTORY_KEY = 'inventory';

/** Единица инвентаря в ResourceStore (форма worldgen 1.3 / систем 1.8e/1.10b). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/**
 * Снимок массы: суммарные деньги и количество КАЖДОГО предмета. `items` —
 * агрегат `itemId → Σ qty` по всем носителям. ReadonlyMap: снимок неизменяем.
 */
export interface EconTotals {
  readonly money: number;
  readonly items: ReadonlyMap<ItemId, number>;
}

/**
 * Σ массы мира: Σ 'money' + Σ 'inventory'.qty по item, по ВСЕМ eid (D-045/D-046).
 * Труп сохраняет свой inventory на своём eid (Death не удаляет ресурсы) ⇒ его лут
 * УЧТЁН — масса не «теряется» при смерти. Детерминизм: `entries` отдаёт по eid,
 * порядок сложения на сумму не влияет (числа целые/устойчивые).
 */
export function worldTotals(world: SimWorld): EconTotals {
  let money = 0;
  for (const [, m] of world.resources.entries<number>(MONEY_KEY)) {
    money += m;
  }
  const items = new Map<ItemId, number>();
  for (const [, inv] of world.resources.entries<readonly InventoryEntry[]>(INVENTORY_KEY)) {
    for (const e of inv) {
      items.set(e.item, (items.get(e.item) ?? 0) + e.qty);
    }
  }
  return { money, items };
}

/** Прибавляет `qty` к `item` в аккумулятор (создаёт запись при отсутствии). */
function add(acc: Map<ItemId, number>, item: ItemId, qty: number): void {
  acc.set(item, (acc.get(item) ?? 0) + qty);
}

/**
 * Чистая дельта массы из ЛЕДЖЕР-событий (`item/*`) в тиковом интервале
 * `[fromTick, toTick]` (оба включительно). Проходит `bus.log` один раз, складывая
 * созданное (produced/harvested/broughtIn) минус уничтоженное (consumed/exported)
 * по каждому item; деньги: broughtIn.money + exported.moneyIn. Прочие типы
 * событий массу не трогают ⇒ игнорируются.
 */
export function ledgerDelta(bus: EventBus, fromTick: Tick, toTick: Tick): EconTotals {
  let money = 0;
  const items = new Map<ItemId, number>();
  for (const ev of bus.log) {
    if (ev.tick < fromTick || ev.tick > toTick) continue;
    switch (ev.type) {
      case 'item/produced':
        add(items, ev.payload.item, ev.payload.qty);
        break;
      case 'item/harvested':
        add(items, ev.payload.item, ev.payload.qty);
        break;
      case 'item/broughtIn':
        for (const [item, qty] of ev.payload.items) add(items, item, qty);
        money += ev.payload.money;
        break;
      case 'item/consumed':
        add(items, ev.payload.item, -ev.payload.qty);
        break;
      case 'item/exported':
        add(items, ev.payload.item, -ev.payload.qty);
        money += ev.payload.moneyIn;
        break;
      default:
        break; // не-леджер событие массу не меняет
    }
  }
  return { money, items };
}

/** Собирает объединённое отсортированное множество itemId из нескольких тоталов. */
function unionItemKeys(...totals: readonly EconTotals[]): ItemId[] {
  const keys = new Set<ItemId>();
  for (const t of totals) for (const k of t.items.keys()) keys.add(k);
  return Array.from(keys).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * ПРЕДОХРАНИТЕЛЬ (D-045): бросает, если `worldTotals(world) − baseline` расходится
 * с `ledgerDelta(0, upToTick)` — то есть где-то масса изменилась БЕЗ леджер-события
 * (дыра закона №3). Проверяет деньги и КАЖДЫЙ item (объединённое множество ключей
 * base/now/ledger, сорт. — детерминизм диагностики). Сообщение перечисляет ВСЕ
 * расхождения `[что: наблюдалось vs ожидалось-по-леджеру]`, чтобы дыру было видно
 * поимённо. Read-only: мир/лог/хэш не трогает.
 */
export function assertEconomyInvariant(
  world: SimWorld,
  bus: EventBus,
  baseline: EconTotals,
  upToTick: Tick,
): void {
  const now = worldTotals(world);
  const ledger = ledgerDelta(bus, 0 as Tick, upToTick);
  const mismatches: string[] = [];

  // Деньги: (now − baseline) должно равняться дельте леджера.
  const moneyObserved = now.money - baseline.money;
  if (moneyObserved !== ledger.money) {
    mismatches.push(
      `money: наблюдаемая дельта ${moneyObserved} ≠ леджер ${ledger.money} ` +
        `(разошлось на ${moneyObserved - ledger.money})`,
    );
  }

  // Предметы: по объединённому множеству ключей.
  for (const item of unionItemKeys(baseline, now, ledger)) {
    const observed = (now.items.get(item) ?? 0) - (baseline.items.get(item) ?? 0);
    const expected = ledger.items.get(item) ?? 0;
    if (observed !== expected) {
      mismatches.push(
        `${item}: наблюдаемая дельта ${observed} ≠ леджер ${expected} ` +
          `(разошлось на ${observed - expected})`,
      );
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `EconomyInvariant НАРУШЕН на upToTick=${upToTick} (закон №3 — масса вне ` +
        `леджера):\n  ${mismatches.join('\n  ')}`,
    );
  }
}

/** Тип-guard для тестов/потребителей: событие относится к леджеру массы. */
export function isLedgerEvent(ev: SimEvent): boolean {
  return (
    ev.type === 'item/produced' ||
    ev.type === 'item/consumed' ||
    ev.type === 'item/harvested' ||
    ev.type === 'item/broughtIn' ||
    ev.type === 'item/exported'
  );
}
