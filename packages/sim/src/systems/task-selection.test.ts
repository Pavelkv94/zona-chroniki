/**
 * @module @zona/sim/systems/task-selection.test
 *
 * Гейт системы TaskSelection (задача 1.8, D-020). Покрывает:
 *  - 0 idle: каждый живой Human ВСЕГДА получает валидный Task (популяция worldgen);
 *  - объяснимость выбора: голодный+еда→EAT; голодный без еды, дичь рядом→HUNT;
 *    уставший ночью→SLEEP(target=Home); угроза (высокий fear)→FLEE; ничего срочного
 *    →FORAGE/REST (fallback, не idle);
 *  - argmax tie-break по коду enum (НЕ rng): на ТОЧНОМ равенстве побеждает меньший код;
 *  - детерминизм: два прогона одного seed → идентичные Task и лог task/selected;
 *  - task/selected ТОЛЬКО при СМЕНЕ задачи (D-032); Task.causeEvent = id события;
 *  - targetLoc всегда валиден/достижим; HUNT только при наличии живой дичи;
 *  - причинность через штампы: TaskSelection+Movement, HUNT в др. локацию →
 *    task/selected→move/departed→move/arrived связаны без скана лога;
 *  - RESUME P0: непрерывный прогон === split через save/load (Task + лог task/selected).
 *
 * Нужды в шкале 0..100 (нормируются /NEED_MAX внутри системы). Мир свежий на тест;
 * addComponent зануляет слот (D-024), значения ставим явно.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, removeComponent, hasComponent, queryEntities } from '../core/ecs';
import { Position, Needs, Health, Skills, Home, Animal, Human, Alive, Task, TaskKind } from '../core/components';
import { createScheduler, type Scheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { HEALTH_MAX } from '../balance/needs';
import { worldgen } from '../worldgen';
import { Needs as NeedsSystem } from './needs';
import { Perception } from './perception';
import { Movement } from './movement';
import { TaskSelection } from './task-selection';

// ── Типизированные SoA-колонки для установки/чтения состояния в тестах ─────────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
const NEED = Needs as unknown as { hunger: Float32Array; thirst: Float32Array; fatigue: Float32Array; fear: Float32Array };
const SKILL = Skills as unknown as { survival: Float32Array; shooting: Float32Array; stealth: Float32Array };
const HOME = Home as unknown as { loc: Uint32Array };
const HP = Health as unknown as { hp: Float32Array };
const ANIM = Animal as unknown as { species: Uint8Array; herd: Uint32Array };
const TSK = Task as unknown as {
  kind: Uint8Array;
  targetLoc: Uint32Array;
  targetEid: Uint32Array;
  startedTick: Uint32Array;
  causeEvent: Uint32Array;
};

/** День (не ночь) — середина светового дня; ночь — около полуночи. */
const DAY_TICK = 600 as Tick;
const NIGHT_TICK = 100 as Tick;

interface StalkerOpts {
  readonly loc: number;
  readonly home?: number;
  readonly hunger?: number;
  readonly thirst?: number;
  readonly fatigue?: number;
  readonly fear?: number;
  readonly survival?: number;
  /** true ⇒ кладём консервы в инвентарь (еда, kind='food'). */
  readonly food?: boolean;
}

/** Селит сталкера с контролируемыми нуждами/навыками/домом/инвентарём. */
function placeStalker(world: SimWorld, o: StalkerOpts): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = o.loc;
  POS.dest[eid] = o.loc;
  addComponent(world.ecs, Needs, eid);
  NEED.hunger[eid] = o.hunger ?? 0;
  NEED.thirst[eid] = o.thirst ?? 0;
  NEED.fatigue[eid] = o.fatigue ?? 0;
  NEED.fear[eid] = o.fear ?? 0;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = HEALTH_MAX;
  addComponent(world.ecs, Skills, eid);
  SKILL.survival[eid] = o.survival ?? 0.5;
  addComponent(world.ecs, Home, eid);
  HOME.loc[eid] = o.home ?? o.loc;
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  if (o.food) {
    world.resources.set('inventory', eid, [{ item: 'canned', qty: 2 }]);
  }
  return eid;
}

/** Селит живую особь (дичь) в локации `loc`. */
function placeAnimal(world: SimWorld, loc: number, species = 0): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  addComponent(world.ecs, Animal, eid);
  ANIM.species[eid] = species;
  ANIM.herd[eid] = 0;
  addComponent(world.ecs, Alive, eid);
  return eid;
}

/** Планировщик с одной TaskSelection. */
function taskScheduler(): Scheduler {
  const s = createScheduler();
  s.register(TaskSelection);
  return s;
}

/** Оценивает задачи РОВНО один раз на тике `tick` (night/day через tick). */
function evalAt(world: SimWorld, tick: Tick): void {
  world.tick = tick;
  taskScheduler().tickOnce(world);
}

/** События task/selected указанного eid. */
function taskEvents(world: SimWorld, eid: EntityId): readonly SimEvent[] {
  return world.bus.log.filter((e) => e.type === 'task/selected' && (e.payload as { eid: number }).eid === eid);
}

// ═══════════════════════════════════════════════════════════════════════════
// ОБЪЯСНИМОСТЬ ВЫБОРА (DoD)
// ═══════════════════════════════════════════════════════════════════════════

describe('объяснимость: выбор выводится из состояния (закон №2)', () => {
  it('голодный с едой в инвентаре → EAT (на месте)', () => {
    const w = createSimWorld(1 as Seed);
    const eid = placeStalker(w, { loc: 0, hunger: 85, thirst: 10, fatigue: 10, food: true });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);
    expect(TSK.targetLoc[eid]).toBe(0); // на месте
  });

  it('голодный БЕЗ еды, дичь в соседней локации → HUNT (target = локация дичи)', () => {
    const w = createSimWorld(2 as Seed);
    const eid = placeStalker(w, { loc: 3, hunger: 85, thirst: 10, fatigue: 10, survival: 0.6, food: false });
    const prey = placeAnimal(w, 4); // сосед loc3 (ребро 3—4)
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[eid]).toBe(4); // локация дичи
    expect(TSK.targetEid[eid]).toBe(prey); // конкретная жертва
  });

  it('уставший ночью → SLEEP с target = Home (не текущая локация)', () => {
    const w = createSimWorld(3 as Seed);
    const eid = placeStalker(w, { loc: 5, home: 0, fatigue: 95 });
    evalAt(w, NIGHT_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP);
    expect(TSK.targetLoc[eid]).toBe(0); // домой (Кордон)
  });

  it('высокий страх (угроза рядом) → FLEE в самого безопасного соседа', () => {
    const w = createSimWorld(4 as Seed);
    // loc3 соседи {1,4,5}: danger 0.25 / 0.4 / 0.1 ⇒ самый безопасный — 5.
    const eid = placeStalker(w, { loc: 3, fear: 100, fatigue: 30 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.FLEE);
    expect(TSK.targetLoc[eid]).toBe(5);
  });

  it('ничего срочного → FORAGE/REST (fallback, НЕ idle) на месте', () => {
    const w = createSimWorld(5 as Seed);
    // loc7 (Рыжий лес): нет воды, опасно (низкая тяга ко сну), дичи нет ⇒ fallback.
    const eid = placeStalker(w, { loc: 7, survival: 0.3, food: false });
    evalAt(w, DAY_TICK);
    expect([TaskKind.FORAGE, TaskKind.REST]).toContain(TSK.kind[eid] as number);
    expect(TSK.targetLoc[eid]).toBe(7); // на месте
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ARGMAX TIE-BREAK ПО КОДУ ENUM (D-020, НЕ rng)
// ═══════════════════════════════════════════════════════════════════════════

describe('argmax: равные оценки → меньший код TaskKind (НЕ rng)', () => {
  // Саркофаг (loc9, danger=1 ⇒ safety=0, без воды, дичи нет). Тогда:
  //   SLEEP = W.fatigue·(f/100)            = 0.008·f   (день, safety 0)
  //   REST  = W.restBase + W.fatigue·(f/100)·REST_FATIGUE_FACTOR = 0.1 + 0.004·f
  // Пересечение РОВНО при f=25 (0.2 == 0.2, точный double-тай): побеждает SLEEP
  // (код 0 < REST 5). Чуть ниже (f=24) REST строго выше ⇒ REST. Так тай-брейк
  // виден: на точном равенстве — меньший код, а не «случайный» из двух.
  it('точное равенство SLEEP==REST (fatigue=25) → SLEEP (меньший код)', () => {
    const w = createSimWorld(6 as Seed);
    const eid = placeStalker(w, { loc: 9, home: 9, fatigue: 25, survival: 0 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP);
  });

  it('чуть ниже точки равенства (fatigue=24) → REST строго выше', () => {
    const w = createSimWorld(6 as Seed);
    const eid = placeStalker(w, { loc: 9, home: 9, fatigue: 24, survival: 0 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.REST);
  });

  it('детерминизм тай-брейка: 5 прогонов fatigue=25 → всегда SLEEP', () => {
    for (let i = 0; i < 5; i++) {
      const w = createSimWorld((100 + i) as Seed);
      const eid = placeStalker(w, { loc: 9, home: 9, fatigue: 25, survival: 0 });
      evalAt(w, DAY_TICK);
      expect(TSK.kind[eid]).toBe(TaskKind.SLEEP);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 0 IDLE НА ПОПУЛЯЦИИ WORLDGEN (закон №4, D-020)
// ═══════════════════════════════════════════════════════════════════════════

describe('0 idle: каждый живой Human получает валидный Task', () => {
  it('после первого тика ни одной Human-сущности без Task; kind в диапазоне', () => {
    const w = createSimWorld(42 as Seed);
    worldgen(w);
    taskScheduler().run(w, 3);

    const humans = queryEntities(w.ecs, [Human, Alive]);
    expect(humans.length).toBe(20);
    const validKinds = new Set<number>(Object.values(TaskKind));
    for (const eid of humans) {
      expect(hasComponent(w.ecs, Task, eid)).toBe(true);
      expect(validKinds.has(TSK.kind[eid] as number)).toBe(true);
      // targetLoc — валидный id локации (0..9).
      expect(TSK.targetLoc[eid]).toBeGreaterThanOrEqual(0);
      expect(TSK.targetLoc[eid]).toBeLessThan(10);
    }
  });

  it('каждый Human получил ровно одно task/selected на первом тике; causeEvent проштампован', () => {
    const w = createSimWorld(42 as Seed);
    worldgen(w);
    taskScheduler().run(w, 1);
    for (const eid of queryEntities(w.ecs, [Human, Alive])) {
      const evs = taskEvents(w, eid);
      expect(evs).toHaveLength(1);
      expect(TSK.causeEvent[eid]).toBe(evs[0]!.id); // штамп = id события (D-030)
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// task/selected ТОЛЬКО ПРИ СМЕНЕ ЗАДАЧИ (D-032)
// ═══════════════════════════════════════════════════════════════════════════

describe('task/selected публикуется только при смене задачи (D-032)', () => {
  it('стабильное состояние ⇒ одно событие, дальше тишина', () => {
    const w = createSimWorld(7 as Seed);
    const eid = placeStalker(w, { loc: 0, hunger: 85, thirst: 5, fatigue: 5, food: true });
    const sched = taskScheduler();
    w.tick = DAY_TICK;
    // Много тиков подряд на дневном тике: нужды не меняем ⇒ задача та же (EAT).
    for (let i = 0; i < 10; i++) {
      w.tick = DAY_TICK;
      sched.tickOnce(w);
    }
    expect(taskEvents(w, eid)).toHaveLength(1);
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);
  });

  it('смена состояния ⇒ второе событие; causeEvent перештампован на новое', () => {
    const w = createSimWorld(7 as Seed);
    const eid = placeStalker(w, { loc: 0, hunger: 85, fatigue: 5, food: true });
    const sched = taskScheduler();
    w.tick = DAY_TICK;
    sched.tickOnce(w); // первый выбор — EAT (голоден, есть еда)
    const first = taskEvents(w, eid);
    expect(first).toHaveLength(1);
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);

    // Резко поднимаем усталость и ставим ночь ⇒ задача сменится на SLEEP.
    NEED.fatigue[eid] = 98;
    w.tick = NIGHT_TICK;
    sched.tickOnce(w);
    const evs = taskEvents(w, eid);
    expect(evs).toHaveLength(2);
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP);
    expect(TSK.causeEvent[eid]).toBe(evs[1]!.id); // перештамп на новое событие
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ЦЕЛЬ ВАЛИДНА/ДОСТИЖИМА; HUNT ТОЛЬКО ПРИ НАЛИЧИИ ДИЧИ (D-026)
// ═══════════════════════════════════════════════════════════════════════════

describe('цель достижима; HUNT только при живой дичи', () => {
  it('без единого животного НИКТО не выбирает HUNT (нет цели)', () => {
    const w = createSimWorld(8 as Seed);
    // Голодные сталкеры без еды в разных локациях, дичи в мире нет.
    for (let l = 0; l < 6; l++) placeStalker(w, { loc: l, hunger: 90, food: false, survival: 0.7 });
    evalAt(w, DAY_TICK);
    for (const eid of queryEntities(w.ecs, [Human, Alive])) {
      expect(TSK.kind[eid]).not.toBe(TaskKind.HUNT);
    }
  });

  it('DRINK без воды в локации → target = достижимая локация с водой (не текущая)', () => {
    const w = createSimWorld(8 as Seed);
    // loc3 без воды, высокая жажда ⇒ DRINK, цель — ближайшая вода.
    const eid = placeStalker(w, { loc: 3, thirst: 95, fatigue: 0, survival: 0 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.DRINK);
    // ближайшая вода из loc3: соседи 1(нет),5(есть,40),4(есть,55) ⇒ Бар(5).
    expect(TSK.targetLoc[eid]).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ДЕТЕРМИНИЗМ (закон №8)
// ═══════════════════════════════════════════════════════════════════════════

describe('детерминизм: один seed → идентичные Task и лог task/selected', () => {
  /** Прогон worldgen-популяции: Needs растит нужды, TaskSelection выбирает. */
  function runPopulation(seed: number): { events: unknown[]; tasks: number[] } {
    const w = createSimWorld(seed as Seed);
    worldgen(w);
    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(TaskSelection);
    s.run(w, 300);
    const events = w.bus.log
      .filter((e) => e.type === 'task/selected')
      .map((e) => ({ id: e.id, tick: e.tick, causedBy: e.causedBy, payload: e.payload }));
    const tasks: number[] = [];
    for (const eid of queryEntities(w.ecs, [Human, Alive])) {
      tasks.push(TSK.kind[eid] as number, TSK.targetLoc[eid] as number, TSK.targetEid[eid] as number);
    }
    return { events, tasks };
  }

  it('worldgen-популяция seed=42: два прогона идентичны (события + Task)', () => {
    const a = runPopulation(42);
    const b = runPopulation(42);
    expect(a.events).toEqual(b.events);
    expect(a.tasks).toEqual(b.tasks);
  });

  /**
   * Смешанная популяция под РАЗНЫЕ задачи (EAT/HUNT/SLEEP/DRINK/FLEE/FORAGE) —
   * доказывает детерминизм ПО ВСЕМУ спектру выбора, а не на вырожденном «все спят».
   * (Полный суточный цикл со сменой задач эмерджентно замкнётся с восстановлением
   * нужд — задача 1.8e; здесь нужды статичны, поэтому варьируем их между особями.)
   */
  function runMixed(seed: number): { events: unknown[]; kinds: number[] } {
    const w = createSimWorld(seed as Seed);
    placeStalker(w, { loc: 0, hunger: 85, thirst: 10, fatigue: 10, food: true }); // EAT
    placeStalker(w, { loc: 3, hunger: 90, survival: 0.6, food: false }); // HUNT (дичь ниже)
    placeStalker(w, { loc: 5, fatigue: 96, home: 0 }); // SLEEP
    placeStalker(w, { loc: 3, thirst: 95, survival: 0 }); // DRINK
    placeStalker(w, { loc: 3, fear: 100, fatigue: 30 }); // FLEE
    placeStalker(w, { loc: 7, survival: 0.3, food: false }); // FORAGE/REST
    placeAnimal(w, 4); // цель охоты для HUNT-сталкера
    evalAt(w, DAY_TICK);
    const events = w.bus.log
      .filter((e) => e.type === 'task/selected')
      .map((e) => ({ id: e.id, causedBy: e.causedBy, payload: e.payload }));
    const kinds: number[] = [];
    for (const eid of queryEntities(w.ecs, [Human, Alive])) kinds.push(TSK.kind[eid] as number);
    return { events, kinds };
  }

  it('смешанная популяция: два прогона идентичны и покрывают ≥4 разных задачи', () => {
    const a = runMixed(55);
    const b = runMixed(55);
    expect(a.events).toEqual(b.events);
    expect(a.kinds).toEqual(b.kinds);
    expect(new Set(a.kinds).size).toBeGreaterThanOrEqual(4); // не вырожденный выбор
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ПРИЧИННОСТЬ ЧЕРЕЗ ШТАМПЫ: TaskSelection + Movement (D-030)
// ═══════════════════════════════════════════════════════════════════════════

describe('интеграция: task/selected → move/departed → move/arrived (штампы, без скана)', () => {
  it('HUNT в соседнюю локацию: departed.causedBy=task/selected, arrived.causedBy=departed', () => {
    const w = createSimWorld(9 as Seed);
    const eid = placeStalker(w, { loc: 3, hunger: 90, thirst: 10, fatigue: 10, survival: 0.6, food: false });
    placeAnimal(w, 4); // дичь в соседней loc4 (ребро 3—4, len 55)

    const s = createScheduler();
    s.register(TaskSelection); // ДО Movement (D-032): штамп раньше чтения
    s.register(Movement);
    // На всех тиках держим день (иначе isNight сменит выбор). Достигаем loc4.
    for (let t = 0; t < 60; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      s.tickOnce(w);
    }

    const sel = w.bus.log.find((e) => e.type === 'task/selected' && (e.payload as { eid: number }).eid === eid)!;
    expect((sel.payload as { kind: number }).kind).toBe(TaskKind.HUNT);
    expect((sel.payload as { targetLoc: number }).targetLoc).toBe(4);

    const dep = w.bus.log.find((e) => e.type === 'move/departed' && (e.payload as { eid: number }).eid === eid)!;
    const arr = w.bus.log.find((e) => e.type === 'move/arrived' && (e.payload as { eid: number }).eid === eid)!;
    expect((dep.payload as { to: number }).to).toBe(4);
    expect(dep.causedBy).toBe(sel.id); // из Task.causeEvent (штамп), НЕ скан лога
    expect(arr.causedBy).toBe(dep.id); // из Position.moveCause
    expect((arr.payload as { at: number }).at).toBe(4);
    expect(POS.loc[eid]).toBe(4); // добрался до дичи
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESUME P0 (закон №8): непрерывный === split через save/load
// ═══════════════════════════════════════════════════════════════════════════

describe('resume: непрерывный прогон === split через save/load', () => {
  function schedulerNT(): Scheduler {
    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(TaskSelection);
    return s;
  }

  function selectedLog(w: SimWorld): unknown[] {
    return w.bus.log
      .filter((e) => e.type === 'task/selected')
      .map((e) => ({ id: e.id, tick: e.tick, causedBy: e.causedBy, payload: e.payload }));
  }

  it('300 тиков непрерывно vs 150+save/load+150 → идентичный хэш и лог task/selected', () => {
    // Непрерывный.
    const cont = createSimWorld(77 as Seed);
    worldgen(cont);
    schedulerNT().run(cont, 300);

    // Split: 150 тиков, снапшот, восстановление, ещё 150.
    const split = createSimWorld(77 as Seed);
    worldgen(split);
    schedulerNT().run(split, 150);
    const restored = deserialize(serialize(split));
    schedulerNT().run(restored, 150);

    expect(hashSnapshot(serialize(restored))).toBe(hashSnapshot(serialize(cont)));
    expect(selectedLog(restored)).toEqual(selectedLog(cont));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ QA (задача 1.8): дыры idle/stale/повтор/resume, tie-break на РАЗНОЙ
// паре, тупик Саркофага, порядок систем как инвариант, полный ретрофит-конвейер.
// Сценарии читаются как маленькие истории Зоны: «сталкер загнал зверя, зверь
// сдох — что делает охотник на следующем шаге?».
// ═══════════════════════════════════════════════════════════════════════════

/** Минимальная живая Human-сущность БЕЗ Home/Skills/инвентаря — граничный носитель. */
function placeBareHuman(world: SimWorld, o: { loc: number; hunger?: number; fatigue?: number; fear?: number }): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = o.loc;
  POS.dest[eid] = o.loc;
  addComponent(world.ecs, Needs, eid);
  NEED.hunger[eid] = o.hunger ?? 0;
  NEED.thirst[eid] = 0;
  NEED.fatigue[eid] = o.fatigue ?? 0;
  NEED.fear[eid] = o.fear ?? 0;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = HEALTH_MAX;
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  // НЕТ: Home, Skills, inventory — проверяем устойчивость к их отсутствию.
  return eid;
}

// ───────────────────────────────────────────────────────────────────────────
// TIE-BREAK НА ДРУГОЙ ПАРЕ КОДОВ (не SLEEP/REST): EAT(1) vs DRINK(2)
// ───────────────────────────────────────────────────────────────────────────
describe('argmax tie-break: РАЗНАЯ пара задач (EAT<DRINK), меньший код на равенстве', () => {
  // Кордон (loc0, вода, safety 0.95). С едой в инвентаре и точно подобранными
  // нуждами EAT и DRINK сходятся бит-в-бит: EAT=0.4·(45/100)+0.3=0.48;
  // DRINK=0.45·(40/100)+1·0.3=0.48 (умножение IEEE754 коммутативно ⇒ точный тай).
  // Побеждает EAT (код 1 < DRINK 2) — тай-брейк работает и НЕ только на SLEEP/REST.
  it('EAT==DRINK (hunger=45,thirst=40) → EAT (меньший код), детерминированно 3 прогона', () => {
    for (let i = 0; i < 3; i++) {
      const w = createSimWorld((200 + i) as Seed);
      const eid = placeStalker(w, { loc: 0, hunger: 45, thirst: 40, fatigue: 0, food: true });
      evalAt(w, DAY_TICK);
      expect(TSK.kind[eid]).toBe(TaskKind.EAT);
      expect(TSK.targetLoc[eid]).toBe(0);
    }
  });

  it('НЕ вырожденный контест: сдвинь жажду выше (thirst=45>hunger=40) → DRINK перевешивает', () => {
    const w = createSimWorld(201 as Seed);
    const eid = placeStalker(w, { loc: 0, hunger: 40, thirst: 45, fatigue: 0, food: true });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.DRINK); // тай-брейк не «залипает» на EAT
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D-032: стабильное состояние → НЕТ перештампа/повтора; штамп и startedTick стабильны
// ───────────────────────────────────────────────────────────────────────────
describe('D-032: неизменная задача не перештамповывается и не плодит событий', () => {
  it('10 тиков той же задачи (EAT) → 1 событие; causeEvent и startedTick НЕ меняются', () => {
    const w = createSimWorld(210 as Seed);
    const eid = placeStalker(w, { loc: 0, hunger: 85, thirst: 5, fatigue: 5, food: true });
    const sched = taskScheduler();
    w.tick = DAY_TICK;
    sched.tickOnce(w); // первичный выбор EAT
    const causeAfterFirst = TSK.causeEvent[eid];
    const startedAfterFirst = TSK.startedTick[eid];
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);
    expect(causeAfterFirst).toBeGreaterThan(0); // штамп проставлен (не null-эквивалент)

    for (let i = 0; i < 10; i++) {
      w.tick = DAY_TICK;
      sched.tickOnce(w);
    }
    expect(taskEvents(w, eid)).toHaveLength(1); // ни одного повторного task/selected
    expect(TSK.causeEvent[eid]).toBe(causeAfterFirst); // штамп НЕ переписан
    expect(TSK.startedTick[eid]).toBe(startedAfterFirst); // «начало задачи» стабильно
  });

  it('реальная смена (EAT→SLEEP): ровно +1 событие и перештамп causeEvent на новое', () => {
    const w = createSimWorld(211 as Seed);
    const eid = placeStalker(w, { loc: 0, home: 0, hunger: 85, fatigue: 5, food: true });
    const sched = taskScheduler();
    w.tick = DAY_TICK;
    sched.tickOnce(w);
    const firstCause = TSK.causeEvent[eid];
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);

    NEED.fatigue[eid] = 98; // усталость к потолку + ночь ⇒ SLEEP перебивает EAT
    w.tick = NIGHT_TICK;
    sched.tickOnce(w);
    const evs = taskEvents(w, eid);
    expect(evs).toHaveLength(2);
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP);
    expect(TSK.causeEvent[eid]).toBe(evs[1]!.id);
    expect(TSK.causeEvent[eid]).not.toBe(firstCause); // причина реально сменилась
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HUNT: co-located дичь, STALE targetEid (жертва умерла), перевыбор
// ───────────────────────────────────────────────────────────────────────────
describe('HUNT: цель детерминирована; смерть жертвы вызывает перевыбор (D-029)', () => {
  it('дичь co-located (в той же loc) → HUNT target=loc, targetEid=min-eid, на месте', () => {
    const w = createSimWorld(220 as Seed);
    const eid = placeStalker(w, { loc: 4, hunger: 90, thirst: 10, survival: 0.6, food: false });
    const preyB = placeAnimal(w, 4);
    const preyA = placeAnimal(w, 4); // порядок расстановки не важен — берётся min eid
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[eid]).toBe(4);
    expect(TSK.targetEid[eid]).toBe(Math.min(preyA, preyB)); // min eid, не «первый расставленный»
  });

  it('жертва умерла к следующему тику → HUNT перевыбирается (не залипает), targetEid обнулён', () => {
    const w = createSimWorld(221 as Seed);
    const eid = placeStalker(w, { loc: 3, hunger: 92, thirst: 5, fatigue: 5, survival: 0.7, food: false });
    const prey = placeAnimal(w, 4); // единственная дичь, сосед loc4
    const sched = taskScheduler();
    w.tick = DAY_TICK;
    sched.tickOnce(w);
    expect(TSK.kind[eid]).toBe(TaskKind.HUNT);
    expect(TSK.targetEid[eid]).toBe(prey);

    // Зверь гибнет (Encounter 1.10 снял бы Alive). Живой дичи в мире не осталось.
    removeComponent(w.ecs, Alive, prey);
    w.tick = DAY_TICK;
    sched.tickOnce(w);

    // ФИКСАЦИЯ ПОВЕДЕНИЯ (запрос QA): без живой дичи HUNT выпадает из argmax (−∞) и
    // TaskSelection перевыбирает ДРУГУЮ валидную задачу — здесь безопасный fallback
    // SLEEP доминирует (safety·W.safe, D-033 tail), НЕ FORAGE; конкретный fallback —
    // предмет баланса, инвариант же — «не HUNT, не idle, ссылка на покойника снята».
    expect(TSK.kind[eid]).not.toBe(TaskKind.HUNT); // не залипает на мёртвой цели
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP); // фактический перевыбор при этих весах
    expect(TSK.targetEid[eid]).toBe(0); // ссылка на покойника снята (D-029)
    expect(hasComponent(w.ecs, Task, eid)).toBe(true); // не idle (закон №4)
    expect(taskEvents(w, eid)).toHaveLength(2); // перевыбор = ровно одно новое событие
  });

  it('жертва умерла, но рядом ещё дичь → HUNT перецеливается на живого (targetEid меняется)', () => {
    const w = createSimWorld(222 as Seed);
    const eid = placeStalker(w, { loc: 3, hunger: 92, thirst: 5, fatigue: 5, survival: 0.7, food: false });
    const prey1 = placeAnimal(w, 4);
    const prey2 = placeAnimal(w, 4);
    const first = Math.min(prey1, prey2);
    const second = Math.max(prey1, prey2);
    const sched = taskScheduler();
    w.tick = DAY_TICK;
    sched.tickOnce(w);
    expect(TSK.targetEid[eid]).toBe(first);

    removeComponent(w.ecs, Alive, first as EntityId); // min-eid жертва гибнет
    w.tick = DAY_TICK;
    sched.tickOnce(w);
    expect(TSK.kind[eid]).toBe(TaskKind.HUNT); // дичь ещё есть — HUNT сохраняется
    expect(TSK.targetEid[eid]).toBe(second); // перецелился на живого из живого запроса
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FLEE из ТУПИКА (Саркофаг loc9, degree=1): куда бежит, не застревает
// ───────────────────────────────────────────────────────────────────────────
describe('FLEE: направление детерминировано и валидно даже из тупика', () => {
  it('высокий страх в Саркофаге (loc9, единственный сосед 8) → FLEE target=8, не стоит на месте', () => {
    const w = createSimWorld(230 as Seed);
    const eid = placeStalker(w, { loc: 9, home: 9, fear: 100, fatigue: 100 });
    evalAt(w, NIGHT_TICK); // даже ночью и уставший — паника перебивает сон
    expect(TSK.kind[eid]).toBe(TaskKind.FLEE);
    expect(TSK.targetLoc[eid]).toBe(8); // единственный выход
    expect(TSK.targetLoc[eid]).not.toBe(9); // цель ≠ текущая ⇒ Movement реально уведёт (не latent idle)
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D-029: мёртвый eid в contacts НЕ влияет на выбор (угроза только через Needs.fear)
// ───────────────────────────────────────────────────────────────────────────
describe('D-029: TaskSelection игнорирует contacts (в т.ч. мусорные/мёртвые eid)', () => {
  it('мусор в contacts не меняет выбор и не роняет систему', () => {
    function choose(withGarbageContacts: boolean): number {
      const w = createSimWorld(240 as Seed);
      const eid = placeStalker(w, { loc: 3, hunger: 88, thirst: 5, fatigue: 5, survival: 0.6, food: false });
      placeAnimal(w, 4);
      if (withGarbageContacts) {
        // eid, которого нет в мире (покойник/мусор). Валидный консюмер упал бы,
        // адресуя его; TaskSelection их не читает — обязан быть невозмутим.
        w.resources.set('contacts', eid, [999999, 888888]);
      }
      evalAt(w, DAY_TICK);
      return TSK.kind[eid] as number;
    }
    const clean = choose(false);
    const dirty = choose(true);
    expect(dirty).toBe(clean); // contacts — не вход выбора
    expect(clean).toBe(TaskKind.HUNT);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ГРАНИЧНЫЕ НОСИТЕЛИ: без Home/Skills/инвентаря — выбор валиден, без throw
// ───────────────────────────────────────────────────────────────────────────
describe('edge: сущность без Home/Skills/inventory выбирает валидно (не бросает)', () => {
  it('уставший ночью без Home → SLEEP, target = ТЕКУЩАЯ loc (fallback дома на месте)', () => {
    const w = createSimWorld(250 as Seed);
    const eid = placeBareHuman(w, { loc: 5, fatigue: 95 });
    expect(() => evalAt(w, NIGHT_TICK)).not.toThrow();
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP);
    expect(TSK.targetLoc[eid]).toBe(5); // нет Home ⇒ homeLoc=loc, спит на месте (валидно)
  });

  it('голодный без инвентаря НЕ выбирает EAT (еды нет — закон №3); валидный fallback/HUNT', () => {
    const w = createSimWorld(251 as Seed);
    const eid = placeBareHuman(w, { loc: 7, hunger: 95 }); // Рыжий лес: дичи рядом нет в этом мире
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.EAT); // нельзя есть отсутствующее
    const valid = new Set<number>(Object.values(TaskKind));
    expect(valid.has(TSK.kind[eid] as number)).toBe(true);
    expect(TSK.targetLoc[eid]).toBeGreaterThanOrEqual(0);
    expect(TSK.targetLoc[eid]).toBeLessThan(10);
  });

  it('0 idle с граничными носителями: каждый получил Task', () => {
    const w = createSimWorld(252 as Seed);
    const a = placeBareHuman(w, { loc: 2, fatigue: 10 });
    const b = placeBareHuman(w, { loc: 6, hunger: 50 });
    const c = placeBareHuman(w, { loc: 8, fear: 70 });
    evalAt(w, DAY_TICK);
    for (const eid of [a, b, c]) {
      expect(hasComponent(w.ecs, Task, eid)).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ПОРЯДОК СИСТЕМ (D-032): TaskSelection ДО Movement — инвариант same-tick штампа
// ───────────────────────────────────────────────────────────────────────────
describe('D-032 инвариант порядка: TaskSelection перед Movement (штамп виден в тот же тик)', () => {
  /** Сценарий: голодный без еды у соседней дичи ⇒ HUNT в соседнюю loc (нужно движение). */
  function huntWorld(seed: number): { w: SimWorld; eid: EntityId } {
    const w = createSimWorld(seed as Seed);
    const eid = placeStalker(w, { loc: 3, hunger: 90, thirst: 10, fatigue: 10, survival: 0.6, food: false });
    placeAnimal(w, 4);
    return { w, eid };
  }

  function firstDeparted(w: SimWorld, eid: EntityId): SimEvent {
    return w.bus.log.find((e) => e.type === 'move/departed' && (e.payload as { eid: number }).eid === eid)!;
  }
  function selected(w: SimWorld, eid: EntityId): SimEvent {
    return w.bus.log.find((e) => e.type === 'task/selected' && (e.payload as { eid: number }).eid === eid)!;
  }

  it('ПРАВИЛЬНЫЙ порядок: departed на ТОМ ЖЕ тике, что и task/selected (штамп прочитан сразу)', () => {
    const { w, eid } = huntWorld(260);
    const s = createScheduler();
    s.register(TaskSelection); // производитель штампа
    s.register(Movement); // потребитель
    for (let t = 0; t < 5; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      s.tickOnce(w);
    }
    const sel = selected(w, eid);
    const dep = firstDeparted(w, eid);
    expect(dep.tick).toBe(sel.tick); // same-tick: TaskSelection проставил causeEvent ДО Movement
    expect(dep.causedBy).toBe(sel.id); // и причина корректна
  });

  it('ПЕРЕВЁРНУТЫЙ порядок: Movement не видит свежий Task ⇒ первый departed ПОЗЖЕ выбора', () => {
    const { w, eid } = huntWorld(260);
    const s = createScheduler();
    s.register(Movement); // потребитель ВПЕРЕДИ — читает Task ещё до его создания
    s.register(TaskSelection);
    for (let t = 0; t < 5; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      s.tickOnce(w);
    }
    const sel = selected(w, eid);
    const dep = firstDeparted(w, eid);
    // Инвариант ломается наблюдаемо: departure сдвигается на тик позже выбора
    // (в тик выбора Movement ещё не видел Task). Это и есть причина требования
    // TaskSelection<Movement (D-032): штамп обязан существовать ДО чтения.
    expect(dep.tick).toBeGreaterThan(sel.tick);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// РЕТРОФИТ MOVEMENT НА ШТАМПЫ: полный конвейер TaskSelection→Movement, мультихоп
// ───────────────────────────────────────────────────────────────────────────
describe('ретрофит: реальный TaskSelection ведёт Movement через мультихоп (штампы, без скана)', () => {
  it('SLEEP домой издалека (5→2→1→0): 1 task/selected, все departed→него, каждый arrived→свой departed', () => {
    const w = createSimWorld(270 as Seed);
    // Ночью, вымотан, дом — Кордон (loc0), сам в Баре (loc5). Дорога домой мультихоп.
    const eid = placeStalker(w, { loc: 5, home: 0, fatigue: 95, thirst: 5, food: false });
    const s = createScheduler();
    s.register(TaskSelection);
    s.register(Movement);
    // Держим ночь весь путь (тики 100..~232 < DAWN=360): SLEEP не сменится днём.
    for (let t = 0; t < 140; t++) {
      w.tick = (NIGHT_TICK + t) as Tick;
      s.tickOnce(w);
    }
    expect(POS.loc[eid]).toBe(0); // добрался домой

    const sels = taskEvents(w, eid);
    expect(sels).toHaveLength(1); // задача не менялась всю дорогу ⇒ один штамп
    const selId = sels[0]!.id;
    expect((sels[0]!.payload as { kind: number }).kind).toBe(TaskKind.SLEEP);
    expect(TSK.causeEvent[eid]).toBe(selId); // штамп в компоненте = событие

    const deps = w.bus.log.filter((e) => e.type === 'move/departed' && (e.payload as { eid: number }).eid === eid);
    const arrs = w.bus.log.filter((e) => e.type === 'move/arrived' && (e.payload as { eid: number }).eid === eid);
    expect(deps.length).toBe(3); // 5→2, 2→1, 1→0
    expect(arrs.length).toBe(3);
    // Причинность через ШТАМПЫ (не скан лога):
    for (const d of deps) {
      expect(d.causedBy).toBe(selId); // departed.causedBy = Task.causeEvent (стабилен на всю ногу)
      expect(d.causedBy).not.toBeNull(); // ← НЕ null там, где TaskSelection проставил штамп
    }
    for (let i = 0; i < arrs.length; i++) {
      expect(arrs[i]!.causedBy).toBe(deps[i]!.id); // arrived.causedBy = свой departed (Position.moveCause)
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ДЕТЕРМИНИЗМ ПОЛНОГО МИНИ-КОНВЕЙЕРА (worldgen + Needs+Perception+TaskSelection+Movement)
// ───────────────────────────────────────────────────────────────────────────
describe('детерминизм: мини-прогон всего конвейера — 2 прогона идентичны (хэш + лог)', () => {
  function fullPipeline(): Scheduler {
    const s = createScheduler();
    // Порядок D-032: Needs<…, Perception<TaskSelection, TaskSelection<Movement.
    s.register(NeedsSystem);
    s.register(Perception);
    s.register(TaskSelection);
    s.register(Movement);
    return s;
  }
  function run(seed: number): { hash: string; log: unknown[] } {
    const w = createSimWorld(seed as Seed);
    worldgen(w);
    fullPipeline().run(w, 200);
    const log = w.bus.log.map((e) => ({ id: e.id, tick: e.tick, type: e.type, causedBy: e.causedBy, payload: e.payload }));
    return { hash: hashSnapshot(serialize(w)), log };
  }

  it('seed=333: идентичный снапшот-хэш и полный лог событий на 200 тиках', () => {
    const a = run(333);
    const b = run(333);
    expect(a.hash).toBe(b.hash);
    expect(a.log).toEqual(b.log);
  });
});
