/**
 * @module @zona/shared/events
 *
 * Контракт события шины (append-only лог, задача 0.4, D-005). Чистые типы без
 * зависимостей от bitecs/DOM/Node (закон №5): реализация шины живёт в
 * `@zona/sim/core/events`, а форму события знают все пакеты монорепо (ui читает
 * лог, headless прогоняет, narrative строит летопись).
 *
 * `SimEventBase` — общая «шапка» любого события:
 *  - `id`       — монотонный `EventId`, присваивается шиной при `publish`
 *                 (переживает save/load, C-4);
 *  - `tick`     — тик, на котором событие ОПУБЛИКОВАНО (берётся из мира);
 *  - `type`     — строковый дискриминант union'а;
 *  - `causedBy` — id события-причины или `null` для корня причинной цепочки
 *                 (закон №6: каждое событие несёт причину).
 *
 * `SimEvent` — расширяемый дискриминированный union. Фаза 0 знает только
 * СЛУЖЕБНЫЕ типы ядра (`sim/tickStarted`, `sim/snapshotTaken`); доменные события
 * (бой, миграция, торговля) профильные инженеры добавят позже, расширив union
 * новыми членами с уникальным `type` и своим `payload`. Фаза 1: система Movement
 * (1.4) добавляет `move/departed` (сущность вышла из локации в соседнюю) и
 * `move/arrived` (сущность достигла соседней локации). Причинность (закон №6):
 * `move/departed.causedBy` → событие выбора задачи (`task/selected` из 1.8) или
 * `null`; `move/arrived.causedBy` → соответствующий `move/departed` этого шага.
 * Задача 1.6 (система Weather) добавляет `weather/changed` (среда сменила погоду);
 * `causedBy` → предыдущий `weather/changed` в логе (цепочка смен), `null` — первая
 * смена в истории мира (корень цепочки погоды).
 *
 * Пример:
 * ```ts
 * const e: SimEvent = {
 *   id: 1 as EventId,
 *   tick: 0,
 *   type: 'sim/tickStarted',
 *   causedBy: null,
 *   payload: { tick: 0 },
 * };
 * ```
 */

import type { EntityId, EventId, LocationId, Tick } from './ids';

/**
 * Вид физиологической нужды (дискриминант в `needs/threshold`). Совпадает с
 * именами полей компонента `Needs` (hunger/thirst/fatigue/fear). Страх (fear)
 * порогов от системы Needs не даёт (она его только затухает); его пересечение
 * порога публикует Perception (1.7) — тип нужды перечислен здесь ради полноты
 * контракта события.
 */
export type NeedKind = 'hunger' | 'thirst' | 'fatigue' | 'fear';

/**
 * Уровень серьёзности пересечённого порога нужды. Пока единственный —
 * `'critical'` (порог `*_CRITICAL` из balance/needs). Именованный уровень (а не
 * сырое число из balance) держит payload читаемым для летописи/логики и
 * расширяемым, если balance введёт промежуточные уровни (например `'warning'`).
 */
export type NeedLevel = 'critical';

/** Общая «шапка» любого события шины. */
export interface SimEventBase {
  /** Монотонный id, присваивается шиной при публикации (C-4). */
  readonly id: EventId;
  /** Тик публикации события (берётся из состояния мира). */
  readonly tick: Tick;
  /** Строковый дискриминант конкретного типа события. */
  readonly type: string;
  /** id события-причины; `null` — корень причинной цепочки (закон №6). */
  readonly causedBy: EventId | null;
}

/**
 * Дискриминированный union всех событий симуляции. Расширяется добавлением
 * новых членов `SimEventBase & { type: '<домен>/<имя>'; payload: … }`.
 */
export type SimEvent =
  | (SimEventBase & { type: 'sim/tickStarted'; payload: { readonly tick: Tick } })
  | (SimEventBase & { type: 'sim/snapshotTaken'; payload: { readonly hash: string } })
  | (SimEventBase & {
      type: 'move/departed';
      /** `eid` вышел из локации `from` в СОСЕДНЮЮ `to` (первый шаг маршрута). */
      payload: { readonly eid: EntityId; readonly from: LocationId; readonly to: LocationId };
    })
  | (SimEventBase & {
      type: 'move/arrived';
      /** `eid` достиг локации `at` (конец текущего шага маршрута). */
      payload: { readonly eid: EntityId; readonly at: LocationId };
    })
  | (SimEventBase & {
      type: 'weather/changed';
      /**
       * Среда сменила погоду с `from` на `to` (задача 1.6, система Weather). Оба
       * значения — КОДЫ погоды = индексы в `WEATHER_TYPES` (balance/weather), они
       * же `WorldClock.weather` (`WEATHER_CODE`). Число, а не строка-литерал, чтобы
       * `@zona/shared` не тянул перечень погод из `@zona/sim` (shared не зависит от
       * sim) и не дублировал контент (закон №10) — сопоставление кода с именем
       * делает потребитель (narrative) через `WEATHER_TYPES`. Погода — процедурная
       * генерация СРЕДЫ (детерминирована от seed), а не «X% исхода у сущности»,
       * поэтому `causedBy` ссылается на ПРЕДЫДУЩИЙ `weather/changed` (цепочка смен,
       * D-005/закон №6), либо `null` для самой первой смены в истории мира.
       */
      payload: { readonly from: number; readonly to: number };
    })
  | (SimEventBase & {
      type: 'needs/threshold';
      /**
       * Нужда `need` сущности `eid` ПЕРЕСЕКЛА порог `level` вверх (задача 1.5,
       * система Needs). Публикуется РОВНО ОДИН раз на пересечение (пока нужда
       * держится выше порога — не повторяется; упала и снова выросла — новое
       * событие). `causedBy: null` — физиология корень причинной цепочки (№2).
       */
      payload: { readonly eid: EntityId; readonly need: NeedKind; readonly level: NeedLevel };
    });
