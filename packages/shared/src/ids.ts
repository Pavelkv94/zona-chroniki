/**
 * @module @zona/shared/ids
 *
 * Branded-числовые и строковые идентификаторы ядра симуляции (D-003).
 *
 * Branded types — это `number`/`string`, помеченные фантомным полем `__brand`.
 * На рантайме это обычные числа/строки (нулевая стоимость), но компилятор
 * запрещает перепутать `EntityId` с `EventId` или с сырым `number`. Так контракты
 * ядра видны в `@zona/shared` без импорта bitecs (закон №5): `EntityId` bitecs —
 * тоже `number`, поэтому наши branded-id совместимы с движком через явный каст
 * внутри `@zona/sim`.
 *
 * Пример:
 * ```ts
 * import type { EntityId } from '@zona/shared';
 * const raw = 5;
 * const eid = raw as EntityId;        // явное «повышение» сырого числа до id
 * const bad: EntityId = 5;            // ❌ ошибка компиляции (нет бренда)
 * ```
 *
 * НАМЕРЕННО НЕ branded: `Tick` и `Seed` — прозрачные псевдонимы `number`.
 * Они участвуют в арифметике (`tick + 1`, `(t - phase) % every`, битовые
 * операции над seed в PRNG), где бренд только мешал бы, требуя постоянных
 * кастов. Их роль документирует имя типа, а не номинальная защита компилятора.
 */

/** Идентификатор сущности ECS. На рантайме — `number` (eid из bitecs). */
export type EntityId = number & { readonly __brand: 'EntityId' };

/** Монотонный идентификатор события шины (append-only лог, задача 0.4). */
export type EventId = number & { readonly __brand: 'EventId' };

/** Идентификатор локации мира. */
export type LocationId = number & { readonly __brand: 'LocationId' };

/** Номер тика симуляции. Начинается с 0, растёт на 1 каждый шаг планировщика. */
export type Tick = number;

/** Seed генератора мира. Трактуется как uint32 (см. core/rng.ts, задача 0.3). */
export type Seed = number;

/** Идентификатор фракции. Строка — ссылка на запись в /sim/data (закон №10). */
export type FactionId = string;

/** Идентификатор шаблона предмета. Строка — ссылка на запись в /sim/data. */
export type ItemId = string;
