/**
 * @module @zona/ui/store/store
 *
 * ZUSTAND-СТОР наблюдателя (задача 4.0). ЕДИНЫЙ источник состояния UI, читаемый всеми
 * панелями (карта/эфир/летопись/инспектор/тайм-бар). Держит ТЕКУЩИЙ `WorldView`
 * (реконструируемый применением `viewDelta`, D-078), окно радио/лог-событий (кольцевой
 * буфер), выбранную деталь сущности, темп/паузу и телеметрию. Действия шлют команды в
 * воркер через `WorkerClient`; входящие `WorkerToUi` применяются `applyMessage`.
 *
 * ── ЗАКОН №5 / D-077 ─────────────────────────────────────────────────────────
 * Стор оперирует ТОЛЬКО plain-контрактами `@zona/shared`; ядро симуляции живёт в
 * воркере. Ни один bitecs-тип сюда не попадает.
 *
 * ── ЗАКОН №8 ─────────────────────────────────────────────────────────────────
 * Действия влияют лишь на ТЕМП/паузу/шаг/инспекцию (`setSpeed`/`step`/`inspect`) — не
 * на содержимое тиков. Стор — читатель/командир, а не участник симуляции.
 *
 * ── ТЕСТИРУЕМОСТЬ (DoD 4.0) ──────────────────────────────────────────────────
 * Применение сообщений (`applyMessage`) и реконструкция вида — чистая логика над
 * состоянием: тестируется установкой состояния напрямую БЕЗ живого воркера/таймеров.
 * Воркер-клиент создаётся ЛЕНИВО при первом `init` (в браузере, main.tsx); в jsdom-
 * тестах `init` не вызывается — состояние выставляется через `setState`.
 */

import { create } from 'zustand';
import type {
  EntityDetail,
  EntityId,
  EntityName,
  Seed,
  SimEvent,
  SnapshotJSON,
  Tick,
  WorkerToUi,
  WorldView,
} from '@zona/shared';
import { applyDelta } from '../bridge/delta';
import { createWorkerClient, type WorkerClient } from '../bridge/worker-client';

/**
 * Размер окна лог-событий (кольцевой буфер). ПРЕЗЕНТАЦИОННЫЙ предел UI (сколько
 * последних событий держать для эфира/летописи), НЕ балансовая константа симуляции
 * (закон №7 — про /sim/balance): на мир не влияет, лишь ограничивает память панели.
 */
const LOG_WINDOW = 1000;

/** Телеметрия воркера (тайм-бар/диагностика темпа). */
export interface SimStats {
  readonly tick: Tick;
  readonly entityCount: number;
  readonly tickMs: number;
}

/** Форма состояния наблюдателя. */
export interface UiState {
  /** Текущий вид мира (реконструируется из view/viewDelta), `null` до init. */
  readonly view: WorldView | null;
  /** Окно последних лог-событий (кольцевой буфер, ≤ LOG_WINDOW). */
  readonly log: readonly SimEvent[];
  /**
   * КЭШ индекса имён `eid → EntityName` (задача 4.3, D-081). Копится дельтами `names`
   * воркера. Read-time рендер эфира строит `nameOf` из него (имя говорящего/субъекта —
   * `EntityView`/лог их не несут). Стабилен: имена задаются при спавне, только прибывают.
   */
  readonly names: Readonly<Record<number, EntityName>>;
  /** Деталь выбранной сущности (ответ на inspect), `null` — ничего не выбрано. */
  readonly detail: EntityDetail | null;
  /** eid выбранной для слежения/инспекции сущности. */
  readonly selectedEid: EntityId | null;
  /** Темп: sim-тиков за реальную секунду (`0` — пауза). */
  readonly speed: number;
  /** true, если на паузе (`speed === 0`). */
  readonly paused: boolean;
  /** Телеметрия воркера, `null` до первого stats. */
  readonly stats: SimStats | null;
  /** Последний полученный снапшот (для сохранения), `null` — не запрашивался. */
  readonly lastSnapshot: { readonly data: SnapshotJSON; readonly seed: Seed; readonly tick: Tick } | null;
  /** Подключён ли живой воркер-мост (создан после init). */
  readonly connected: boolean;

  // ── Команды воркеру (влияют лишь на темп/паузу/шаг/инспекцию, закон №8) ──────
  /** Собрать/восстановить мир: свежий от seed или resume из snapshot. */
  init(seed: Seed, snapshot?: SnapshotJSON): void;
  /** Задать темп (тиков/реальную секунду; 0 — пауза). */
  setSpeed(ticksPerRealSecond: number): void;
  /** Пауза (темп → 0). */
  pause(): void;
  /** Продвинуть ровно `ticks` тиков (обычно на паузе). */
  step(ticks: number): void;
  /** Выбрать сущность и запросить её деталь. */
  inspect(eid: EntityId): void;
  /** Сбросить выбор/деталь (закрыть инспектор). ЧИСТО read-side, воркеру не шлёт. */
  clearSelection(): void;
  /** Запросить полный снапшот мира (сохранение). */
  requestSnapshot(): void;

  // ── Применение входящих сообщений воркера (вызывает WorkerClient) ───────────
  /** Применить сообщение `WorkerToUi` к состоянию (view/viewDelta/logDelta/…). */
  applyMessage(msg: WorkerToUi): void;
}

/**
 * Клиент моста — module-level синглтон (ровно один воркер = ровно один мир, заметка
 * 4.1). Создаётся ЛЕНИВО при первом `init`. Держим вне zustand-состояния: это не
 * данные для рендера, а транспорт (не должен триггерить перерисовки).
 */
let client: WorkerClient | null = null;

export const useUiStore = create<UiState>((set, get) => {
  /** Гарантировать наличие клиента (создать при первом обращении в браузере). */
  const ensureClient = (): WorkerClient => {
    if (client === null) {
      client = createWorkerClient((msg) => get().applyMessage(msg));
    }
    return client;
  };

  return {
    view: null,
    log: [],
    names: {},
    detail: null,
    selectedEid: null,
    speed: 0,
    paused: true,
    stats: null,
    lastSnapshot: null,
    connected: false,

    init(seed, snapshot) {
      const c = ensureClient();
      // Новый мир — чистим окно/имена/деталь/выбор (прошлый мир больше не актуален).
      set({ view: null, log: [], names: {}, detail: null, selectedEid: null, stats: null, connected: true });
      c.post(snapshot ? { type: 'init', seed, snapshot } : { type: 'init', seed });
    },

    setSpeed(ticksPerRealSecond) {
      const tps = ticksPerRealSecond > 0 ? ticksPerRealSecond : 0;
      set({ speed: tps, paused: tps === 0 });
      client?.post({ type: 'setSpeed', ticksPerRealSecond: tps });
    },

    pause() {
      get().setSpeed(0);
    },

    step(ticks) {
      if (ticks <= 0) return;
      client?.post({ type: 'step', ticks });
    },

    inspect(eid) {
      set({ selectedEid: eid });
      client?.post({ type: 'inspect', eid });
    },

    clearSelection() {
      // Закрытие инспектора — чистое обнуление выбора/детали (закон №8: воркеру
      // команда НЕ шлётся, тик мира не трогается). Симметрично `inspect`.
      set({ selectedEid: null, detail: null });
    },

    requestSnapshot() {
      client?.post({ type: 'requestSnapshot' });
    },

    applyMessage(msg) {
      switch (msg.type) {
        case 'view': {
          set({ view: msg.view });
          return;
        }
        case 'viewDelta': {
          const prev = get().view;
          // Дельта без базового вида некорректна — игнорируем (ждём полный view).
          if (prev === null) return;
          const next = applyDelta(prev, {
            tick: msg.tick,
            day: msg.day,
            weather: msg.weather,
            changed: msg.changed,
            removed: msg.removed,
          });
          set({ view: next });
          return;
        }
        case 'logDelta': {
          if (msg.events.length === 0) return;
          const merged = [...get().log, ...msg.events];
          // Кольцевой буфер: держим только последние LOG_WINDOW событий.
          const log = merged.length > LOG_WINDOW ? merged.slice(merged.length - LOG_WINDOW) : merged;
          set({ log });
          return;
        }
        case 'names': {
          // МЕРЖ дельты имён в кэш (D-081): имена стабильны, воркер шлёт только новые/
          // изменившиеся eid. Пустая дельта — no-op (не плодим ре-рендер).
          const keys = Object.keys(msg.names);
          if (keys.length === 0) return;
          set({ names: { ...get().names, ...msg.names } });
          return;
        }
        case 'detail': {
          set({ detail: msg.detail });
          return;
        }
        case 'snapshot': {
          set({ lastSnapshot: { data: msg.data, seed: msg.seed, tick: msg.tick } });
          return;
        }
        case 'stats': {
          set({ stats: { tick: msg.tick, entityCount: msg.entityCount, tickMs: msg.tickMs } });
          return;
        }
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
        }
      }
    },
  };
});

/**
 * ТЕСТОВЫЙ хук сброса моста: терминирует воркер и обнуляет синглтон-клиента, чтобы
 * следующий `init` создал свежий. Не для продакшена (в UI мост живёт всю сессию).
 */
export function __resetWorkerClientForTest(): void {
  client?.terminate();
  client = null;
}
