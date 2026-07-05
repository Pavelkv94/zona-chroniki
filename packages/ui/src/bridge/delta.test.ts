/**
 * Тесты дельта-диффа вида (задача 4.0, D-078). ЧИСТЫЕ, headless (без DOM/воркера):
 *  - ИНВАРИАНТ round-trip: `applyDelta(prev, diffView(prev, next))` deep-equal `next`;
 *  - корректность `changed` (новые + изменённые) и `removed` (исчезнувшие);
 *  - `population` пересчитывается из итогового набора (не несётся в дельте).
 */

import { describe, it, expect } from 'vitest';
import type {
  EntityId,
  EntityKind,
  EntityView,
  FactionId,
  LocationId,
  Tick,
  WorldView,
} from '@zona/shared';
import { diffView, applyDelta } from './delta';

/** Собрать `EntityView` с дефолтами (переопределяемыми). */
function ev(eid: number, over: Partial<EntityView> = {}): EntityView {
  return {
    eid: eid as EntityId,
    kind: 'human' as EntityKind,
    faction: 'loners' as FactionId,
    loc: 1 as LocationId,
    dest: null,
    etaTicks: 0,
    hpFrac: 1,
    task: null,
    inCombat: false,
    carrying: false,
    alive: true,
    ...over,
  };
}

/** Собрать `WorldView`, вычислив `population` из сущностей (как exportWorldView). */
function wv(tick: number, weather: number, entities: EntityView[]): WorldView {
  const sorted = [...entities].sort((a, b) => (a.eid as number) - (b.eid as number));
  let humans = 0;
  let animals = 0;
  let corpses = 0;
  for (const e of sorted) {
    if (e.kind === 'human') humans++;
    else if (e.kind === 'animal') animals++;
    else if (e.kind === 'corpse') corpses++;
  }
  return {
    day: Math.floor(tick / 1440),
    tick: tick as Tick,
    weather,
    entities: sorted,
    population: { humans, animals, corpses },
  };
}

describe('diffView + applyDelta — round-trip', () => {
  const cases: Array<{ name: string; prev: WorldView; next: WorldView }> = [
    {
      name: 'без изменений',
      prev: wv(10, 0, [ev(1), ev(2)]),
      next: wv(11, 0, [ev(1), ev(2)]),
    },
    {
      name: 'сущность изменила позицию и hp',
      prev: wv(10, 0, [ev(1), ev(2)]),
      next: wv(20, 1, [ev(1, { loc: 3 as LocationId, hpFrac: 0.5 }), ev(2)]),
    },
    {
      name: 'добавлена новая сущность',
      prev: wv(10, 0, [ev(1)]),
      next: wv(15, 0, [ev(1), ev(2, { kind: 'animal' as EntityKind, faction: null })]),
    },
    {
      name: 'сущность исчезла',
      prev: wv(10, 0, [ev(1), ev(2), ev(3)]),
      next: wv(30, 2, [ev(1), ev(3)]),
    },
    {
      name: 'человек стал трупом (kind сменился)',
      prev: wv(10, 0, [ev(1, { kind: 'human' as EntityKind, alive: true })]),
      next: wv(40, 0, [ev(1, { kind: 'corpse' as EntityKind, alive: false, hpFrac: 0 })]),
    },
    {
      name: 'смешанные: смена + добавление + удаление',
      prev: wv(10, 0, [ev(1), ev(2), ev(5)]),
      next: wv(50, 3, [
        ev(1, { task: 4 }),
        ev(3, { kind: 'settlement' as EntityKind, faction: null }),
        ev(5),
      ]),
    },
    {
      name: 'от пустого мира',
      prev: wv(0, 0, []),
      next: wv(5, 0, [ev(1), ev(2, { kind: 'animal' as EntityKind, faction: null })]),
    },
    {
      name: 'до пустого мира',
      prev: wv(10, 0, [ev(1), ev(2)]),
      next: wv(60, 0, []),
    },
  ];

  for (const c of cases) {
    it(`реконструирует next: ${c.name}`, () => {
      const delta = diffView(c.prev, c.next);
      const reconstructed = applyDelta(c.prev, delta);
      expect(reconstructed).toEqual(c.next);
    });
  }
});

describe('diffView — changed/removed', () => {
  it('changed содержит только новые/изменённые, removed — только исчезнувшие', () => {
    const prev = wv(10, 0, [ev(1), ev(2), ev(3)]);
    const next = wv(11, 0, [ev(1), ev(2, { hpFrac: 0.3 }), ev(4)]);
    const delta = diffView(prev, next);

    // eid 1 не изменился → НЕ в changed; eid 2 изменился, eid 4 новый → в changed.
    expect(delta.changed.map((e) => e.eid as number).sort((a, b) => a - b)).toEqual([2, 4]);
    // eid 3 исчез → в removed.
    expect(delta.removed.map((e) => e as number)).toEqual([3]);
    expect(delta.tick).toBe(11);
  });

  it('prev === null ⇒ все сущности в changed, removed пуст', () => {
    const next = wv(5, 0, [ev(1), ev(2)]);
    const delta = diffView(null, next);
    expect(delta.changed.map((e) => e.eid as number)).toEqual([1, 2]);
    expect(delta.removed).toEqual([]);
  });

  it('changed отсортирован по eid (детерминизм, закон №8)', () => {
    const prev = wv(10, 0, []);
    const next = wv(11, 0, [ev(9), ev(1), ev(5)]);
    const delta = diffView(prev, next);
    expect(delta.changed.map((e) => e.eid as number)).toEqual([1, 5, 9]);
  });
});

describe('applyDelta — population пересчитывается', () => {
  it('населённость выводится из итогового набора, а не из дельты', () => {
    const base = wv(10, 0, [ev(1, { kind: 'human' as EntityKind })]);
    const delta = diffView(
      base,
      wv(11, 0, [
        ev(1, { kind: 'human' as EntityKind }),
        ev(2, { kind: 'animal' as EntityKind, faction: null }),
        ev(3, { kind: 'corpse' as EntityKind, faction: null, alive: false }),
      ]),
    );
    const result = applyDelta(base, delta);
    expect(result.population).toEqual({ humans: 1, animals: 1, corpses: 1 });
  });
});
