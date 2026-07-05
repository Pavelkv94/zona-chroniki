/**
 * @module @zona/shared/view
 *
 * КОНТРАКТ «ВИД НА МИР» Sim→UI (задача 4.1, D-076). ФУНДАМЕНТ Фазы 4 (интерфейс
 * наблюдателя): plain-СЕРИАЛИЗУЕМЫЙ снимок состояния сущностей на тик, который ядро
 * (`@zona/sim/view/export`) собирает ЧТЕНИЕМ ECS+ResourceStore и отдаёт наружу. От
 * этих форм зависят Worker-мост и все панели UI (карта, список, инспектор).
 *
 * ── ЗАКОН №5 (граница ECS ↔ UI), КРИТИЧНО ────────────────────────────────────
 * Здесь — ТОЛЬКО plain-типы: числа, строки, branded-id `@zona/shared` и уже
 * существующие plain-контракты (`MemoryRecord`/`RelationEntry`). НИ ОДИН bitecs/ECS
 * тип (`ComponentRef`, `EcsWorld`, SoA-колонка) сюда НЕ течёт — пакет `@zona/shared`
 * физически не зависит от bitecs/DOM/Node (D-003/D-011). Экспортёры в `/sim` читают
 * ECS ВНУТРИ и возвращают эти формы; движок остаётся приватным (D-011). grep-тест
 * (задача 4.1) закрепляет: в этом файле нет импортов bitecs.
 *
 * ── D-006 (read-only презентация) ────────────────────────────────────────────
 * Как `renderEventLog` (D-006), экспортёры этих форм — ЧИСТОЕ ЧТЕНИЕ: они НЕ система,
 * в конвейер тика НЕ входят, мир НЕ мутируют и событий НЕ эмитят. Поэтому вычисление
 * `WorldView`/`EntityDetail` не двигает голдены (D-080: Фаза 4 — наблюдатель, не
 * участник симуляции).
 *
 * ── Два уровня детализации ────────────────────────────────────────────────────
 *  - `WorldView` (+`EntityView[]`) — ЛЁГКИЙ снимок КАЖДЫЙ тик: минимум для карты/
 *    списка (позиция, вид, фракция, доля HP, задача, флаги). Сортирован по eid
 *    (детерминизм, закон №8).
 *  - `EntityDetail` — ТЯЖЁЛОЕ полное состояние ПО ЗАПРОСУ (клик по сущности): нужды,
 *    инвентарь, деньги, память, отношения, слава, недавние события. Шлётся не каждый
 *    тик.
 */

import type { EntityId, EventId, FactionId, ItemId, LocationId, Tick } from './ids';
import type { MemoryRecord, RelationEntry } from './memory';

/**
 * СТРОКОВЫЙ вид сущности для карты/инспектора — НЕ ECS-тег (закон №5: наружу течёт
 * стабильный строковый enum, а не `ComponentRef` тега Human/Corpse/Animal/Settlement).
 * РАСШИРЯЕМ: мутанты/зомби (`'mutant'`/`'zombie'`) появятся, когда их сущности будут
 * заведены — union дополняется APPEND-ONLY, потребители обязаны иметь default-ветку.
 */
export type EntityKind = 'human' | 'animal' | 'corpse' | 'settlement';

/**
 * ЛЁГКИЙ вид ОДНОЙ сущности (шлётся каждый снапшот). Минимум для карты и списка.
 *  - `kind`      — строковый вид (см. `EntityKind`), выведен из тегов ВНУТРИ экспортёра;
 *  - `faction`   — id фракции из ResourceStore `'faction'`, либо `null` (у животных/
 *                  трупов/поселений записи нет — `null`);
 *  - `loc`       — текущая локация; `dest` — цель перехода или `null`, если стоит на
 *                  месте (`dest === loc`, без sentinel, D-019); `etaTicks` — тиков до
 *                  прибытия (0, если стоит);
 *  - `hpFrac`    — доля здоровья [0..1] (`hp / HEALTH_MAX`, кламп); у сущностей без
 *                  здоровья (поселение) — `1` (не «повреждаемо»);
 *  - `task`      — код `TaskKind` текущей задачи или `null` (нет компонента Task);
 *  - `inCombat`  — участник открытого столкновения (см. `export.ts`: в 4.1 всегда
 *                  `false` — бой длится один тик, персистентного состояния нет);
 *  - `carrying`  — несёт ли ЦЕННОЕ (в инвентаре есть предмет kind `'artifact'`);
 *  - `alive`     — несёт ли тег Alive.
 */
export interface EntityView {
  readonly eid: EntityId;
  readonly kind: EntityKind;
  readonly faction: FactionId | null;
  readonly loc: LocationId;
  readonly dest: LocationId | null;
  readonly etaTicks: number;
  readonly hpFrac: number;
  readonly task: number | null;
  readonly inCombat: boolean;
  readonly carrying: boolean;
  readonly alive: boolean;
}

/**
 * Снимок мира на тик: часы + погода + сущности (СОРТ. по eid) + сводка населения.
 *  - `day`     — игровой день = `floor(tick / TICKS_PER_DAY)` (0-based);
 *  - `weather` — КОД погоды (индекс `WEATHER_TYPES`, как `WorldClock.weather`);
 *  - `entities`— все видимые сущности (human/animal/corpse/settlement), сорт. по eid;
 *  - `population` — быстрая сводка живых людей/животных и трупов (по вычисленному
 *                   `kind`: мёртвый человек считается `corpse`, не `human`).
 */
export interface WorldView {
  readonly day: number;
  readonly tick: Tick;
  readonly weather: number;
  readonly entities: readonly EntityView[];
  readonly population: {
    readonly humans: number;
    readonly animals: number;
    readonly corpses: number;
  };
}

/** Имя NPC для инспектора (форма ResourceStore `'name'`, D-007; закон №4). */
export interface EntityName {
  readonly first: string;
  readonly last: string;
  readonly nickname: string;
}

/** Текущая задача сущности для инспектора (форма компонента Task). */
export interface EntityTask {
  readonly kind: number;
  readonly targetLoc?: LocationId;
  readonly targetEid?: EntityId;
}

/**
 * ТЯЖЁЛОЕ полное состояние сущности ПО ЗАПРОСУ (клик в инспекторе). Собирается
 * глубоким чтением компонентов и ResourceStore; шлётся не каждый тик.
 *  - `name`        — имя (только у людей; у животных/поселений опущено);
 *  - `dest`        — цель перехода (опущена, если стоит на месте);
 *  - `species`     — строковый ключ вида (`SpeciesData.key`) — только у живых животных
 *                    (трупы теряют компонент Animal ⇒ вид не восстановим);
 *  - `needs`       — нужды [0..100] (у трупа/поселения без компонента Needs — нули);
 *  - `hp`          — сырые очки здоровья (у поселения без Health — 0);
 *  - `task`        — текущая задача (опущена, если компонента Task нет);
 *  - `inventory`   — предметы парами `[itemId, qty]`, СОРТ. по itemId;
 *  - `money`       — деньги (ResourceStore `'money'`, 0 при отсутствии);
 *  - `memory`/`relations` — plain-массивы 2.15 (уже типизированы в `@zona/shared`);
 *  - `fame`        — накопленная известность (ResourceStore `'fame'`, D-067);
 *  - `recentEvents`— id событий лога, где сущность УЧАСТВУЕТ (недавнее окно; см. export.ts).
 */
export interface EntityDetail {
  readonly eid: EntityId;
  readonly kind: EntityKind;
  readonly faction: FactionId | null;
  readonly name?: EntityName;
  readonly loc: LocationId;
  readonly dest?: LocationId;
  readonly species?: string;
  readonly needs: {
    readonly hunger: number;
    readonly thirst: number;
    readonly fatigue: number;
    readonly fear: number;
  };
  readonly hp: number;
  readonly task?: EntityTask;
  readonly inventory: readonly (readonly [ItemId, number])[];
  readonly money: number;
  readonly memory: readonly MemoryRecord[];
  readonly relations: readonly RelationEntry[];
  readonly fame: number;
  readonly recentEvents: readonly EventId[];
}
