/**
 * @module @zona/sim/view/export
 *
 * ЭКСПОРТЁРЫ «ВИДА НА МИР» Sim→UI (задача 4.1, D-076). ФУНДАМЕНТ Фазы 4 (интерфейс
 * наблюдателя): собирают из приватного ECS+ResourceStore plain-СЕРИАЛИЗУЕМЫЕ формы
 * `@zona/shared` (`WorldView`/`EntityView`/`EntityDetail`) для Worker-моста и панелей
 * UI. НЕ система: в конвейер тика НЕ входят, worldgen их НЕ зовёт.
 *
 * ── ЧТО ЧИТАЕТ ────────────────────────────────────────────────────────────────
 *  - SoA-компоненты (`Position`/`Health`/`Task`/`Needs`/`Animal`/`WorldClock`) через
 *    типизированные проекции колонок (как worldgen), под гейтом `hasComponent`;
 *  - ТЕГИ (`Human`/`Corpse`/`Alive`) — для вывода строкового `kind` и `alive`;
 *  - `ResourceStore` (`'name'`/`'faction'`/`'inventory'`/`'money'`/`'memory'`/
 *    `'relations'`/`'fame'`) через `get` (D-050/D-058/D-067);
 *  - `WorldClock` singleton — погода; день выведен из `world.tick` (`TICKS_PER_DAY`);
 *  - `data` (`getSpecies`/`getItem`) — ключ вида и признак «артефакт» (закон №10);
 *  - `bus.log` — для `recentEvents` (глубокое чтение по клику, O(лог) допустимо).
 *
 * ── D-006 / ЧИСТОЕ ЧТЕНИЕ (доказано тестом) ──────────────────────────────────
 * Как `renderEventLog` (D-006): НЕ мутируют мир, НЕ эмитят события, НЕ трогают лог/
 * ResourceStore/ECS на запись. `hashSnapshot(serialize(world))` до == после экспорта
 * (тест 4.1). Детерминированы (закон №8): обходы отсортированы по eid/itemId, никакой
 * итерации по Map/Set без сортировки. Поэтому Фаза 4 НЕ двигает голдены (D-080).
 *
 * ── ЗАКОН №5 (ГРАНИЦА ECS ↔ UI), КРИТИЧНО ────────────────────────────────────
 * Возвращают ТОЛЬКО plain-типы `@zona/shared` — НИ ОДИН bitecs/ECS-тип
 * (`ComponentRef`, `EcsWorld`, SoA-колонка) не течёт в `WorldView`/`EntityView`/
 * `EntityDetail`. Обёртки `core/ecs` (`queryEntities`/`hasComponent`/`existsEntity`)
 * ЧИТАЮТСЯ ВНУТРИ, но НЕ реэкспортируются (D-011). Пакет остаётся headless (закон №5).
 *
 * Пример:
 * ```ts
 * const view = exportWorldView(world);      // лёгкий снимок каждый тик
 * const detail = exportEntityDetail(world, view.entities[0]!.eid); // по клику
 * ```
 */

import type {
  EntityId,
  EventId,
  FactionId,
  ItemId,
  LocationId,
  MemoryRecord,
  RelationEntry,
  EntityKind,
  EntityView,
  WorldView,
  EntityName,
  EntityTask,
  EntityDetail,
} from '@zona/shared';
import type { SimWorld } from '../core/world';
import { queryEntities, hasComponent, existsEntity } from '../core/ecs';
import {
  Position,
  Health,
  Task,
  Needs,
  Animal,
  WorldClock,
  Human,
  Corpse,
  Alive,
  Settlement,
} from '../core/components';
import { getSpecies, getItem } from '../data/index';
import { HEALTH_MAX } from '../balance/needs';
import { TICKS_PER_DAY } from '../balance/time';
import { MEMORY_KEY, RELATIONS_KEY } from '../systems/memory';
import { FAME_KEY, participantsOf } from '../narrative/significance';

// ── Типизированные проекции SoA-колонок (как worldgen; наружу не текут) ───────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
const HP = Health as unknown as { hp: Float32Array };
const TSK = Task as unknown as { kind: Uint8Array; targetLoc: Uint32Array; targetEid: Uint32Array };
const NEED = Needs as unknown as {
  hunger: Float32Array;
  thirst: Float32Array;
  fatigue: Float32Array;
  fear: Float32Array;
};
const ANIM = Animal as unknown as { species: Uint8Array };
const CLOCK = WorldClock as unknown as { weather: Uint8Array };

/** «Холодная» запись имени сталкера (форма ResourceStore 'name', D-007). */
interface NameRecord {
  readonly first: string;
  readonly last: string;
  readonly nickname: string;
}

/** Единица инвентаря в ResourceStore (ссылка на предмет + количество, закон №3). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/**
 * Ключи ResourceStore БЕЗ экспортируемой константы (совпадают с литералами worldgen,
 * D-007/D-046). Держим рядом с потребителем, чтобы не плодить магические строки в теле.
 */
const NAME_KEY = 'name';
const FACTION_KEY = 'faction';
const INVENTORY_KEY = 'inventory';
const MONEY_KEY = 'money';

/**
 * Размер окна `recentEvents` (последние N событий сущности) — ПРЕЗЕНТАЦИОННЫЙ предел,
 * НЕ балансовая константа (закон №7 про баланс симуляции): не влияет на мир, лишь
 * ограничивает вес детали инспектора. Инспектор показывает недавнее, а не всю историю.
 */
const RECENT_EVENTS_LIMIT = 50;

/**
 * Строковый `kind` сущности по ТЕГАМ (закон №5: наружу — строковый enum, не ECS-тег).
 * ПОРЯДОК ПРОВЕРКИ важен: `Corpse` ПЕРВЫМ — мёртвый человек несёт И `Human`, И `Corpse`
 * (Death снимает `Alive`, вешает `Corpse`, но `Human`-тег остаётся) ⇒ он `'corpse'`,
 * а не `'human'`. Затем `Human`, `Animal`, `Settlement`. `null` — сущность не одна из
 * видимых на карте (часы мира, аномальное поле): в `WorldView` она не попадает, а
 * `exportEntityDetail` для неё вернёт `null` (её нельзя «кликнуть»).
 */
function classifyKind(world: SimWorld, eid: EntityId): EntityKind | null {
  if (hasComponent(world.ecs, Corpse, eid)) return 'corpse';
  if (hasComponent(world.ecs, Human, eid)) return 'human';
  if (hasComponent(world.ecs, Animal, eid)) return 'animal';
  if (hasComponent(world.ecs, Settlement, eid)) return 'settlement';
  return null;
}

/** Доля здоровья [0..1] (`hp / HEALTH_MAX`, кламп); без Health (поселение) — 1. */
function hpFracOf(world: SimWorld, eid: EntityId): number {
  if (!hasComponent(world.ecs, Health, eid)) return 1;
  const frac = HP.hp[eid as number]! / HEALTH_MAX;
  if (frac < 0) return 0;
  if (frac > 1) return 1;
  return frac;
}

/** Фракция из ResourceStore 'faction' или null (у животных/трупов/поселений — null). */
function factionOf(world: SimWorld, eid: EntityId): FactionId | null {
  return world.resources.get<FactionId>(FACTION_KEY, eid) ?? null;
}

/** Несёт ли сущность ЦЕННОЕ — в инвентаре есть предмет kind 'artifact' (закон №3). */
function isCarrying(world: SimWorld, eid: EntityId): boolean {
  const inv = world.resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid);
  if (inv === undefined) return false;
  for (const entry of inv) {
    // Все itemId инвентаря существуют в items.json (закон №3) — getItem не бросит.
    if (getItem(entry.item).kind === 'artifact') return true;
  }
  return false;
}

/**
 * Лёгкий `EntityView` для сущности `eid` известного `kind`. Читает SoA-колонки под
 * гейтом `hasComponent` (D-024: без гейта прочли бы «холодный» остаток слота).
 * `dest === loc` ⇒ стоит на месте ⇒ `dest = null`, `etaTicks = 0` (D-019, без sentinel).
 */
function toEntityView(world: SimWorld, eid: EntityId, kind: EntityKind): EntityView {
  const i = eid as number;
  const hasPos = hasComponent(world.ecs, Position, eid);
  const loc = (hasPos ? POS.loc[i]! : 0) as LocationId;
  const rawDest = hasPos ? POS.dest[i]! : 0;
  const dest = hasPos && rawDest !== POS.loc[i]! ? (rawDest as LocationId) : null;
  const etaTicks = hasPos ? POS.etaTicks[i]! : 0;
  const task = hasComponent(world.ecs, Task, eid) ? TSK.kind[i]! : null;
  return {
    eid,
    kind,
    faction: factionOf(world, eid),
    loc,
    dest,
    etaTicks,
    hpFrac: hpFracOf(world, eid),
    task,
    // inCombat: столкновение живёт РОВНО ОДИН тик (encounter/started+resolved в одном
    // тике, см. events.ts) — персистентного «в бою» состояния на сущности НЕТ, читать
    // нечего. Вычислять его сканом лога `bus.at(tick)` дорого (O(лог) на КАЖДЫЙ экспорт
    // каждый тик) и неоднозначно (буфер текущего тика ещё не закоммичен). В 4.1 — всегда
    // false; TODO: «недавно в бою» из закоммиченного окна encounter-событий — отдельная
    // задача Фазы 4, чтобы не тянуть тяжёлый лог-скан в горячий per-tick экспорт.
    inCombat: false,
    carrying: isCarrying(world, eid),
    alive: hasComponent(world.ecs, Alive, eid),
  };
}

/**
 * ЛЁГКИЙ снимок мира на тик (задача 4.1, D-076). Итерирует носителей видимых тегов
 * (`Human`/`Animal`/`Corpse`/`Settlement`), собирает `EntityView[]` СОРТ. по eid,
 * читает `WorldClock` (погода) и выводит день из `world.tick`. ЧИСТАЯ, детерминированная,
 * НЕ мутирует и НЕ эмитит события (D-006/D-080 ⇒ голдены целы).
 */
export function exportWorldView(world: SimWorld): WorldView {
  // Объединяем носителей видимых тегов в множество (сущность может нести несколько:
  // мёртвый человек — Human+Corpse), затем сорт. по eid (детерминизм, закон №8).
  const set = new Set<EntityId>();
  for (const comp of [Human, Animal, Corpse, Settlement]) {
    for (const eid of queryEntities(world.ecs, [comp])) set.add(eid);
  }
  const eids = [...set].sort((a, b) => (a as number) - (b as number));

  const entities: EntityView[] = [];
  let humans = 0;
  let animals = 0;
  let corpses = 0;
  for (const eid of eids) {
    const kind = classifyKind(world, eid);
    if (kind === null) continue; // недостижимо (eid из тех же тегов), но типобезопасно
    entities.push(toEntityView(world, eid, kind));
    if (kind === 'human') humans++;
    else if (kind === 'animal') animals++;
    else if (kind === 'corpse') corpses++;
  }

  // Часы мира: singleton-носитель WorldClock (worldgen 1.3). Пустой мир — нет носителя
  // ⇒ погода 0 (как стартовое 'clear', индекс 0). Берём min-eid (детерминизм).
  const clocks = queryEntities(world.ecs, [WorldClock]);
  const weather = clocks.length > 0 ? CLOCK.weather[clocks[0]! as number]! : 0;

  return {
    day: Math.floor(world.tick / TICKS_PER_DAY),
    tick: world.tick,
    weather,
    entities,
    population: { humans, animals, corpses },
  };
}

/**
 * ЛЁГКИЙ ИНДЕКС ИМЁН людей мира (задача 4.3, D-081) — `eid → EntityName`. РЕЗОЛВ имён
 * для read-time рендера эфира (`renderMessage.ctx.nameOf`): `EntityView`/`ViewDelta`
 * ИМЁН НЕ несут (лёгкий снимок каждый тик), а строка радио-сообщения требует имя
 * говорящего/субъекта. Имена ЗАДАЮТСЯ ПРИ СПАВНЕ и не меняются (worldgen/PopulationInflux)
 * ⇒ индекс дёшев и стабилен: воркер шлёт его ДЕЛЬТОЙ (только новые/изменившиеся eid),
 * UI кэширует и строит `nameOf`.
 *
 * ЧИТАЕТ носителей `Human` (только у людей есть имя; животных не касается) — ВКЛЮЧАЯ
 * трупы (Death снимает `Alive`, но `Human` и запись `'name'` СОХРАНЯЕТ), чтобы имя
 * ПОГИБШЕГО субъекта эфира всё ещё резолвилось. Обход `queryEntities` сорт. по eid
 * (детерминизм, закон №8); ключи-числа объекта итерируются по возрастанию.
 *
 * ── ЗАКОН №5 / D-006 (как остальные экспортёры) ───────────────────────────────
 * Возвращает PLAIN `Record<number, EntityName>` — ни один bitecs-тип наружу не течёт;
 * НЕ система, в конвейер не входит, мир НЕ мутирует и события НЕ эмитит (hash до==после)
 * ⇒ голдены целы (D-080). `EntityName` — уже существующий plain-контракт `@zona/shared`.
 */
export function exportNames(world: SimWorld): Record<number, EntityName> {
  const out: Record<number, EntityName> = {};
  for (const eid of queryEntities(world.ecs, [Human])) {
    const n = world.resources.get<NameRecord>(NAME_KEY, eid);
    if (n === undefined) continue; // человек без записи имени (не должно быть, закон №4) — пропуск
    out[eid as number] = { first: n.first, last: n.last, nickname: n.nickname };
  }
  return out;
}

/**
 * ГЛУБОКОЕ полное состояние сущности `eid` (задача 4.1, D-076) — ПО ЗАПРОСУ (клик),
 * не каждый тик. `null`, если сущности нет (`existsEntity`) ИЛИ она не «кликабельна»
 * (не одна из видимых — часы мира/аномальное поле: в `WorldView` её нет, детали ей
 * не нужны). Читает компоненты (под гейтом `hasComponent`, D-024) + ResourceStore
 * (`name`/`faction`/`inventory`/`money`/`memory`/`relations`/`fame`) и лог (recentEvents).
 * ЧИСТОЕ ЧТЕНИЕ (D-006): мир не трогает (тест «hash до == после»).
 */
export function exportEntityDetail(world: SimWorld, eid: EntityId): EntityDetail | null {
  if (!existsEntity(world.ecs, eid)) return null;
  const kind = classifyKind(world, eid);
  if (kind === null) return null; // существует, но не видимая на карте сущность
  const i = eid as number;

  const hasPos = hasComponent(world.ecs, Position, eid);
  const loc = (hasPos ? POS.loc[i]! : 0) as LocationId;
  const dest =
    hasPos && POS.dest[i]! !== POS.loc[i]! ? (POS.dest[i]! as LocationId) : undefined;

  // Нужды: у трупа/поселения компонента Needs нет (Death снимает; поселение не несёт)
  // ⇒ нули (гейт против «холодного» остатка слота, D-024).
  const hasNeeds = hasComponent(world.ecs, Needs, eid);
  const needs = {
    hunger: hasNeeds ? NEED.hunger[i]! : 0,
    thirst: hasNeeds ? NEED.thirst[i]! : 0,
    fatigue: hasNeeds ? NEED.fatigue[i]! : 0,
    fear: hasNeeds ? NEED.fear[i]! : 0,
  };
  const hp = hasComponent(world.ecs, Health, eid) ? HP.hp[i]! : 0;

  // Вид — только у ЖИВОГО животного (труп теряет Animal ⇒ вид не восстановим). key —
  // стабильный контент-id (закон №10), как FactionId-строка.
  const species = hasComponent(world.ecs, Animal, eid)
    ? getSpecies(ANIM.species[i]!).key
    : undefined;

  // Задача (если есть Task). targetEid>0 ⇒ реальная цель (eid 0 зарезервирован);
  // targetLoc>0 ⇒ явная целевая локация (loc 0 = Кордон как явная цель здесь не
  // различима от «не задано» — presentational, авторитетен Task; редкий кейс).
  let task: EntityTask | undefined;
  if (hasComponent(world.ecs, Task, eid)) {
    const t: { kind: number; targetLoc?: LocationId; targetEid?: EntityId } = { kind: TSK.kind[i]! };
    if (TSK.targetLoc[i]! > 0) t.targetLoc = TSK.targetLoc[i]! as LocationId;
    if (TSK.targetEid[i]! > 0) t.targetEid = TSK.targetEid[i]! as EntityId;
    task = t;
  }

  // Инвентарь → пары [itemId, qty], СОРТ. по itemId (закон №8; store уже сортирован,
  // но пересортировываем ради инварианта формы независимо от источника).
  const invRaw = world.resources.get<readonly InventoryEntry[]>(INVENTORY_KEY, eid) ?? [];
  const inventory: (readonly [ItemId, number])[] = invRaw
    .map((e) => [e.item, e.qty] as readonly [ItemId, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const name = world.resources.get<NameRecord>(NAME_KEY, eid);
  const money = world.resources.get<number>(MONEY_KEY, eid) ?? 0;
  const memory = world.resources.get<readonly MemoryRecord[]>(MEMORY_KEY, eid) ?? [];
  const relations = world.resources.get<readonly RelationEntry[]>(RELATIONS_KEY, eid) ?? [];
  const fame = world.resources.get<number>(FAME_KEY, eid) ?? 0;

  const detail: EntityDetail = {
    eid,
    kind,
    faction: factionOf(world, eid),
    loc,
    needs,
    hp,
    inventory,
    money,
    memory,
    relations,
    fame,
    recentEvents: recentEventsOf(world, eid),
  };
  // Опциональные поля — только когда есть (exactOptionalPropertyTypes-safe).
  if (name !== undefined) (detail as { name?: EntityName }).name = name;
  if (dest !== undefined) (detail as { dest?: LocationId }).dest = dest;
  if (species !== undefined) (detail as { species?: string }).species = species;
  if (task !== undefined) (detail as { task?: EntityTask }).task = task;
  return detail;
}

/**
 * id последних `RECENT_EVENTS_LIMIT` событий лога, где сущность `eid` УЧАСТВУЕТ.
 * «Участие» = `eid` среди `participantsOf(ev)` (канон нарратива, значимые события) ЛИБО
 * прямой актёр событий распорядка (`task/selected`/`move/*`, самые частые per-entity).
 * Скан ВСЕГО лога O(лог) допустим: это глубокое чтение ПО КЛИКУ, не в горячем тике.
 * Порядок — по возрастанию id (хронология, детерминизм, закон №8), окно — последние N.
 */
function recentEventsOf(world: SimWorld, eid: EntityId): readonly EventId[] {
  const ids: EventId[] = [];
  for (const ev of world.bus.log) {
    if (eventInvolves(ev, eid)) ids.push(ev.id);
  }
  // Последние N (окно недавнего), сохраняя хронологический порядок.
  return ids.length > RECENT_EVENTS_LIMIT ? ids.slice(ids.length - RECENT_EVENTS_LIMIT) : ids;
}

/**
 * УЧАСТВУЕТ ли `eid` в событии `ev`. База — `participantsOf` (значимые/боевые/
 * нарративные события). Плюс прямые актёры распорядка, которые `participantsOf`
 * СОЗНАТЕЛЬНО опускает как «шумные» для летописи, но для инспектора КОНКРЕТНОЙ
 * сущности они ценны: `task/selected`, `move/departed`, `move/arrived` (актёр — `eid`
 * в payload). Так `recentEvents` активного NPC не пуст даже без боёв.
 */
function eventInvolves(ev: import('@zona/shared').SimEvent, eid: EntityId): boolean {
  for (const p of participantsOf(ev)) if (p === eid) return true;
  switch (ev.type) {
    case 'task/selected':
    case 'move/departed':
    case 'move/arrived':
      return ev.payload.eid === eid;
    default:
      return false;
  }
}
