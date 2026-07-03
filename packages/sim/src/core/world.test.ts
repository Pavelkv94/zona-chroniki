/**
 * @module @zona/sim/core/world.test
 *
 * Юниты каркаса ядра (задача 0.1): детерминизм итерации ResourceStore,
 * корректность get/set/delete, инициализация SimWorld и жизненный цикл
 * сущностей в обёртке над bitecs.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed } from '@zona/shared';
import { createSimWorld, destroyEntity } from './world';
import {
  spawnEntity,
  destroyEcsEntity,
  existsEntity,
  allEntities,
  createEcsWorld,
} from './ecs';

/** Утилита: сырое число → branded EntityId для тестовых сценариев. */
const id = (n: number): EntityId => n as EntityId;

describe('ResourceStore', () => {
  it('entries() детерминирован: вставка 5,1,3 → выдача по возрастанию 1,3,5', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set('name', id(5), 'e5');
    resources.set('name', id(1), 'e1');
    resources.set('name', id(3), 'e3');

    const out = resources.entries<string>('name');
    expect(out.map(([eid]) => eid)).toEqual([1, 3, 5]);
    expect(out).toEqual([
      [1, 'e1'],
      [3, 'e3'],
      [5, 'e5'],
    ]);
  });

  it('порядок entries() не зависит от порядка вставки', () => {
    const a = createSimWorld(0 as Seed).resources;
    const b = createSimWorld(0 as Seed).resources;
    a.set('k', id(2), 'x');
    a.set('k', id(10), 'y');
    a.set('k', id(1), 'z');
    b.set('k', id(10), 'y');
    b.set('k', id(1), 'z');
    b.set('k', id(2), 'x');
    expect(a.entries('k')).toEqual(b.entries('k'));
    // Числовая, а не лексикографическая сортировка: 10 после 2.
    expect(a.entries<string>('k').map(([e]) => e)).toEqual([1, 2, 10]);
  });

  it('get/set читает записанное; set перезаписывает', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set('hp', id(7), 100);
    expect(resources.get<number>('hp', id(7))).toBe(100);
    resources.set('hp', id(7), 42);
    expect(resources.get<number>('hp', id(7))).toBe(42);
  });

  it('get несуществующего ключа/eid = undefined', () => {
    const { resources } = createSimWorld(0 as Seed);
    expect(resources.get('missing', id(1))).toBeUndefined();
    resources.set('name', id(1), 'a');
    expect(resources.get('name', id(999))).toBeUndefined();
    expect(resources.entries('missing')).toEqual([]);
  });

  it('delete удаляет пару; повторный delete/несуществующий безопасен', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set('name', id(1), 'a');
    resources.set('name', id(2), 'b');
    resources.delete('name', id(1));
    expect(resources.get('name', id(1))).toBeUndefined();
    expect(resources.get('name', id(2))).toBe('b');
    expect(() => resources.delete('name', id(1))).not.toThrow();
    expect(() => resources.delete('nope', id(1))).not.toThrow();
    expect(resources.entries<string>('name').map(([e]) => e)).toEqual([2]);
  });

  it('разные ключи изолированы', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set('name', id(1), 'a');
    resources.set('faction', id(1), 'loners');
    expect(resources.get('name', id(1))).toBe('a');
    expect(resources.get('faction', id(1))).toBe('loners');
  });
});

describe('createSimWorld', () => {
  it('стартовое состояние: tick === 0 и seed сохранён', () => {
    const world = createSimWorld(42 as Seed);
    expect(world.tick).toBe(0);
    expect(world.seed).toBe(42);
  });

  it('свежий ResourceStore пуст', () => {
    const world = createSimWorld(1 as Seed);
    expect(world.resources.entries('name')).toEqual([]);
  });

  it('каждый вызов создаёт независимый мир', () => {
    const a = createSimWorld(1 as Seed);
    const b = createSimWorld(1 as Seed);
    a.resources.set('name', id(1), 'a');
    expect(b.resources.get('name', id(1))).toBeUndefined();
  });

  it('world.rng — детерминированный PRNG от seed мира (задача 0.3)', () => {
    // Один seed → идентичные потоки; продвижение одного мира не трогает другой.
    const a = createSimWorld(42 as Seed);
    const b = createSimWorld(42 as Seed);
    const seqA = [a.rng.next(), a.rng.next(), a.rng.next()];
    const seqB = [b.rng.next(), b.rng.next(), b.rng.next()];
    expect(seqA).toEqual(seqB);
    expect(a.rng.fork('sys').next()).toBe(b.rng.fork('sys').next());
  });
});

describe('bitecs-обёртка: жизненный цикл сущностей', () => {
  it('spawn → existsEntity true; destroyEcsEntity → false', () => {
    const w = createEcsWorld();
    const eid = spawnEntity(w);
    expect(existsEntity(w, eid)).toBe(true);
    destroyEcsEntity(w, eid);
    expect(existsEntity(w, eid)).toBe(false);
  });

  it('allEntities() отсортирован по возрастанию даже после destroy+переиспользования eid', () => {
    const w = createEcsWorld();
    const e1 = spawnEntity(w);
    const e2 = spawnEntity(w);
    const e3 = spawnEntity(w);
    expect([e1, e2, e3]).toEqual([1, 2, 3]);
    destroyEcsEntity(w, e2); // освобождаем eid 2
    const reused = spawnEntity(w); // bitecs выдаёт снова eid 2 (freelist)
    expect(reused).toBe(e2);
    // Несмотря на порядок freelist [1,3,2], обёртка отдаёт строго [1,2,3].
    expect(allEntities(w)).toEqual([1, 2, 3]);
  });
});

describe('destroyEntity(world): единая точка удаления (ECS + ресурсы)', () => {
  it('SimWorld.ecs пригоден для spawn; destroyEntity убирает из ECS', () => {
    const world = createSimWorld(7 as Seed);
    const eid = spawnEntity(world.ecs);
    expect(existsEntity(world.ecs, eid)).toBe(true);
    destroyEntity(world, eid);
    expect(existsEntity(world.ecs, eid)).toBe(false);
  });

  it('destroyEntity идемпотентен: повтор и несуществующий eid безопасны', () => {
    const world = createSimWorld(0 as Seed);
    const eid = spawnEntity(world.ecs);
    destroyEntity(world, eid);
    expect(() => destroyEntity(world, eid)).not.toThrow();
    expect(() => destroyEntity(world, id(9999))).not.toThrow();
  });
});

describe('ResourceStore.has и purgeEntity', () => {
  it('has отличает «нет пары» от «значение === undefined»', () => {
    const { resources } = createSimWorld(0 as Seed);
    expect(resources.has('name', id(1))).toBe(false);
    resources.set<undefined>('name', id(1), undefined);
    // get отдаёт undefined в обоих случаях, has — различает.
    expect(resources.get('name', id(1))).toBeUndefined();
    expect(resources.has('name', id(1))).toBe(true);
    resources.delete('name', id(1));
    expect(resources.has('name', id(1))).toBe(false);
  });

  it('purgeEntity вычищает eid по ВСЕМ ключам, не трогая соседние eid', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set('name', id(1), 'A');
    resources.set('inv', id(1), ['gun']);
    resources.set('hp', id(1), 100);
    // соседи по тем же ключам
    resources.set('name', id(2), 'B');
    resources.set('inv', id(3), ['bread']);

    resources.purgeEntity(id(1));

    // eid=1 исчез из всех ключей...
    expect(resources.has('name', id(1))).toBe(false);
    expect(resources.has('inv', id(1))).toBe(false);
    expect(resources.has('hp', id(1))).toBe(false);
    // ...соседи целы.
    expect(resources.get('name', id(2))).toBe('B');
    expect(resources.get<readonly string[]>('inv', id(3))).toEqual(['bread']);
    expect(resources.entries<string>('name').map(([e]) => e)).toEqual([2]);
    expect(resources.entries<readonly string[]>('inv').map(([e]) => e)).toEqual([3]);
  });

  it('purgeEntity несуществующего eid безопасен и ничего не меняет', () => {
    const { resources } = createSimWorld(0 as Seed);
    resources.set('name', id(1), 'A');
    expect(() => resources.purgeEntity(id(999))).not.toThrow();
    expect(resources.get('name', id(1))).toBe('A');
  });
});
