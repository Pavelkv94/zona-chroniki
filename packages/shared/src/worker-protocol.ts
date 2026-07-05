/**
 * @module @zona/shared/worker-protocol
 *
 * КОНТРАКТ WORKER-МОСТА Sim⇄UI (задача 4.0, D-077/D-078). ГРАНИЦА `postMessage`
 * между Web Worker (крутит headless-`@zona/sim`) и React-наблюдателем (`@zona/ui`).
 * Здесь — ТОЛЬКО plain-СЕРИАЛИЗУЕМЫЕ дискриминированные union'ы: всё, что пересекает
 * `postMessage`, обязано быть JSON-representable (числа, строки, branded-id, массивы,
 * уже существующие plain-контракты `@zona/shared`).
 *
 * ── ЗАКОН №5 (граница ECS ↔ UI), КРИТИЧНО ────────────────────────────────────
 * Как `view.ts`, пакет `@zona/shared` физически НЕ зависит от bitecs/DOM/Node. НИ ОДИН
 * ECS-тип (`ComponentRef`, `EcsWorld`, SoA-колонка) не течёт в эти сообщения — наружу
 * из воркера едут только `WorldView`/`ViewDelta`/`EntityView`/`EntityDetail`/`SimEvent`/
 * `SnapshotJSON` (plain). Воркер импортирует `@zona/sim` ВНУТРИ и гоняет мир headless;
 * на `postMessage` он кладёт результат `exportWorldView`/`exportEntityDetail`/`serialize`
 * — plain-формы, а не движок (D-077: единственная граница — postMessage).
 *
 * ── ЗАКОН №8 (детерминизм), КРИТИЧНО ─────────────────────────────────────────
 * UI-команды влияют ТОЛЬКО на ТЕМП/паузу/шаг/инспекцию — НЕ на СОДЕРЖИМОЕ тиков.
 * `setSpeed` меняет, сколько тиков воркер продвигает за реальную секунду; `step`
 * продвигает ровно N тиков на паузе. Каждый тик считается тем же seeded-конвейером
 * (`registerPhase3Systems`), поэтому «тот же seed + тот же номер тика → тот же хэш»
 * держится независимо от того, как быстро/рвано наблюдатель прокрутил время.
 *
 * ── D-078 (дельты + throttle) ────────────────────────────────────────────────
 * Воркер шлёт не полный `WorldView` каждый тик, а `viewDelta` (только изменённые/
 * исчезнувшие сущности) с THROTTLE (~10–15 Гц, не на каждый sim-тик). Форму дельты
 * задаёт `ViewDelta` (ЧИСТО вычислима из пары WorldView, см. `@zona/ui/bridge/delta`):
 * применение `applyDelta(prev, viewDelta)` реконструирует следующий `WorldView` бит-в-бит.
 *
 * ── Направления ──────────────────────────────────────────────────────────────
 *  - `UiToWorker` — команды наблюдателя воркеру (init/setSpeed/step/inspect/requestSnapshot).
 *  - `WorkerToUi` — обновления воркера наблюдателю (view/viewDelta/logDelta/detail/
 *    snapshot/stats).
 */

import type { EntityId, Seed, Tick } from './ids';
import type { EntityView, EntityDetail, WorldView } from './view';
import type { SimEvent } from './events';
import type { SnapshotJSON } from './snapshot';

/**
 * ДЕЛЬТА двух `WorldView` (D-078). Несёт ТОЛЬКО изменения: `changed` — новые ИЛИ
 * отличающиеся хоть одним полем `EntityView` (сорт. по eid, детерминизм), `removed`
 * — eid сущностей, исчезнувших с прошлого снимка. Часы/погода передаются целиком
 * (`day`/`tick`/`weather`), а `population` НЕ несётся: она ПРОИЗВОДНА от итогового
 * набора сущностей (`applyDelta` пересчитывает её по `kind`), значит дельта минимальна.
 * Инвариант (тест 4.0): `applyDelta(prev, diffView(prev, next))` deep-equal `next`.
 */
export interface ViewDelta {
  /** Тик итогового снимка (как `WorldView.tick`). */
  readonly tick: Tick;
  /** Игровой день итогового снимка (`floor(tick / TICKS_PER_DAY)`). */
  readonly day: number;
  /** Код погоды итогового снимка (индекс `WEATHER_TYPES`). */
  readonly weather: number;
  /** Новые/изменённые `EntityView` (сорт. по eid, закон №8). */
  readonly changed: readonly EntityView[];
  /** eid сущностей, исчезнувших с прошлого снимка (сорт. по eid). */
  readonly removed: readonly EntityId[];
}

/**
 * UI→Worker: команды наблюдателя. Влияют лишь на ТЕМП/паузу/шаг/инспекцию (закон №8),
 * не на содержимое тиков.
 */
export type UiToWorker =
  /**
   * Собрать/восстановить ОДИН мир. Без `snapshot` — свежий мир от `seed`
   * (`createSimWorld`→`worldgen`→`registerPhase3Systems`). С `snapshot` — `deserialize`
   * (resume; `seed` в сообщении для отображения/консистентности, авторитетен snapshot).
   * ВАЖНО: воркер крутит РОВНО ОДИН мир (SoA-колонки bitecs глобальны на процесс).
   */
  | { readonly type: 'init'; readonly seed: Seed; readonly snapshot?: SnapshotJSON }
  /**
   * Задать темп: сколько sim-тиков продвигать за РЕАЛЬНУЮ секунду. `0` — ПАУЗА.
   * Не влияет на содержимое тиков (закон №8), только на скорость наблюдения.
   */
  | { readonly type: 'setSpeed'; readonly ticksPerRealSecond: number }
  /** Продвинуть РОВНО `ticks` тиков (обычно на паузе — покадровый шаг). */
  | { readonly type: 'step'; readonly ticks: number }
  /** Запросить тяжёлую деталь сущности `eid` (клик в инспекторе → `detail`). */
  | { readonly type: 'inspect'; readonly eid: EntityId }
  /** Запросить полный снапшот мира (сохранение → `snapshot`). */
  | { readonly type: 'requestSnapshot' };

/**
 * Worker→UI: обновления наблюдателю. plain-формы `@zona/shared` (закон №5) — ни один
 * bitecs-тип не пересекает `postMessage` (D-077).
 */
export type WorkerToUi =
  /** ПОЛНЫЙ снимок мира (первый после init/resume; дальше — дельты, D-078). */
  | { readonly type: 'view'; readonly view: WorldView }
  /** ДЕЛЬТА к прошлому снимку (throttle ~10–15 Гц, D-078). Поля — как `ViewDelta`. */
  | {
      readonly type: 'viewDelta';
      readonly tick: Tick;
      readonly day: number;
      readonly weather: number;
      readonly changed: readonly EntityView[];
      readonly removed: readonly EntityId[];
    }
  /** НОВЫЕ события лога с прошлой отправки (для радио-эфира/летописи). */
  | { readonly type: 'logDelta'; readonly events: readonly SimEvent[] }
  /** Тяжёлая деталь сущности (ответ на `inspect`); `null` — не «кликабельна»/нет. */
  | { readonly type: 'detail'; readonly detail: EntityDetail | null }
  /** Полный снапшот (ответ на `requestSnapshot`) для сохранения. */
  | {
      readonly type: 'snapshot';
      readonly data: SnapshotJSON;
      readonly seed: Seed;
      readonly tick: Tick;
    }
  /** Периодическая телеметрия воркера (для тайм-бара/диагностики темпа). */
  | {
      readonly type: 'stats';
      readonly tick: Tick;
      readonly entityCount: number;
      readonly tickMs: number;
    };
