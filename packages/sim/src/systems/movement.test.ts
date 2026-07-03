/**
 * @module @zona/sim/systems/movement.test
 *
 * Гейт системы Movement (задача 1.4, B.1). Покрывает:
 *  - одиночный переход: прибытие РОВНО через edgeLen тиков, события departed/arrived;
 *  - мультихоп: серия departed/arrived по кратчайшему пути, приход в цель;
 *  - «стоит»: без Task или при цели == loc — не движется, событий нет;
 *  - детерминизм: два прогона одного сценария → идентичные события и позиции;
 *  - порядок обработки = сортировка по eid (закон №8);
 *  - причинность: departed.causedBy → task/selected из at(tick-1); arrived → departed.
 *
 * Movement rng не использует, поэтому детерминизм тут структурный (порядок eid),
 * а не про PRNG. Мир каждый тест свежий (свежий eid-аллокатор); addComponent
 * зануляет слот (D-024), значения ставим явно.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, LocationId, Seed, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent } from '../core/ecs';
import { Position, Task, TaskKind } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { edgeLen, neighbors } from '../data/index';
import { Movement } from './movement';

// Типизированные SoA-колонки для установки/чтения состояния в тестах.
const POS = Position as unknown as {
  loc: Uint32Array;
  dest: Uint32Array;
  etaTicks: Float32Array;
};
const TSK = Task as unknown as { targetLoc: Uint32Array; kind: Uint8Array };

/** Селит сущность-ходока: Position (стоит в `loc`) + Task с целью `target`. */
function placeMover(world: SimWorld, loc: number, target: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // dest===loc ⇒ стоит (D-019)
  addComponent(world.ecs, Task, eid);
  TSK.kind[eid] = TaskKind.FORAGE;
  TSK.targetLoc[eid] = target;
  return eid;
}

/** Планировщик с единственной системой Movement. */
function movementScheduler() {
  const s = createScheduler();
  s.register(Movement);
  return s;
}

/** События движения указанного eid из лога, в порядке публикации. */
function moveEvents(world: SimWorld, eid: EntityId): readonly SimEvent[] {
  return world.bus.log.filter(
    (e) =>
      (e.type === 'move/departed' || e.type === 'move/arrived') &&
      (e.payload as { eid: number }).eid === eid,
  );
}

/** Нормализация события до сравнимого кортежа. */
function normalize(log: readonly SimEvent[]): ReadonlyArray<Record<string, unknown>> {
  return log.map((e) => ({ id: e.id, tick: e.tick, type: e.type, causedBy: e.causedBy, payload: e.payload }));
}

describe('одиночный переход: прибытие ровно через edgeLen тиков', () => {
  const from = 0;
  const to = 1; // сосед Кордона
  const len = edgeLen(from as LocationId, to as LocationId)!;

  it('departed на тике 0, arrived на тике edgeLen, loc обновлён', () => {
    const w = createSimWorld(1 as Seed);
    const eid = placeMover(w, from, to);
    movementScheduler().run(w, len + 1); // тики 0..len

    expect(POS.loc[eid]).toBe(to);
    expect(POS.dest[eid]).toBe(to); // прибыл ⇒ снова стоит

    const evs = moveEvents(w, eid);
    expect(evs).toHaveLength(2);

    const dep = evs[0]!;
    expect(dep.type).toBe('move/departed');
    expect(dep.tick).toBe(0);
    expect(dep.payload).toEqual({ eid, from, to });

    const arr = evs[1]!;
    expect(arr.type).toBe('move/arrived');
    expect(arr.tick).toBe(len); // РОВНО edgeLen тиков после departure
    expect(arr.payload).toEqual({ eid, at: to });
  });

  it('не прибывает раньше edgeLen тиков', () => {
    const w = createSimWorld(1 as Seed);
    const eid = placeMover(w, from, to);
    movementScheduler().run(w, len); // тики 0..len-1

    expect(POS.loc[eid]).toBe(from); // ещё в пути
    expect(moveEvents(w, eid).some((e) => e.type === 'move/arrived')).toBe(false);
  });

  it('arrived.causedBy указывает на соответствующий departed', () => {
    const w = createSimWorld(1 as Seed);
    const eid = placeMover(w, from, to);
    movementScheduler().run(w, len + 1);
    const [dep, arr] = moveEvents(w, eid);
    expect(arr!.causedBy).toBe(dep!.id);
  });
});

describe('мультихоп: серия departed/arrived по кратчайшему пути', () => {
  // 0→2 вынужденно через 1: [0,1,2].
  const l01 = edgeLen(0 as LocationId, 1 as LocationId)!;
  const l12 = edgeLen(1 as LocationId, 2 as LocationId)!;

  it('идёт 0→1→2, приходит в цель; departed/arrived чередуются', () => {
    const w = createSimWorld(2 as Seed);
    const eid = placeMover(w, 0, 2);
    // Хоп1: departure@0, arrival@l01. Пауза 1 тик. Хоп2: departure@l01+1,
    // arrival@l01+1+l12. Прогоняем с запасом.
    const arriveTick = l01 + 1 + l12;
    movementScheduler().run(w, arriveTick + 1);

    expect(POS.loc[eid]).toBe(2);

    const evs = moveEvents(w, eid).map((e) => ({ type: e.type, tick: e.tick, payload: e.payload }));
    expect(evs).toEqual([
      { type: 'move/departed', tick: 0, payload: { eid, from: 0, to: 1 } },
      { type: 'move/arrived', tick: l01, payload: { eid, at: 1 } },
      { type: 'move/departed', tick: l01 + 1, payload: { eid, from: 1, to: 2 } },
      { type: 'move/arrived', tick: arriveTick, payload: { eid, at: 2 } },
    ]);
  });

  it('каждый arrived.causedBy = его departed (причинная цепочка шага)', () => {
    const w = createSimWorld(2 as Seed);
    const eid = placeMover(w, 0, 2);
    movementScheduler().run(w, l01 + 1 + l12 + 1);
    const evs = moveEvents(w, eid);
    // evs = [dep1, arr1, dep2, arr2]
    expect(evs[1]!.causedBy).toBe(evs[0]!.id);
    expect(evs[3]!.causedBy).toBe(evs[2]!.id);
  });
});

describe('«стоит»: не движется без причины', () => {
  it('нет Task → не движется, событий нет', () => {
    const w = createSimWorld(3 as Seed);
    const eid = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, eid);
    POS.loc[eid] = 5;
    POS.dest[eid] = 5;
    // Task не добавляем.
    movementScheduler().run(w, 50);
    expect(POS.loc[eid]).toBe(5);
    expect(POS.dest[eid]).toBe(5);
    expect(w.bus.log).toHaveLength(0);
  });

  it('Task.targetLoc == loc → не движется, событий нет', () => {
    const w = createSimWorld(3 as Seed);
    const eid = placeMover(w, 5, 5); // цель == текущей локации
    movementScheduler().run(w, 50);
    expect(POS.loc[eid]).toBe(5);
    expect(moveEvents(w, eid)).toHaveLength(0);
  });
});

describe('детерминизм и порядок обработки (закон №8)', () => {
  /** Сценарий: три ходока с разными целями, прогон N тиков. */
  function scenario(seed: number): SimWorld {
    const w = createSimWorld(seed as Seed);
    placeMover(w, 0, 1); // eid 1
    placeMover(w, 2, 5); // eid 2
    placeMover(w, 3, 4); // eid 3
    movementScheduler().run(w, 120);
    return w;
  }

  it('два прогона одного сценария → идентичный лог событий', () => {
    const a = scenario(7);
    const b = scenario(7);
    expect(normalize(a.bus.log)).toEqual(normalize(b.bus.log));
  });

  it('порядок departed на тике 0 = сортировка по eid', () => {
    const w = scenario(7);
    const tick0 = w.bus.log.filter((e) => e.tick === 0 && e.type === 'move/departed');
    const eids = tick0.map((e) => (e.payload as { eid: number }).eid);
    const sorted = [...eids].sort((x, y) => x - y);
    expect(eids).toEqual(sorted);
    expect(eids).toEqual([1, 2, 3]); // три ходока стартуют на тике 0
  });
});

/** Публикует мок-событие task/selected (1.8, ещё не в union) через ослабленный каст. */
function publishTaskSelected(world: SimWorld, eid: EntityId, targetLoc: number): EventId {
  const publishLoose = world.bus.publish as unknown as (e: {
    type: string;
    causedBy: EventId | null;
    payload: { eid: EntityId; targetLoc: number };
  }) => EventId;
  return publishLoose({ type: 'task/selected', causedBy: null, payload: { eid, targetLoc } });
}

describe('причинность: departed первого хопа → совпадающий task/selected (eid,targetLoc)', () => {
  it('находит task/selected этого eid с совпадающим targetLoc', () => {
    const w = createSimWorld(9 as Seed);
    const eid = placeMover(w, 0, 1);

    // Тик 0: фиксируем task/selected для цели 1 (Movement ещё не гоняем).
    const selId = publishTaskSelected(w, eid, 1);
    w.bus.endTick(0 as Tick);
    w.tick = 1 as Tick;

    // Тик 1: Movement делает departure первого хопа и ищет совпадающую причину.
    movementScheduler().run(w, 1);

    const dep = moveEvents(w, eid).find((e) => e.type === 'move/departed')!;
    expect(dep.tick).toBe(1);
    expect(dep.causedBy).toBe(selId);
  });

  it('targetLoc без совпадающего task/selected → null (НЕ прилипает старый чужой)', () => {
    const w = createSimWorld(9 as Seed);
    const eid = placeMover(w, 0, 1); // реальная цель — локация 1

    // Есть task/selected, но для ДРУГОЙ цели (5) — не должен прилипнуть к цели 1.
    publishTaskSelected(w, eid, 5);
    w.bus.endTick(0 as Tick);
    w.tick = 1 as Tick;

    movementScheduler().run(w, 1);
    const dep = moveEvents(w, eid).find((e) => e.type === 'move/departed')!;
    expect(dep.causedBy).toBeNull();
  });

  it('нет task/selected вовсе → departed.causedBy = null', () => {
    const w = createSimWorld(9 as Seed);
    const eid = placeMover(w, 0, 1);
    movementScheduler().run(w, 1);
    const dep = moveEvents(w, eid).find((e) => e.type === 'move/departed')!;
    expect(dep.causedBy).toBeNull();
  });
});

describe('причинность мультихопа: цепочка замкнута до корня (MAJOR-1)', () => {
  // 0→5 = [0,1,2,5] (3 хопа) — промежуточные departed должны цепляться к arrived.
  it('dep2.causedBy=arr1, dep3.causedBy=arr2; вся цепочка резолвится до task/selected→null', () => {
    const w = createSimWorld(11 as Seed);
    const eid = placeMover(w, 0, 5);

    // Корень ноги — task/selected(targetLoc=5), закоммичен до departure.
    const selId = publishTaskSelected(w, eid, 5);
    w.bus.endTick(0 as Tick);
    w.tick = 1 as Tick;

    // С запасом: 3 хопа по кратчайшему пути + 2 паузы на промежуточных узлах.
    movementScheduler().run(w, 400);
    expect(POS.loc[eid]).toBe(5);

    const evs = moveEvents(w, eid);
    // Последовательность: dep1, arr1, dep2, arr2, dep3, arr3.
    expect(evs.map((e) => e.type)).toEqual([
      'move/departed', 'move/arrived',
      'move/departed', 'move/arrived',
      'move/departed', 'move/arrived',
    ]);
    const [dep1, arr1, dep2, arr2, dep3, arr3] = evs as [SimEvent, SimEvent, SimEvent, SimEvent, SimEvent, SimEvent];

    // Первый хоп цепляется к task/selected; промежуточные — к предыдущему arrived.
    expect(dep1.causedBy).toBe(selId);
    expect(dep2.causedBy).toBe(arr1.id);
    expect(dep3.causedBy).toBe(arr2.id);
    // Каждое прибытие — к своему departure.
    expect(arr1.causedBy).toBe(dep1.id);
    expect(arr2.causedBy).toBe(dep2.id);
    expect(arr3.causedBy).toBe(dep3.id);

    // Полная резолюция цепочки от финального arrived до корня (task/selected → null).
    const byId = new Map<EventId, SimEvent>();
    for (const e of w.bus.log) byId.set(e.id, e);
    let cursor: SimEvent | undefined = arr3;
    const seen = new Set<EventId>();
    let steps = 0;
    while (cursor && cursor.causedBy !== null) {
      expect(seen.has(cursor.id)).toBe(false); // без циклов
      seen.add(cursor.id);
      expect(cursor.causedBy).toBeLessThan(cursor.id); // причина раньше следствия
      const next: SimEvent | undefined = byId.get(cursor.causedBy);
      expect(next).toBeDefined(); // причина существует в логе
      cursor = next;
      steps++;
    }
    expect(cursor!.id).toBe(selId); // цепочка упирается в task/selected
    expect(cursor!.causedBy).toBeNull(); // корень
    expect(steps).toBe(6); // arr3→dep3→arr2→dep2→arr1→dep1→sel
  });
});

describe('инвариант цели (F-2): невалидная цель → стоит без throw', () => {
  // Контракт: TaskSelection (1.8) обязана давать валидный достижимый targetLoc;
  // молчаливый вечный простой ловит world-инвариант гейта 1.13, не краш здесь.
  it('targetLoc вне диапазона (firstStep=undefined) → сущность стоит, событий нет', () => {
    const w = createSimWorld(13 as Seed);
    const eid = placeMover(w, 4, 99); // 99 — нет такой локации
    expect(() => movementScheduler().run(w, 50)).not.toThrow();
    expect(POS.loc[eid]).toBe(4);
    expect(POS.dest[eid]).toBe(4); // так и не двинулся
    expect(moveEvents(w, eid)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ QA (задача 1.4): ре-роутинг, точная арифметика мультихопа,
// граничные цели, дробный eta, независимость сущностей. Сценарии читаются как
// маленькие истории мира: «сталкер вышел к X, но передумал на полпути…».
// ═══════════════════════════════════════════════════════════════════════════

describe('РЕ-РОУТИНГ: Task.targetLoc меняется, пока сущность В ПУТИ', () => {
  // Зафиксированное поведение (D-026 п.2, else-ветка Movement): пока dest !== loc,
  // Movement НЕ читает Task — текущий хоп ДОВОДИТСЯ до конца, перестроение только
  // после прибытия в промежуточный узел. Значит: не дёргается, не телепортируется,
  // не зацикливается — но ОБЯЗАН доехать до текущего dest (коммит хопа).

  it('смена цели 2→3 в середине хопа 0→1: доводит до 1, потом уходит в 3 (без телепорта)', () => {
    const w = createSimWorld(11 as Seed);
    const eid = placeMover(w, 0, 2); // путь [0,1,2]: dep 0→1@0, arr 1@40
    const sched = movementScheduler();

    sched.run(w, 20); // тики 0..19 — в пути к 1 (loc=0, dest=1)
    expect(POS.loc[eid]).toBe(0);
    expect(POS.dest[eid]).toBe(1);

    TSK.targetLoc[eid] = 3; // сталкер передумал на полпути: теперь цель — 3

    sched.run(w, 80); // доводим до оседания
    expect(POS.loc[eid]).toBe(3); // добрался до НОВОЙ цели

    const evs = moveEvents(w, eid).map((e) => ({ type: e.type, tick: e.tick, payload: e.payload }));
    // Текущий хоп к 1 ДОВЕДЁН (коммит), затем перестроение 1→3 (firstStep(1,3)=3).
    expect(evs).toEqual([
      { type: 'move/departed', tick: 0, payload: { eid, from: 0, to: 1 } },
      { type: 'move/arrived', tick: 40, payload: { eid, at: 1 } },
      { type: 'move/departed', tick: 41, payload: { eid, from: 1, to: 3 } },
      { type: 'move/arrived', tick: 91, payload: { eid, at: 3 } }, // 41 + edgeLen(1,3)=50
    ]);
  });

  it('ни один переход не «перепрыгивает» узел: loc меняется только по рёбрам графа', () => {
    const w = createSimWorld(11 as Seed);
    const eid = placeMover(w, 0, 2);
    const sched = movementScheduler();
    sched.run(w, 20);
    TSK.targetLoc[eid] = 3;
    sched.run(w, 80);

    // Восстанавливаем траекторию loc из событий arrived и проверяем смежность.
    const arrivals = moveEvents(w, eid)
      .filter((e) => e.type === 'move/arrived')
      .map((e) => (e.payload as { at: number }).at);
    let prev = 0; // старт
    for (const at of arrivals) {
      expect(neighbors(prev as LocationId)).toContain(at as LocationId); // ребро существует
      prev = at;
    }
  });

  it('смена цели ОБРАТНО в исходную точку 1→0: доводит хоп до 1 (overshoot), потом возвращается в 0', () => {
    // Документирует «стоимость коммита»: сталкер уже вышел из 0 к 1; отмена цели
    // на 0 НЕ разворачивает его в пути — он доходит до 1 и лишь затем идёт назад.
    const w = createSimWorld(12 as Seed);
    const eid = placeMover(w, 0, 1); // dep 0→1@0, arr 1@40
    const sched = movementScheduler();
    sched.run(w, 10); // в пути к 1
    TSK.targetLoc[eid] = 0; // «вернись домой»

    sched.run(w, 80);
    expect(POS.loc[eid]).toBe(0); // вернулся

    const evs = moveEvents(w, eid).map((e) => ({ type: e.type, tick: e.tick, payload: e.payload }));
    expect(evs).toEqual([
      { type: 'move/departed', tick: 0, payload: { eid, from: 0, to: 1 } },
      { type: 'move/arrived', tick: 40, payload: { eid, at: 1 } }, // overshoot до 1
      { type: 'move/departed', tick: 41, payload: { eid, from: 1, to: 0 } },
      { type: 'move/arrived', tick: 81, payload: { eid, at: 0 } }, // 41 + 40
    ]);
  });

  it('смена цели на ТЕКУЩИЙ dest промежуточного хопа: доезжает и ОСТАНАВЛИВАЕТСЯ там', () => {
    const w = createSimWorld(13 as Seed);
    const eid = placeMover(w, 0, 2); // dep 0→1, дальше был бы 1→2
    const sched = movementScheduler();
    sched.run(w, 20);
    TSK.targetLoc[eid] = 1; // цель = узел, к которому уже едем

    sched.run(w, 60);
    expect(POS.loc[eid]).toBe(1);
    expect(POS.dest[eid]).toBe(1); // стоит

    const evs = moveEvents(w, eid).map((e) => ({ type: e.type, tick: e.tick }));
    // Ровно один хоп; второго departure нет (targetLoc==loc после прибытия).
    expect(evs).toEqual([
      { type: 'move/departed', tick: 0 },
      { type: 'move/arrived', tick: 40 },
    ]);
  });
});

describe('граничные цели: невалидная / недостижимая targetLoc', () => {
  it('targetLoc вне диапазона id (99): Movement не падает, не зависает, стоит без событий', () => {
    // ХВОСТ-КОНТРАКТ: firstStep возвращает undefined ⇒ Movement молча пропускает
    // (continue). Сущность остаётся стоять НАВСЕГДА (латентный idle, закон №4),
    // но система устойчива: не бросает и не зацикливается на тике. Ответственность
    // «валидный targetLoc» лежит на TaskSelection (D-026 п.1); дефенсивного assert
    // здесь НЕТ — фиксируем это тестом как явный контракт.
    const w = createSimWorld(14 as Seed);
    const eid = placeMover(w, 0, 99);
    expect(() => movementScheduler().run(w, 100)).not.toThrow();
    expect(POS.loc[eid]).toBe(0);
    expect(POS.dest[eid]).toBe(0); // так и не тронулся
    expect(moveEvents(w, eid)).toHaveLength(0);
  });

  it('targetLoc == loc в момент departure (уже на месте): НЕ публикует departed', () => {
    const w = createSimWorld(14 as Seed);
    const eid = placeMover(w, 6, 6); // стоит в 6, цель 6
    movementScheduler().run(w, 30);
    expect(POS.loc[eid]).toBe(6);
    expect(w.bus.log.some((e) => e.type === 'move/departed')).toBe(false);
    expect(moveEvents(w, eid)).toHaveLength(0);
  });
});

describe('точная арифметика тиков', () => {
  it('departure@T (T!=0), edgeLen=40 → arrival РОВНО @T+40, не T+39/T+41', () => {
    // Сущность стоит в цели, потом цель меняется на тике 10 ⇒ departure именно @10.
    const w = createSimWorld(15 as Seed);
    const eid = placeMover(w, 0, 0); // цель == loc: стоит, событий нет
    const sched = movementScheduler();
    sched.run(w, 10); // тики 0..9 — стоит, лог пуст
    expect(w.bus.log).toHaveLength(0);
    expect(w.tick).toBe(10);

    TSK.targetLoc[eid] = 1; // edgeLen(0,1)=40
    sched.run(w, 41); // тики 10..50

    const evs = moveEvents(w, eid);
    const dep = evs.find((e) => e.type === 'move/departed')!;
    const arr = evs.find((e) => e.type === 'move/arrived')!;
    expect(dep.tick).toBe(10); // departure ровно на T
    expect(arr.tick).toBe(50); // T + 40, не 49 и не 51
  });

  it('мультихоп через 4 ребра 0→7 [0,1,3,4,7]: полная цепочка, arrival@218', () => {
    // Арифметика (посчитана вручную и сверена с pathfinder):
    //   рёбра 40+50+55+70 = 215; между 4 хопами 3 передышки по 1 тику ⇒ 218.
    const w = createSimWorld(16 as Seed);
    const eid = placeMover(w, 0, 7);
    movementScheduler().run(w, 219);

    expect(POS.loc[eid]).toBe(7);

    const evs = moveEvents(w, eid).map((e) => ({ type: e.type, tick: e.tick, payload: e.payload }));
    expect(evs).toEqual([
      { type: 'move/departed', tick: 0, payload: { eid, from: 0, to: 1 } },
      { type: 'move/arrived', tick: 40, payload: { eid, at: 1 } },
      { type: 'move/departed', tick: 41, payload: { eid, from: 1, to: 3 } },
      { type: 'move/arrived', tick: 91, payload: { eid, at: 3 } },
      { type: 'move/departed', tick: 92, payload: { eid, from: 3, to: 4 } },
      { type: 'move/arrived', tick: 147, payload: { eid, at: 4 } },
      { type: 'move/departed', tick: 148, payload: { eid, from: 4, to: 7 } },
      { type: 'move/arrived', tick: 218, payload: { eid, at: 7 } },
    ]);
  });

  it('мультихоп 0→7: каждый arrived.causedBy = его departed; id событий монотонны', () => {
    const w = createSimWorld(16 as Seed);
    const eid = placeMover(w, 0, 7);
    movementScheduler().run(w, 219);
    const evs = moveEvents(w, eid); // [dep,arr,dep,arr,dep,arr,dep,arr]

    // Причинность шага: arrived ссылается на departed своего хопа.
    for (let i = 1; i < evs.length; i += 2) {
      expect(evs[i]!.type).toBe('move/arrived');
      expect(evs[i - 1]!.type).toBe('move/departed');
      expect(evs[i]!.causedBy).toBe(evs[i - 1]!.id);
    }
    // Монотонность id по порядку публикации (append-only лог, закон №8).
    for (let i = 1; i < evs.length; i++) {
      expect(evs[i]!.id).toBeGreaterThan(evs[i - 1]!.id);
    }
  });
});

describe('дробный etaTicks (f32) — детерминизм и порог прибытия <= 0', () => {
  // В 1.4 множители скорости отключены ⇒ eta всегда целый (D-026 п.3). Тест
  // прямо инъектирует дробный eta в транзитную сущность, чтобы зафиксировать
  // семантику будущих множителей: прибытие когда eta <= 0 (эффективно ceil).
  function transitEntity(w: SimWorld, loc: number, dest: number, eta: number): EntityId {
    const eid = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, eid);
    POS.loc[eid] = loc;
    POS.dest[eid] = dest; // dest !== loc ⇒ в пути (else-ветка, Task не нужен)
    POS.etaTicks[eid] = eta;
    return eid;
  }

  it('eta=3.5: прибывает после ceil(3.5)=4 списаний (на тике 3), не раньше', () => {
    const w = createSimWorld(17 as Seed);
    const eid = transitEntity(w, 0, 1, 3.5);
    const sched = movementScheduler();

    sched.run(w, 3); // тики 0,1,2: eta 2.5→1.5→0.5 (>0), ещё в пути
    expect(POS.loc[eid]).toBe(0);
    expect(moveEvents(w, eid)).toHaveLength(0);

    sched.run(w, 1); // тик 3: eta -0.5 <= 0 ⇒ прибытие
    expect(POS.loc[eid]).toBe(1);
    const arr = moveEvents(w, eid).find((e) => e.type === 'move/arrived')!;
    expect(arr.tick).toBe(3);
  });

  it('дробный eta детерминирован: два прогона → идентичный тик прибытия', () => {
    function run(seed: number): number {
      const w = createSimWorld(seed as Seed);
      const eid = transitEntity(w, 2, 5, 6.25);
      movementScheduler().run(w, 20);
      return moveEvents(w, eid).find((e) => e.type === 'move/arrived')!.tick;
    }
    expect(run(18)).toBe(run(18));
    expect(run(18)).toBe(6); // ceil(6.25)=7 списаний ⇒ прибытие на тике 6
  });
});

describe('независимость сущностей на одном ребре', () => {
  it('две сущности 0→1 одновременно: оба departed@0, оба arrived@40, независимы', () => {
    const w = createSimWorld(19 as Seed);
    const a = placeMover(w, 0, 1);
    const b = placeMover(w, 0, 1);
    movementScheduler().run(w, 41);

    for (const eid of [a, b]) {
      expect(POS.loc[eid]).toBe(1);
      const evs = moveEvents(w, eid);
      expect(evs.map((e) => e.type)).toEqual(['move/departed', 'move/arrived']);
      expect(evs[0]!.tick).toBe(0);
      expect(evs[1]!.tick).toBe(40);
      expect(evs[1]!.causedBy).toBe(evs[0]!.id); // своя цепочка, не перепутана
    }
    // На тике 0 departed идут в порядке возрастания eid (закон №8).
    const dep0 = w.bus.log.filter((e) => e.tick === 0 && e.type === 'move/departed');
    const eids = dep0.map((e) => (e.payload as { eid: number }).eid);
    expect(eids).toEqual([...eids].sort((x, y) => x - y));
  });
});
