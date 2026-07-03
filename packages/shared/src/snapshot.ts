/**
 * @module @zona/shared/snapshot
 *
 * Контракт снапшота мира (save/load, задача 0.5, D-012). ЧИСТЫЕ типы без
 * зависимостей от bitecs/DOM/Node (закон №5): форму снапшота знают все пакеты
 * (headless пишет/читает файлы, ui показывает мета-данные), а реализация
 * сериализации живёт в `@zona/sim/core/snapshot` (0.5a — write-path) и
 * `deserialize` (0.5b — read-path).
 *
 * ── Форма (D-012) ───────────────────────────────────────────────────────────
 * `SnapshotJSON` — полностью JSON-safe снимок состояния мира. Ключевые
 * инварианты детерминизма (закон №8):
 *  - `entities` — только ЖИВЫЕ eid, по возрастанию (закон №3: покойников нет).
 *    Это ПРОИЗВОДНОЕ значение; авторитет по живым eid — `ecsIndex` (freelist),
 *    `entities` сверяется на deserialize (0.5b).
 *  - `resources` — ключи и eid внутри каждого ключа отсортированы; значения —
 *    только plain-JSON-данные (D-013: `Map/Set/классы/функции/undefined` → throw
 *    при сериализации).
 *  - `ecsIndex` — НЕПРОЗРАЧНЫЙ blob аллокатора bitecs (`EntityIndex`, D-011):
 *    плоские числа, нормализованные без дыр. `@zona/shared` не знает его формы —
 *    её знают только `@zona/sim/core/ecs` (export) и 0.5b (restore).
 *  - `rngState` — состояние ТОЛЬКО корневого rng (uint32, D-014); per-system
 *    форки stateless (D-009) и не сохраняются.
 *  - `eventSeq` — счётчик `EventId` шины (монотонность через save/load, C-4).
 *  - `eventLog` — весь append-only лог в порядке `EventId`.
 *  - `components` — SoA-компоненты bitecs. Пусто (`{}`), пока реестр компонентов
 *    пуст (Фаза 0 и задача 1.0). ЗАМОРОЖЕННАЯ форма колонки — `ComponentColumnJSON`
 *    (D-018): `{ eids:[живые,сорт по возр.], fields:{ f:number[] } }`, где
 *    `fields[f][i]` соответствует `eids[i]`, все длины равны, перечислены ТОЛЬКО
 *    живые носители (закон №3). Тип свойства оставлен `Record<string, JsonValue>`
 *    (значения снапшота НЕДОВЕРЕННЫЕ — форма проверяется на deserialize рантайм-
 *    валидацией, как `ecsIndex`), а конкретную форму фиксирует `ComponentColumnJSON`.
 *
 * Стабильность хэша (`hashSnapshot`) обеспечивает канонизатор в
 * `@zona/sim/core/snapshot`, а НЕ `JSON.stringify` (у него порядок ключей =
 * insertion order → нестабилен, нарушение закона №8).
 */

import type { EntityId, Seed, Tick } from './ids';
import type { SimEvent } from './events';

/**
 * Замкнутый рекурсивный тип JSON-значения. Всё, что попадает в снапшот, обязано
 * быть представимо этим типом (иначе канонизатор бросит на сериализации).
 * `undefined`, функции, символы, `Map`/`Set` и экземпляры классов НЕ входят.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

/**
 * ЗАМОРОЖЕННАЯ форма одной колонки SoA-компонента в снапшоте (D-018). Пишется
 * `serialize` и валидируется `deserialize`. Инварианты (закон №8, закон №3):
 *  - `eids` — ТОЛЬКО живые носители компонента, по возрастанию eid;
 *  - `fields` — по одному числовому массиву на поле (ФИКСИРОВАННЫЙ порядок задаёт
 *    реестр компонентов, не этот тип);
 *  - `fields[f][i]` соответствует `eids[i]`; длины всех массивов равны `eids.length`.
 *
 * Значения — plain-число (для `f32` — уже округлённое до f32, что делает канон
 * детерминированным). Тип структурно совместим с `JsonValue`, поэтому свойство
 * `SnapshotJSON.components` типизировано как `Record<string, JsonValue>`
 * (недоверенный вход → рантайм-валидация в `deserialize`), а эта форма — контракт
 * того, что `serialize` производит и что `deserialize` ожидает после проверки.
 */
export interface ComponentColumnJSON {
  /** Живые носители компонента, по возрастанию eid (закон №3/№8). */
  readonly eids: readonly EntityId[];
  /** Поле → колонка значений; `fields[f][i]` ↔ `eids[i]`, длины равны. */
  readonly fields: Record<string, readonly number[]>;
}

/**
 * Полный JSON-safe снимок состояния мира (D-012). Форма ЗАМОРОЖЕНА в 0.5a;
 * `deserialize` (0.5b) обязан принимать ровно её. `version: 1` — литерал:
 * рост схемы = рост версии + миграция.
 */
export interface SnapshotJSON {
  /** Версия формата снапшота. Рост схемы → рост версии + миграция. */
  readonly version: 1;
  /** Seed мира: одинаковый seed → одинаковая история (закон №8). */
  readonly seed: Seed;
  /** Тик, на котором снят снимок. */
  readonly tick: Tick;
  /** Состояние корневого rng, uint32 (D-014). Per-system форки не сохраняются. */
  readonly rngState: number;
  /** Счётчик выданных `EventId` шины (монотонность через save/load, C-4). */
  readonly eventSeq: number;
  /**
   * Непрозрачный blob аллокатора bitecs (`EntityIndex`, D-011): плоские числа,
   * без дыр. Авторитет по живым eid и порядку freelist. Форму знает только
   * `@zona/sim/core/ecs` (`exportEntityIndex`) и восстановление 0.5b.
   */
  readonly ecsIndex: JsonValue;
  /** Живые eid по возрастанию (закон №3). Производное от `ecsIndex`, сверяется в 0.5b. */
  readonly entities: readonly EntityId[];
  /**
   * «Холодные» данные ResourceStore. Ключи отсортированы; внутри ключа пары
   * `[eid, value]` отсортированы по eid; значения — plain JSON (D-013).
   */
  readonly resources: Record<string, ReadonlyArray<readonly [EntityId, JsonValue]>>;
  /** SoA-компоненты bitecs. Фаза 0: компонентов нет → `{}` (D-012). */
  readonly components: Record<string, JsonValue>;
  /** Весь append-only лог событий в порядке `EventId` (C-4). */
  readonly eventLog: readonly SimEvent[];
}
