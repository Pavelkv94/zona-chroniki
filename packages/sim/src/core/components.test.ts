/**
 * @module @zona/sim/core/components.test
 *
 * Гейт доменных SoA-компонентов (задача 1.2, D-019). Проверяет РЕАЛЬНЫЕ компоненты
 * из глобального `COMPONENT_REGISTRY` (а не тест-реестр 1.0):
 *  - реестр наполнен, отсортирован по name, assertRegistrySorted проходит;
 *  - round-trip каждого компонента через ГЛОБАЛЬНЫЙ реестр (serialize/deserialize
 *    без второго аргумента) — значения и хэш совпадают;
 *  - теги (Human/Corpse/Alive): членство переживает save/load, колонка fields:{};
 *  - addComponent зануляет поля переиспользованного eid на реальном Needs (D-024);
 *  - порядок полей в снапшоте = объявленный; ключи components сорт. по name;
 *  - ёмкость: при целевом максимуме Фазы 1 addComponent не бросает; граница — WORLD_CAPACITY;
 *  - голдены пустого мира (481914ae) не сдвигаются от наполнения реестра.
 *
 * Компоненты — модульные singleton'ы (глобальные массивы). Изоляция между тестами:
 * каждый тест создаёт свежий мир (свежий eid-аллокатор, eid с 1) и ВСЕГДА
 * addComponent перед чтением — add зануляет слот (D-024), поэтому стухшие значения
 * прошлого теста не протекают.
 */

import { describe, it, expect } from 'vitest';
import type { Seed, Tick } from '@zona/shared';
import { createSimWorld, destroyEntity } from './world';
import { spawnEntity, addComponent, hasComponent, queryEntities, type ComponentRef } from './ecs';
import {
  COMPONENT_REGISTRY,
  assertRegistrySorted,
  type ComponentMeta,
} from './registry';
import {
  DOMAIN_COMPONENTS,
  WORLD_CAPACITY,
  TaskKind,
  WEATHER_CODE,
  Position,
  Needs,
  Health,
  Task,
  Skills,
  Home,
  Animal,
  WorldClock,
  Settlement,
  AnomalyField,
  Job,
  Human,
  Corpse,
  Alive,
} from './components';
import { WEATHER_TYPES } from '../balance/weather';
import { serialize, deserialize, hashSnapshot } from './snapshot';

/** Нетипизированный доступ к колонкам компонента (запись/чтение произвольных полей по eid). */
function cols(ref: ComponentRef): Record<string, { [i: number]: number }> {
  return ref as unknown as Record<string, { [i: number]: number }>;
}

describe('реестр наполнен и отсортирован (D-019, закон №8)', () => {
  it('COMPONENT_REGISTRY === DOMAIN_COMPONENTS и проходит assertRegistrySorted', () => {
    expect(COMPONENT_REGISTRY).toBe(DOMAIN_COMPONENTS);
    expect(() => assertRegistrySorted(COMPONENT_REGISTRY)).not.toThrow();
  });

  it('все ожидаемые компоненты присутствуют по стабильным именам', () => {
    const names = COMPONENT_REGISTRY.map((m) => m.name);
    expect(names).toEqual([
      'alive',
      'animal',
      'anomalyfield',
      'corpse',
      'health',
      'home',
      'human',
      'job',
      'needs',
      'personality',
      'position',
      'settlement',
      // Фаза 5 (задача 5.0): 'sickness' между 'settlement' и 'skills' (нулевой
      // мембершип — в снапшот прогона не пишется, регистрация схемы аддитивна).
      'sickness',
      'skills',
      'task',
      'worldclock',
    ]);
  });

  it('имена реально отсортированы по возрастанию (UTF-16)', () => {
    const names = COMPONENT_REGISTRY.map((m) => m.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('поля данных-компонентов объявлены в фиксированном порядке; теги имеют fields:[]', () => {
    const byName = new Map(COMPONENT_REGISTRY.map((m) => [m.name, m] as const));
    // causality-поля (D-030, 1.2b) — в КОНЦЕ списков полей (append, закон №8).
    expect(byName.get('position')?.fields).toEqual(['loc', 'dest', 'etaTicks', 'moveCause']);
    expect(byName.get('needs')?.fields).toEqual(['hunger', 'thirst', 'fatigue', 'fear']);
    expect(byName.get('health')?.fields).toEqual(['hp', 'lethalCause']);
    expect(byName.get('task')?.fields).toEqual([
      'kind',
      'targetLoc',
      'targetEid',
      'startedTick',
      'causeEvent',
    ]);
    expect(byName.get('skills')?.fields).toEqual(['shooting', 'survival', 'stealth']);
    expect(byName.get('home')?.fields).toEqual(['loc']);
    expect(byName.get('animal')?.fields).toEqual(['species', 'herd']);
    // Фаза 5 (задача 5.0): поля эмиссии добавлены APPEND-ONLY в КОНЕЦ (weather/
    // weatherSince не тронуты, порядок снапшота стабилен, закон №8).
    expect(byName.get('worldclock')?.fields).toEqual([
      'weather',
      'weatherSince',
      'zonePressure',
      'emissionPhase',
      'phaseSince',
    ]);
    // Фаза 5 (задача 5.0): новый компонент Sickness (мембершип нулевой до 5.8).
    expect(byName.get('sickness')?.fields).toEqual([
      'disease',
      'severity',
      'exposure',
      'sinceTick',
    ]);
    // Фаза 2 (D-046): data-компоненты без тега, поля в объявленном порядке.
    expect(byName.get('settlement')?.fields).toEqual([
      'morale',
      'security',
      'buildTarget',
      'buildProgress',
    ]);
    expect(byName.get('anomalyfield')?.fields).toEqual(['charge', 'tier']);
    expect(byName.get('job')?.fields).toEqual(['workplace', 'employer']);
    // Теги — без полей.
    expect(byName.get('human')?.fields).toEqual([]);
    expect(byName.get('corpse')?.fields).toEqual([]);
    expect(byName.get('alive')?.fields).toEqual([]);
  });

  it('поля колонок компонента совпадают с ключами SoA-хранилища (нет опечаток в реестре)', () => {
    for (const meta of COMPONENT_REGISTRY) {
      const storeKeys = Object.keys(meta.ref).sort();
      const fieldKeys = [...meta.fields].sort();
      expect(storeKeys).toEqual(fieldKeys);
    }
  });
});

describe('перечисления-коды (структура, не дублируют контент)', () => {
  it('TaskKind — плотные ui8-коды с 0; FORAGE/REST присутствуют (fallback D-020)', () => {
    // Коды 0–6 (Фаза 1) НЕ тронуты append-ом Фазы 2 (стабильность формата, закон №8).
    expect(TaskKind.SLEEP).toBe(0);
    expect(TaskKind.EAT).toBe(1);
    expect(TaskKind.DRINK).toBe(2);
    expect(TaskKind.FORAGE).toBe(3);
    expect(TaskKind.HUNT).toBe(4);
    expect(TaskKind.REST).toBe(5);
    expect(TaskKind.FLEE).toBe(6);
    // Все коды помещаются в ui8 и уникальны.
    const codes = Object.values(TaskKind);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(256);
    }
  });

  it('Фаза 2: WORK/TRADE/ROB/SEARCH — append-only коды 7–10, уникальны, влезают в ui8', () => {
    expect(TaskKind.WORK).toBe(7);
    expect(TaskKind.TRADE).toBe(8);
    expect(TaskKind.ROB).toBe(9);
    expect(TaskKind.SEARCH).toBe(10);
    // Новые коды не пересекаются с 0–6 и попадают в ui8.
    for (const c of [TaskKind.WORK, TaskKind.TRADE, TaskKind.ROB, TaskKind.SEARCH]) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeLessThan(256);
    }
  });

  it('WEATHER_CODE — производный индекс WEATHER_TYPES (единый источник порядка)', () => {
    WEATHER_TYPES.forEach((w, i) => {
      expect(WEATHER_CODE[w]).toBe(i);
    });
    expect(WEATHER_CODE.clear).toBe(0);
  });
});

describe('round-trip КАЖДОГО компонента через ГЛОБАЛЬНЫЙ реестр (D-018/D-019)', () => {
  /**
   * Навешивает компонент на свежий eid, пишет заданные значения полей, затем
   * serialize→deserialize→serialize через глобальный реестр и сверяет хэш + значения.
   */
  function roundTrip(ref: ComponentRef, values: Record<string, number>): void {
    const w = createSimWorld(11 as Seed);
    const e = spawnEntity(w.ecs);
    addComponent(w.ecs, ref, e);
    const c = cols(ref);
    for (const [f, v] of Object.entries(values)) c[f]![e] = v;

    // Захватываем ОКРУГЛЁННЫЙ до типа колонки эталон КАК ПРИМИТИВ (копия по значению)
    // ДО сериализации — иначе сравнение с живым массивом было бы тавтологией.
    const expected: Record<string, number> = {};
    for (const f of Object.keys(values)) expected[f] = c[f]![e]!;

    const snap1 = serialize(w); // глобальный COMPONENT_REGISTRY
    const w2 = deserialize(snap1);
    const snap2 = serialize(w2);
    expect(hashSnapshot(snap2)).toBe(hashSnapshot(snap1));
    expect(hasComponent(w2.ecs, ref, e)).toBe(true);
    // Значение реально пережило round-trip: сверяем восстановленный массив с
    // захваченным ранее примитивом (f32-округление/ui8-усечение уже учтены в expected).
    const c2 = cols(ref);
    for (const f of Object.keys(values)) {
      expect(c2[f]![e]).toBe(expected[f]);
    }
  }

  it('Position (ui32/ui32/f32)', () => {
    roundTrip(Position, { loc: 3, dest: 7, etaTicks: 12.5 });
  });
  it('Needs (4×f32)', () => {
    roundTrip(Needs, { hunger: 0.25, thirst: 0.5, fatigue: 0.75, fear: 0.125 });
  });
  it('Health (f32)', () => {
    roundTrip(Health, { hp: 87.5 });
  });
  it('Task (ui8/ui32/eid/ui32)', () => {
    roundTrip(Task, { kind: TaskKind.HUNT, targetLoc: 4, targetEid: 42, startedTick: 1000 });
  });
  it('Skills (3×f32)', () => {
    roundTrip(Skills, { shooting: 0.6, survival: 0.3, stealth: 0.9 });
  });
  it('Home (ui32)', () => {
    roundTrip(Home, { loc: 0 });
  });
  it('Animal (ui8/ui32)', () => {
    roundTrip(Animal, { species: 1, herd: 5 });
  });
  it('WorldClock (ui8/ui32)', () => {
    roundTrip(WorldClock, { weather: WEATHER_CODE.storm, weatherSince: 500 });
  });
  // Фаза 2 (D-046): границы типов f32/ui32/ui8/eid переживают round-trip.
  it('Settlement (f32/f32/ui8/f32) — границы полей', () => {
    roundTrip(Settlement, {
      morale: Math.fround(1 / 3),
      security: 0.875,
      buildTarget: 255, // max ui8
      buildProgress: 0.5,
    });
  });
  it('AnomalyField (f32/ui8) — границы полей', () => {
    roundTrip(AnomalyField, { charge: Math.fround(0.1), tier: 255 });
  });
  it('Job (ui32/eid) — границы полей (eid-ссылка без ремапа, D-011)', () => {
    roundTrip(Job, { workplace: 4294967295, employer: 123 });
  });

  it('все данные-компоненты вместе на одной сущности — полный снапшот round-trip', () => {
    const w = createSimWorld(21 as Seed);
    const e = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, e);
    addComponent(w.ecs, Needs, e);
    addComponent(w.ecs, Health, e);
    addComponent(w.ecs, Task, e);
    addComponent(w.ecs, Skills, e);
    addComponent(w.ecs, Home, e);
    cols(Position)['loc']![e] = 2;
    cols(Position)['dest']![e] = 2; // стоит на месте (dest===loc)
    cols(Needs)['thirst']![e] = 0.4;
    cols(Health)['hp']![e] = 100;
    cols(Task)['kind']![e] = TaskKind.DRINK;
    cols(Skills)['shooting']![e] = 0.7;
    cols(Home)['loc']![e] = 0;

    const snap1 = serialize(w);
    // Ключи присутствующих компонентов отсортированы по name.
    expect(Object.keys(snap1.components)).toEqual([
      'health',
      'home',
      'needs',
      'position',
      'skills',
      'task',
    ]);
    const w2 = deserialize(snap1);
    expect(hashSnapshot(serialize(w2))).toBe(hashSnapshot(snap1));
    expect(hasComponent(w2.ecs, Position, e)).toBe(true);
    expect(hasComponent(w2.ecs, Task, e)).toBe(true);
  });
});

describe('ТЕГИ: членство переживает save/load, колонка fields:{} (D-019)', () => {
  it('Human/Alive: round-trip членства; в снапшоте пустые fields', () => {
    const w = createSimWorld(31 as Seed);
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs);
    addComponent(w.ecs, Human, e1);
    addComponent(w.ecs, Alive, e1);
    addComponent(w.ecs, Human, e2); // e2 — человек, но не помечен Alive
    // Заметим: тег не имеет полей — просто членство.
    const snap = serialize(w);
    const humanCol = snap.components['human'] as unknown as {
      eids: number[];
      fields: Record<string, number[]>;
    };
    expect(humanCol.eids).toEqual([e1, e2]);
    expect(humanCol.fields).toEqual({}); // fields:{} для тега
    const aliveCol = snap.components['alive'] as unknown as { eids: number[]; fields: object };
    expect(aliveCol.eids).toEqual([e1]);
    expect(aliveCol.fields).toEqual({});

    const w2 = deserialize(snap);
    expect(hasComponent(w2.ecs, Human, e1)).toBe(true);
    expect(hasComponent(w2.ecs, Human, e2)).toBe(true);
    expect(hasComponent(w2.ecs, Alive, e1)).toBe(true);
    expect(hasComponent(w2.ecs, Alive, e2)).toBe(false);
    expect(hashSnapshot(serialize(w2))).toBe(hashSnapshot(snap));
  });

  it('Corpse: тег без единого носителя не пишется (ключа нет)', () => {
    const w = createSimWorld(32 as Seed);
    const e1 = spawnEntity(w.ecs);
    addComponent(w.ecs, Human, e1); // есть человек, но нет трупов
    const snap = serialize(w);
    expect(snap.components['corpse']).toBeUndefined();
    expect('human' in snap.components).toBe(true);
  });

  it('queryEntities по тегу возвращает носителей (отсортировано)', () => {
    const w = createSimWorld(33 as Seed);
    const e1 = spawnEntity(w.ecs);
    const e2 = spawnEntity(w.ecs);
    const e3 = spawnEntity(w.ecs);
    addComponent(w.ecs, Corpse, e3);
    addComponent(w.ecs, Corpse, e1);
    expect(queryEntities(w.ecs, [Corpse])).toEqual([e1, e3]);
    expect(hasComponent(w.ecs, Corpse, e2)).toBe(false);
  });
});

describe('addComponent зануляет поля переиспользованного eid на реальном Needs (D-024)', () => {
  it('reuse eid: новый носитель Needs без записи полей = 0, не значения покойника', () => {
    const w = createSimWorld(41 as Seed);
    const dead = spawnEntity(w.ecs);
    addComponent(w.ecs, Needs, dead);
    const n = cols(Needs);
    n['hunger']![dead] = 0.9;
    n['thirst']![dead] = 0.8;
    n['fatigue']![dead] = 0.7;
    n['fear']![dead] = 0.6;
    destroyEntity(w, dead); // массив ВСЁ ЕЩЁ держит значения покойника

    const reborn = spawnEntity(w.ecs);
    expect(reborn).toBe(dead); // bitecs переиспользовал eid (иначе тест не про ghost)
    addComponent(w.ecs, Needs, reborn); // БЕЗ записи полей — полагаемся на зануление
    expect(n['hunger']![reborn]).toBe(0);
    expect(n['thirst']![reborn]).toBe(0);
    expect(n['fatigue']![reborn]).toBe(0);
    expect(n['fear']![reborn]).toBe(0);

    // И в снапшот попадает чистый носитель.
    const snap = serialize(w);
    const col = snap.components['needs'] as unknown as { eids: number[]; fields: { hunger: number[] } };
    expect(col.eids).toEqual([reborn]);
    expect(col.fields.hunger).toEqual([0]);
  });

  it('Фаза 2: reuse eid зануляет Settlement/AnomalyField/Job (D-046 + D-024)', () => {
    const w = createSimWorld(42 as Seed);
    const dead = spawnEntity(w.ecs);
    // Носитель всех трёх Фаза-2-компонентов с ненулевыми полями.
    addComponent(w.ecs, Settlement, dead);
    addComponent(w.ecs, AnomalyField, dead);
    addComponent(w.ecs, Job, dead);
    const s = cols(Settlement);
    const a = cols(AnomalyField);
    const j = cols(Job);
    s['morale']![dead] = 0.9;
    s['security']![dead] = 0.8;
    s['buildTarget']![dead] = 7;
    s['buildProgress']![dead] = 0.4;
    a['charge']![dead] = 0.6;
    a['tier']![dead] = 3;
    j['workplace']![dead] = 99;
    j['employer']![dead] = 5;
    destroyEntity(w, dead); // массивы всё ещё держат значения покойника

    const reborn = spawnEntity(w.ecs);
    expect(reborn).toBe(dead); // reuse eid из freelist
    addComponent(w.ecs, Settlement, reborn);
    addComponent(w.ecs, AnomalyField, reborn);
    addComponent(w.ecs, Job, reborn);
    // Зануление на входе (D-024): покойник не просвечивает.
    for (const f of ['morale', 'security', 'buildTarget', 'buildProgress']) {
      expect(s[f]![reborn]).toBe(0);
    }
    expect(a['charge']![reborn]).toBe(0);
    expect(a['tier']![reborn]).toBe(0);
    expect(j['workplace']![reborn]).toBe(0);
    expect(j['employer']![reborn]).toBe(0);
  });
});

describe('порядок полей в снапшоте = объявленный (закон №8)', () => {
  it('Position: колонка несёт ровно loc/dest/etaTicks, значения по эти полям', () => {
    const w = createSimWorld(51 as Seed);
    const e = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, e);
    // Пишем поля в «перемешанном» порядке — снапшот перечисляет их по meta.fields.
    cols(Position)['etaTicks']![e] = 3.5;
    cols(Position)['loc']![e] = 8;
    cols(Position)['dest']![e] = 9;
    const snap = serialize(w);
    const col = snap.components['position'] as unknown as {
      eids: number[];
      fields: Record<string, number[]>;
    };
    // moveCause (D-030, 1.2b) сериализуется В КОНЦЕ — не записан ⇒ 0 (D-024).
    expect(Object.keys(col.fields)).toEqual(['loc', 'dest', 'etaTicks', 'moveCause']);
    expect(col.fields['loc']).toEqual([8]);
    expect(col.fields['dest']).toEqual([9]);
    expect(col.fields['etaTicks']).toEqual([3.5]);
    expect(col.fields['moveCause']).toEqual([0]);
  });
});

describe('ЁМКОСТЬ WORLD_CAPACITY как потолок Фазы 1 (закон №8)', () => {
  it('целевой максимум Фазы 1 (~450 сущностей) — addComponent не бросает', () => {
    // Пик одновременных сущностей Фазы 1 (20 людей + стада + трупы + мир) ≈ 400–450.
    // Проверяем с ЗАПАСОМ: 600 сущностей, у каждой навешиваем несколько компонентов.
    const w = createSimWorld(61 as Seed);
    const PHASE1_TARGET = 600;
    for (let i = 0; i < PHASE1_TARGET; i++) {
      const e = spawnEntity(w.ecs);
      expect(() => {
        addComponent(w.ecs, Position, e);
        addComponent(w.ecs, Needs, e);
        addComponent(w.ecs, Health, e);
        addComponent(w.ecs, Alive, e);
      }).not.toThrow();
    }
    expect(queryEntities(w.ecs, [Health]).length).toBe(PHASE1_TARGET);
  });

  it('граница задокументирована и жёсткая: eid == WORLD_CAPACITY → throw', () => {
    // WORLD_CAPACITY — жёсткий потолок; eid вне [0, WORLD_CAPACITY) падает ГРОМКО
    // (RangeError), а не портит память. eid раздаются с 1 → крутим до WORLD_CAPACITY.
    const w = createSimWorld(62 as Seed);
    let last = 0;
    while (last < WORLD_CAPACITY) last = spawnEntity(w.ecs) as unknown as number;
    expect(last).toBe(WORLD_CAPACITY); // первый eid вне полуинтервала [0, cap)
    expect(() => addComponent(w.ecs, Health, last as never)).toThrow(/ёмкост|вне ёмкости/i);
    // Сосед в границах навешивается штатно.
    expect(() => addComponent(w.ecs, Health, (WORLD_CAPACITY - 1) as never)).not.toThrow();
  });

  it('WORLD_CAPACITY — явное значение (не молчаливый дефолт)', () => {
    expect(WORLD_CAPACITY).toBe(4096);
  });
});

describe('голдены не сдвигаются от наполнения реестра', () => {
  it('пустой мир (default = наполненный реестр) → components === {} и хэш 481914ae', () => {
    const w = createSimWorld(0 as Seed);
    const snap = serialize(w); // глобальный (теперь непустой) реестр
    expect(snap.components).toEqual({});
    expect(hashSnapshot(snap)).toBe('481914ae');
  });

  it('регистрация компонентов без НОСИТЕЛЕЙ не пишет ключей в snapshot', () => {
    const w = createSimWorld(1 as Seed);
    // Сущности есть, но БЕЗ компонентов → components остаётся {}.
    spawnEntity(w.ecs);
    spawnEntity(w.ecs);
    const snap = serialize(w);
    expect(snap.components).toEqual({});
  });
});

describe('детерминизм: два прогона одним seed → идентичный хэш снапшота (закон №8)', () => {
  /** Детерминированно населяет мир: людей с Needs/Position/Task + мир-singleton с WorldClock. */
  function build(seed: number): ReturnType<typeof createSimWorld> {
    const w = createSimWorld(seed as Seed);
    const world = spawnEntity(w.ecs); // сущность-мир
    addComponent(w.ecs, WorldClock, world);
    cols(WorldClock)['weather']![world] = WEATHER_CODE.fog;
    cols(WorldClock)['weatherSince']![world] = 0;
    for (let i = 0; i < 5; i++) {
      const e = spawnEntity(w.ecs);
      addComponent(w.ecs, Human, e);
      addComponent(w.ecs, Alive, e);
      addComponent(w.ecs, Position, e);
      addComponent(w.ecs, Needs, e);
      addComponent(w.ecs, Task, e);
      cols(Position)['loc']![e] = i;
      cols(Position)['dest']![e] = i;
      cols(Needs)['hunger']![e] = i * 0.1;
      cols(Task)['kind']![e] = (i % 7) as number;
      cols(Task)['startedTick']![e] = i;
    }
    w.bus.publish({ type: 'sim/tickStarted', causedBy: null, payload: { tick: 0 as Tick } });
    w.bus.endTick(0 as Tick);
    return w;
  }

  it('build(77) дважды подряд даёт один хэш и один канон', () => {
    const a = serialize(build(77));
    const b = serialize(build(77));
    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
    // seed отличается → хэш другой (санити).
    const c = serialize(build(78));
    expect(hashSnapshot(c)).not.toBe(hashSnapshot(a));
  });
});
