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
 *  • FORAGE→ hunger −= FORAGE_RECOVERY_PER_TICK * loc.forage (подножный корм,
 *            обилие 0..1; в бедных локациях почти ноль), кламп 0. Собранное съедено
 *            на месте, в инвентарь не кладётся — источник СРЕДА (закон №3 ок).
 *  • HUNT  → БЕЗ восстановления здесь: мясо даёт Encounter (1.10) через труп/разделку.
 *  • FLEE  → БЕЗ восстановления: это только движение (Movement).
 *
 * ── События: ТОЛЬКО ЛЕДЖЕР расхода еды (D-045, ретрофит 2.0) ──────────────────
 * Изменение Needs и восстановление из СРЕДЫ (DRINK/FORAGE/SLEEP/REST) события НЕ
 * порождают: это состояние, которое нисходящие системы читают через компоненты
 * (закон №6 не требует события без адресата-подписчика). НО расход ЕДЫ при EAT
 * ФИЗИЧЕСКИ уничтожает предмет (уменьшает Σ inventory мира) — а любое изменение
 * массы замкнутой экономики обязано быть видимо леджеру (закон №3, D-045). Поэтому
 * EAT публикует `item/consumed {who, item, qty:1, reason:'eat'}` с `causedBy =
 * Task.causeEvent` (задача, приведшая к еде; штамп D-030, или null). Механику
 * расхода это НЕ меняет — только делает её видимой EconomyInvariant. Прочие эффекты
 * массу не трогают (вода/корм — из среды, не предмет) ⇒ остаются без событий.
 *
 * ── Детерминизм (закон №8) ────────────────────────────────────────────────────
 * rng НЕ используется: восстановление чисто арифметическое (закон №2 — случайность
 * лишь для физического разброса, здесь его нет). Обход носителей —
 * `queryEntities` (сорт. по eid). Выбор съедаемой еды детерминирован (самая
 * питательная; tie — первая по отсортированному по item инвентарю). Needs (f32) и
 * инвентарь (ResourceStore) сериализуются ⇒ resume после load продолжает тождественно.
 */

import type { EntityId, EventId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import { queryEntities, hasComponent } from '../core/ecs';
import { Position, Needs, Task, Home, Human, Alive, TaskKind } from '../core/components';
import { getLocation, getItem } from '../data/index';
import type { LocationId } from '@zona/shared';
import {
  NEED_MAX,
  SLEEP_RECOVERY_PER_TICK,
  REST_RECOVERY_PER_TICK,
  DRINK_RECOVERY_PER_TICK,
  FORAGE_RECOVERY_PER_TICK,
} from '../balance/needs';

/** Ключ ResourceStore со списком инвентаря (D-007); форма — как пишет worldgen 1.3. */
const INVENTORY_KEY = 'inventory';

/** Единица инвентаря (та же форма, что пишет worldgen 1.3, сорт. по item). */
interface InventoryEntry {
  readonly item: string;
  readonly qty: number;
}

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
 * Система TaskEffects (`every: 1`). Для каждого стоящего у цели живого человека с
 * задачей исполняет её эффект: восстанавливает нужду и (EAT) расходует еду.
 */
export const TaskEffects: System = {
  name: 'TaskEffects',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const ecs = world.ecs;

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
          const forage = getLocation(loc as LocationId).forage;
          NEED.hunger[eid] = clamp(
            (NEED.hunger[eid] as number) - FORAGE_RECOVERY_PER_TICK * forage,
            0,
            NEED_MAX,
          );
          break;
        }
        // HUNT/FLEE — без восстановления здесь (мясо даёт Encounter 1.10; FLEE —
        // только движение). Прочие коды не встречаются (TaskSelection ставит из enum).
        default:
          break;
      }
    }
  },
};
