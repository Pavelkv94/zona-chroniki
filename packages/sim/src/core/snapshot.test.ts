/**
 * @module @zona/sim/core/snapshot.test
 *
 * Гейт задачи 0.5a (write-path сериализации). Проверяет ИНВАРИАНТЫ, а не поля:
 *  1. `hashSnapshot` инвариантен к порядку вставки ключей (закон №8, C-3).
 *  2. Канонизатор бросает на непредставимых значениях с контекстом (D-013).
 *  3. Закон №3: покойник не попадает ни в `entities`, ни в `resources`, ни в хэш.
 *  4. `entities` отсортирован; два мира с одним seed и программой → идентичны.
 *  5. `exportEntityIndex` сериализуем, детерминирован, без дыр/undefined.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, Seed, Tick, SnapshotJSON } from '@zona/shared';
import { createSimWorld, destroyEntity, type SimWorld } from './world';
import { spawnEntity, exportEntityIndex } from './ecs';
import { canonicalize, hashSnapshot, serialize } from './snapshot';

/** Сырое число → branded EntityId. */
const id = (n: number): EntityId => n as EntityId;

describe('canonicalize: детерминизм и запреты (D-012/D-013)', () => {
  it('порядок ключей объекта не влияет на результат (сортировка ключей)', () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('вложенные объекты канонизируются рекурсивно', () => {
    const a = canonicalize({ outer: { y: 1, x: 2 }, arr: [3, 1, 2] });
    const b = canonicalize({ arr: [3, 1, 2], outer: { x: 2, y: 1 } });
    expect(a).toBe(b);
    // Массив сохраняет порядок (упорядоченные данные), объекты — сорт. ключей.
    expect(a).toBe('{"arr":[3,1,2],"outer":{"x":2,"y":1}}');
  });

  it('null допустим (например causedBy:null)', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize({ causedBy: null })).toBe('{"causedBy":null}');
  });

  it('числа через Number.toString; NaN/±Infinity → throw с контекстом', () => {
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(-7)).toBe('-7');
    expect(() => canonicalize(NaN, 'field=hp')).toThrow(/NaN|Infinity/);
    expect(() => canonicalize(NaN, 'field=hp')).toThrow(/field=hp/);
    expect(() => canonicalize(Infinity, 'field=dmg')).toThrow(/field=dmg/);
    expect(() => canonicalize(-Infinity)).toThrow(/Infinity/);
  });

  it('undefined/функция/символ/bigint → throw с контекстом', () => {
    expect(() => canonicalize(undefined, 'k=x eid=1')).toThrow(/undefined/);
    expect(() => canonicalize(undefined, 'k=x eid=1')).toThrow(/k=x eid=1/);
    expect(() => canonicalize(() => 0, 'fn')).toThrow(/функция/);
    expect(() => canonicalize(Symbol('s'), 'sym')).toThrow(/symbol/);
    expect(() => canonicalize(10n, 'big')).toThrow(/bigint/);
  });

  it('Map/Set/экземпляр класса → throw с контекстом (ключ/eid) — D-013', () => {
    const map = new Map([[1, 'a']]);
    expect(() => canonicalize(map, 'resources["rel"] eid=7')).toThrow(/Map/);
    expect(() => canonicalize(map, 'resources["rel"] eid=7')).toThrow(
      /resources\["rel"\] eid=7/,
    );
    expect(() => canonicalize(new Set([1]), 'resources["mem"] eid=3')).toThrow(/Set/);
    class Foo {
      x = 1;
    }
    expect(() => canonicalize(new Foo(), 'val')).toThrow(/plain/);
  });

  it('undefined ВНУТРИ значения объекта тоже бросает (путь показывает ключ)', () => {
    expect(() => canonicalize({ a: 1, b: undefined })).toThrow(/undefined/);
    expect(() => canonicalize({ a: 1, b: undefined })).toThrow(/\.b/);
  });

  it('дыра в массиве → throw', () => {
    const holey: number[] = [1, 2];
    holey[5] = 6; // индексы 2..4 — дыры
    expect(() => canonicalize(holey)).toThrow(/дыра/);
  });
});

/**
 * Строит мир из «программы» — списка команд. Позволяет собрать ОДНО И ТО ЖЕ
 * логическое состояние разными путями (для проверки инвариантности хэша).
 */
type Cmd =
  | { op: 'spawn' }
  | { op: 'set'; key: string; eid: number; value: unknown }
  | { op: 'destroy'; eid: number };

function build(seed: number, program: readonly Cmd[]): SimWorld {
  const world = createSimWorld(seed as Seed);
  for (const cmd of program) {
    if (cmd.op === 'spawn') spawnEntity(world.ecs);
    else if (cmd.op === 'set') world.resources.set(cmd.key, id(cmd.eid), cmd.value);
    else destroyEntity(world, id(cmd.eid));
  }
  return world;
}

describe('DoD #1: hashSnapshot инвариантен к порядку вставки', () => {
  it('ключи ресурсов и поля объектов-значений в разном порядке → один хэш', () => {
    // Мир A: одни eid, значения-объекты вставлены полями в одном порядке,
    // ключи ресурсов — в одном порядке.
    const a = build(123, [
      { op: 'spawn' },
      { op: 'spawn' },
      { op: 'set', key: 'name', eid: 1, value: 'Sidorovich' },
      { op: 'set', key: 'inv', eid: 1, value: { gun: 1, bread: 2, ammo: 3 } },
      { op: 'set', key: 'name', eid: 2, value: 'Wolf' },
    ]);
    // Мир B: ТЕ ЖЕ факты, но ключи ресурсов и поля объекта — в ДРУГОМ порядке.
    const b = build(123, [
      { op: 'spawn' },
      { op: 'spawn' },
      { op: 'set', key: 'name', eid: 2, value: 'Wolf' },
      { op: 'set', key: 'inv', eid: 1, value: { ammo: 3, bread: 2, gun: 1 } },
      { op: 'set', key: 'name', eid: 1, value: 'Sidorovich' },
    ]);

    const snapA = serialize(a);
    const snapB = serialize(b);
    expect(hashSnapshot(snapA)).toBe(hashSnapshot(snapB));
    // И каноничная строка тоже совпадает (сильнее, чем совпадение хэша).
    expect(canonicalize(snapA)).toBe(canonicalize(snapB));
  });
});

describe('DoD #3: закон №3 — покойник не попадает в снапшот', () => {
  it('destroyEntity одной из трёх → её нет в entities/resources, хэш только по живым', () => {
    const world = createSimWorld(7 as Seed);
    const e1 = spawnEntity(world.ecs);
    const e2 = spawnEntity(world.ecs);
    const e3 = spawnEntity(world.ecs);
    world.resources.set('name', e1, 'A');
    world.resources.set('name', e2, 'B');
    world.resources.set('name', e3, 'C');
    world.resources.set('inv', e2, ['артефакт']);

    destroyEntity(world, e2);

    const snap = serialize(world);
    // e2 нет среди живых сущностей.
    expect(snap.entities).not.toContain(e2);
    expect(snap.entities).toEqual([e1, e3]);
    // e2 нет в ресурсах ни под одним ключом.
    const names = snap.resources['name'] ?? [];
    expect(names.map(([eid]) => eid)).toEqual([e1, e3]);
    // Ключ 'inv' был только у e2 → после фильтрации отсутствует целиком.
    expect(snap.resources['inv']).toBeUndefined();

    // Эталон фильтрации: мир, где eid 2 ЖИВ, но без ресурсов. Набор ресурсов по
    // живым eid обязан совпасть с миром, где eid 2 УБИТ (в обоих его ресурсов нет).
    const world2 = createSimWorld(7 as Seed);
    const f1 = spawnEntity(world2.ecs);
    spawnEntity(world2.ecs); // eid 2 — живой, но без ресурсов
    const f3 = spawnEntity(world2.ecs);
    world2.resources.set('name', f1, 'A');
    world2.resources.set('name', f3, 'C');
    expect(snap.resources).toEqual(serialize(world2).resources);
    // Но entities РАЗЛИЧАЮТСЯ: в world eid 2 мёртв, в world2 — жив.
    expect(serialize(world2).entities).toEqual([e1, e2, e3]);
    expect(snap.entities).toEqual([e1, e3]);
  });

  it('serialize НЕ включает покойника даже если бы запись осталась в ResourceStore', () => {
    // Симулируем «протёкшую» запись: пишем ресурс на eid, которого нет среди
    // живых (обходя единую точку удаления). serialize обязан её отфильтровать.
    const world = createSimWorld(1 as Seed);
    const alive = spawnEntity(world.ecs); // eid 1
    world.resources.set('name', alive, 'Alive');
    // Запись-призрак на никогда-не-живший eid 999.
    world.resources.set('name', id(999), 'Ghost');

    const snap = serialize(world);
    const names = snap.resources['name'] ?? [];
    expect(names.map(([eid]) => eid)).toEqual([alive]);
    expect(names.some(([, v]) => v === 'Ghost')).toBe(false);
  });
});

describe('DoD #4: entities отсортирован; два мира с одним seed → идентичны', () => {
  it('entities по возрастанию даже после destroy/reuse', () => {
    const world = createSimWorld(5 as Seed);
    const [e1, e2, e3] = [
      spawnEntity(world.ecs),
      spawnEntity(world.ecs),
      spawnEntity(world.ecs),
    ];
    destroyEntity(world, e2);
    const e4 = spawnEntity(world.ecs); // переиспользует eid e2 (freelist)
    expect(e4).toBe(e2);
    const snap = serialize(world);
    expect(snap.entities).toEqual([e1, e2, e3]);
    expect(snap.entities).toEqual([...snap.entities].sort((x, y) => x - y));
  });

  it('одинаковый seed + одинаковая программа → идентичные serialize и hashSnapshot', () => {
    const program: readonly Cmd[] = [
      { op: 'spawn' },
      { op: 'spawn' },
      { op: 'spawn' },
      { op: 'set', key: 'name', eid: 1, value: 'Стрелок' },
      { op: 'set', key: 'hp', eid: 1, value: 100 },
      { op: 'set', key: 'name', eid: 3, value: 'Болотный Доктор' },
      { op: 'destroy', eid: 2 },
      { op: 'spawn' }, // reuse eid 2
      { op: 'set', key: 'name', eid: 2, value: 'Новичок' },
    ];
    const a = serialize(build(999, program));
    const b = serialize(build(999, program));
    expect(a).toEqual(b);
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('разный seed → разный snapshot (seed попадает в снапшот)', () => {
    const program: readonly Cmd[] = [{ op: 'spawn' }];
    const a = serialize(build(1, program));
    const b = serialize(build(2, program));
    expect(a.seed).not.toBe(b.seed);
    expect(hashSnapshot(a)).not.toBe(hashSnapshot(b));
  });
});

describe('DoD #5: exportEntityIndex сериализуем, детерминирован, без дыр', () => {
  it('после create/destroy/reuse индекс проходит JSON round-trip без throw', () => {
    const world = createSimWorld(3 as Seed);
    spawnEntity(world.ecs);
    const b = spawnEntity(world.ecs);
    spawnEntity(world.ecs);
    destroyEntity(world, b);
    spawnEntity(world.ecs); // reuse
    const idx = exportEntityIndex(world.ecs);
    expect(() => JSON.parse(JSON.stringify(idx))).not.toThrow();
    // Канонизатор не встретит undefined/дыр (иначе бросил бы).
    expect(() => canonicalize(idx)).not.toThrow();
  });

  it('sparse нормализован в плотный массив без дыр (индекс 0 → 0, не undefined)', () => {
    const world = createSimWorld(3 as Seed);
    spawnEntity(world.ecs);
    spawnEntity(world.ecs);
    const idx = exportEntityIndex(world.ecs) as {
      sparse: number[];
      dense: number[];
      aliveCount: number;
      maxId: number;
    };
    // Ни одного empty-item: каждый индекс присутствует.
    expect(idx.sparse.every((_, i) => i in idx.sparse)).toBe(true);
    expect(idx.dense.every((_, i) => i in idx.dense)).toBe(true);
    // Все значения — числа (никаких undefined/null).
    expect(idx.sparse.every((v) => typeof v === 'number')).toBe(true);
    expect(idx.dense.every((v) => typeof v === 'number')).toBe(true);
    // Дыра id 0 заполнена нулём.
    expect(idx.sparse[0]).toBe(0);
    expect(idx.aliveCount).toBe(2);
    expect(idx.maxId).toBe(2);
  });

  it('два одинаковых мира → одинаковый blob индекса (детерминизм)', () => {
    const make = (): SimWorld => {
      const w = createSimWorld(42 as Seed);
      const a = spawnEntity(w.ecs);
      spawnEntity(w.ecs);
      spawnEntity(w.ecs);
      destroyEntity(w, a);
      spawnEntity(w.ecs);
      return w;
    };
    const idxA = exportEntityIndex(make().ecs);
    const idxB = exportEntityIndex(make().ecs);
    expect(idxA).toEqual(idxB);
    expect(canonicalize(idxA)).toBe(canonicalize(idxB));
  });
});

describe('значения ресурсов ИЗОЛИРОВАНЫ от живого мира (deep-clone)', () => {
  it('(а) мутация значения В СНАПШОТЕ не меняет ResourceStore', () => {
    const world = createSimWorld(2 as Seed);
    const e = spawnEntity(world.ecs);
    world.resources.set('inv', e, ['gun', 'bread']);
    world.resources.set('stats', e, { hp: 100, nested: { sta: 50 } });

    const snap = serialize(world);
    // Мутируем клонированные значения внутри снапшота (массив и вложенный объект).
    (snap.resources['inv']![0]![1] as string[]).push('artifact');
    (snap.resources['stats']![0]![1] as { hp: number; nested: { sta: number } }).nested.sta = 1;

    // Живой мир НЕ затронут — снапшот держит независимые копии.
    expect(world.resources.get('inv', e)).toEqual(['gun', 'bread']);
    expect(world.resources.get('stats', e)).toEqual({ hp: 100, nested: { sta: 50 } });
  });

  it('(б) мутация значения в МИРЕ после serialize не меняет снятый снапшот', () => {
    const world = createSimWorld(2 as Seed);
    const e = spawnEntity(world.ecs);
    const inv = ['gun'];
    world.resources.set('inv', e, inv);

    const snap = serialize(world);
    const hashBefore = hashSnapshot(snap);

    // Мутируем значение in-place в живом мире ПОСЛЕ снятия снимка.
    inv.push('artifact');
    world.resources.set('name', e, 'Позже'); // и добавляем новый ресурс

    // Уже снятый снимок неизменен — ни значение, ни хэш.
    expect(snap.resources['inv']![0]![1]).toEqual(['gun']);
    expect(snap.resources['name']).toBeUndefined();
    expect(hashSnapshot(snap)).toBe(hashBefore);
  });

  it('клон структурно РАВЕН оригиналу → хэш детерминизма не изменился', () => {
    const world = createSimWorld(2 as Seed);
    const e = spawnEntity(world.ecs);
    const value = { a: [1, 2, { b: 'x' }], c: null };
    world.resources.set('deep', e, value);
    const snap = serialize(world);
    // Значение в снапшоте равно исходному (но это другой объект — deep-clone).
    expect(snap.resources['deep']![0]![1]).toEqual(value);
    expect(snap.resources['deep']![0]![1]).not.toBe(value);
  });
});

describe('serialize: цельность формы снапшота (D-012/D-014)', () => {
  it('несёт version/seed/tick/rngState/eventSeq/components и лог событий', () => {
    const world = createSimWorld(11 as Seed);
    spawnEntity(world.ecs);
    // Публикуем и фиксируем событие, чтобы проверить eventSeq/eventLog.
    world.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } });
    world.bus.endTick(0);

    const snap = serialize(world);
    expect(snap.version).toBe(1);
    expect(snap.seed).toBe(11);
    expect(snap.tick).toBe(0);
    expect(snap.rngState).toBe(world.rng.state);
    expect(snap.eventSeq).toBe(world.bus.eventSeq);
    expect(snap.eventSeq).toBe(1);
    expect(snap.components).toEqual({});
    expect(snap.eventLog.map((e) => e.id)).toEqual([1]);
    // Весь снапшот канонизуем (в т.ч. лог с causedBy:null).
    expect(() => hashSnapshot(snap)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// УСИЛЕНИЕ QA (задача 0.5a). Ниже — тесты, читаемые как сценарии мира: числовые
// края канона, чувствительность хэша к КАЖДОМУ полю (нет «схлопывания»), клон vs
// живые ссылки, форма freelist для resume (0.5b), прогон нескольких тиков.
// ─────────────────────────────────────────────────────────────────────────────

describe('canonicalize: числовые края — строка стабильна и различает значения', () => {
  it('−0 и 0 канонизируются одинаково в "0" (как JSON; знак нуля не несёт смысла)', () => {
    // Number.prototype.toString(-0) === "0" (и JSON.stringify(-0) === "0"): канон
    // намеренно наследует эту семантику. eid/деньги/hp не бывают −0, так что
    // склейка безопасна; фиксируем её, чтобы изменение канона не прошло молча.
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });

  it('отрицательные (в т.ч. versionMask = −16777216 из ecsIndex) сохраняют знак', () => {
    // versionMask в blob bitecs отрицателен — канон обязан его пронести дословно,
    // иначе восстановленный индекс (0.5b) разошёлся бы по битам.
    expect(canonicalize(-16777216)).toBe('-16777216');
    expect(canonicalize(-7)).toBe('-7');
    // Отрицательное и положительное того же модуля — разные строки (нет склейки).
    expect(canonicalize(-5)).not.toBe(canonicalize(5));
  });

  it('большие целые (2^31, 2^32−1, 2^53) — десятичная строка без экспоненты', () => {
    expect(canonicalize(2 ** 31)).toBe('2147483648');
    expect(canonicalize(2 ** 32 - 1)).toBe('4294967295');
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    // Соседние большие целые различимы (нет потери младшего разряда в строке).
    expect(canonicalize(2 ** 31)).not.toBe(canonicalize(2 ** 31 + 1));
  });

  it('float 0.1+0.2 → одна и та же строка при повторе (детерминизм IEEE-754)', () => {
    const s = canonicalize(0.1 + 0.2);
    expect(s).toBe('0.30000000000000004');
    expect(canonicalize(0.1 + 0.2)).toBe(s); // стабильно между вызовами
    // Логически «0.3», собранное иначе, отличается по битам ⇒ разная строка.
    expect(canonicalize(0.3)).not.toBe(s);
  });
});

describe('canonicalize: глубокая вложенность — сортировка ключей на всех уровнях', () => {
  it('объект-в-массиве-в-объекте: ключи сортируются везде, массивы держат порядок', () => {
    // Одно логическое дерево, собранное двумя путями (поля объектов в разном
    // порядке), — одна каноничная строка на любой глубине.
    const a = canonicalize({
      z: [{ y: 1, x: 2 }, { b: [3, 1, 2], a: 0 }],
      m: { deep: { q: 9, p: 8 } },
    });
    const b = canonicalize({
      m: { deep: { p: 8, q: 9 } },
      z: [{ x: 2, y: 1 }, { a: 0, b: [3, 1, 2] }],
    });
    expect(a).toBe(b);
    // Массив [3,1,2] сохранил порядок; все объекты — по возрастанию ключей.
    expect(a).toBe(
      '{"m":{"deep":{"p":8,"q":9}},"z":[{"x":2,"y":1},{"a":0,"b":[3,1,2]}]}',
    );
  });

  it('ключи-числа-строки сортируются ЛЕКСИКОГРАФИЧЕСКИ (почему eid-карты — массивы, D-013)', () => {
    // "10" < "2" по UTF-16 — не числовой порядок. Значит объект, ключёванный
    // eid-строками, отсортировался бы не по eid: D-013 и требует хранить такие
    // карты отсортированным массивом [eid,value], а не объектом.
    expect(canonicalize({ '10': 'a', '2': 'b', '1': 'c' })).toBe(
      '{"1":"c","10":"a","2":"b"}',
    );
  });
});

/**
 * Полный, «богатый» снапшот для проверки чувствительности хэша к каждому полю:
 * две сущности, два ключа ресурсов, одно зафиксированное событие.
 */
function richSnapshot(): SnapshotJSON {
  const w = createSimWorld(555 as Seed);
  const e1 = spawnEntity(w.ecs);
  spawnEntity(w.ecs);
  w.resources.set('name', e1, 'Стрелок');
  w.resources.set('inv', e1, { ammo: 5, gun: 1 });
  w.tick = 0;
  w.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 } });
  w.bus.endTick(0);
  return serialize(w);
}

describe('hashSnapshot: чувствительность к КАЖДОМУ полю (нет схлопывания)', () => {
  it('изменение любого поля SnapshotJSON меняет хэш', () => {
    const base = richSnapshot();
    const h0 = hashSnapshot(base);

    // Каждый вариант отличается от base ровно одним полем ⇒ обязан дать иной хэш.
    const variants: ReadonlyArray<readonly [string, SnapshotJSON]> = [
      ['version', { ...base, version: 2 as unknown as 1 }],
      ['seed', { ...base, seed: 556 as Seed }],
      ['tick', { ...base, tick: 1 as Tick }],
      ['rngState', { ...base, rngState: base.rngState + 1 }],
      ['eventSeq', { ...base, eventSeq: base.eventSeq + 1 }],
      [
        'ecsIndex',
        { ...base, ecsIndex: { ...(base.ecsIndex as object), maxId: 99 } as SnapshotJSON['ecsIndex'] },
      ],
      ['entities', { ...base, entities: [...base.entities, 99 as EntityId] }],
      [
        'resources',
        {
          ...base,
          resources: { ...base.resources, name: [[1 as EntityId, 'Волк']] },
        },
      ],
      ['components', { ...base, components: { marker: 1 } }],
      ['eventLog', { ...base, eventLog: [] }],
    ];

    const seen = new Map<string, string>([['<base>', h0]]);
    for (const [field, snap] of variants) {
      const h = hashSnapshot(snap);
      expect(h, `поле '${field}' не изменило хэш (схлопывание)`).not.toBe(h0);
      seen.set(field, h);
    }
    // Все хэши различны попарно — ни одно поле не «перекрывает» другое.
    expect(new Set(seen.values()).size).toBe(seen.size);
  });

  it('перестановка значений между полями (tick↔eventSeq) даёт РАЗНЫЕ хэши', () => {
    // Ключи в каноне помечены именами, поэтому обмен значениями между полями не
    // сталкивается в одну строку (нет «структурной» коллизии).
    const base = richSnapshot();
    const swapped: SnapshotJSON = {
      ...base,
      tick: base.eventSeq as Tick,
      eventSeq: base.tick,
    };
    expect(hashSnapshot(swapped)).not.toBe(hashSnapshot(base));
  });
});

describe('пустой мир: сериализуется и хэшируется без throw (голден-хэш)', () => {
  it('0 сущностей / 0 ресурсов / 0 событий — валидный снапшот и стабильный хэш', () => {
    const world = createSimWorld(0 as Seed);
    const snap = serialize(world);
    expect(snap.entities).toEqual([]);
    expect(snap.resources).toEqual({});
    expect(snap.eventLog).toEqual([]);
    expect(snap.eventSeq).toBe(0);
    expect(() => hashSnapshot(snap)).not.toThrow();
    // Голден-хэш: детерминированный якорь. Изменение канонизатора/формы пустого
    // снапшота (регрессия детерминизма) уронит этот тест сразу.
    expect(hashSnapshot(snap)).toBe('481914ae');
    expect(hashSnapshot(snap)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('снимок vs живые ссылки: клон internals, но НЕ значений ресурсов', () => {
  it('exportEntityIndex — КЛОН: мутация возвращённого blob не меняет мир', () => {
    const world = createSimWorld(3 as Seed);
    spawnEntity(world.ecs);
    const b = spawnEntity(world.ecs);
    spawnEntity(world.ecs);
    destroyEntity(world, b);
    spawnEntity(world.ecs); // reuse

    const before = exportEntityIndex(world.ecs) as {
      aliveCount: number;
      dense: number[];
      sparse: number[];
    };
    // Портим возвращённый blob всеми способами.
    before.aliveCount = 999;
    before.dense.push(123);
    before.sparse[0] = 777;

    // Повторный экспорт ТОГО ЖЕ мира обязан дать исходную форму (blob был копией).
    const after = exportEntityIndex(world.ecs) as typeof before;
    expect(after.aliveCount).not.toBe(999);
    expect(after.dense).not.toContain(123);
    expect(after.sparse[0]).toBe(0);
  });

  it('serialize().entities — свежий массив: мутация не влияет на повторный serialize', () => {
    const world = createSimWorld(3 as Seed);
    spawnEntity(world.ecs);
    spawnEntity(world.ecs);
    const snap = serialize(world);
    (snap.entities as EntityId[]).push(999 as EntityId);
    (snap.entities as EntityId[]).sort(() => -1); // и порядок портим
    // Свежий serialize не заражён мутацией предыдущего результата.
    expect(serialize(world).entities).toEqual([1, 2]);
  });

  it('ЗНАЧЕНИЯ ресурсов КЛОНИРУЮТСЯ: снапшот НЕ делит ссылку с ResourceStore (обе стороны)', () => {
    // Ревью-правка 0.5a: serialize кладёт в снапшот DEEP-CLONE значения, а не
    // ссылку (консистентно с exportEntityIndex). Снимок независим от живого мира
    // в ОБЕ стороны — критично для 0.5b (снимок держится для resume между тиками).
    const world = createSimWorld(3 as Seed);
    const e = spawnEntity(world.ecs);
    world.resources.set('inv', e, { ammo: 5 });

    const snap = serialize(world);
    const invPairs = snap.resources['inv'] as ReadonlyArray<readonly [EntityId, { ammo: number }]>;
    const value = invPairs[0]![1];
    // (а) Это РАЗНЫЕ объекты — не общая ссылка.
    expect(value).not.toBe(world.resources.get('inv', e));
    expect(value).toEqual({ ammo: 5 });
    // (б) Мутация значения в снапшоте НЕ протекает в живой мир.
    value.ammo = 999;
    expect(world.resources.get<{ ammo: number }>('inv', e)?.ammo).toBe(5);
    // (в) Мутация значения в мире НЕ протекает в уже снятый снапшот.
    world.resources.get<{ ammo: number }>('inv', e)!.ammo = 7;
    expect(value.ammo).toBe(999);
  });
});

describe('freelist в ecsIndex: форма и resume-семантика (критично для 0.5b)', () => {
  it('add 1..4, remove 2,3 → dense=[1,4,3,2], aliveCount=2 (живой префикс + хвост-freelist)', () => {
    const world = createSimWorld(1 as Seed);
    const e1 = spawnEntity(world.ecs);
    const e2 = spawnEntity(world.ecs);
    const e3 = spawnEntity(world.ecs);
    const e4 = spawnEntity(world.ecs);
    expect([e1, e2, e3, e4]).toEqual([1, 2, 3, 4]);
    destroyEntity(world, e2);
    destroyEntity(world, e3);

    const idx = exportEntityIndex(world.ecs) as {
      dense: number[];
      sparse: number[];
      aliveCount: number;
      maxId: number;
    };
    // Живой префикс — первые aliveCount элементов dense; хвост — freelist мёртвых.
    expect(idx.aliveCount).toBe(2);
    expect(idx.dense).toEqual([1, 4, 3, 2]);
    expect(idx.dense.slice(0, idx.aliveCount)).toEqual([1, 4]); // живые
    expect(idx.dense.slice(idx.aliveCount)).toEqual([3, 2]); // freelist (порядок гибели)
    expect(idx.maxId).toBe(4);
    expect(idx.sparse).toEqual([0, 0, 3, 2, 1]);
    // entities (производное) — только живые, отсортированы.
    expect(serialize(world).entities).toEqual([1, 4]);
  });

  it('ОДИНАКОВЫЙ живой набор, но РАЗНАЯ история create/destroy → РАЗНЫЙ хэш (resume-семантика)', () => {
    // Мир A: сущности 1,2,3, никогда ничего не удаляли (freelist пуст, maxId=3).
    const a = createSimWorld(9 as Seed);
    spawnEntity(a.ecs);
    spawnEntity(a.ecs);
    spawnEntity(a.ecs);

    // Мир B: тот же ЖИВОЙ набор {1,2,3}, но история другая — был eid 4 и умер
    // (freelist={4}, maxId=4). entities идентичны, ecsIndex — нет.
    const b = createSimWorld(9 as Seed);
    spawnEntity(b.ecs);
    spawnEntity(b.ecs);
    spawnEntity(b.ecs);
    const four = spawnEntity(b.ecs);
    destroyEntity(b, four);

    const snapA = serialize(a);
    const snapB = serialize(b);
    // Живой набор совпадает…
    expect(snapA.entities).toEqual(snapB.entities);
    expect(snapA.entities).toEqual([1, 2, 3]);
    // …но ecsIndex (freelist/maxId) различается ⇒ хэши обязаны РАЗЛИЧАТЬСЯ.
    // Это и есть контракт resume (D-011): порядок freelist — часть состояния,
    // иначе после load NPC переиспользовали бы eid в другом порядке.
    expect(hashSnapshot(snapA)).not.toBe(hashSnapshot(snapB));
    expect(snapA.ecsIndex).not.toEqual(snapB.ecsIndex);
  });
});

describe('serialize после нескольких тиков с фейк-системой, публикующей события', () => {
  it('eventLog снапшота = bus.log, eventSeq и tick совпадают', () => {
    const world = createSimWorld(77 as Seed);
    const hero = spawnEntity(world.ecs);
    world.resources.set('name', hero, 'Меченый');

    // «Фейк-система»: каждый тик публикует событие причинно (первое — корень,
    // следующие ссылаются на предыдущее), затем планировщик-имитатор фиксирует
    // тик и сдвигает world.tick. Три тика.
    let prev: EventId | null = null;
    for (let t = 0; t < 3; t++) {
      world.tick = t as Tick;
      const idPublished: EventId = world.bus.publish({
        type: 'sim/tickStarted',
        causedBy: prev, // цепочка причин через тики
        payload: { tick: t as Tick },
      });
      prev = idPublished;
      world.bus.endTick(t as Tick);
    }

    const snap = serialize(world);
    expect(snap.tick).toBe(2); // снят на последнем тике
    expect(snap.eventSeq).toBe(3);
    expect(snap.eventSeq).toBe(world.bus.eventSeq);
    // Лог в снапшоте = зафиксированный лог шины (порядок и содержимое).
    expect(snap.eventLog).toEqual(world.bus.log);
    expect(snap.eventLog.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(snap.eventLog.map((e) => e.tick)).toEqual([0, 1, 2]);
    // Причинная цепочка полная: корень null, далее каждый causedBy = id предыдущего.
    expect(snap.eventLog.map((e) => e.causedBy)).toEqual([null, 1, 2]);
    // Весь снапшот с непустым логом канонизуем и хэшируем без throw.
    expect(() => hashSnapshot(snap)).not.toThrow();
  });
});

describe('eid ВНУТРИ значения ресурса: канонизируется стабильно, остаётся числом', () => {
  it('значение [eid, {friendOf: eid2}] — стабильный канон, eid не теряется/не строкуется', () => {
    const world = createSimWorld(3 as Seed);
    const a = spawnEntity(world.ecs);
    const b = spawnEntity(world.ecs);
    // Отношение хранит eid друга и внутри объекта, и как элемент массива.
    world.resources.set('rel', a, [b, { friendOf: b }]);

    const snap = serialize(world);
    const rel = snap.resources['rel'] as ReadonlyArray<readonly [EntityId, unknown]>;
    expect(rel).toEqual([[a, [b, { friendOf: b }]]]);
    const pair = rel[0]!;
    // eid остались ЧИСЛАМИ (не превратились в строки при сериализации).
    expect(typeof pair[0]).toBe('number');
    const inner = pair[1] as [number, { friendOf: number }];
    expect(typeof inner[0]).toBe('number');
    expect(typeof inner[1].friendOf).toBe('number');
    // Канон стабилен и не переставляет массив [eid, obj] (порядок — данные).
    expect(canonicalize(rel)).toBe(`[[${a},[${b},{"friendOf":${b}}]]]`);
    // Тот же факт, собранный с другим порядком полей объекта, — тот же канон.
    const world2 = createSimWorld(3 as Seed);
    const a2 = spawnEntity(world2.ecs);
    const b2 = spawnEntity(world2.ecs);
    world2.resources.set('rel', a2, [b2, { friendOf: b2 }]);
    expect(canonicalize(serialize(world2).resources['rel'])).toBe(canonicalize(rel));
  });
});
