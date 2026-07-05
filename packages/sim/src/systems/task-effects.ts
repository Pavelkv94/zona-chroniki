/**
 * @module @zona/sim/systems/task-effects
 *
 * Система TaskEffects (задача 1.8e, B.4) — ИСПОЛНЕНИЕ выбранной задачи: пока
 * сущность СТОИТ у цели, задача восстанавливает соответствующую нужду и (для еды)
 * ФИЗИЧЕСКИ расходует предмет из инвентаря. Это второй такт распорядка дня:
 * TaskSelection (1.8) РЕШАЕТ, что делать; TaskEffects — ДЕЛАЕТ. Пара «накопление
 * нужд (Needs 1.5) ↔ их закрытие (здесь)» замыкает суточный цикл эмерджентно, БЕЗ
 * явного расписания (закон №1 — мир живёт без игрока; закон №2 — причинность из
 * состояния, не «X% шанс»).
 *
 * ── Что читает/пишет (только своё, закон №6) ─────────────────────────────────
 * Читает Position (loc/dest — стоит ли), Task.kind, Home.loc, Needs, инвентарь
 * (ResourceStore 'inventory'), СТАТИКУ локации из data (water/forage). Пишет
 * Needs (уменьшает нужды) и инвентарь (расход еды). Другие системы не зовёт —
 * результат виден им через компоненты/ресурсы (Needs — TaskSelection'у, инвентарь —
 * экономике). Публикует РОВНО одно событие — леджер `item/consumed` при EAT
 * (D-045, см. ниже «События: только леджер расхода еды»).
 *
 * ── Условие исполнения: сущность СТОИТ у цели (D-019) ────────────────────────
 * Эффект применяется ТОЛЬКО когда `Position.dest === Position.loc` (сущность на
 * месте, не в транзите). В пути (dest !== loc) задача НЕ исполняется — нельзя есть/
 * пить/спать, шагая по Зоне. TaskSelection ставит цель задачи так, что «на месте»
 * означает «у нужного ресурса» (EAT/FORAGE/REST → текущая loc; SLEEP → Home; DRINK →
 * ближайшая вода; HUNT → локация дичи). Порядок в тике (D-032): TaskEffects ПОСЛЕ
 * Movement (сущность уже переместилась/прибыла в этот тик) и ДО Encounters.
 *
 * ── Семантика по видам задач (ставки ТОЛЬКО из balance/needs, закон №7) ───────
 *  • EAT   → съедает ОДНУ единицу самой питательной еды (kind='food', qty>0) из
 *            инвентаря: qty−1 (при 0 — запись удаляется, сортировка по item
 *            сохраняется), hunger −= nutrition этого предмета (items.json), кламп 0.
 *            Еда ФИЗИЧЕСКИ уходит из инвентаря (закон №3). Нет еды → no-op
 *            (TaskSelection не выбирает EAT без еды, но система устойчива).
 *  • DRINK → если loc.water===true: thirst −= DRINK_RECOVERY_PER_TICK, кламп 0.
 *            Вода из СРЕДЫ (река/колодец), не предмет — закон №3 не нарушается. Не
 *            у воды → no-op.
 *  • SLEEP → если сущность ДОМА (loc === Home.loc; без Home — homeLoc=loc, спит на
 *            месте): fatigue −= SLEEP_RECOVERY_PER_TICK, кламп 0. Стоя SLEEP вне
 *            дома (носитель Home away from home) — БЕЗ эффекта (для отдыха вне дома
 *            есть REST).
 *  • REST  → fatigue −= REST_RECOVERY_PER_TICK (< SLEEP: привал слабее сна) в ЛЮБОЙ
 *            локации, кламп 0.
 *  • FORAGE→ ДОБЫВАЕТ физический предмет `forage_food` из ОБИЛИЯ локации в инвентарь
 *            (P-5/5.2): голод больше НЕ гасится напрямую — фуражир собирает раститель-
 *            ную еду, а EAT её потом ест (чище/физичнее: масса проходит через леджер).
 *            Выход за тик = `floor(FORAGE_FOOD_YIELD_PER_ABUNDANCE × обилие_патча)`
 *            (истощённый/мёртвый патч → 0, «пусто→ноль», закон №1/№2). Обилие —
 *            ВОЗОБНОВЛЯЕМЫЙ истощаемый ресурс (см. ниже «Обилие среды»). Источник
 *            ФИЗИЧЕН — растительность угодья (закон №3). qty>0 ⇒ ЛЕДЖЕР
 *            `item/harvested{source:'forage'}` (D-045).
 *  • HUNT  → БЕЗ восстановления здесь: мясо даёт Encounter (1.10) через труп/разделку.
 *  • FLEE  → БЕЗ восстановления: это только движение (Movement).
 *
 * ── Обилие среды: ВОЗОБНОВЛЯЕМЫЙ истощаемый ресурс (закон №1/№2/№8) ────────────
 * Собирательство не берёт бесконечную еду из пустоты: у КАЖДОЙ локации есть ТЕКУЩЕЕ
 * обилие (0..base, где base = `loc.forage` из map.json = ёмкость среды). Фуражировка
 * ИСТОЩАЕТ патч (−`FORAGE_DEPLETION_PER_FOOD` за каждую добытую единицу), а со временем
 * он ДЕТЕРМИНИРОВАННО отрастает к base (+`FORAGE_REGEN_PER_TICK`/тик). Так возникает
 * ёмкость: несколько фуражиров конкурируют за патч (по eid — детерминизм), выкачанный
 * патч даёт ноль до восстановления (связь с 5.3 «приток по ёмкости»). ТЕКУЩЕЕ обилие
 * хранится как СЕРИАЛИЗУЕМЫЙ разрежённый массив `[loc, abundance]` (только ИСТОЩЁННЫЕ
 * патчи, base — по умолчанию) на singleton-носителе `WorldClock` (это «среда-часы»
 * мира; живой eid ⇒ переживает снапшот, resume-safe, закон №8). Регенерация идёт раз в
 * тик по разрежённому набору истощённых патчей (их мало ⇒ дёшево, не O(n²)). Нет
 * носителя WorldClock (голый createSimWorld без worldgen) ⇒ среды нет ⇒ FORAGE не
 * исполняется (пустой мир не оживает — 481914ae цел). rng НЕ участвует (закон №2).
 *
 * ── События: ЛЕДЖЕР массы EAT (расход) и FORAGE (добыча) (D-045, закон №3) ─────
 * Изменение Needs и восстановление из СРЕДЫ (DRINK/SLEEP/REST) события НЕ порождают:
 * это состояние, которое нисходящие системы читают через компоненты (закон №6 не
 * требует события без адресата-подписчика). НО любое изменение Σ массы замкнутой
 * экономики обязано быть видимо леджеру (закон №3, D-045): EAT ФИЗИЧЕСКИ уничтожает
 * съеденную единицу → `item/consumed {who, item, qty:1, reason:'eat'}`; FORAGE ФИЗИЧЕСКИ
 * добывает еду из среды → `item/harvested {who, item:'forage_food', qty, source:'forage'}`.
 * Обоим `causedBy = Task.causeEvent` (задача, приведшая к действию; штамп D-030, или
 * null). EconomyInvariant видит массу через оба события. Изменение ОБИЛИЯ патча массу
 * инвентарей НЕ трогает (обилие — свойство СРЕДЫ, не предмет) ⇒ отдельного события не
 * требует; учтена лишь добытая масса `forage_food`.
 *
 * ── Детерминизм (закон №8) ────────────────────────────────────────────────────
 * rng НЕ используется: восстановление чисто арифметическое (закон №2 — случайность
 * лишь для физического разброса, здесь его нет). Обход носителей —
 * `queryEntities` (сорт. по eid). Выбор съедаемой еды детерминирован (самая
 * питательная; tie — первая по отсортированному по item инвентарю). Needs (f32) и
 * инвентарь (ResourceStore) сериализуются ⇒ resume после load продолжает тождественно.
 */

import type { EntityId, EventId, ItemId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { ResourceStore } from '../core/world';
import { queryEntities, hasComponent } from '../core/ecs';
import { Position, Needs, Task, Home, Human, Alive, WorldClock, TaskKind } from '../core/components';
import { getLocation, getItem } from '../data/index';
import {
  NEED_MAX,
  SLEEP_RECOVERY_PER_TICK,
  REST_RECOVERY_PER_TICK,
  DRINK_RECOVERY_PER_TICK,
} from '../balance/needs';
import {
  FORAGE_FOOD_YIELD_PER_ABUNDANCE,
  FORAGE_DEPLETION_PER_FOOD,
  FORAGE_REGEN_PER_TICK,
} from '../balance/ecology';

/** Ключ ResourceStore со списком инвентаря (D-007); форма — как пишет worldgen 1.3. */
const INVENTORY_KEY = 'inventory';

/**
 * Ключ ResourceStore с ТЕКУЩИМ обилием собирательства по локациям (P-5/5.2). Живёт
 * на singleton-носителе WorldClock (среда мира). Значение — РАЗРЕЖЁННЫЙ массив пар
 * `[loc, abundance]`, отсортированный по loc, ТОЛЬКО для ИСТОЩЁННЫХ патчей (обилие <
 * base); отсутствие пары ⇒ патч на базовом обилии `loc.forage` (полон). Массив (не
 * Map) — требование сериализации (D-013); сорт. по loc — детерминизм (закон №8).
 */
const FORAGE_ABUNDANCE_KEY = 'forageAbundance';

/** Строковый id добываемой растительной еды (контент items.json, закон №10). */
const FORAGE_FOOD_ITEM = 'forage_food' as ItemId;

/** Единица инвентаря (та же форма, что пишет worldgen 1.3, сорт. по item). */
interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
}

/** Пара «локация → текущее обилие» в сериализуемом массиве обилия (сорт. по loc). */
type AbundanceEntry = readonly [loc: number, abundance: number];

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const POS = Position as unknown as { readonly loc: Uint32Array; readonly dest: Uint32Array };
const NEED = Needs as unknown as {
  hunger: Float32Array;
  thirst: Float32Array;
  fatigue: Float32Array;
  fear: Float32Array;
};
const HOME = Home as unknown as { readonly loc: Uint32Array };
const TSK = Task as unknown as { readonly kind: Uint8Array; readonly causeEvent: Uint32Array };

/** Значение, зажатое в отрезок [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** ui32-поле причины (0 = «нет причины», D-031) → `EventId | null`. */
function causeOrNull(id: number): EventId | null {
  return id === 0 ? null : (id as EventId);
}

/**
 * Съедает ОДНУ единицу самой питательной еды из инвентаря сущности (детерминизм:
 * при равной питательности берётся первая по отсортированному по item инвентарю —
 * строгое `>` при обходе). ФИЗИЧЕСКИ списывает единицу (qty−1; при 0 — удаляет
 * запись, сохраняя сортировку) и уменьшает hunger на nutrition съеденного (кламп 0).
 * Закон №3: суммарное число предметов уменьшается ровно на съеденное. Возвращает
 * itemId съеденного предмета (для леджер-события `item/consumed`, D-045) или
 * `undefined` (no-op, съедобной еды нет). `inv` НЕ мутируется на месте —
 * записывается НОВЫЙ массив (изоляция от возможных общих ссылок; worldgen даёт
 * свежую копию, но эффект — своя ответственность).
 */
function eatOne(
  resources: SystemCtx['world']['resources'],
  eid: EntityId,
  inv: readonly InventoryEntry[],
): string | undefined {
  // Ищем самую питательную еду; tie → первая по (уже отсортированному) массиву.
  let bestIdx = -1;
  let bestNutrition = -Infinity;
  for (let i = 0; i < inv.length; i++) {
    const e = inv[i] as InventoryEntry;
    if (e.qty <= 0) continue;
    const item = getItem(e.item);
    if (item.kind !== 'food') continue;
    const nutrition = item.nutrition ?? 0;
    if (nutrition > bestNutrition) {
      bestNutrition = nutrition;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return undefined; // еды нет — EAT ничего не восстанавливает

  const eaten = inv[bestIdx] as InventoryEntry;
  const nutrition = getItem(eaten.item).nutrition ?? 0;

  // Новый массив: qty−1; при 0 — запись выпадает (сортировка по item сохраняется,
  // т.к. остальные элементы идут в прежнем порядке).
  const next: InventoryEntry[] = [];
  for (let i = 0; i < inv.length; i++) {
    const e = inv[i] as InventoryEntry;
    if (i === bestIdx) {
      if (e.qty - 1 > 0) next.push({ item: e.item, qty: e.qty - 1 });
      // qty−1 === 0 ⇒ запись не переносится (предмет физически исчерпан).
    } else {
      next.push(e);
    }
  }
  resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, eid, next);

  NEED.hunger[eid] = clamp((NEED.hunger[eid] as number) - nutrition, 0, NEED_MAX);
  return eaten.item;
}

/**
 * Добавляет `qty` единиц предмета `item` в инвентарь, СОХРАНЯЯ сортировку по item
 * (D-007) и СЛИВАЯ с существующей записью того же item (никаких дублей — иначе
 * фуражир накопил бы тысячи отдельных записей forage_food, раздув инвентарь/снапшот).
 * Возвращает НОВЫЙ массив (иммутабельность, как eatOne). Вставка нового item — в
 * позицию, удерживающую возрастающий порядок item (строгое `<`).
 */
function addItemSorted(
  inv: readonly InventoryEntry[],
  item: string,
  qty: number,
): InventoryEntry[] {
  const next: InventoryEntry[] = [];
  let done = false;
  for (const e of inv) {
    if (e.item === item) {
      next.push({ item, qty: e.qty + qty }); // слияние с существующей записью
      done = true;
    } else {
      if (!done && item < e.item) {
        next.push({ item, qty }); // вставка перед первым бо́льшим item (сорт. сохранён)
        done = true;
      }
      next.push(e);
    }
  }
  if (!done) next.push({ item, qty }); // item больше всех имеющихся — в конец
  return next;
}

/** Читает разрежённый массив обилия с носителя WorldClock в Map<loc, abundance>. */
function readAbundance(resources: ResourceStore, clockEid: EntityId): Map<number, number> {
  const arr = resources.get<readonly AbundanceEntry[]>(FORAGE_ABUNDANCE_KEY, clockEid) ?? [];
  const m = new Map<number, number>();
  for (const [loc, a] of arr) m.set(loc, a);
  return m;
}

/**
 * Пишет обилие обратно на WorldClock как ОТСОРТИРОВАННЫЙ по loc массив пар (закон
 * №8). Пустая карта ⇒ УДАЛЯЕМ запись ресурса (не пишем `[]`): «нет истощённых патчей»
 * = отсутствие ключа, что тождественно исходному состоянию до любой фуражировки
 * (стабильность снапшота/хэша; resume-safe).
 */
function writeAbundance(resources: ResourceStore, clockEid: EntityId, m: Map<number, number>): void {
  if (m.size === 0) {
    resources.delete(FORAGE_ABUNDANCE_KEY, clockEid);
    return;
  }
  const out: AbundanceEntry[] = [];
  for (const loc of Array.from(m.keys()).sort((a, b) => a - b)) {
    out.push([loc, m.get(loc) as number]);
  }
  resources.set<readonly AbundanceEntry[]>(FORAGE_ABUNDANCE_KEY, clockEid, out);
}

/**
 * Система TaskEffects (`every: 1`). Для каждого стоящего у цели живого человека с
 * задачей исполняет её эффект: восстанавливает нужду, (EAT) расходует еду, (FORAGE)
 * добывает `forage_food` из обилия локации. Раз в тик регенерирует истощённые патчи
 * обилия к базовому (ёмкость среды). Детерминирована, rng не использует.
 */
export const TaskEffects: System = {
  name: 'TaskEffects',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const ecs = world.ecs;
    const resources = world.resources;

    // ── Обилие среды: носитель = singleton WorldClock (P-5/5.2) ────────────────
    // Обилие собирательства живёт на WorldClock (среда-часы мира). Нет носителя
    // (голый createSimWorld без worldgen) ⇒ среды нет ⇒ FORAGE не исполняется, а
    // пустой мир не оживает (голден 481914ae цел).
    const clocks = queryEntities(ecs, [WorldClock]);
    const clockEid: EntityId | undefined = clocks.length > 0 ? (clocks[0] as EntityId) : undefined;
    let abundance: Map<number, number> | undefined;
    let abundanceDirty = false;
    if (clockEid !== undefined) {
      abundance = readAbundance(resources, clockEid);
      // РЕГЕНЕРАЦИЯ (раз в тик, по разрежённому набору истощённых патчей — дёшево):
      // каждый истощённый патч подтягивается к base; достигнув base — снимается из
      // карты (снова «полон»). Детерминированный обход по возрастанию loc (закон №8).
      if (abundance.size > 0) {
        for (const loc of Array.from(abundance.keys()).sort((a, b) => a - b)) {
          const base = getLocation(loc as LocationId).forage;
          const grown = Math.min(base, (abundance.get(loc) as number) + FORAGE_REGEN_PER_TICK);
          if (grown >= base) abundance.delete(loc);
          else abundance.set(loc, grown);
        }
        abundanceDirty = true;
      }
    }

    for (const eid of queryEntities(ecs, [Human, Alive, Task, Needs])) {
      // Исполняем ТОЛЬКО когда сущность СТОИТ у цели (D-019): dest === loc.
      if ((POS.dest[eid] as number) !== (POS.loc[eid] as number)) continue;

      const loc = POS.loc[eid] as number;
      const kind = TSK.kind[eid] as number;

      switch (kind) {
        case TaskKind.EAT: {
          const inv = world.resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid);
          if (inv !== undefined) {
            const eatenItem = eatOne(world.resources, eid, inv);
            // ЛЕДЖЕР (D-045, закон №3): съеденная единица ФИЗИЧЕСКИ ушла из мира —
            // публикуем item/consumed, чтобы EconomyInvariant видел это уничтожение
            // массы. Причина — задача, приведшая к еде (штамп Task.causeEvent, D-030):
            // без штампа (0) — null. Механику расхода eatOne не меняем.
            if (eatenItem !== undefined) {
              bus.publish({
                type: 'item/consumed',
                causedBy: causeOrNull(TSK.causeEvent[eid] as number),
                payload: { who: eid, item: eatenItem, qty: 1, reason: 'eat' },
              });
            }
          }
          break;
        }
        case TaskKind.DRINK: {
          if (getLocation(loc as LocationId).water) {
            NEED.thirst[eid] = clamp(
              (NEED.thirst[eid] as number) - DRINK_RECOVERY_PER_TICK,
              0,
              NEED_MAX,
            );
          }
          break;
        }
        case TaskKind.SLEEP: {
          // Дома, если есть Home и loc совпадает; без Home — «дом» на месте (спит тут).
          const homeLoc = hasComponent(ecs, Home, eid) ? (HOME.loc[eid] as number) : loc;
          if (loc === homeLoc) {
            NEED.fatigue[eid] = clamp(
              (NEED.fatigue[eid] as number) - SLEEP_RECOVERY_PER_TICK,
              0,
              NEED_MAX,
            );
          }
          break;
        }
        case TaskKind.REST: {
          NEED.fatigue[eid] = clamp(
            (NEED.fatigue[eid] as number) - REST_RECOVERY_PER_TICK,
            0,
            NEED_MAX,
          );
          break;
        }
        case TaskKind.FORAGE: {
          // Собирательство добывает физический forage_food из ОБИЛИЯ патча (закон №3).
          // Нет носителя WorldClock (среды) ⇒ нечего собирать (пустой мир не оживает).
          if (clockEid === undefined || abundance === undefined) break;
          const base = getLocation(loc as LocationId).forage;
          const a = abundance.get(loc) ?? base; // нет записи ⇒ патч полон (base)
          const yieldQty = Math.floor(FORAGE_FOOD_YIELD_PER_ABUNDANCE * a);
          if (yieldQty <= 0) break; // истощённый/мёртвый патч — ничего (пусто→ноль)

          // Кладём добытое в инвентарь (слияние, сорт. по item) — масса пришла в мир.
          const inv = resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
          resources.set<readonly InventoryEntry[]>(
            INVENTORY_KEY,
            eid,
            addItemSorted(inv, FORAGE_FOOD_ITEM, yieldQty),
          );
          // ЛЕДЖЕР (D-045, закон №3): добытая из среды масса видима EconomyInvariant.
          // Причина — задача FORAGE, приведшая к сбору (штамп Task.causeEvent, D-030).
          bus.publish({
            type: 'item/harvested',
            causedBy: causeOrNull(TSK.causeEvent[eid] as number),
            payload: { who: eid, item: FORAGE_FOOD_ITEM, qty: yieldQty, source: 'forage' },
          });
          // ИСТОЩЕНИЕ патча пропорц. добыче (ёмкость среды): a может уйти к 0.
          abundance.set(loc, Math.max(0, a - yieldQty * FORAGE_DEPLETION_PER_FOOD));
          abundanceDirty = true;
          break;
        }
        // HUNT/FLEE — без восстановления здесь (мясо даёт Encounter 1.10; FLEE —
        // только движение). Прочие коды не встречаются (TaskSelection ставит из enum).
        default:
          break;
      }
    }

    // Единая запись обилия после регенерации + истощений этого тика (сорт. по loc;
    // пустая карта ⇒ ключ снимается — стабильность снапшота). Пишем ТОЛЬКО при
    // изменениях (нет фуражировки и нет истощённых патчей ⇒ ресурс не трогаем —
    // важно для голдена: пока обилие не тронуто, снапшот тождествен исходному).
    if (clockEid !== undefined && abundanceDirty && abundance !== undefined) {
      writeAbundance(resources, clockEid, abundance);
    }
  },
};
