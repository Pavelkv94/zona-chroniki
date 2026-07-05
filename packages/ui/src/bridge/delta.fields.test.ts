/**
 * Тесты ПОЛЕВОЙ ПОЛНОТЫ дельта-диффа (задача 4.0, D-078, КРИТИЧНО). Читается как
 * сценарий наблюдения: «сталкер прошёл ребро — карта должна это увидеть; ранен —
 * увидеть; поднял артефакт — увидеть; умер — увидеть». Каждый сценарий трогает РОВНО
 * ОДНО поле `EntityView` и требует, чтобы дельта его ПОЙМАЛА (сущность попала в
 * `changed`) и чтобы round-trip реконструировал следующий вид бит-в-бит.
 *
 * ── ЗАЧЕМ ПОЛЕ ЗА ПОЛЕМ ─────────────────────────────────────────────────────
 * `diffView` сравнивает по ЯВНОМУ списку `ENTITY_FIELDS`. Если поле выпало из списка
 * (или новое поле `EntityView` не добавлено в него), его изменение станет НЕВИДИМЫМ
 * для UI — сталкер «телепортнётся» или «воскреснет» на карте наблюдателя без события.
 * Матрица ниже ловит такую дыру на КОНКРЕТНОМ поле; страж полноты (последний тест)
 * ловит саму дыру структурно — при появлении нового поля `EntityView` без alt-значения
 * тест падает громко (`satisfies keyof[]` в delta.ts проверяет валидность ключей, но
 * НЕ покрытие ВСЕХ — эту гарантию держим здесь, рантайм-обходом ключей снимка).
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

/** Базовая сущность в «покое»: жива, цела, стоит, ничего не несёт, не в бою. */
function base(): EntityView {
  return {
    eid: 1 as EntityId,
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
  };
}

/** Собрать WorldView вокруг одной сущности (population выведем из kind). */
function around(entity: EntityView, tick: number, weather = 0): WorldView {
  const k = entity.kind;
  return {
    day: Math.floor(tick / 1440),
    tick: tick as Tick,
    weather,
    entities: [entity],
    population: {
      humans: k === 'human' ? 1 : 0,
      animals: k === 'animal' ? 1 : 0,
      corpses: k === 'corpse' ? 1 : 0,
    },
  };
}

/**
 * Для КАЖДОГО наблюдаемого поля `EntityView` — значение, ОТЛИЧНОЕ от `base()`, и
 * человекочитаемый сценарий мира. `Record<Exclude<keyof EntityView,'eid'>>` заставляет
 * компилятор требовать запись на КАЖДОЕ поле (кроме тождества eid) — забыть новое поле
 * при расширении `EntityView` нельзя: не скомпилируется.
 */
const MUTATION: Record<
  Exclude<keyof EntityView, 'eid'>,
  { readonly scenario: string; readonly value: EntityView[Exclude<keyof EntityView, 'eid'>] }
> = {
  kind: { scenario: 'человек пал и стал трупом (kind)', value: 'corpse' as EntityKind },
  faction: { scenario: 'сталкер вышел из фракции (faction → null)', value: null },
  loc: { scenario: 'прошёл ребро в соседнюю локацию (loc)', value: 2 as LocationId },
  dest: { scenario: 'взял курс на цель перехода (dest)', value: 5 as LocationId },
  etaTicks: { scenario: 'до прибытия осталось 7 тиков (etaTicks)', value: 7 },
  hpFrac: { scenario: 'получил рану — половина HP (hpFrac)', value: 0.5 },
  task: { scenario: 'сменил занятие (task)', value: 3 },
  inCombat: { scenario: 'вступил в открытый бой (inCombat)', value: true },
  carrying: { scenario: 'поднял артефакт (carrying)', value: true },
  alive: { scenario: 'потерял тег Alive (alive)', value: false },
};

describe('дельта ловит изменение КАЖДОГО поля EntityView (D-078)', () => {
  const b = base();
  const prev = around(b, 100);

  for (const key of Object.keys(MUTATION) as Array<keyof typeof MUTATION>) {
    const { scenario, value } = MUTATION[key];
    it(`${scenario} → попадает в changed и восстанавливается`, () => {
      const mutated: EntityView = { ...b, [key]: value } as EntityView;
      const next = around(mutated, 130);

      const delta = diffView(prev, next);
      // Поле реально изменилось — сущность ОБЯЗАНА оказаться в changed (иначе UI слеп).
      expect(delta.changed.map((e) => e.eid as number)).toContain(1);
      // И round-trip воспроизводит именно этот вид (значение поля донесено).
      expect(applyDelta(prev, delta)).toEqual(next);
    });
  }

  it('СТРАЖ ПОЛНОТЫ: каждое поле снимка (кроме eid) охвачено матрицей', () => {
    // Ключи реального снимка минус тождество eid — все должны иметь сценарий-мутацию.
    const observed = Object.keys(b).filter((k) => k !== 'eid');
    const covered = Object.keys(MUTATION);
    expect([...observed].sort()).toEqual([...covered].sort());
  });

  it('НЕ-изменение (тот же вид, другой тик) НЕ раздувает changed', () => {
    // Часы идут, сущность неподвижна — changed пуст, но часы в дельте свежие.
    const next = around(b, 101);
    const delta = diffView(prev, next);
    expect(delta.changed).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.tick).toBe(101);
    expect(applyDelta(prev, delta)).toEqual(next);
  });
});

describe('дельта: границы набора сущностей (D-078)', () => {
  it('первый снимок (prev=null) → весь мир как changed, ничего removed', () => {
    const next = around(base(), 5);
    const delta = diffView(null, next);
    expect(delta.changed.map((e) => e.eid as number)).toEqual([1]);
    expect(delta.removed).toEqual([]);
    // Без базового вида реконструируем от пустого мира — тот же next.
    const emptyBase: WorldView = {
      day: 0,
      tick: 0 as Tick,
      weather: 0,
      entities: [],
      population: { humans: 0, animals: 0, corpses: 0 },
    };
    expect(applyDelta(emptyBase, delta)).toEqual(next);
  });

  it('пустой → непустой: население пересчитано из changed по kind', () => {
    const empty: WorldView = {
      day: 0,
      tick: 0 as Tick,
      weather: 0,
      entities: [],
      population: { humans: 0, animals: 0, corpses: 0 },
    };
    const human = base();
    const animal: EntityView = { ...base(), eid: 2 as EntityId, kind: 'animal' as EntityKind, faction: null };
    const corpse: EntityView = { ...base(), eid: 3 as EntityId, kind: 'corpse' as EntityKind, faction: null, alive: false };
    const next: WorldView = {
      day: 0,
      tick: 9 as Tick,
      weather: 0,
      entities: [human, animal, corpse],
      population: { humans: 1, animals: 1, corpses: 1 },
    };
    const delta = diffView(empty, next);
    // Дельта сама население НЕ несёт — applyDelta выводит его из changed.
    expect('population' in delta).toBe(false);
    const result = applyDelta(empty, delta);
    expect(result.population).toEqual({ humans: 1, animals: 1, corpses: 1 });
    expect(result).toEqual(next);
  });

  it('непустой → пустой: все сущности в removed, население обнуляется', () => {
    const prev = around(base(), 10);
    const empty: WorldView = {
      day: 0,
      tick: 60 as Tick,
      weather: 0,
      entities: [],
      population: { humans: 0, animals: 0, corpses: 0 },
    };
    const delta = diffView(prev, empty);
    expect(delta.removed.map((e) => e as number)).toEqual([1]);
    expect(delta.changed).toEqual([]);
    expect(applyDelta(prev, delta)).toEqual(empty);
  });
});
