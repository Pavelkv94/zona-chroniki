/**
 * @module @zona/sim/core/registry.test
 *
 * Юнит-гейт инфраструктуры SoA-компонентов (задача 1.0, D-018):
 *  - `assertRegistrySorted` — инвариант реестра (уникальность/сортировка/непустота);
 *  - обёртки `defineComponentT`/`addComponent`/`hasComponent`/`removeComponent`/
 *    `queryEntities` над bitecs 0.4 (порядок аргументов, сортировка eid, guard ёмкости).
 *
 * Сериализацию компонентов проверяет `snapshot.components.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { createSimWorld } from './world';
import type { Seed } from '@zona/shared';
import {
  spawnEntity,
  destroyEcsEntity,
  defineComponentT,
  addComponent,
  hasComponent,
  removeComponent,
  queryEntities,
  Types,
} from './ecs';
import { assertRegistrySorted, COMPONENT_REGISTRY, type ComponentMeta } from './registry';

describe('assertRegistrySorted: инвариант реестра (закон №8)', () => {
  it('глобальный COMPONENT_REGISTRY наполнен доменными компонентами (1.2) и валиден', () => {
    // 1.0 держал реестр пустым; 1.2 (D-019) наполнил его доменными компонентами.
    // Инвариант тот же: реестр непуст и проходит assertRegistrySorted (сорт./уник.).
    expect(COMPONENT_REGISTRY.length).toBeGreaterThan(0);
    expect(() => assertRegistrySorted(COMPONENT_REGISTRY)).not.toThrow();
  });

  it('отсортированный уникальный реестр проходит', () => {
    const ref = defineComponentT({ x: Types.f32 });
    const reg: ComponentMeta[] = [
      { name: 'alpha', ref, fields: ['x'] },
      { name: 'beta', ref, fields: ['x'] },
      { name: 'gamma', ref, fields: ['x'] },
    ];
    expect(() => assertRegistrySorted(reg)).not.toThrow();
  });

  it('дублирующееся имя → throw', () => {
    const ref = defineComponentT({ x: Types.f32 });
    const reg: ComponentMeta[] = [
      { name: 'dup', ref, fields: ['x'] },
      { name: 'dup', ref, fields: ['x'] },
    ];
    expect(() => assertRegistrySorted(reg)).toThrow(/дубл/i);
  });

  it('нарушенный порядок → throw', () => {
    const ref = defineComponentT({ x: Types.f32 });
    const reg: ComponentMeta[] = [
      { name: 'zeta', ref, fields: ['x'] },
      { name: 'alpha', ref, fields: ['x'] },
    ];
    expect(() => assertRegistrySorted(reg)).toThrow(/не отсортирован/i);
  });

  it('пустое имя → throw', () => {
    const ref = defineComponentT({ x: Types.f32 });
    const reg: ComponentMeta[] = [{ name: '', ref, fields: ['x'] }];
    expect(() => assertRegistrySorted(reg)).toThrow(/пустое имя/i);
  });
});

describe('defineComponentT: валидация схемы и ёмкости', () => {
  it('пустая схема → throw', () => {
    expect(() => defineComponentT({})).toThrow(/пуста/i);
  });

  it('неположительная/дробная ёмкость → throw', () => {
    expect(() => defineComponentT({ x: Types.f32 }, 0)).toThrow(/ёмкость/i);
    expect(() => defineComponentT({ x: Types.f32 }, -1)).toThrow(/ёмкость/i);
    expect(() => defineComponentT({ x: Types.f32 }, 1.5)).toThrow(/ёмкость/i);
  });

  it('поля — типизированные массивы нужного типа', () => {
    const c = defineComponentT({ a: Types.f32, b: Types.ui32, c: Types.ui8, d: Types.eid }, 8);
    const store = c as unknown as Record<string, ArrayBufferView>;
    expect(store['a']).toBeInstanceOf(Float32Array);
    expect(store['b']).toBeInstanceOf(Uint32Array);
    expect(store['c']).toBeInstanceOf(Uint8Array);
    expect(store['d']).toBeInstanceOf(Uint32Array);
    // Скрытая ёмкость не попадает в перечислимые ключи (не мешает обходу полей).
    expect(Object.keys(c)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('f32-поле округляет значение до float32 при записи (детерминизм канона)', () => {
    const c = defineComponentT({ a: Types.f32 }, 4);
    const store = c as unknown as { a: Float32Array };
    store.a[1] = 0.1;
    expect(store.a[1]).toBe(Math.fround(0.1));
    expect(store.a[1]).not.toBe(0.1); // именно f32-округление, не double
  });
});

describe('ecs-обёртки компонентов: add/has/remove/query (bitecs 0.4)', () => {
  it('add/has/remove в порядке (world, comp, eid)', () => {
    const w = createSimWorld(1 as Seed);
    const comp = defineComponentT({ v: Types.f32 }, 16);
    const e = spawnEntity(w.ecs);
    expect(hasComponent(w.ecs, comp, e)).toBe(false); // до add — и на незарегистрированном
    addComponent(w.ecs, comp, e);
    expect(hasComponent(w.ecs, comp, e)).toBe(true);
    removeComponent(w.ecs, comp, e);
    expect(hasComponent(w.ecs, comp, e)).toBe(false);
  });

  it('queryEntities отсортирован по возрастанию eid независимо от порядка add (закон №8)', () => {
    const w = createSimWorld(1 as Seed);
    const comp = defineComponentT({ v: Types.f32 }, 16);
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs);
    const e3 = spawnEntity(w.ecs);
    // Добавляем в «перемешанном» порядке — результат обязан быть отсортирован.
    addComponent(w.ecs, comp, e3);
    addComponent(w.ecs, comp, e1);
    addComponent(w.ecs, comp, e2);
    expect(queryEntities(w.ecs, [comp])).toEqual([e1, e2, e3]);
  });

  it('queryEntities с несколькими компонентами — AND (все перечисленные)', () => {
    const w = createSimWorld(1 as Seed);
    const a = defineComponentT({ v: Types.f32 }, 16);
    const b = defineComponentT({ v: Types.ui32 }, 16);
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs);
    addComponent(w.ecs, a, e1);
    addComponent(w.ecs, b, e1);
    addComponent(w.ecs, a, e2); // e2 несёт только a
    expect(queryEntities(w.ecs, [a, b])).toEqual([e1]);
    expect(queryEntities(w.ecs, [a])).toEqual([e1, e2]);
  });

  it('guard ёмкости: addComponent для eid вне ёмкости → throw (закон №8, не тихая порча)', () => {
    const w = createSimWorld(1 as Seed);
    const comp = defineComponentT({ v: Types.f32 }, 2); // ёмкость [0,2)
    // Сущности с eid=1 хватает; поднимем eid за границу через прямой ecs-destroy+spawn.
    // eid раздаются с 1; spawn трёх даёт 1,2,3 — eid=2 уже == ёмкость.
    spawnEntity(w.ecs); // 1
    const e2 = spawnEntity(w.ecs); // 2 (== ёмкость 2 → вне [0,2))
    expect(() => addComponent(w.ecs, comp, e2)).toThrow(/ёмкост/i);
  });

  it('destroyEcsEntity снимает членство компонента (query больше не видит eid)', () => {
    const w = createSimWorld(1 as Seed);
    const comp = defineComponentT({ v: Types.f32 }, 16);
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs);
    addComponent(w.ecs, comp, e1);
    addComponent(w.ecs, comp, e2);
    destroyEcsEntity(w.ecs, e1);
    expect(queryEntities(w.ecs, [comp])).toEqual([e2]);
    expect(hasComponent(w.ecs, comp, e1)).toBe(false);
  });
});

describe('несколько компонентов и разные наборы у сущностей (независимость колонок)', () => {
  it('три жителя с РАЗНЫМИ наборами компонентов — каждая колонка независима', () => {
    // Сценарий: у бармена есть «здоровье» и «позиция», у сталкера только «позиция»,
    // у тайника только «здоровье». Ни один запрос не должен путать носителей.
    const w = createSimWorld(1 as Seed);
    const health = defineComponentT({ hp: Types.f32 }, 32);
    const pos = defineComponentT({ x: Types.f32, y: Types.f32 }, 32);
    const barman = spawnEntity(w.ecs);
    const stalker = spawnEntity(w.ecs);
    const stash = spawnEntity(w.ecs);
    addComponent(w.ecs, health, barman);
    addComponent(w.ecs, pos, barman);
    addComponent(w.ecs, pos, stalker);
    addComponent(w.ecs, health, stash);

    expect(queryEntities(w.ecs, [health])).toEqual([barman, stash]);
    expect(queryEntities(w.ecs, [pos])).toEqual([barman, stalker]);
    // AND: только тот, у кого оба.
    expect(queryEntities(w.ecs, [health, pos])).toEqual([barman]);
    // Членство точечное, без «протекания» между компонентами.
    expect(hasComponent(w.ecs, pos, stash)).toBe(false);
    expect(hasComponent(w.ecs, health, stalker)).toBe(false);
  });

  it('AND-семантика устойчива к порядку перечисления компонентов', () => {
    const w = createSimWorld(1 as Seed);
    const a = defineComponentT({ v: Types.f32 }, 16);
    const b = defineComponentT({ v: Types.ui32 }, 16);
    const both = spawnEntity(w.ecs);
    const onlyA = spawnEntity(w.ecs);
    addComponent(w.ecs, a, both);
    addComponent(w.ecs, b, both);
    addComponent(w.ecs, a, onlyA);
    // Порядок [a,b] и [b,a] даёт один и тот же (отсортированный) результат.
    expect(queryEntities(w.ecs, [a, b])).toEqual([both]);
    expect(queryEntities(w.ecs, [b, a])).toEqual([both]);
  });
});

describe('removeComponent: снятие членства и судьба значения в колонке', () => {
  it('после снятия сущность выпадает из запроса и hasComponent=false', () => {
    const w = createSimWorld(1 as Seed);
    const comp = defineComponentT({ v: Types.f32 }, 16);
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs);
    addComponent(w.ecs, comp, e1);
    addComponent(w.ecs, comp, e2);
    removeComponent(w.ecs, comp, e1);
    expect(hasComponent(w.ecs, comp, e1)).toBe(false);
    expect(queryEntities(w.ecs, [comp])).toEqual([e2]);
  });

  it('D-024: removeComponent НЕ чистит массив, но повторный addComponent ЗАНУЛЯЕТ поле', () => {
    // Контракт D-024 (симметрия активной очистки D-008): чистку делает СТОРОНА add,
    // а не remove. removeComponent оставляет значение в SoA-массиве (индекс по eid),
    // но addComponent зануляет поля носителя на входе — поэтому повторно навешенный
    // компонент стартует чистым, а не «воскрешает» прошлое значение. Это закрывает
    // корень «призрака компонента» при reuse eid (см. snapshot.components.test.ts).
    const w = createSimWorld(1 as Seed);
    const comp = defineComponentT({ v: Types.f32 }, 16);
    const store = comp as unknown as { v: Float32Array };
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, comp, e1);
    store.v[e1] = 42;
    removeComponent(w.ecs, comp, e1);
    // remove НЕ трогает массив: значение всё ещё лежит по eid.
    expect(store.v[e1]).toBe(42);
    addComponent(w.ecs, comp, e1); // повторный add — зануляет поле (D-024)
    expect(store.v[e1]).toBe(0); // чистый старт, а не «воскресшее» 42
  });
});

describe('ЁМКОСТЬ колонок как жёсткий потолок мира (закон №8)', () => {
  it('eid == capacity → throw (граница полуинтервала [0,cap))', () => {
    const w = createSimWorld(1 as Seed);
    const comp = defineComponentT({ v: Types.f32 }, 3); // [0,3)
    spawnEntity(w.ecs); // 1
    spawnEntity(w.ecs); // 2 (внутри)
    const e3 = spawnEntity(w.ecs); // 3 (== ёмкость → вне)
    expect(() => addComponent(w.ecs, comp, e3)).toThrow(/ёмкост/i);
  });

  it('НАХОДКА: мир крупнее DEFAULT_COMPONENT_CAPACITY (4096) — addComponent на высоком eid бросает ГРОМКО, а не портит память', () => {
    // Фиксируем: bitecs раздаёт eid без потолка, но SoA-колонки дефолтной ёмкости
    // 4096 не могут нести eid>=4096. Guard превращает выход за массив из тихой
    // потери в ранний RangeError. Это жёсткий потолок Фазы 1 (перф-бюджет 250, но
    // freelist может разогнать maxId при массовых spawn/destroy).
    const w = createSimWorld(1 as Seed);
    const comp = defineComponentT({ v: Types.f32 }); // дефолтная ёмкость 4096
    let last = 0 as unknown as ReturnType<typeof spawnEntity>;
    // eid раздаются с 1; крутим, пока не достанем eid == 4096 (первый вне [0,4096)).
    while ((last as unknown as number) < 4096) last = spawnEntity(w.ecs);
    expect(last as unknown as number).toBe(4096);
    expect(() => addComponent(w.ecs, comp, last)).toThrow(/ёмкост|вне ёмкости/i);
    // Сосед в границах по-прежнему навешивается штатно (память не испорчена).
    const inRange = 4095 as unknown as typeof last;
    expect(() => addComponent(w.ecs, comp, inRange)).not.toThrow();
  });
});

describe('типовые границы записи в колонки (f32/ui32/ui8/eid)', () => {
  it('ui8 оборачивает по модулю 256, ui32 держит полный диапазон, f32 округляет', () => {
    const c = defineComponentT({ flag: Types.ui8, big: Types.ui32, ref: Types.eid, x: Types.f32 }, 8);
    const s = c as unknown as {
      flag: Uint8Array; big: Uint32Array; ref: Uint32Array; x: Float32Array;
    };
    s.flag[1] = 256; // → 0 (обёртка Uint8Array)
    expect(s.flag[1]).toBe(0);
    s.flag[1] = 255;
    expect(s.flag[1]).toBe(255);
    s.big[1] = 0xffffffff; // 4294967295 — верхняя граница ui32
    expect(s.big[1]).toBe(4294967295);
    s.ref[1] = 4096; // eid хранится как ui32, ремапа нет (D-011)
    expect(s.ref[1]).toBe(4096);
    s.x[1] = 1 / 3; // f32-округление, не double
    expect(s.x[1]).toBe(Math.fround(1 / 3));
    expect(s.x[1]).not.toBe(1 / 3);
  });
});
