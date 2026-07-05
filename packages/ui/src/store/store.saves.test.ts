/**
 * Тесты СОХРАНЕНИЙ на уровне стора (задача 4.8, D-082). Проверяют save/load-flow как
 * оркестровку: `requestSave` → воркеру уходит `requestSnapshot`, пришедший снапшот-ответ
 * персистится в IndexedDB (мокнутый персист-стор); `loadSave` читает запись и делает resume
 * (`init{seed, snapshot}` воркеру). Живой воркер и живой IndexedDB не поднимаются — мост
 * замокан (ловим `post`), персист-стор инъецирован (`__setSavesStoreForTest`).
 *
 * ── ЗАКОН №8 ────────────────────────────────────────────────────────────────
 * В воркер при загрузке уходят ТОЛЬКО `seed` + `snapshot` (deserialize/resume). UI-метки
 * (id/savedAt/name) остаются в персист-слое — проверяем, что init их НЕ несёт.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Seed, SnapshotJSON, Tick, UiToWorker } from '@zona/shared';
import { createSavesStore } from '../persistence/saves';
import type { SaveInput, SaveMeta, SavedSnapshot, SavesStore } from '../persistence/saves';

// Мост замокан ДО импорта стора (как в store.test.ts).
const bridge = vi.hoisted(() => ({ posted: [] as UiToWorker[], terminated: 0 }));
vi.mock('../bridge/worker-client', () => ({
  createWorkerClient: (_onMessage: (msg: unknown) => void) => ({
    post: (msg: UiToWorker) => {
      bridge.posted.push(msg);
    },
    terminate: () => {
      bridge.terminated += 1;
    },
  }),
}));

import { useUiStore, __resetWorkerClientForTest, __setSavesStoreForTest } from './store';

/** Прогнать очередь микротасков/промисов (персист асинхронен). */
const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

/**
 * Дождаться условия, прокачивая очередь задач (реальный fake-indexeddb резолвит транзакции
 * через несколько тиков task-queue: put→then→refreshSaves→listSaves→then→set). Мок-стор
 * укладывается в один flush, живая БД — нет; поллинг покрывает оба без гонок.
 */
async function waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await flush();
}

function snap(over: Partial<SnapshotJSON> = {}): SnapshotJSON {
  return {
    version: 1,
    seed: 42 as Seed,
    tick: 500 as Tick,
    rngState: 7,
    eventSeq: 3,
    ecsIndex: [],
    entities: [],
    resources: {},
    components: {},
    eventLog: [],
    ...over,
  } as SnapshotJSON;
}

/** Управляемый мок персист-стора: пишет в память, копит вызовы. */
function makeFakeSaves(): {
  store: SavesStore;
  saved: SaveInput[];
  deleted: string[];
  records: Map<string, SavedSnapshot>;
} {
  const saved: SaveInput[] = [];
  const deleted: string[] = [];
  const records = new Map<string, SavedSnapshot>();
  let counter = 0;
  const store: SavesStore = {
    async saveSnapshot(input) {
      saved.push(input);
      const id = input.id ?? `id-${counter++}`;
      records.set(id, {
        id,
        seed: input.seed,
        tick: input.tick,
        name: input.name ?? '',
        savedAt: input.savedAt ?? 1000,
        data: input.data,
      });
      return id;
    },
    async listSaves() {
      return [...records.values()]
        .map((r): SaveMeta => ({ id: r.id, seed: r.seed, tick: r.tick, name: r.name, savedAt: r.savedAt }))
        .sort((a, b) => b.savedAt - a.savedAt);
    },
    async loadSnapshot(id) {
      return records.get(id) ?? null;
    },
    async deleteSave(id) {
      deleted.push(id);
      records.delete(id);
    },
  };
  return { store, saved, deleted, records };
}

let fake: ReturnType<typeof makeFakeSaves>;

beforeEach(() => {
  __resetWorkerClientForTest();
  bridge.posted.length = 0;
  bridge.terminated = 0;
  fake = makeFakeSaves();
  __setSavesStoreForTest(fake.store);
  useUiStore.setState({ saves: [], savedIndicator: null, lastSnapshot: null });
});

describe('requestSave-flow: снапшот → персист в IndexedDB', () => {
  it('requestSave шлёт requestSnapshot воркеру (без snapshot ещё нет персиста)', () => {
    useUiStore.getState().init(42 as Seed);
    bridge.posted.length = 0;
    useUiStore.getState().requestSave('привал');
    expect(bridge.posted).toEqual([{ type: 'requestSnapshot' }]);
    expect(fake.saved).toEqual([]); // снапшот ещё не пришёл
  });

  it('пришедший snapshot-ответ персистится под именем requestSave', async () => {
    useUiStore.getState().init(42 as Seed);
    useUiStore.getState().requestSave('привал у костра');
    // Воркер отвечает снапшотом (симулируем входящее сообщение моста).
    const data = snap({ tick: 777 as Tick });
    useUiStore.getState().applyMessage({ type: 'snapshot', data, seed: 42 as Seed, tick: 777 as Tick });
    await flush();

    expect(fake.saved.length).toBe(1);
    expect(fake.saved[0]).toMatchObject({ data, seed: 42, tick: 777, name: 'привал у костра' });
    // Индикатор «сохранено» выставлен; список обновлён.
    expect(useUiStore.getState().savedIndicator).not.toBeNull();
    expect(useUiStore.getState().saves.length).toBe(1);
  });

  it('обычный requestSnapshot (без requestSave) НЕ персистит', async () => {
    useUiStore.getState().init(42 as Seed);
    useUiStore.getState().requestSnapshot();
    useUiStore.getState().applyMessage({ type: 'snapshot', data: snap(), seed: 42 as Seed, tick: 5 as Tick });
    await flush();
    expect(fake.saved).toEqual([]);
    // lastSnapshot всё равно записан (для прочих нужд).
    expect(useUiStore.getState().lastSnapshot).not.toBeNull();
  });

  it('второй snapshot после одного requestSave НЕ персистится повторно (флаг снят)', async () => {
    useUiStore.getState().init(42 as Seed);
    useUiStore.getState().requestSave('раз');
    useUiStore.getState().applyMessage({ type: 'snapshot', data: snap(), seed: 42 as Seed, tick: 1 as Tick });
    await flush();
    // Ещё один снапшот (например, телеметрия/иной requestSnapshot) — без нового save.
    useUiStore.getState().applyMessage({ type: 'snapshot', data: snap(), seed: 42 as Seed, tick: 2 as Tick });
    await flush();
    expect(fake.saved.length).toBe(1);
  });

  it('requestSave до init (моста нет) — тихо игнорируется, не персистит', async () => {
    useUiStore.getState().requestSave('x');
    await flush();
    expect(bridge.posted).toEqual([]);
    expect(fake.saved).toEqual([]);
  });

  it('requestSave() без имени персистит под пустым именем (безымянный сейв)', async () => {
    useUiStore.getState().init(42 as Seed);
    useUiStore.getState().requestSave();
    useUiStore.getState().applyMessage({ type: 'snapshot', data: snap(), seed: 42 as Seed, tick: 9 as Tick });
    await flush();
    expect(fake.saved.length).toBe(1);
    expect(fake.saved[0]!.name).toBe('');
  });

  it('два requestSave подряд до ответа → ДВА сейва в порядке FIFO (ни один не теряется)', async () => {
    // Наблюдатель дважды нажал «Сохранить» до прихода снапшота. Каждый requestSave шлёт
    // свой requestSnapshot ⇒ придут ДВА снапшот-ответа. Очередь имён (не скаляр) отдаёт
    // 'первый' первому ответу, 'второй' — второму: оба сохранения доезжают, порядок FIFO.
    useUiStore.getState().init(42 as Seed);
    useUiStore.getState().requestSave('первый');
    useUiStore.getState().requestSave('второй');
    useUiStore.getState().applyMessage({ type: 'snapshot', data: snap(), seed: 42 as Seed, tick: 1 as Tick });
    useUiStore.getState().applyMessage({ type: 'snapshot', data: snap(), seed: 42 as Seed, tick: 2 as Tick });
    await flush();
    expect(fake.saved.length).toBe(2);
    expect(fake.saved.map((s) => s.name)).toEqual(['первый', 'второй']);
  });
});

describe('loadSave-flow: IndexedDB → resume воркеру (закон №8)', () => {
  it('loadSave читает запись и шлёт init{seed, snapshot} (метки НЕ текут в мир)', async () => {
    useUiStore.getState().init(1 as Seed);
    // Готовим запись в персисте (как будто ранее сохранили).
    const data = snap({ seed: 99 as Seed, tick: 3000 as Tick });
    await fake.store.saveSnapshot({ id: 'save-A', data, seed: 99 as Seed, tick: 3000 as Tick, name: 'глубокий рейд' });
    bridge.posted.length = 0;

    useUiStore.getState().loadSave('save-A');
    await flush();

    // В воркер ушёл resume: ровно seed + snapshot, без id/savedAt/name.
    expect(bridge.posted).toEqual([{ type: 'init', seed: 99, snapshot: data }]);
    const initMsg = bridge.posted[0] as Extract<UiToWorker, { type: 'init' }>;
    expect('id' in initMsg).toBe(false);
    expect('savedAt' in initMsg).toBe(false);
    expect('name' in initMsg).toBe(false);
  });

  it('loadSave несуществующего id — no-op (воркеру ничего)', async () => {
    useUiStore.getState().init(1 as Seed);
    bridge.posted.length = 0;
    useUiStore.getState().loadSave('нет-такого');
    await flush();
    expect(bridge.posted).toEqual([]);
  });

  it('init-сообщение resume несёт РОВНО {type, seed, snapshot} — ни одной UI-метки лишней', async () => {
    // Жёсткий страж утечки: перечисляем ВСЕ ключи init. Даже «ядовитые» name/id/savedAt
    // в записи не должны просочиться в мир (закон №8 — воркер знает лишь seed+snapshot).
    useUiStore.getState().init(1 as Seed);
    const data = snap({ seed: 7 as Seed, tick: 42 as Tick });
    await fake.store.saveSnapshot({ id: 'ЯД-id', data, seed: 7 as Seed, tick: 42 as Tick, name: 'ЯД-имя', savedAt: 123 });
    bridge.posted.length = 0;
    useUiStore.getState().loadSave('ЯД-id');
    await flush();
    expect(Object.keys(bridge.posted[0]!).sort()).toEqual(['seed', 'snapshot', 'type']);
  });
});

describe('сквозной round-trip через РЕАЛЬНЫЙ IndexedDB: save → persist → load → resume (закон №8)', () => {
  it('снапшот, доехавший до воркера при загрузке, БИТ-В-БИТ равен сохранённому — но НЕ тот же объект', async () => {
    // Самый сильный тест закона №8: НЕ мок, а настоящий fake-indexeddb (structured clone,
    // как в браузере). Проходим полный путь наблюдателя: сохранил мир → снапшот записался
    // в БД → загрузил → в воркер ушёл snapshot для deserialize. Данные обязаны вернуться
    // бит-в-бит (resume даст мир, идентичный непрерывному прогону), но объект — НОВАЯ копия
    // (клон БД), а не общий ref (иначе персист «жил бы» в памяти, а не на «диске»).
    __setSavesStoreForTest(createSavesStore({ factory: new IDBFactory() }));

    useUiStore.getState().init(7 as Seed);
    const data = snap({ seed: 7 as Seed, tick: 4242 as Tick, rngState: 999, eventSeq: 13 });
    useUiStore.getState().requestSave('глубокий рейд');
    useUiStore.getState().applyMessage({ type: 'snapshot', data, seed: 7 as Seed, tick: 4242 as Tick });
    await waitFor(() => useUiStore.getState().saves.length > 0);

    // Список подтянулся из реальной БД — запись на месте с UI-метками.
    const saves = useUiStore.getState().saves;
    expect(saves.length).toBe(1);
    expect(saves[0]!.name).toBe('глубокий рейд');
    const savedId = saves[0]!.id;

    bridge.posted.length = 0;
    useUiStore.getState().loadSave(savedId);
    await waitFor(() => bridge.posted.length > 0);

    const initMsg = bridge.posted[0] as Extract<UiToWorker, { type: 'init' }>;
    expect(initMsg.type).toBe('init');
    expect(initMsg.seed).toBe(7);
    // Бит-в-бит равенство сохранённому...
    expect(initMsg.snapshot).toEqual(data);
    // ...но это КЛОН из БД, а не исходный объект памяти.
    expect(initMsg.snapshot).not.toBe(data);
    // И снова — ни одной UI-метки в мир.
    expect(Object.keys(initMsg).sort()).toEqual(['seed', 'snapshot', 'type']);
  });
});

describe('refreshSaves / deleteSave', () => {
  it('refreshSaves подтягивает список из IndexedDB в стор', async () => {
    await fake.store.saveSnapshot({ id: 'a', data: snap(), seed: 1 as Seed, tick: 10 as Tick, name: 'A', savedAt: 100 });
    await fake.store.saveSnapshot({ id: 'b', data: snap(), seed: 2 as Seed, tick: 20 as Tick, name: 'B', savedAt: 200 });
    useUiStore.getState().refreshSaves();
    await flush();
    expect(useUiStore.getState().saves.map((m) => m.name)).toEqual(['B', 'A']); // новые сверху
  });

  it('deleteSave удаляет из IndexedDB и обновляет список', async () => {
    await fake.store.saveSnapshot({ id: 'a', data: snap(), seed: 1 as Seed, tick: 10 as Tick, name: 'A', savedAt: 100 });
    await fake.store.saveSnapshot({ id: 'b', data: snap(), seed: 2 as Seed, tick: 20 as Tick, name: 'B', savedAt: 200 });
    useUiStore.getState().deleteSave('a');
    await flush();
    expect(fake.deleted).toEqual(['a']);
    expect(useUiStore.getState().saves.map((m) => m.name)).toEqual(['B']);
  });
});
