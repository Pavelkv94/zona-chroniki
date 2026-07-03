/**
 * @module @zona/sim/core/causality.test
 *
 * Гейт инфраструктуры причинности (задача 1.2b, D-030/D-031/D-032). Проверяет ТОЛЬКО
 * инфраструктуру — НЕ подключение к системам (штамп в 1.8, чтение в 1.10/1.11):
 *  - новые ui32-поля причинности зарегистрированы и переживают save/load
 *    (Task.causeEvent / Position.moveCause / Health.lethalCause);
 *  - `addComponent` зануляет их у свежего носителя (D-024): не «остаток покойника»
 *    при переиспользовании eid, а честный 0 = «нет причины»;
 *  - `stampCause` пишет корректно и валидирует EventId по D-031 (0..0xFFFFFFFF,
 *    целое), бросая на выходе за диапазон вместо тихого усечения ссылки причинности.
 *
 * Компоненты — модульные singleton'ы: каждый тест берёт свежий мир (eid с 1) и
 * ВСЕГДА addComponent перед чтением (add зануляет слот, D-024) — стухшие значения
 * прошлого теста не протекают.
 */

import { describe, it, expect } from 'vitest';
import type { Seed, EntityId } from '@zona/shared';
import { createSimWorld, destroyEntity } from './world';
import {
  spawnEntity,
  addComponent,
  stampCause,
  hasComponent,
  type ComponentRef,
} from './ecs';
import { Position, Task, Health, TaskKind } from './components';
import { serialize, deserialize, hashSnapshot } from './snapshot';

/** Нетипизированный доступ к колонкам компонента (запись/чтение по eid). */
function cols(ref: ComponentRef): Record<string, { [i: number]: number }> {
  return ref as unknown as Record<string, { [i: number]: number }>;
}

describe('поля причинности переживают save/load (D-030, закон №8)', () => {
  it('Task/Position/Health: causeEvent/moveCause/lethalCause round-trip тождественны', () => {
    const w = createSimWorld(101 as Seed);
    const e = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, e);
    addComponent(w.ecs, Task, e);
    addComponent(w.ecs, Health, e);
    // Значимые НЕнулевые причины (EventId), плюс прочие поля — чтобы поймать сдвиг
    // порядка полей (append: причинность в конце).
    cols(Position)['loc']![e] = 3;
    cols(Position)['dest']![e] = 5;
    cols(Position)['moveCause']![e] = 4242;
    cols(Task)['kind']![e] = TaskKind.HUNT;
    cols(Task)['startedTick']![e] = 900;
    cols(Task)['causeEvent']![e] = 7777;
    cols(Health)['hp']![e] = 55;
    cols(Health)['lethalCause']![e] = 123456789;

    const snap1 = serialize(w);
    const w2 = deserialize(snap1);
    expect(hashSnapshot(serialize(w2))).toBe(hashSnapshot(snap1));

    // Значения причинности пережили round-trip до последнего бита ui32.
    expect(cols(Position)['moveCause']![e]).toBe(4242);
    expect(cols(Task)['causeEvent']![e]).toBe(7777);
    expect(cols(Health)['lethalCause']![e]).toBe(123456789);
    expect(hasComponent(w2.ecs, Position, e)).toBe(true);

    // Поле причинности сериализуется В КОНЦЕ колонки (append, закон №8).
    const pos = snap1.components['position'] as unknown as {
      fields: Record<string, number[]>;
    };
    expect(Object.keys(pos.fields)).toEqual(['loc', 'dest', 'etaTicks', 'moveCause']);
    expect(pos.fields['moveCause']).toEqual([4242]);
    const task = snap1.components['task'] as unknown as { fields: Record<string, number[]> };
    expect(Object.keys(task.fields)).toEqual([
      'kind',
      'targetLoc',
      'targetEid',
      'startedTick',
      'causeEvent',
    ]);
    const hp = snap1.components['health'] as unknown as { fields: Record<string, number[]> };
    expect(Object.keys(hp.fields)).toEqual(['hp', 'lethalCause']);
    expect(hp.fields['lethalCause']).toEqual([123456789]);
  });
});

describe('addComponent зануляет поля причинности переиспользованного eid (D-024)', () => {
  it('reuse eid: свежий носитель имеет causeEvent/moveCause/lethalCause = 0, не значение покойника', () => {
    const w = createSimWorld(102 as Seed);
    const dead = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, dead);
    addComponent(w.ecs, Task, dead);
    addComponent(w.ecs, Health, dead);
    // Покойник нёс НЕнулевые причины — они остаются в глобальных SoA-массивах.
    stampCause(Position, 'moveCause', dead, 111);
    stampCause(Task, 'causeEvent', dead, 222);
    stampCause(Health, 'lethalCause', dead, 333);
    destroyEntity(w, dead); // массивы ВСЁ ЕЩЁ держат 111/222/333

    const reborn = spawnEntity(w.ecs);
    expect(reborn).toBe(dead); // bitecs переиспользовал eid — иначе тест не про ghost
    addComponent(w.ecs, Position, reborn);
    addComponent(w.ecs, Task, reborn);
    addComponent(w.ecs, Health, reborn);
    // БЕЗ записи причин: полагаемся на зануление addComponent (0 = «нет причины»).
    expect(cols(Position)['moveCause']![reborn]).toBe(0);
    expect(cols(Task)['causeEvent']![reborn]).toBe(0);
    expect(cols(Health)['lethalCause']![reborn]).toBe(0);
  });
});

describe('stampCause: запись и guard EventId (D-030/D-031)', () => {
  it('пишет EventId в ui32-поле указанной сущности', () => {
    const w = createSimWorld(103 as Seed);
    const e = spawnEntity(w.ecs);
    addComponent(w.ecs, Task, e);
    stampCause(Task, 'causeEvent', e, 9001);
    expect(cols(Task)['causeEvent']![e]).toBe(9001);
    // Повторный штамп перезаписывает (смена состояния, D-032).
    stampCause(Task, 'causeEvent', e, 9002);
    expect(cols(Task)['causeEvent']![e]).toBe(9002);
  });

  it('границы валидны: id=0 («нет причины») и id=0xFFFFFFFF (максимум) не бросают', () => {
    const w = createSimWorld(104 as Seed);
    const e = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, e);
    expect(() => stampCause(Position, 'moveCause', e, 0)).not.toThrow();
    expect(cols(Position)['moveCause']![e]).toBe(0);
    expect(() => stampCause(Position, 'moveCause', e, 0xffffffff)).not.toThrow();
    expect(cols(Position)['moveCause']![e]).toBe(0xffffffff);
  });

  it('бросает на id<0, id>0xFFFFFFFF и дробном id (тихое усечение запрещено, D-031)', () => {
    const w = createSimWorld(105 as Seed);
    const e = spawnEntity(w.ecs);
    addComponent(w.ecs, Health, e);
    expect(() => stampCause(Health, 'lethalCause', e, -1)).toThrow(RangeError);
    expect(() => stampCause(Health, 'lethalCause', e, 0x100000000)).toThrow(RangeError);
    expect(() => stampCause(Health, 'lethalCause', e, 1.5)).toThrow(RangeError);
    expect(() => stampCause(Health, 'lethalCause', e, Number.NaN)).toThrow(RangeError);
    expect(() => stampCause(Health, 'lethalCause', e, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    // Ни один невалидный вызов не должен был записать поле (осталось занулённым).
    expect(cols(Health)['lethalCause']![e]).toBe(0);
  });

  it('бросает на несуществующем поле (опечатка = программерская ошибка)', () => {
    const w = createSimWorld(106 as Seed);
    const e = spawnEntity(w.ecs);
    addComponent(w.ecs, Task, e);
    expect(() => stampCause(Task, 'nope', e, 1)).toThrow(TypeError);
  });

  it('два прогона одним seed → идентичный лог штампов причинности (детерминизм, закон №8)', () => {
    // Инфраструктурный аналог «два прогона, один seed, идентичный результат»:
    // одинаковая последовательность stampCause даёт побитово одинаковый снапшот.
    function build(seed: number): ReturnType<typeof serialize> {
      const w = createSimWorld(seed as Seed);
      const ids: EntityId[] = [];
      for (let i = 0; i < 4; i++) {
        const e = spawnEntity(w.ecs);
        addComponent(w.ecs, Position, e);
        addComponent(w.ecs, Task, e);
        addComponent(w.ecs, Health, e);
        cols(Position)['loc']![e] = i;
        ids.push(e);
      }
      // Штампуем причинность детерминированно по индексу.
      ids.forEach((e, i) => {
        stampCause(Task, 'causeEvent', e, 1000 + i);
        stampCause(Position, 'moveCause', e, 2000 + i);
        stampCause(Health, 'lethalCause', e, 3000 + i);
      });
      return serialize(w);
    }
    expect(hashSnapshot(build(77))).toBe(hashSnapshot(build(77)));
  });
});
