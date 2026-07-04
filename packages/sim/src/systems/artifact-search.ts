/**
 * @module @zona/sim/systems/artifact-search
 *
 * Система ArtifactSearch (задача 2.10, D-057) — ИСПОЛНЕНИЕ подбора артефакта стоящим
 * в аномальном поле NPC (`Task.kind === SEARCH`). Подбор есть ПЕРЕВОД массы (закон №3):
 * запись артефакта ФИЗИЧЕСКИ переезжает из наземного лута поля (cold `'inventory'` на
 * eid поля, куда её положил ArtifactSpawn 2.9, D-054, УЖЕ отледжерив рождение как
 * `item/harvested{source:'anomaly'}`) в инвентарь NPC. Суммарная масса мира (Σ
 * 'inventory' по всем eid) НЕ меняется, поэтому ArtifactSearch НЕ эмитит леджер
 * `item/*` (это не создание/уничтожение, а смена владельца — как торговля D-047), а
 * EconomyInvariant (D-045) держится с товарной дельтой 0. rng НЕ используется.
 *
 * ── ГЛАВНЫЙ ТЕСТ (закон №1) ───────────────────────────────────────────────────
 * Всё работает БЕЗ игрока: NPC с задачей SEARCH (её выбирает TaskSelection 2.10 из
 * состояния — достижимое поле с артефактом + спокойствие) приходит к полю и подбирает
 * артефакт по состоянию лута поля, даже если ни одного игрока нет. ArtifactSearch НЕ
 * решает, КОГДА искать (это TaskSelection через выбор задачи) — лишь ИСПОЛНЯЕТ при уже
 * выбранном Task=SEARCH у стоящего в поле NPC.
 *
 * ── ЧТО ЧИТАЕТ/ПИШЕТ (только своё, закон №6) ─────────────────────────────────────
 * Читает Task(kind/causeEvent), Position(loc/dest) NPC; AnomalyField+Position полей;
 * наземный лут поля и инвентарь NPC ('inventory', D-046); КОНТЕНТ предмета (getItem —
 * `kind==='artifact'`). Пишет лут поля и инвентарь NPC (перевод НОВЫМИ массивами через
 * resources.set, НЕ мутируя чужую хранимую ссылку — D-035). Публикует `artifact/collected`
 * (causedBy = Task.causeEvent NPC, D-030/D-047). Системы не зовёт (общение через ECS/шину).
 *
 * ── СЕМАНТИКА ИСПОЛНЕНИЯ (детерминированная политика 2.10) ────────────────────────
 * Для каждого NPC (Human, Alive, Task, Position; сорт. по eid, закон №8) с
 * `Task.kind === SEARCH`, СТОЯЩЕГО (`Position.dest === loc`) в локации, где есть
 * аномальное поле с артефактом на луте:
 *  1) найти поле-носителя по loc (мирроринг Trade `settlementByLoc`, D-056): среди
 *     полей этой локации взять поле с НАИМЕНЬШИМ eid, на СВЕЖЕМ луте которого лежит
 *     артефакт (лут читается заново на каждого NPC — последовательные подборы одного
 *     тика видят опустошённое поле, как Trade перечитывает склад);
 *  2) подобрать РОВНО ОДНУ ЕДИНИЦУ артефакта с НАИМЕНЬШИМ itemId (детерминированный
 *     выбор, закон №8) — перевод поле→NPC.
 * ПОЛИТИКА «ОДНА ЕДИНИЦА ЗА ВЫЗОВ» (обосновано): подбор ограничен одной единицей на
 * тик — симметрично тому, как ArtifactSpawn рождает РОВНО ОДИН артефакт за вызов, и
 * духу Trade (не более одной позиции за фазу). Поле с несколькими артефактами NPC
 * опустошает за несколько тиков подряд (пока лут не пуст, TaskSelection удерживает
 * SEARCH — loc остаётся в artifactFieldLocs; опустело → перевыбор, не idle, закон №4).
 * Это делает подбор осторожным (аномальная опасность) и легибельным, без разового
 * скачка массы.
 *
 * ── ПОЧЕМУ ЦЕЛЬ ПО loc, А НЕ ПО targetEid поля (D-056/D-057) ──────────────────────
 * TaskSelection ставит `Task.targetLoc` = loc поля, но НЕ пишет targetEid: лут поля
 * ТРАНЗИТЕН (подбор его опустошает), поэтому хранить eid конкретного поля в задаче
 * хрупко (устареет при опустошении/множестве полей), а loc-резолвинг всегда берёт поле
 * с реальным лутом — как Trade находит поселение по loc.
 *
 * ── ДЕТЕРМИНИЗМ / RESUME (закон №8, P0) ───────────────────────────────────────────
 * Обход полей и NPC — `queryEntities` (сорт. по eid). Инвентари пишутся НОВЫМИ
 * массивами (сорт. по item), rng не используется ⇒ непрерывный прогон ≡ split save/load
 * (перевод зависит только от состояния лута/инвентаря, не от тика).
 *
 * ── НЕ В КОНВЕЙЕРЕ (голдены Фазы 1) ───────────────────────────────────────────────
 * ArtifactSearch НЕ регистрируется в registerPhase1Systems/worldgen (носителей
 * AnomalyField текущий worldgen не заводит — до 2.16): нет полей ⇒ ранний выход ⇒
 * система no-op на текущем мире, голдены Фазы 1 не сдвигаются. Экспортируется как
 * System из @zona/sim (прогон в отдельном планировщике); подключение — задача 2.16.
 */

import type { EntityId, EventId, ItemId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { ResourceStore } from '../core/world';
import { queryEntities } from '../core/ecs';
import { Task, Position, Human, Alive, AnomalyField, TaskKind } from '../core/components';
import { getItem } from '../data/index';

/** Наземный лут поля / инвентарь NPC под ключом 'inventory' (D-046). */
const INVENTORY_KEY = 'inventory';

/** Единица инвентаря (та же форма, что пишут worldgen/ArtifactSpawn, сорт. по item). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

// ── Типизированные SoA-колонки ───────────────────────────────────────────────
const TASK = Task as unknown as { kind: Uint8Array; causeEvent: Uint32Array };
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };

/**
 * itemId артефакта с НАИМЕНЬШИМ id среди позиций лута с qty>0 (детерминированный
 * выбор, закон №8), либо undefined, если артефакта нет. Обход по возрастанию itemId +
 * первый матч фиксирует tie-break.
 */
function pickArtifact(inv: readonly InventoryEntry[]): ItemId | undefined {
  let pick: ItemId | undefined;
  for (const e of inv) {
    if (e.qty <= 0 || getItem(e.item).kind !== 'artifact') continue;
    if (pick === undefined || e.item < pick) pick = e.item;
  }
  return pick;
}

/**
 * Убирает РОВНО ОДНУ единицу `item` из инвентаря — НОВЫЙ массив (не in-place чужой
 * ссылки, D-035), позиция дропается при qty→0, сортировка по item сохраняется.
 */
function removeOne(inv: readonly InventoryEntry[], item: ItemId): InventoryEntry[] {
  const next: InventoryEntry[] = [];
  for (const e of inv) {
    if (e.item === item) {
      if (e.qty - 1 > 0) next.push({ item, qty: e.qty - 1 });
    } else {
      next.push(e);
    }
  }
  return next;
}

/**
 * Добавляет РОВНО ОДНУ единицу `item` в инвентарь — НОВЫЙ массив (D-035), мержит с
 * существующей записью, сортировку по item сохраняет/восстанавливает.
 */
function addOne(inv: readonly InventoryEntry[], item: ItemId): InventoryEntry[] {
  const next: InventoryEntry[] = [];
  let merged = false;
  for (const e of inv) {
    if (e.item === item) {
      next.push({ item, qty: e.qty + 1 });
      merged = true;
    } else {
      next.push(e);
    }
  }
  if (!merged) next.push({ item, qty: 1 });
  next.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  return next;
}

/** Наземный лут поля (или []). */
function invOf(resources: ResourceStore, eid: EntityId): readonly InventoryEntry[] {
  return resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
}

/**
 * Система ArtifactSearch (`every: 1`). Каждый тик исполняет подбор артефактов стоящими
 * в аномальных полях NPC с Task=SEARCH. Порядок в конвейере (2.16): после Movement
 * (NPC прибыл), около Trade/Encounters. Детерминирована, rng не использует.
 */
export const ArtifactSearch: System = {
  name: 'ArtifactSearch',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const ecs = world.ecs;
    const resources = world.resources;

    // loc → аномальные поля этой локации (сорт. по eid — queryEntities сортирует).
    // Один раз до цикла NPC (как settlementByLoc у Trade). Пусто ⇒ ранний выход.
    const fieldsByLoc = new Map<number, EntityId[]>();
    for (const f of queryEntities(ecs, [AnomalyField, Position])) {
      const l = POS.loc[f] as number;
      let bucket = fieldsByLoc.get(l);
      if (bucket === undefined) {
        bucket = [];
        fieldsByLoc.set(l, bucket);
      }
      bucket.push(f);
    }
    if (fieldsByLoc.size === 0) return; // нет полей — no-op (голдены Фазы 1 целы)

    // NPC с Task=SEARCH, стоящие в локации поля. Лут поля перечитывается СВЕЖИМ на
    // каждого NPC (последовательные подборы одного тика видят опустошённое поле).
    for (const npcEid of queryEntities(ecs, [Human, Alive, Task, Position])) {
      if ((TASK.kind[npcEid] as number) !== TaskKind.SEARCH) continue;
      const loc = POS.loc[npcEid] as number;
      if ((POS.dest[npcEid] as number) !== loc) continue; // ещё в пути — не стоит
      const fields = fieldsByLoc.get(loc);
      if (fields === undefined) continue; // на локации нет поля

      // Поле-носитель: min-eid поле этой loc, на СВЕЖЕМ луте которого есть артефакт.
      let fieldEid: EntityId | undefined;
      let fieldInv: readonly InventoryEntry[] | undefined;
      let item: ItemId | undefined;
      for (const f of fields) {
        const inv = invOf(resources, f);
        const pick = pickArtifact(inv);
        if (pick !== undefined) {
          fieldEid = f;
          fieldInv = inv;
          item = pick;
          break;
        }
      }
      if (fieldEid === undefined || fieldInv === undefined || item === undefined) continue;

      // ПЕРЕВОД (закон №3, D-035): одна единица артефакта поле→NPC новыми массивами.
      const npcInv = invOf(resources, npcEid);
      resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, fieldEid, removeOne(fieldInv, item));
      resources.set<readonly InventoryEntry[]>(INVENTORY_KEY, npcEid, addOne(npcInv, item));

      // Причинность (закон №6, D-030/D-047): подбор — следствие задачи SEARCH.
      const causeRaw = TASK.causeEvent[npcEid] as number;
      const cause: EventId | null = causeRaw > 0 ? (causeRaw as EventId) : null;
      bus.publish({
        type: 'artifact/collected',
        causedBy: cause,
        payload: { collector: npcEid, field: fieldEid, item, qty: 1, loc: loc as LocationId },
      });
    }
  },
};
