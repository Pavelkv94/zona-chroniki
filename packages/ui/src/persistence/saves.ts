/**
 * @module @zona/ui/persistence/saves
 *
 * ПЕРСИСТЕНТНЫЙ СЛОЙ СОХРАНЕНИЙ (задача 4.8, D-082). Обёртка над IndexedDB: кладёт/читает
 * записи сохранения (снапшот мира `SnapshotJSON` + seed + tick + UI-метки id/имя/время) в
 * браузерную БД. Меню сохранений (`SaveControls`) и стор (`store`) говорят ТОЛЬКО с этим
 * API — сырой `indexedDB`/`IDBRequest` наружу не течёт.
 *
 * ── ЗАКОН №5 (DOM/IndexedDB только в /ui) ────────────────────────────────────
 * IndexedDB — браузерный (DOM) API, значит живёт ИСКЛЮЧИТЕЛЬНО в `@zona/ui`. Этот модуль
 * НЕ импортирует `@zona/sim` (ни логику, ни константы): единственная связь с симуляцией —
 * plain-тип `SnapshotJSON` из `@zona/shared`, который здесь ЛИШЬ хранится/возвращается
 * байт-в-байт, не интерпретируется. `@zona/sim` остаётся headless (в Node сохранений нет —
 * это презентационная функция наблюдателя).
 *
 * ── ЗАКОН №8 (детерминизм resume): персист НЕ портит данные ───────────────────
 * Round-trip `saveSnapshot → loadSnapshot` возвращает `SnapshotJSON` ТОЧНО таким, каким его
 * сериализовал воркер (structured clone IndexedDB — глубокая копия plain-JSON без потерь).
 * Значит `deserialize(loaded.data)` в воркере даёт мир, БИТ-В-БИТ идентичный непрерывному
 * прогону (resume-safe доказан Фазами 0–3; D-008/C-4 — eventId монотонен через save/load).
 * UI-метки (`id`/`savedAt`/`name`) — ЧИСТАЯ презентация: генерируются здесь (`Date.now`/
 * `crypto.randomUUID` допустимы — закон №8 про СИМУЛЯЦИЮ, не про UI-метки) и НИКОГДА не
 * передаются в мир (в воркер уходят лишь `seed` + `data`, см. `store.loadSave`).
 *
 * ── ЗАКОН №3 (ничего из воздуха): загруженный мир = ровно сохранённое ─────────
 * Восстановление не «выдумывает» состояние: мир пересобирается `deserialize` из точной
 * копии ранее сериализованного снапшота. Никаких дефолтов/дорисовки — что сохранили, то
 * и вернули.
 *
 * ── ТЕСТИРУЕМОСТЬ (инъекция фабрики БД) ──────────────────────────────────────
 * Доступ к БД абстрагирован через `IDBFactory` (по умолчанию — глобальный `indexedDB`
 * браузера). `createSavesStore(deps)` принимает фабрику + генераторы id/времени, поэтому в
 * тестах (Vitest jsdom) подставляется `fake-indexeddb` и детерминированные id/часы — без
 * живого браузера.
 */

import type { Seed, SnapshotJSON, Tick } from '@zona/shared';

/** Имя браузерной БД сохранений. */
const DB_NAME = 'zona-saves';
/** Версия схемы БД (ↀ при изменении object-store'ов). */
const DB_VERSION = 1;
/** Имя object-store, где лежат записи сохранений (keyPath: `id`). */
const STORE = 'snapshots';

/**
 * МЕТАДАННЫЕ сохранения для меню (без тяжёлого `data`). `savedAt` — epoch-мс UI-метка
 * (когда наблюдатель нажал «сохранить»), `tick` — игровой тик снапшота (день выводит
 * презентация из tick, чтобы не тянуть балансовую `TICKS_PER_DAY` в персист-слой, закон №5).
 */
export interface SaveMeta {
  /** Уникальный id записи (UI-метка, генерируется здесь; в мир НЕ течёт). */
  readonly id: string;
  /** Seed мира снапшота (для отображения/консистентности; при resume идёт в воркер). */
  readonly seed: Seed;
  /** Игровой тик снапшота (из него презентация выводит день). */
  readonly tick: Tick;
  /** Пользовательское имя сохранения (пусто — безымянное). */
  readonly name: string;
  /** Время сохранения (epoch-мс, UI-метка). */
  readonly savedAt: number;
}

/** ПОЛНАЯ запись сохранения: метаданные + снапшот мира. */
export interface SavedSnapshot extends SaveMeta {
  /** Снапшот мира `SnapshotJSON` — хранится/возвращается байт-в-байт (закон №8). */
  readonly data: SnapshotJSON;
}

/** Вход `saveSnapshot`: снапшот + seed + tick, опц. имя/время/id (иначе генерируются). */
export interface SaveInput {
  readonly data: SnapshotJSON;
  readonly seed: Seed;
  readonly tick: Tick;
  /** Имя сохранения (по умолчанию — пустая строка, безымянное). */
  readonly name?: string;
  /** Метка времени (по умолчанию — `Date.now()` через инъецируемые часы). */
  readonly savedAt?: number;
  /** Явный id (по умолчанию — генерируется; полезно для детерминизма тестов). */
  readonly id?: string;
}

/** Узкий API персист-слоя сохранений. */
export interface SavesStore {
  /** Записать снапшот (снапшот + seed + tick + метки). Возвращает id записи. */
  saveSnapshot(input: SaveInput): Promise<string>;
  /** Метаданные всех сохранений для меню, отсортированные по времени (новые сверху). */
  listSaves(): Promise<SaveMeta[]>;
  /** Полная запись по id (или `null`, если нет). */
  loadSnapshot(id: string): Promise<SavedSnapshot | null>;
  /** Удалить запись по id (no-op, если нет). */
  deleteSave(id: string): Promise<void>;
}

/** Зависимости фабрики стора (инъекция для тестируемости). */
export interface SavesStoreDeps {
  /** Фабрика IndexedDB (по умолчанию — глобальный `indexedDB` браузера). */
  readonly factory?: IDBFactory;
  /** Генератор id записей (по умолчанию — `crypto.randomUUID`/fallback). */
  readonly idGen?: () => string;
  /** Часы для `savedAt` (по умолчанию — `Date.now`). */
  readonly clock?: () => number;
}

/** Промисификация `IDBRequest` (браузерный API колбэчный — заворачиваем в Promise). */
function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Открыть (создав схему при первом запуске) БД сохранений через инъецированную фабрику. */
function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // keyPath 'id' — запись сама несёт свой ключ (id — UI-метка сохранения).
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('open zona-saves failed'));
  });
}

/** Дефолтный генератор id: `crypto.randomUUID`, с безопасным fallback (не в мир — UI-метка). */
function defaultIdGen(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback (окружения без crypto.randomUUID): время + случайный хвост. Не для симуляции —
  // чисто UI-идентификатор записи (закон №8 не нарушен: в мир не течёт).
  return `save-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Создать персист-стор поверх инъецированных зависимостей. Без аргументов — боевой
 * (глобальный `indexedDB`, `crypto.randomUUID`, `Date.now`). В тестах — `fake-indexeddb`
 * + детерминированные id/часы.
 */
export function createSavesStore(deps: SavesStoreDeps = {}): SavesStore {
  const maybeFactory =
    deps.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (maybeFactory === undefined) {
    throw new Error(
      'IndexedDB недоступен: передайте factory в createSavesStore (нет глобального indexedDB)',
    );
  }
  // Явная re-привязка: узкий тип не переносится в вложенные замыкания (withStore).
  const factory: IDBFactory = maybeFactory;
  const idGen = deps.idGen ?? defaultIdGen;
  const clock = deps.clock ?? Date.now;

  /** Выполнить работу над object-store в транзакции нужного режима, затем закрыть БД. */
  async function withStore<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await openDb(factory);
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = await work(store);
      // Дождаться коммита транзакции (для readwrite — гарантия записи на диск).
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = (): void => resolve();
        tx.onerror = (): void => reject(tx.error ?? new Error('transaction failed'));
        tx.onabort = (): void => reject(tx.error ?? new Error('transaction aborted'));
      });
      return result;
    } finally {
      db.close();
    }
  }

  return {
    async saveSnapshot(input: SaveInput): Promise<string> {
      const record: SavedSnapshot = {
        id: input.id ?? idGen(),
        seed: input.seed,
        tick: input.tick,
        name: input.name ?? '',
        savedAt: input.savedAt ?? clock(),
        data: input.data,
      };
      await withStore('readwrite', async (store) => {
        await promisifyRequest(store.put(record));
      });
      return record.id;
    },

    async listSaves(): Promise<SaveMeta[]> {
      const all = await withStore('readonly', (store) =>
        promisifyRequest(store.getAll() as IDBRequest<SavedSnapshot[]>),
      );
      // Метаданные без тяжёлого `data`; новые сверху (убыв. по savedAt, tie-break по id).
      return all
        .map((r): SaveMeta => ({ id: r.id, seed: r.seed, tick: r.tick, name: r.name, savedAt: r.savedAt }))
        .sort((a, b) => (b.savedAt - a.savedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async loadSnapshot(id: string): Promise<SavedSnapshot | null> {
      const rec = await withStore('readonly', (store) =>
        promisifyRequest(store.get(id) as IDBRequest<SavedSnapshot | undefined>),
      );
      return rec ?? null;
    },

    async deleteSave(id: string): Promise<void> {
      await withStore('readwrite', async (store) => {
        await promisifyRequest(store.delete(id));
      });
    },
  };
}
