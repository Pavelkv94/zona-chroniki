/**
 * Тесты ПЕРСИСТ-СЛОЯ сохранений (задача 4.8, D-082). Каждый тест получает СВЕЖУЮ,
 * изолированную `fake-indexeddb` фабрику (новый `IDBFactory` = пустая БД), поэтому save/
 * list/load/delete проверяются на реальном IndexedDB-коде без живого браузера.
 *
 * ── ЗАКОН №8 (персист НЕ портит данные) ──────────────────────────────────────
 * Ключевой инвариант: round-trip `saveSnapshot → loadSnapshot` возвращает `SnapshotJSON`
 * БИТ-В-БИТ (глубокое равенство вложенного plain-JSON). Значит `deserialize(loaded.data)`
 * даст мир, идентичный непрерывному прогону (resume-safe доказан в /sim). id/savedAt —
 * UI-метки: инъецируем детерминированными, чтобы проверять сортировку/изоляцию.
 */

import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Seed, SnapshotJSON, Tick } from '@zona/shared';
import { createSavesStore, type SavesStore } from './saves';

/** Свежий изолированный стор поверх новой fake-БД + детерминированные id/часы. */
function freshStore(opts: { idGen?: () => string; clock?: () => number } = {}): SavesStore {
  return createSavesStore({ factory: new IDBFactory(), idGen: opts.idGen, clock: opts.clock });
}

/** Репрезентативный «богатый» снапшот (вложенные структуры — проверка глубокого round-trip). */
function snapshot(over: Partial<SnapshotJSON> = {}): SnapshotJSON {
  return {
    version: 1,
    seed: 42 as Seed,
    tick: 1500 as Tick,
    rngState: 123456,
    eventSeq: 77,
    ecsIndex: [1, 2, 3],
    entities: [{ eid: 1, gen: 0 }, { eid: 2, gen: 1 }] as unknown as SnapshotJSON['entities'],
    resources: { name: { '1': { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' } } },
    components: { Position: { x: [1.5, 2.5], y: [3.5, 4.5] } },
    eventLog: [{ id: 1, tick: 10, type: 'sim/tickStarted', causedBy: null, payload: { tick: 10 } }],
    ...over,
  } as SnapshotJSON;
}

describe('saveSnapshot → loadSnapshot: round-trip бит-в-бит (закон №8)', () => {
  it('возвращает SnapshotJSON точно таким, каким сохранён (глубокое равенство)', async () => {
    const store = freshStore({ idGen: () => 'id-1', clock: () => 1000 });
    const snap = snapshot();
    const id = await store.saveSnapshot({ data: snap, seed: 42 as Seed, tick: 1500 as Tick, name: 'привал' });

    const loaded = await store.loadSnapshot(id);
    expect(loaded).not.toBeNull();
    // Снапшот — байт-в-байт (persist не интерпретирует данные, лишь хранит).
    expect(loaded!.data).toEqual(snap);
    // Метаданные сопровождают запись.
    expect(loaded!.seed).toBe(42);
    expect(loaded!.tick).toBe(1500);
    expect(loaded!.name).toBe('привал');
    expect(loaded!.savedAt).toBe(1000);
    expect(loaded!.id).toBe('id-1');
  });

  it('загруженный data — независимая копия (мутация оригинала не влияет)', async () => {
    const store = freshStore();
    const snap = snapshot();
    const id = await store.saveSnapshot({ data: snap, seed: 42 as Seed, tick: 1500 as Tick });
    // Мутируем ОРИГИНАЛ после сохранения — в БД лежит структурная копия (закон №8).
    (snap.components as Record<string, unknown>).Position = 'СЛОМАНО';
    const loaded = await store.loadSnapshot(id);
    expect(loaded!.data.components).toEqual({ Position: { x: [1.5, 2.5], y: [3.5, 4.5] } });
  });

  it('loadSnapshot несуществующего id → null', async () => {
    const store = freshStore();
    expect(await store.loadSnapshot('нет-такого')).toBeNull();
  });

  it('name по умолчанию — пустая строка (безымянное сохранение)', async () => {
    const store = freshStore();
    const id = await store.saveSnapshot({ data: snapshot(), seed: 1 as Seed, tick: 5 as Tick });
    const loaded = await store.loadSnapshot(id);
    expect(loaded!.name).toBe('');
  });
});

describe('listSaves: метаданные + сортировка (новые сверху)', () => {
  it('возвращает метаданные БЕЗ тяжёлого data, отсортированные по savedAt убыв.', async () => {
    let t = 0;
    const clockTimes = [100, 300, 200];
    const store = freshStore({ idGen: () => `id-${t}`, clock: () => clockTimes[t++]! });
    await store.saveSnapshot({ data: snapshot(), seed: 1 as Seed, tick: 10 as Tick, name: 'A' }); // savedAt 100
    await store.saveSnapshot({ data: snapshot(), seed: 2 as Seed, tick: 20 as Tick, name: 'B' }); // savedAt 300
    await store.saveSnapshot({ data: snapshot(), seed: 3 as Seed, tick: 30 as Tick, name: 'C' }); // savedAt 200

    const list = await store.listSaves();
    expect(list.map((m) => m.name)).toEqual(['B', 'C', 'A']); // 300, 200, 100
    // meta не несёт data (лёгкий список для меню).
    for (const m of list) expect('data' in m).toBe(false);
    expect(list[0]).toEqual({ id: 'id-1', seed: 2, tick: 20, name: 'B', savedAt: 300 });
  });

  it('пустая БД → пустой список', async () => {
    expect(await freshStore().listSaves()).toEqual([]);
  });
});

describe('несколько сохранений: изоляция по id', () => {
  it('разные id — независимые записи; загрузка одной не задевает другую', async () => {
    let i = 0;
    const store = freshStore({ idGen: () => `id-${i++}` });
    const idA = await store.saveSnapshot({ data: snapshot({ tick: 11 as Tick }), seed: 1 as Seed, tick: 11 as Tick, name: 'A' });
    const idB = await store.saveSnapshot({ data: snapshot({ tick: 22 as Tick }), seed: 2 as Seed, tick: 22 as Tick, name: 'B' });
    expect(idA).not.toBe(idB);

    expect((await store.loadSnapshot(idA))!.tick).toBe(11);
    expect((await store.loadSnapshot(idB))!.tick).toBe(22);
    expect((await store.listSaves()).length).toBe(2);
  });

  it('явный тот же id ПЕРЕЗАПИСЫВАЕТ запись (put по keyPath)', async () => {
    const store = freshStore();
    await store.saveSnapshot({ id: 'slot', data: snapshot(), seed: 1 as Seed, tick: 10 as Tick, name: 'старое' });
    await store.saveSnapshot({ id: 'slot', data: snapshot(), seed: 1 as Seed, tick: 99 as Tick, name: 'новое' });
    const list = await store.listSaves();
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe('новое');
    expect(list[0]!.tick).toBe(99);
  });
});

describe('deleteSave', () => {
  it('удаляет запись; остальные целы', async () => {
    let i = 0;
    const store = freshStore({ idGen: () => `id-${i++}` });
    const idA = await store.saveSnapshot({ data: snapshot(), seed: 1 as Seed, tick: 10 as Tick, name: 'A' });
    const idB = await store.saveSnapshot({ data: snapshot(), seed: 2 as Seed, tick: 20 as Tick, name: 'B' });

    await store.deleteSave(idA);
    expect(await store.loadSnapshot(idA)).toBeNull();
    expect(await store.loadSnapshot(idB)).not.toBeNull();
    expect((await store.listSaves()).map((m) => m.name)).toEqual(['B']);
  });

  it('удаление несуществующего id — no-op (не бросает)', async () => {
    const store = freshStore();
    await expect(store.deleteSave('нет')).resolves.toBeUndefined();
  });
});

describe('round-trip: усиление изоляции копий и целостности причинной цепочки (законы №3/№6/№8)', () => {
  it('причинная цепочка событий (causedBy) переживает персист бит-в-бит', async () => {
    // Летопись мира: событие B порождено событием A (полная цепочка causedBy). После
    // save→load цепочка обязана вернуться той же — иначе resume «забыл» причину (закон №6).
    const store = freshStore({ idGen: () => 'raid' });
    const eventLog = [
      { id: 1, tick: 10, type: 'sim/spotted', causedBy: null, payload: { who: 1 } },
      { id: 2, tick: 11, type: 'npc/fled', causedBy: 1, payload: { from: 1 } },
    ] as unknown as SnapshotJSON['eventLog'];
    const id = await store.saveSnapshot({ data: snapshot({ eventLog }), seed: 42 as Seed, tick: 12 as Tick });
    const loaded = await store.loadSnapshot(id);
    expect(loaded!.data.eventLog).toEqual(eventLog);
  });

  it('глубоко вложенная мутация оригинала (внутри eventLog) не протекает в БД', async () => {
    // Не только верхний уровень — structured clone копирует ГЛУБОКО. Мутируем вложенный
    // payload уже сохранённого оригинала: в БД лежит нетронутая копия.
    const store = freshStore();
    const snap = snapshot();
    const id = await store.saveSnapshot({ data: snap, seed: 1 as Seed, tick: 5 as Tick });
    (snap.eventLog[0]!.payload as Record<string, unknown>).tick = 99999;
    const loaded = await store.loadSnapshot(id);
    expect((loaded!.data.eventLog[0]!.payload as Record<string, unknown>).tick).toBe(10);
  });

  it('два loadSnapshot одной записи — НЕЗАВИСИМЫЕ копии (мутация одной не рвёт другую)', async () => {
    // Каждый resume должен получать свежий мир: если бы load возвращал общий ref, мутация
    // первого загруженного снапшота отравила бы второй (и БД). Проверяем независимость.
    const store = freshStore({ idGen: () => 'slot' });
    const id = await store.saveSnapshot({ data: snapshot(), seed: 1 as Seed, tick: 5 as Tick });
    const first = await store.loadSnapshot(id);
    (first!.data.components as Record<string, unknown>).Position = 'ОТРАВЛЕНО';
    const second = await store.loadSnapshot(id);
    expect(second!.data.components).toEqual({ Position: { x: [1.5, 2.5], y: [3.5, 4.5] } });
  });

  it('saveSnapshot возвращает ИМЕННО переданный явный id (детерминизм слота)', async () => {
    const store = freshStore();
    const returned = await store.saveSnapshot({ id: 'мой-слот', data: snapshot(), seed: 1 as Seed, tick: 5 as Tick });
    expect(returned).toBe('мой-слот');
  });
});

describe('listSaves: детерминизм порядка при равном времени (закон №8)', () => {
  it('при одинаковом savedAt порядок стабилен — tie-break по id (не зависит от порядка вставки)', async () => {
    // Наблюдатель нажал «сохранить» дважды в одну мс (одинаковый clock). Список обязан
    // упорядочиться ДЕТЕРМИНИРОВАННО (по id), иначе меню «прыгает» между прогонами.
    const store = freshStore({ clock: () => 500 });
    await store.saveSnapshot({ id: 'z-поздний', data: snapshot(), seed: 1 as Seed, tick: 10 as Tick, name: 'Z' });
    await store.saveSnapshot({ id: 'a-ранний', data: snapshot(), seed: 2 as Seed, tick: 20 as Tick, name: 'A' });
    const list = await store.listSaves();
    // savedAt равны ⇒ tie-break по id по возрастанию: 'a-ранний' < 'z-поздний'.
    expect(list.map((m) => m.id)).toEqual(['a-ранний', 'z-поздний']);
  });
});

describe('createSavesStore: без фабрики и без глобального indexedDB — понятная ошибка', () => {
  it('бросает, если IndexedDB недоступен', () => {
    // jsdom без fake-indexeddb-глобала: global indexedDB отсутствует → явная ошибка.
    const hadGlobal = 'indexedDB' in globalThis;
    if (hadGlobal) {
      // Среда уже имеет глобал — пропускаем (тест актуален лишь без него).
      expect(true).toBe(true);
      return;
    }
    expect(() => createSavesStore()).toThrow(/IndexedDB недоступен/);
  });
});
