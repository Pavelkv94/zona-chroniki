/**
 * @module @zona/sim/core/world.invariants.test
 *
 * QA-усиление задачи 0.1. Эти тесты читаются как сценарии жизни мира и
 * проверяют ТРИ инварианта каркаса ядра, а не отдельные поля:
 *
 *  1. ResourceStore.entries(key) детерминирован по возрастанию eid —
 *     независимо от порядка вставки И от удалений (закон №8).
 *  2. createSimWorld(seed) рождает чистый воспроизводимый мир.
 *  3. Обёртка bitecs 0.4 согласована по spawn/destroy/exists, и — риск C-6 —
 *     ПЕРЕИСПОЛЬЗУЕТ eid после destroy. Единая точка удаления
 *     `destroyEntity(world, eid)` вычищает и ECS, и ResourceStore, поэтому новая
 *     сущность на переиспользованном eid читается как чистая (F-1 закрыта).
 *     Низкоуровневый `destroyEcsEntity` (только ECS) используется для проверки
 *     самой обёртки движка.
 *
 * После доработки 0.1: F-1 (призрак ресурсов) и F-2 (несортированный
 * allEntities) инвертированы — теперь тесты фиксируют ИСПРАВЛЕННОЕ поведение.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed } from '@zona/shared';
import { createSimWorld, destroyEntity } from './world';
import {
  createEcsWorld,
  spawnEntity,
  destroyEcsEntity,
  existsEntity,
  allEntities,
} from './ecs';

/** Сырое число → branded EntityId для тестовых сценариев. */
const id = (n: number): EntityId => n as EntityId;

/**
 * Все перестановки массива, вычисленные ДЕТЕРМИНИРОВАННО (без Math.random):
 * детерминизм обязателен и в тестах. Порядок перестановок фиксирован рекурсией.
 */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i]!, ...p]);
  }
  return out;
}

describe('ResourceStore: детерминизм итерации (закон №8)', () => {
  it('любая из 24 перестановок вставки {2,5,9,13} даёт одинаковый entries() по возрастанию', () => {
    const eids = [2, 5, 9, 13];
    const expected = eids.map((e) => [e, `v${e}`] as const);

    const results = permutations(eids).map((order) => {
      const { resources } = createSimWorld(0 as Seed);
      for (const e of order) resources.set('name', id(e), `v${e}`);
      return resources.entries<string>('name');
    });

    // Каждая перестановка вставки → идентичный отсортированный результат.
    for (const r of results) expect(r).toEqual(expected);
    // И все результаты попарно равны эталону — «одинаковый seed → одинаковая история».
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('сортировка ЧИСЛОВАЯ, а не лексикографическая: 2 < 10 < 100', () => {
    const { resources } = createSimWorld(0 as Seed);
    for (const e of [100, 2, 10, 21, 3]) resources.set('k', id(e), e);
    expect(resources.entries<number>('k').map(([e]) => e)).toEqual([2, 3, 10, 21, 100]);
  });

  it('порядок восстанавливается после удалений и повторных вставок в другом порядке', () => {
    const { resources } = createSimWorld(0 as Seed);
    // Насыщаем, вычищаем часть, дозаписываем «вперемешку».
    for (const e of [4, 1, 7, 2]) resources.set('m', id(e), `a${e}`);
    resources.delete('m', id(7));
    resources.delete('m', id(1));
    resources.set('m', id(5), 'a5');
    resources.set('m', id(1), 'a1-again');
    // Несмотря на историю вставок/удалений — строго по возрастанию eid.
    expect(resources.entries<string>('m')).toEqual([
      [1, 'a1-again'],
      [2, 'a2'],
      [4, 'a4'],
      [5, 'a5'],
    ]);
  });

  it('два независимых мира с одинаковыми операциями в разном порядке → идентичный лог entries()', () => {
    const w1 = createSimWorld(0 as Seed).resources;
    const w2 = createSimWorld(0 as Seed).resources;
    // Мир 1: прямой порядок.
    w1.set('inv', id(3), 'gun');
    w1.set('inv', id(1), 'bread');
    w1.set('inv', id(8), 'medkit');
    w1.delete('inv', id(3));
    // Мир 2: обратный порядок тех же итоговых фактов.
    w2.set('inv', id(8), 'medkit');
    w2.set('inv', id(3), 'gun');
    w2.set('inv', id(1), 'bread');
    w2.delete('inv', id(3));
    expect(w1.entries('inv')).toEqual(w2.entries('inv'));
    expect(w1.entries<string>('inv')).toEqual([
      [1, 'bread'],
      [8, 'medkit'],
    ]);
  });
});

describe('ResourceStore: граничные случаи', () => {
  it('пустой/неизвестный ключ → entries() === []', () => {
    const { resources } = createSimWorld(0 as Seed);
    expect(resources.entries('never-written')).toEqual([]);
  });

  it('удаление ПОСЛЕДНЕГО элемента ключа: entries() снова пуст, ключ переиспользуем', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set('solo', id(42), 'x');
    resources.delete('solo', id(42));
    expect(resources.entries('solo')).toEqual([]);
    expect(resources.get('solo', id(42))).toBeUndefined();
    // Ключ можно наполнить заново — предыдущее удаление не «сломало» бакет.
    resources.set('solo', id(1), 'y');
    expect(resources.entries<string>('solo')).toEqual([[1, 'y']]);
  });

  it('delete несуществующей пары и несуществующего ключа не бросает и не создаёт записей', () => {
    const { resources } = createSimWorld(0 as Seed);
    expect(() => resources.delete('ghost-key', id(1))).not.toThrow();
    resources.set('present', id(1), 'a');
    expect(() => resources.delete('present', id(999))).not.toThrow();
    expect(() => resources.delete('present', id(1))).not.toThrow();
    expect(() => resources.delete('present', id(1))).not.toThrow(); // повторно
    expect(resources.entries('present')).toEqual([]);
    // «Ощупывание» несуществующего ключа не должно было его материализовать.
    expect(resources.entries('ghost-key')).toEqual([]);
  });

  it('set(undefined) хранится как значение, но get его отдаёт (undefined как данные ≠ отсутствие)', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set<undefined>('opt', id(1), undefined);
    // Пара существует и попадает в entries, хотя значение === undefined.
    expect(resources.entries('opt')).toEqual([[1, undefined]]);
    expect(resources.get('opt', id(1))).toBeUndefined();
    // Это неотличимо от «нет пары» через get — потенциальная ловушка для вызывающего.
    expect(resources.get('opt', id(2))).toBeUndefined();
  });
});

describe('ResourceStore: изоляция и типы между ключами', () => {
  it('один eid под разными ключами держит разные значения и типы независимо', () => {
    const { resources } = createSimWorld(0 as Seed);
    const npc = id(1);
    resources.set<string>('name', npc, 'Sidorovich');
    resources.set<number>('hp', npc, 100);
    resources.set<readonly string[]>('inv', npc, ['bread', 'gun']);

    expect(resources.get<string>('name', npc)).toBe('Sidorovich');
    expect(resources.get<number>('hp', npc)).toBe(100);
    expect(resources.get<readonly string[]>('inv', npc)).toEqual(['bread', 'gun']);

    // Удаление одного ключа не задевает соседние ключи того же eid.
    resources.delete('hp', npc);
    expect(resources.get('hp', npc)).toBeUndefined();
    expect(resources.get<string>('name', npc)).toBe('Sidorovich');
    expect(resources.get<readonly string[]>('inv', npc)).toEqual(['bread', 'gun']);
  });

  it('одинаковый eid в разных ключах не конфликтует; entries() каждого ключа независим', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set('name', id(1), 'A');
    resources.set('name', id(2), 'B');
    resources.set('faction', id(1), 'loners');
    resources.set('faction', id(3), 'duty');
    expect(resources.entries<string>('name').map(([e]) => e)).toEqual([1, 2]);
    expect(resources.entries<string>('faction').map(([e]) => e)).toEqual([1, 3]);
  });
});

describe('bitecs-обёртка: жизненный цикл и allEntities()', () => {
  it('spawn N, destroy части → allEntities() содержит только живых', () => {
    const w = createEcsWorld();
    const spawned = Array.from({ length: 6 }, () => spawnEntity(w));
    // Убиваем каждую вторую.
    destroyEcsEntity(w, spawned[1]!);
    destroyEcsEntity(w, spawned[3]!);
    destroyEcsEntity(w, spawned[5]!);

    const alive = new Set(allEntities(w));
    expect(alive.has(spawned[0]!)).toBe(true);
    expect(alive.has(spawned[2]!)).toBe(true);
    expect(alive.has(spawned[4]!)).toBe(true);
    expect(alive.has(spawned[1]!)).toBe(false);
    expect(alive.has(spawned[3]!)).toBe(false);
    expect(alive.has(spawned[5]!)).toBe(false);
    expect(alive.size).toBe(3);
    // exists согласован с allEntities для каждой сущности.
    for (const e of spawned) expect(existsEntity(w, e)).toBe(alive.has(e));
  });

  it('destroy несуществующего/повторный destroy не бросают (идемпотентность вызова)', () => {
    const w = createEcsWorld();
    const e = spawnEntity(w);
    destroyEcsEntity(w, e);
    expect(() => destroyEcsEntity(w, e)).not.toThrow();
    expect(() => destroyEcsEntity(w, id(9999))).not.toThrow();
    expect(existsEntity(w, e)).toBe(false);
  });

  it('exists для никогда-не-рождённого id === false', () => {
    const w = createEcsWorld();
    expect(existsEntity(w, id(1))).toBe(false);
    expect(existsEntity(w, id(500))).toBe(false);
  });

  it('РИСК C-6: bitecs 0.4 ПЕРЕИСПОЛЬЗУЕТ eid после destroy', () => {
    const w = createEcsWorld();
    const a = spawnEntity(w);
    const b = spawnEntity(w);
    destroyEcsEntity(w, b);
    const reused = spawnEntity(w);
    // Освобождённый eid выдаётся снова — это и есть риск C-6 из D-007.
    expect(reused).toBe(b);
    expect(existsEntity(w, a)).toBe(true);
    expect(existsEntity(w, reused)).toBe(true);
  });

  it('F-2 (исправлено): allEntities() отсортирован по возрастанию даже после переиспользования eid', () => {
    const w = createEcsWorld();
    const [e1, e2, e3] = [spawnEntity(w), spawnEntity(w), spawnEntity(w)];
    destroyEcsEntity(w, e2);
    const e4 = spawnEntity(w); // займёт освобождённый eid e2 (freelist)
    const e5 = spawnEntity(w);
    const order = allEntities(w);
    // Внутренний порядок freelist был бы [e1, e3, e4(=e2), e5]; обёртка сортирует.
    expect(e4).toBe(e2);
    expect(order).toEqual([e1, e2, e3, e5]); // строго [1,2,3,4]
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });
});

describe('F-1 (исправлено): destroyEntity вычищает ResourceStore — призрака на переиспользованном eid нет', () => {
  it('после destroyEntity холодные данные сущности удалены из ResourceStore', () => {
    const world = createSimWorld(0 as Seed);
    const npc = spawnEntity(world.ecs);
    world.resources.set('name', npc, 'Стрелок');
    world.resources.set('inv', npc, ['артефакт']);

    destroyEntity(world, npc);

    // Сущности в ECS больше нет...
    expect(existsEntity(world.ecs, npc)).toBe(false);
    // ...и её «холодные» данные тоже вычищены (purgeEntity): сериализация по
    // entries() не захватит мусор мёртвого eid (D-007, риск C-6 закрыт).
    expect(world.resources.has('name', npc)).toBe(false);
    expect(world.resources.get<string>('name', npc)).toBeUndefined();
    expect(world.resources.entries('name')).toEqual([]);
    expect(world.resources.entries('inv')).toEqual([]);
  });

  it('новая сущность на освобождённом eid читается как ЧИСТАЯ (закон №3 соблюдён)', () => {
    const world = createSimWorld(0 as Seed);
    const dead = spawnEntity(world.ecs);
    world.resources.set('name', dead, 'Покойник');
    world.resources.set('inv', dead, ['ПМ', 'патроны']);
    destroyEntity(world, dead);

    // bitecs выдаёт тот же eid новой сущности...
    const fresh = spawnEntity(world.ecs);
    expect(fresh).toBe(dead); // C-6 переиспользование

    // ...но данные покойника уже вычищены — «свежий» NPC пуст, ничего не
    // появилось «из воздуха».
    expect(world.resources.has('name', fresh)).toBe(false);
    expect(world.resources.get<string>('name', fresh)).toBeUndefined();
    expect(world.resources.get<readonly string[]>('inv', fresh)).toBeUndefined();
  });
});
