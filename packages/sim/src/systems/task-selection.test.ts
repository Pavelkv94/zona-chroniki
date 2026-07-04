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
 *  - RESUME P0: непрерывный прогон === split через save/load (Task + лог task/selected);
 *  - WORK (2.4) и TRADE (2.6): выбор из состояния (Job/инвентарь+обстановка), гейт
 *    safety·needCalm, ночь/критическая нужда/отсутствие цели исключают их (−∞).
 *
 * Нужды в шкале 0..100 (нормируются /NEED_MAX внутри системы). Мир свежий на тест;
 * addComponent зануляет слот (D-024), значения ставим явно.
 */

import { describe, it, expect } from 'vitest';
import type { Contact, EntityId, FactionId, LocationId, Seed, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, removeComponent, hasComponent, queryEntities } from '../core/ecs';
import { Position, Needs, Health, Skills, Home, Animal, Human, Alive, Job, Settlement, AnomalyField, Task, TaskKind } from '../core/components';
import { createScheduler, type Scheduler } from '../core/scheduler';
import type { SystemCtx } from '../core/system';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { HEALTH_MAX } from '../balance/needs';
import { worldgen } from '../worldgen';
import { STALKER_COUNT, BANDIT_COUNT, SETTLEMENT_RESIDENTS } from '../balance/worldgen';
import { getSettlements, neighbors } from '../data/index';
import { Needs as NeedsSystem } from './needs';
import { Perception } from './perception';
import { Movement } from './movement';
import { TaskSelection } from './task-selection';
import { setRelation, entitySubject, addAvoid, getAvoids, isAvoided } from './memory';
import { RobberyMemory } from './robbery-memory';
import { MemoryDecay } from './memory-decay';
import { ROBBERY_AVOID_DURATION_TICKS } from '../balance/social';

// ── Типизированные SoA-колонки для установки/чтения состояния в тестах ─────────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
const NEED = Needs as unknown as { hunger: Float32Array; thirst: Float32Array; fatigue: Float32Array; fear: Float32Array };
const SKILL = Skills as unknown as { survival: Float32Array; shooting: Float32Array; stealth: Float32Array };
const HOME = Home as unknown as { loc: Uint32Array };
const JOB = Job as unknown as { workplace: Uint32Array; employer: Uint32Array };
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
  it('голодный с едой (и дичь рядом) → EAT: доедает запас, а не идёт на охоту (D-034)', () => {
    const w = createSimWorld(1 as Seed);
    // loc3 без воды, дичь рядом. С едой EAT масштабируется голодом и бьёт HUNT.
    const eid = placeStalker(w, { loc: 3, hunger: 85, thirst: 10, fatigue: 10, survival: 0.3, food: true });
    placeAnimal(w, 3); // дичь под боком — но еда в рюкзаке рациональнее
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);
    expect(TSK.targetLoc[eid]).toBe(3); // на месте
  });

  it('СЫТЫЙ с едой (hunger≈0) НЕ выбирает EAT — не переедает (D-034)', () => {
    const w = createSimWorld(1 as Seed);
    // loc7: нет воды, опасно (низкая тяга ко сну), дичи нет ⇒ выбор среди fallback.
    const eid = placeStalker(w, { loc: 7, hunger: 0, survival: 0.3, food: true });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.EAT); // еда есть, но голода нет
    expect([TaskKind.FORAGE, TaskKind.REST]).toContain(TSK.kind[eid] as number);
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
    // Все живые люди генезиса 2.16b (D-065): 20 одиночек + 4 бандита + на поселение
    // (1 торговец + SETTLEMENT_RESIDENTS резидентов) — ВСЕ Human+Alive и ВСЕ получают
    // Task (не idle, закон №4/D-020), включая бандитов/резидентов.
    expect(humans.length).toBe(
      STALKER_COUNT + BANDIT_COUNT + getSettlements().length * (1 + SETTLEMENT_RESIDENTS),
    );
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
// ОБХОД МАРШРУТА (задача 2.13, D-050/D-063)
// ═══════════════════════════════════════════════════════════════════════════

describe('обход маршрута: NPC избегает помеченную локацию при выборе цели', () => {
  const FAR = 10_000_000; // untilTick далеко в будущем ⇒ обход активен на DAY_TICK

  it('HUNT: избегаемую локацию дичи НЕ выбирает — уходит на дальнюю неизбегаемую', () => {
    const w = createSimWorld(20 as Seed);
    // Голодный без еды в loc1 (Свалка): соседи 2(len35), 3(len50). Дичь в обеих.
    const eid = placeStalker(w, { loc: 1, hunger: 90, food: false, survival: 0.7 });
    placeAnimal(w, 2);
    placeAnimal(w, 3);

    // Контроль: без обхода HUNT → ближайшая дичь в loc2.
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[eid]).toBe(2);

    // Обход loc2 ⇒ HUNT перецеливается на дальнюю loc3 (огибает опасное место).
    addAvoid(w.resources, eid, 2, FAR);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[eid]).toBe(3);
  });

  it('HUNT: единственная дичь в избегаемой локации ⇒ HUNT исключён (−∞), выбор иной задачи', () => {
    const w = createSimWorld(21 as Seed);
    const eid = placeStalker(w, { loc: 1, hunger: 90, food: false, survival: 0.7 });
    placeAnimal(w, 2); // единственная дичь — в соседней loc2

    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.HUNT); // контроль: охотится

    addAvoid(w.resources, eid, 2, FAR);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.HUNT); // некуда охотиться → другая задача
  });

  it('FLEE: избегаемого безопасного соседа НЕ выбирает — бежит к следующему безопасному', () => {
    const w = createSimWorld(22 as Seed);
    // Напуган в loc3: соседи 1(danger .25), 5(.1), 4(.4). safest = 5.
    const eid = placeStalker(w, { loc: 3, fear: 95, survival: 0 });

    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.FLEE);
    expect(TSK.targetLoc[eid]).toBe(5); // контроль: безопаснейший сосед

    addAvoid(w.resources, eid, 5, FAR);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.FLEE);
    expect(TSK.targetLoc[eid]).toBe(1); // 5 избегаем ⇒ следующий безопасный (danger .25)
  });

  it('обход НЕ влияет на NPC без avoid-записей (изоляция)', () => {
    const w = createSimWorld(23 as Seed);
    const avoider = placeStalker(w, { loc: 1, hunger: 90, food: false, survival: 0.7 });
    const clean = placeStalker(w, { loc: 1, hunger: 90, food: false, survival: 0.7 });
    placeAnimal(w, 2);
    placeAnimal(w, 3);
    addAvoid(w.resources, avoider, 2, FAR);

    evalAt(w, DAY_TICK);
    // Избегающий уходит на loc3; «чистый» — на ближайшую loc2 (поведение не изменилось).
    expect(TSK.kind[avoider]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[avoider]).toBe(3);
    expect(TSK.kind[clean]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[clean]).toBe(2);
  });

  it('истёкший обход (untilTick<=tick) не влияет — цель прежняя', () => {
    const w = createSimWorld(24 as Seed);
    const eid = placeStalker(w, { loc: 1, hunger: 90, food: false, survival: 0.7 });
    placeAnimal(w, 2);
    placeAnimal(w, 3);
    // Обход loc2 истёк ДО DAY_TICK (until <= tick) ⇒ isAvoided false ⇒ цель = loc2.
    addAvoid(w.resources, eid, 2, (DAY_TICK as number) - 1);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[eid]).toBe(2);
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
  // нуждами EAT и DRINK сходятся бит-в-бит под НОВОЙ формулой EAT (D-034):
  // EAT=(0.4+0.3)·(66/100)=0.46199999999999997; DRINK=0.45·(36/100)+1·0.3 то же
  // значение (проверено brute-force IEEE754). Оба — глобальный максимум (SLEEP
  // 0.285, REST 0.1). Побеждает EAT (код 1 < DRINK 2) — тай-брейк работает и НЕ
  // только на SLEEP/REST.
  it('EAT==DRINK (hunger=66,thirst=36) → EAT (меньший код), детерминированно 3 прогона', () => {
    for (let i = 0; i < 3; i++) {
      const w = createSimWorld((200 + i) as Seed);
      const eid = placeStalker(w, { loc: 0, hunger: 66, thirst: 36, fatigue: 0, food: true });
      evalAt(w, DAY_TICK);
      expect(TSK.kind[eid]).toBe(TaskKind.EAT);
      expect(TSK.targetLoc[eid]).toBe(0);
    }
  });

  it('НЕ вырожденный контест: жажда выше (thirst=50) → DRINK перевешивает EAT', () => {
    const w = createSimWorld(201 as Seed);
    const eid = placeStalker(w, { loc: 0, hunger: 66, thirst: 50, fatigue: 0, food: true });
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

// ═══════════════════════════════════════════════════════════════════════════
// WORK (задача 2.4): носитель Job днём при спокойных нуждах → WORK; нужды/страх/
// ночь перебивают; безработный НЕ получает WORK (поведение не-Job не меняется).
// ═══════════════════════════════════════════════════════════════════════════

/** Селит сталкера И навешивает Job(workplace, employer=фиктивный eid). */
function placeWorker(world: SimWorld, o: StalkerOpts & { workplace: number }): EntityId {
  const eid = placeStalker(world, o);
  addComponent(world.ecs, Job, eid);
  JOB.workplace[eid] = o.workplace;
  JOB.employer[eid] = 1; // фиктивный работодатель (WORK-выбор его не читает)
  return eid;
}

describe('WORK: носитель Job днём при спокойных нуждах выходит на смену', () => {
  it('спокойный работник днём на рабочем месте (loc0) → WORK, target=workplace (на месте)', () => {
    const w = createSimWorld(300 as Seed);
    // Кордон (loc0): безопасно, спокоен ⇒ WORK бьёт fallback'и/дневной SLEEP.
    const eid = placeWorker(w, { loc: 0, home: 0, workplace: 0 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.WORK);
    expect(TSK.targetLoc[eid]).toBe(0); // рабочее место = текущая loc
  });

  it('работник вне рабочего места (в Баре loc5, workplace=0) → WORK target=0; Movement довозит', () => {
    const w = createSimWorld(301 as Seed);
    const eid = placeWorker(w, { loc: 5, home: 5, workplace: 0 });
    const s = createScheduler();
    s.register(TaskSelection); // ДО Movement (D-032)
    s.register(Movement);
    // Держим день весь путь 5→2→1→0 (нужды не растим — Needs-система не в конвейере).
    for (let t = 0; t < 140; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      s.tickOnce(w);
    }
    expect(TSK.kind[eid]).toBe(TaskKind.WORK);
    expect(TSK.targetLoc[eid]).toBe(0);
    expect(POS.loc[eid]).toBe(0); // Movement довёз до рабочего места
    // Штамп причинности проставлен (task/selected → causeEvent), как у прочих задач.
    const sel = taskEvents(w, eid);
    expect(sel.length).toBeGreaterThanOrEqual(1);
    expect(TSK.causeEvent[eid]).toBe(sel[sel.length - 1]!.id);
  });

  it('на первом выборе WORK публикует task/selected и штампует Task.causeEvent', () => {
    const w = createSimWorld(302 as Seed);
    const eid = placeWorker(w, { loc: 0, home: 0, workplace: 0 });
    evalAt(w, DAY_TICK);
    const evs = taskEvents(w, eid);
    expect(evs).toHaveLength(1);
    expect((evs[0]!.payload as { kind: number }).kind).toBe(TaskKind.WORK);
    expect(TSK.causeEvent[eid]).toBe(evs[0]!.id);
  });
});

describe('WORK: нужды/страх/ночь перебивают смену (рационально)', () => {
  it('ГОЛОДНЫЙ работник с едой → EAT, не WORK (сначала поесть)', () => {
    const w = createSimWorld(310 as Seed);
    const eid = placeWorker(w, { loc: 0, home: 0, workplace: 0, hunger: 85, food: true });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);
  });

  it('работник В ОПАСНОСТИ (высокий страх) → FLEE, не WORK', () => {
    const w = createSimWorld(311 as Seed);
    const eid = placeWorker(w, { loc: 0, home: 0, workplace: 0, fear: 100 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.FLEE);
  });

  it('НОЧЬЮ работник спит, а не выходит на смену (WORK исключён из argmax)', () => {
    const w = createSimWorld(312 as Seed);
    const eid = placeWorker(w, { loc: 0, home: 0, workplace: 0 });
    evalAt(w, NIGHT_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.WORK);
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP); // спокоен ночью дома ⇒ сон
  });
});

describe('WORK недоступен без Job: поведение не-Job NPC не меняется (закон против регресса 2.4)', () => {
  it('тот же спокойный сталкер на loc0 БЕЗ Job → НЕ WORK (Job навешен ⇒ WORK)', () => {
    // Без Job: WORK исключён (−∞) ⇒ выбор из до-2.4 набора (fallback/DRINK/SLEEP).
    const wNo = createSimWorld(320 as Seed);
    const bare = placeStalker(wNo, { loc: 0, home: 0 });
    evalAt(wNo, DAY_TICK);
    const kindNoJob = TSK.kind[bare] as number;
    expect(kindNoJob).not.toBe(TaskKind.WORK);

    // С Job: РОВНО тот же старт → WORK. Значит дельта 2.4 замкнута на носителях Job.
    const wJob = createSimWorld(320 as Seed);
    const worker = placeWorker(wJob, { loc: 0, home: 0, workplace: 0 });
    evalAt(wJob, DAY_TICK);
    expect(TSK.kind[worker]).toBe(TaskKind.WORK);
  });

  it('мир БЕЗ единого Job: полный worldgen-прогон не порождает ни одной WORK-задачи', () => {
    const w = createSimWorld(321 as Seed);
    worldgen(w);
    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(TaskSelection);
    s.run(w, 300);
    for (const eid of queryEntities(w.ecs, [Human, Alive])) {
      expect(TSK.kind[eid]).not.toBe(TaskKind.WORK); // worldgen не навешивает Job
    }
  });
});

describe('WORK: детерминизм 2× и resume (Job + Task сериализуются)', () => {
  /** Мир с работником в Баре (workplace=Кордон) — WORK ведёт Movement мультихоп. */
  function buildWorkWorld(seed: number): SimWorld {
    const w = createSimWorld(seed as Seed);
    placeWorker(w, { loc: 5, home: 5, workplace: 0 });
    placeWorker(w, { loc: 0, home: 0, workplace: 0 }); // уже на месте
    placeStalker(w, { loc: 3, hunger: 90, survival: 0.6 }); // не-Job контроль
    return w;
  }
  function schedulerNT(): Scheduler {
    const s = createScheduler();
    s.register(NeedsSystem);
    s.register(TaskSelection);
    s.register(Movement);
    return s;
  }

  it('два прогона одного seed → идентичный хэш и лог task/selected', () => {
    function run(seed: number): { hash: string; log: unknown[] } {
      const w = buildWorkWorld(seed);
      const s = schedulerNT();
      for (let t = 0; t < 120; t++) {
        w.tick = (DAY_TICK + t) as Tick;
        s.tickOnce(w);
      }
      const log = w.bus.log
        .filter((e) => e.type === 'task/selected')
        .map((e) => ({ id: e.id, causedBy: e.causedBy, payload: e.payload }));
      return { hash: hashSnapshot(serialize(w)), log };
    }
    const a = run(330);
    const b = run(330);
    expect(a.hash).toBe(b.hash);
    expect(a.log).toEqual(b.log);
  });

  it('resume: непрерывный === split через save/load (Job+Task в снапшоте)', () => {
    const cont = buildWorkWorld(331);
    const contSched = schedulerNT();
    for (let t = 0; t < 120; t++) {
      cont.tick = (DAY_TICK + t) as Tick;
      contSched.tickOnce(cont);
    }

    const split = buildWorkWorld(331);
    const splitSched = schedulerNT();
    for (let t = 0; t < 60; t++) {
      split.tick = (DAY_TICK + t) as Tick;
      splitSched.tickOnce(split);
    }
    const restored = deserialize(serialize(split));
    const restoredSched = schedulerNT();
    for (let t = 60; t < 120; t++) {
      restored.tick = (DAY_TICK + t) as Tick;
      restoredSched.tickOnce(restored);
    }
    expect(hashSnapshot(serialize(restored))).toBe(hashSnapshot(serialize(cont)));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WORK ТАЙ-БРЕЙК ПО КОДУ (D-020): WORK=7 — ПОСЛЕДНИЙ код; на ТОЧНОМ равенстве
// проигрывает ЛЮБОЙ задаче 0..6. Фиксируем знаковый порядок: работа не «залипает».
// ───────────────────────────────────────────────────────────────────────────
describe('WORK: тай-брейк — WORK (код 7) на точном равенстве проигрывает меньшему коду', () => {
  // Дикая территория (loc4): danger 0.4 ⇒ safety=0.6, вода есть, дичи не селим.
  // Спокойный работник днём: WORK = W.work·safety·1 = 0.5·0.6 = 0.3 (needCalm=1).
  // DRINK = waterHere·W.water = 1·0.3 = 0.3 (thirst=0). 0.3 === 0.3 бит-в-бит
  // (проверено IEEE754: 0.5*0.6 === 1*0.3). Оба — глобальный максимум (SLEEP день
  // 0.18, FORAGE 0.155, REST 0.1). Побеждает DRINK (код 2 < WORK 7): работа —
  // ПОСЛЕДНЯЯ в массиве кандидатов и со строгим `>` не вытесняет равный максимум.
  it('WORK==DRINK (loc4, спокоен, день) → DRINK (меньший код), НЕ WORK', () => {
    const w = createSimWorld(340 as Seed);
    const eid = placeWorker(w, { loc: 4, home: 4, workplace: 4 }); // все нужды 0, еды нет, дичи нет
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.DRINK); // тай-брейк отдал победу коду 2
    expect(TSK.kind[eid]).not.toBe(TaskKind.WORK); // WORK (7) уступает на равенстве
  });

  it('детерминизм тай-брейка: 4 прогона того же среза → всегда DRINK (не «мигает» на WORK)', () => {
    for (let i = 0; i < 4; i++) {
      const w = createSimWorld((341 + i) as Seed);
      const eid = placeWorker(w, { loc: 4, home: 4, workplace: 4 });
      evalAt(w, DAY_TICK);
      expect(TSK.kind[eid]).toBe(TaskKind.DRINK);
    }
  });

  it('контраст: тот же спокойный работник на loc0 (safety 0.95) — WORK строго выше DRINK ⇒ WORK', () => {
    // На loc0 WORK=0.5·0.95=0.475 > DRINK 0.3: работа НЕ вообще-слабее, а именно на
    // ноже равенства уступает. Смещаем безопасность вверх — WORK честно побеждает.
    const w = createSimWorld(345 as Seed);
    const eid = placeWorker(w, { loc: 0, home: 0, workplace: 0 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.WORK);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// СМЕНА ДЕНЬ→НОЧЬ: работник днём WORK, ночью SLEEP — причинно, +1 событие на СМЕНЕ,
// не каждый тик; штамп перецеплен. «Рабочий день» замыкается сам, без расписания.
// ───────────────────────────────────────────────────────────────────────────
describe('WORK: суточный переход день→ночь замыкает смену в сон (причинно, D-032)', () => {
  it('день WORK → ночь SLEEP: ровно +1 task/selected на смене, causeEvent перештампован', () => {
    const w = createSimWorld(350 as Seed);
    const eid = placeWorker(w, { loc: 0, home: 0, workplace: 0 }); // спокоен, дома=рабочее место
    const sched = taskScheduler();

    // Дневная смена: несколько тиков подряд днём ⇒ один выбор WORK, дальше тишина.
    for (let i = 0; i < 5; i++) {
      w.tick = DAY_TICK;
      sched.tickOnce(w);
    }
    expect(TSK.kind[eid]).toBe(TaskKind.WORK);
    const dayEvents = taskEvents(w, eid);
    expect(dayEvents).toHaveLength(1); // стабильная смена не плодит событий (D-032)
    const workCause = TSK.causeEvent[eid];

    // Наступает ночь: WORK выпадает из argmax (−∞), спокойный дома → SLEEP.
    w.tick = NIGHT_TICK;
    sched.tickOnce(w);
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP);
    const afterNight = taskEvents(w, eid);
    expect(afterNight).toHaveLength(2); // РОВНО одно новое событие на переходе
    expect(TSK.causeEvent[eid]).toBe(afterNight[1]!.id); // штамп перецеплен на смену
    expect(TSK.causeEvent[eid]).not.toBe(workCause); // причина реально сменилась

    // Ночь продолжается: SLEEP держится, событий БОЛЬШЕ не публикуется (не каждый тик).
    for (let i = 0; i < 5; i++) {
      w.tick = NIGHT_TICK;
      sched.tickOnce(w);
    }
    expect(TSK.kind[eid]).toBe(TaskKind.SLEEP);
    expect(taskEvents(w, eid)).toHaveLength(2); // всё ещё 2 — ночь не перештамповывает

    // И обратно: рассвет возвращает на смену (WORK) — ещё +1 событие (симметрично).
    w.tick = DAY_TICK;
    sched.tickOnce(w);
    expect(TSK.kind[eid]).toBe(TaskKind.WORK);
    expect(taskEvents(w, eid)).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// РАБОТНИК ИЗДАЛЕКА: Movement ВЕДЁТ к workplace по рёбрам (не телепорт); пришёл —
// остаётся на смене (targetLoc==loc==workplace, dest осел). Работа — не latent idle.
// ───────────────────────────────────────────────────────────────────────────
describe('WORK: путь к рабочему месту идёт по рёбрам, по прибытии смена держится', () => {
  it('работник в Баре (loc5), workplace=Кордон(loc0): доходит мультихопом и ОСТАЁТСЯ работать', () => {
    const w = createSimWorld(360 as Seed);
    const eid = placeWorker(w, { loc: 5, home: 5, workplace: 0 });
    const s = createScheduler();
    s.register(TaskSelection);
    s.register(Movement);

    // Фиксируем перемещение ПО РЁБРАМ: собираем все посещённые loc из move/arrived.
    const visited: number[] = [];
    let prev = POS.loc[eid] as number;
    for (let t = 0; t < 140; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      s.tickOnce(w);
      const cur = POS.loc[eid] as number;
      if (cur !== prev) {
        // Шаг обязан быть по существующему ребру карты (не телепорт).
        expect(neighbors(prev as LocationId)).toContain(cur as LocationId);
        visited.push(cur);
        prev = cur;
      }
    }
    expect(POS.loc[eid]).toBe(0); // дошёл до рабочего места
    expect(visited[visited.length - 1]).toBe(0);
    expect(visited.length).toBeGreaterThanOrEqual(2); // реально шёл (мультихоп 5→2→1→0)

    // Пришёл — смена держится: цель==текущая==workplace, движение осело (dest==loc).
    expect(TSK.kind[eid]).toBe(TaskKind.WORK);
    expect(TSK.targetLoc[eid]).toBe(0);
    expect(POS.dest[eid]).toBe(POS.loc[eid]); // Movement no-op на месте (не latent idle)

    // Ещё тики на месте: остаётся WORK, новых task/selected нет (D-032).
    const before = taskEvents(w, eid).length;
    for (let t = 140; t < 160; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      s.tickOnce(w);
    }
    expect(TSK.kind[eid]).toBe(TaskKind.WORK);
    expect(taskEvents(w, eid).length).toBe(before); // осел — не перевыбирает
  });

  it('несколько работников с РАЗНЫМИ workplace: каждый доходит на СВОЁ место', () => {
    const w = createSimWorld(361 as Seed);
    const toKordon = placeWorker(w, { loc: 5, home: 5, workplace: 0 }); // 5→…→0
    const stayBar = placeWorker(w, { loc: 5, home: 5, workplace: 5 }); // уже на месте
    const toBar = placeWorker(w, { loc: 0, home: 0, workplace: 5 }); // 0→…→5
    const s = createScheduler();
    s.register(TaskSelection);
    s.register(Movement);
    for (let t = 0; t < 140; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      s.tickOnce(w);
    }
    expect(POS.loc[toKordon]).toBe(0);
    expect(POS.loc[stayBar]).toBe(5);
    expect(POS.loc[toBar]).toBe(5);
    for (const e of [toKordon, stayBar, toBar]) {
      expect(TSK.kind[e]).toBe(TaskKind.WORK);
      expect(TSK.targetLoc[e]).toBe(JOB.workplace[e]); // каждый на СВОЁМ рабочем месте
      expect(POS.loc[e]).toBe(JOB.workplace[e]);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ЭКОНОМ-ИНВАРИАНТ (закон №3): WORK-выбор и путь на смену НЕ двигают массу.
// TaskSelection/Movement публикуют только task/*, move/* — ни item/*, ни денег.
// ───────────────────────────────────────────────────────────────────────────
describe('WORK: смена не создаёт и не двигает предметы/деньги (закон №3)', () => {
  it('прогон работника на смену → в логе нет ни одного item/* события; money не тронут', () => {
    const w = createSimWorld(370 as Seed);
    const eid = placeWorker(w, { loc: 5, home: 5, workplace: 0 });
    w.resources.set<number>('money', eid, 250);
    const s = createScheduler();
    s.register(TaskSelection);
    s.register(Movement);
    for (let t = 0; t < 140; t++) {
      w.tick = (DAY_TICK + t) as Tick;
      s.tickOnce(w);
    }
    expect(TSK.kind[eid]).toBe(TaskKind.WORK);
    const itemEvents = w.bus.log.filter((e) => e.type.startsWith('item/'));
    expect(itemEvents).toHaveLength(0); // выбор задачи/ходьба не леджерят предметы
    expect(w.resources.get<number>('money', eid)).toBe(250); // деньги не сдвинулись
    // Все события прогона — только про распорядок и перемещение (не про массу).
    const types = new Set(w.bus.log.map((e) => e.type));
    for (const t of types) {
      expect(t.startsWith('task/') || t.startsWith('move/')).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRADE (задача 2.6): выбор НАМЕРЕНИЯ торговать из состояния инвентаря + обстановки.
// Причинно (закон №2): повод — нехватка эссеншелов ИЛИ избыток на сбыт; гейт
// safety·needCalm как у WORK; ночь и отсутствие поселений исключают TRADE (−∞).
// ═══════════════════════════════════════════════════════════════════════════

/** Единица инвентаря для тестов (форма worldgen/Trade). */
interface InvEntry {
  readonly item: string;
  readonly qty: number;
}

/** Селит сущность-поселение (Settlement + Position) в локации `loc` — цель TRADE. */
function placeSettlement(world: SimWorld, loc: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  addComponent(world.ecs, Settlement, eid);
  return eid;
}

/** Ставит инвентарь NPC напрямую (обход food-хелпера placeStalker). */
function setInv(world: SimWorld, eid: EntityId, inv: readonly InvEntry[]): void {
  world.resources.set('inventory', eid, inv);
}

/** Сбалансированный инвентарь БЕЗ повода: еда==keep, патроны==keep, ничего лишнего. */
const BALANCED_INV: readonly InvEntry[] = [
  { item: 'canned', qty: 4 }, // food: keep=4 ⇒ ни нехватки (≥2), ни избытка (не >4)
  { item: 'ammo_9mm', qty: 16 }, // ammo: keep=16 ⇒ ни нехватки (≥8), ни избытка (не >16)
];
/** Тот же баланс + один артефакт (kind без резерва ⇒ ЛЮБОЙ qty = избыток на сбыт). */
const SURPLUS_INV: readonly InvEntry[] = [
  { item: 'canned', qty: 4 },
  { item: 'ammo_9mm', qty: 16 },
  { item: 'artifact_medusa', qty: 1 }, // избыток (reserve 0) ⇒ ПОВОД торговать
];

describe('TRADE: намерение торговать выводится из инвентаря и обстановки (закон №2)', () => {
  it('спокойный NPC днём с ИЗБЫТКОМ у поселения → TRADE, target = поселение (на месте)', () => {
    const w = createSimWorld(400 as Seed);
    placeSettlement(w, 0); // Кордон (safety 0.95)
    const eid = placeStalker(w, { loc: 0, home: 0 }); // все нужды 0, спокоен
    setInv(w, eid, SURPLUS_INV);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.TRADE);
    expect(TSK.targetLoc[eid]).toBe(0); // поселение на текущей loc ⇒ Movement no-op
    expect(TSK.targetEid[eid]).toBe(0); // Trade находит поселение по loc, targetEid не нужен
  });

  it('спрос на эссеншелы (мало еды/патронов) — тоже повод: спокойный NPC → TRADE', () => {
    const w = createSimWorld(401 as Seed);
    placeSettlement(w, 0);
    const eid = placeStalker(w, { loc: 0, home: 0 });
    setInv(w, eid, [{ item: 'ammo_9mm', qty: 2 }]); // ammo 2 < ESSENTIAL_AMMO_MIN(8), еды 0 < 2
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.TRADE);
  });

  it('НЕТ повода (баланс эссеншелов, ничего лишнего) → НЕ TRADE (sTrade=−∞)', () => {
    const w = createSimWorld(402 as Seed);
    placeSettlement(w, 0);
    const eid = placeStalker(w, { loc: 0, home: 0 });
    setInv(w, eid, BALANCED_INV);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.TRADE); // торговать незачем — не идём «в пустоту»
  });

  it('контраст повода на ОДНОМ срезе: +артефакт превращает НЕ-TRADE в TRADE', () => {
    // Тот же спокойный NPC у поселения: с BALANCED — не торгует, с SURPLUS — торгует.
    // Доказывает, что решает ИМЕННО повод из инвентаря, а не прочая обстановка.
    const wNo = createSimWorld(403 as Seed);
    placeSettlement(wNo, 0);
    const noReason = placeStalker(wNo, { loc: 0, home: 0 });
    setInv(wNo, noReason, BALANCED_INV);
    evalAt(wNo, DAY_TICK);
    expect(TSK.kind[noReason]).not.toBe(TaskKind.TRADE);

    const wYes = createSimWorld(403 as Seed);
    placeSettlement(wYes, 0);
    const withReason = placeStalker(wYes, { loc: 0, home: 0 });
    setInv(wYes, withReason, SURPLUS_INV);
    evalAt(wYes, DAY_TICK);
    expect(TSK.kind[withReason]).toBe(TaskKind.TRADE);
  });

  it('НЕТ поселений в мире → TRADE недостижим (sTrade=−∞), даже при явном избытке', () => {
    const w = createSimWorld(404 as Seed);
    // Поселение НЕ создаём: settlementLocs пусто ⇒ nearestLoc был бы null (D-026).
    const eid = placeStalker(w, { loc: 0, home: 0 });
    setInv(w, eid, SURPLUS_INV);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.TRADE);
  });

  it('КРИТИЧЕСКАЯ нужда гасит TRADE: голодный с едой у поселения → EAT, не TRADE', () => {
    const w = createSimWorld(405 as Seed);
    placeSettlement(w, 0);
    // Повод торговать есть (артефакт), но голод у потолка ⇒ needCalm→0 гасит TRADE,
    // а EAT растёт с голодом. Выживание вперёд торговли.
    const eid = placeStalker(w, { loc: 0, home: 0, hunger: 92, food: true });
    setInv(w, eid, [{ item: 'canned', qty: 2 }, { item: 'artifact_medusa', qty: 1 }]);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);
    expect(TSK.kind[eid]).not.toBe(TaskKind.TRADE);
  });

  it('НОЧЬЮ TRADE исключён (рынок закрыт): тот же повод днём→TRADE, ночью→НЕ TRADE', () => {
    const wDay = createSimWorld(406 as Seed);
    placeSettlement(wDay, 0);
    const day = placeStalker(wDay, { loc: 0, home: 0 });
    setInv(wDay, day, SURPLUS_INV);
    evalAt(wDay, DAY_TICK);
    expect(TSK.kind[day]).toBe(TaskKind.TRADE);

    const wNight = createSimWorld(406 as Seed);
    placeSettlement(wNight, 0);
    const night = placeStalker(wNight, { loc: 0, home: 0 });
    setInv(wNight, night, SURPLUS_INV);
    evalAt(wNight, NIGHT_TICK);
    expect(TSK.kind[night]).not.toBe(TaskKind.TRADE); // ночью не выходит торговать
  });

  it('targetLoc = БЛИЖАЙШЕЕ поселение: NPC у loc3, поселения в 5(рядом) и 0(дальше) → цель 5', () => {
    const w = createSimWorld(407 as Seed);
    placeSettlement(w, 5); // Бар — сосед loc3 (1 хоп)
    placeSettlement(w, 0); // Кордон — дальше (loc3→1→0)
    const eid = placeStalker(w, { loc: 3, home: 3 }); // спокоен, нужды 0
    setInv(w, eid, SURPLUS_INV);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.TRADE);
    expect(TSK.targetLoc[eid]).toBe(5); // ближайшее по edgeLen поселение (не текущая loc)
    expect(TSK.targetLoc[eid]).not.toBe(3); // цель ≠ текущая ⇒ Movement реально ведёт (не latent idle)
  });

  it('смена задачи на TRADE публикует task/selected (kind=TRADE) и штампует Task.causeEvent', () => {
    const w = createSimWorld(408 as Seed);
    placeSettlement(w, 0);
    const eid = placeStalker(w, { loc: 0, home: 0 });
    setInv(w, eid, SURPLUS_INV);
    evalAt(w, DAY_TICK);
    const evs = taskEvents(w, eid);
    expect(evs).toHaveLength(1);
    expect((evs[0]!.payload as { kind: number }).kind).toBe(TaskKind.TRADE);
    expect((evs[0]!.payload as { targetLoc: number }).targetLoc).toBe(0);
    expect(TSK.causeEvent[eid]).toBe(evs[0]!.id); // штамп причинности (D-030)
  });

  it('детерминизм: TRADE-срез, 3 прогона одного seed → идентичный выбор и цель', () => {
    for (let i = 0; i < 3; i++) {
      const w = createSimWorld(409 as Seed);
      placeSettlement(w, 5);
      placeSettlement(w, 0);
      const eid = placeStalker(w, { loc: 3, home: 3 });
      setInv(w, eid, SURPLUS_INV);
      evalAt(w, DAY_TICK);
      expect(TSK.kind[eid]).toBe(TaskKind.TRADE);
      expect(TSK.targetLoc[eid]).toBe(5);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH (задача 2.10): поход за артефактом. Причинно (закон №2): цель есть ТОЛЬКО
// при ДОСТИЖИМОМ аномальном поле, на луте которого ФИЗИЧЕСКИ лежит артефакт. Гейт
// safety·needCalm как у WORK/TRADE; ночь/критическая нужда/отсутствие поля → −∞.
// ═══════════════════════════════════════════════════════════════════════════

/** Селит аномальное поле (AnomalyField+Position) в `loc` с артефактом на луте. */
function placeArtifactField(world: SimWorld, loc: number, artifact = 'artifact_medusa'): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  addComponent(world.ecs, AnomalyField, eid);
  world.resources.set('inventory', eid, [{ item: artifact, qty: 1 }]);
  return eid;
}

/** Селит аномальное поле БЕЗ артефакта (пустой лут) — не цель SEARCH. */
function placeEmptyField(world: SimWorld, loc: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  addComponent(world.ecs, AnomalyField, eid);
  return eid; // инвентарь НЕ ставим — лут пуст
}

describe('SEARCH: намерение искать артефакт выводится из состояния поля (закон №2)', () => {
  it('спокойный NPC днём у поля С артефактом → SEARCH, target = поле (на месте)', () => {
    const w = createSimWorld(500 as Seed);
    placeArtifactField(w, 0); // Кордон (safety 0.95)
    const eid = placeStalker(w, { loc: 0, home: 0 }); // все нужды 0, спокоен
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.SEARCH);
    expect(TSK.targetLoc[eid]).toBe(0); // поле на текущей loc ⇒ Movement no-op
    expect(TSK.targetEid[eid]).toBe(0); // ArtifactSearch находит поле по loc, targetEid не нужен
  });

  it('поле БЕЗ артефакта (пустой лут) → НЕ SEARCH (искать нечего, sSearch=−∞)', () => {
    const w = createSimWorld(501 as Seed);
    placeEmptyField(w, 0); // поле есть, но лут пуст
    const eid = placeStalker(w, { loc: 0, home: 0 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.SEARCH);
  });

  it('НЕТ полей в мире → SEARCH недостижим (sSearch=−∞)', () => {
    const w = createSimWorld(502 as Seed);
    const eid = placeStalker(w, { loc: 0, home: 0 });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.SEARCH);
  });

  it('контраст на ОДНОМ срезе: артефакт на луте превращает НЕ-SEARCH в SEARCH', () => {
    // Тот же спокойный NPC у поля: пустое поле — не ищет, с артефактом — ищет.
    // Доказывает, что решает ИМЕННО лут поля, а не прочая обстановка.
    const wNo = createSimWorld(503 as Seed);
    placeEmptyField(wNo, 0);
    const noReason = placeStalker(wNo, { loc: 0, home: 0 });
    evalAt(wNo, DAY_TICK);
    expect(TSK.kind[noReason]).not.toBe(TaskKind.SEARCH);

    const wYes = createSimWorld(503 as Seed);
    placeArtifactField(wYes, 0);
    const withReason = placeStalker(wYes, { loc: 0, home: 0 });
    evalAt(wYes, DAY_TICK);
    expect(TSK.kind[withReason]).toBe(TaskKind.SEARCH);
  });

  it('КРИТИЧЕСКАЯ нужда гасит SEARCH: голодный с едой у поля с артефактом → EAT, не SEARCH', () => {
    const w = createSimWorld(504 as Seed);
    placeArtifactField(w, 0);
    // Поле с артефактом рядом, но голод у потолка ⇒ needCalm→0 гасит SEARCH,
    // а EAT растёт с голодом. Выживание вперёд хабара.
    const eid = placeStalker(w, { loc: 0, home: 0, hunger: 92, food: true });
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.EAT);
    expect(TSK.kind[eid]).not.toBe(TaskKind.SEARCH);
  });

  it('НОЧЬЮ SEARCH исключён: тот же артефакт днём→SEARCH, ночью→НЕ SEARCH', () => {
    const wDay = createSimWorld(505 as Seed);
    placeArtifactField(wDay, 0);
    const day = placeStalker(wDay, { loc: 0, home: 0 });
    evalAt(wDay, DAY_TICK);
    expect(TSK.kind[day]).toBe(TaskKind.SEARCH);

    const wNight = createSimWorld(505 as Seed);
    placeArtifactField(wNight, 0);
    const night = placeStalker(wNight, { loc: 0, home: 0 });
    evalAt(wNight, NIGHT_TICK);
    expect(TSK.kind[night]).not.toBe(TaskKind.SEARCH); // ночью в аномалию не лезет
  });

  it('targetLoc = БЛИЖАЙШЕЕ поле: NPC у loc3, поля в 5(рядом) и 0(дальше) → цель 5', () => {
    const w = createSimWorld(506 as Seed);
    placeArtifactField(w, 5); // Бар — сосед loc3 (1 хоп)
    placeArtifactField(w, 0); // Кордон — дальше (loc3→1→0)
    const eid = placeStalker(w, { loc: 3, home: 3 }); // спокоен, нужды 0
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.SEARCH);
    expect(TSK.targetLoc[eid]).toBe(5); // ближайшее по edgeLen поле (не текущая loc)
    expect(TSK.targetLoc[eid]).not.toBe(3); // цель ≠ текущая ⇒ Movement реально ведёт
  });

  it('TRADE сильнее SEARCH у спокойного NPC: поле с артефактом И поселение с поводом → TRADE (D-066)', () => {
    // 2.16c (D-066): W.trade(0.75) > W.search(0.7) при равном гейте safety·needCalm.
    // Диагноз здоровья мира: при search>trade спокойный NPC, УЖЕ несущий артефакт
    // (повод торговать — избыток), уходил за ЕЩЁ артефактом вместо сбыта, хабар копился
    // в инвентарях и НЕ доходил до склада ⇒ money-faucet (Export) не файрил. Инвертировав
    // порядок, замыкаем монетизацию: есть повод сбыть — сначала неси ПРОДАТЬ. NPC без
    // повода торговать (canTrade=false) по-прежнему ИЩЕТ (см. тесты ниже). См. utility.ts.
    const w = createSimWorld(507 as Seed);
    placeArtifactField(w, 0);
    placeSettlement(w, 0);
    const eid = placeStalker(w, { loc: 0, home: 0 });
    setInv(w, eid, SURPLUS_INV); // повод торговать → сбыт бьёт новую вылазку за хабаром
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.TRADE); // доставка/сбыт бьёт жадность (D-066)
  });

  it('смена задачи на SEARCH публикует task/selected (kind=SEARCH) и штампует Task.causeEvent', () => {
    const w = createSimWorld(508 as Seed);
    placeArtifactField(w, 0);
    const eid = placeStalker(w, { loc: 0, home: 0 });
    evalAt(w, DAY_TICK);
    const evs = taskEvents(w, eid);
    expect(evs).toHaveLength(1);
    expect((evs[0]!.payload as { kind: number }).kind).toBe(TaskKind.SEARCH);
    expect((evs[0]!.payload as { targetLoc: number }).targetLoc).toBe(0);
    expect(TSK.causeEvent[eid]).toBe(evs[0]!.id); // штамп причинности (D-030)
  });

  it('детерминизм: SEARCH-срез, 3 прогона одного seed → идентичный выбор и цель', () => {
    for (let i = 0; i < 3; i++) {
      const w = createSimWorld(509 as Seed);
      placeArtifactField(w, 5);
      placeArtifactField(w, 0);
      const eid = placeStalker(w, { loc: 3, home: 3 });
      evalAt(w, DAY_TICK);
      expect(TSK.kind[eid]).toBe(TaskKind.SEARCH);
      expect(TSK.targetLoc[eid]).toBe(5);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ГРАБЁЖ (ROB, задача 2.12, D-049/D-062)
// ═══════════════════════════════════════════════════════════════════════════

/** Ставит фракцию/профессию NPC (наблюдаемые «холодные» данные, D-007). */
function setRole(world: SimWorld, eid: EntityId, faction: string, profession = 'stalker'): void {
  world.resources.set<FactionId>('faction', eid, faction as FactionId);
  world.resources.set<string>('profession', eid, profession);
}

/** Список видимых контактов наблюдателя (сорт. по target — как пишет Perception). */
function setContacts(world: SimWorld, observer: EntityId, targets: readonly EntityId[]): void {
  const cs: Contact[] = targets
    .slice()
    .sort((a, b) => a - b)
    .map((t) => ({ target: t, spottedEvent: 0 }));
  world.resources.set<Contact[]>('contacts', observer, cs);
}

/** Кладёт оружие (pm) в инвентарь цели — делает её ВООРУЖЁННОЙ (видимое снаряжение). */
function armWith(world: SimWorld, eid: EntityId, extra: ReadonlyArray<{ item: string; qty: number }> = []): void {
  world.resources.set('inventory', eid, [{ item: 'pm', qty: 1 }, ...extra]);
}

describe('ROB: гейт хищной диспозиции + утилити-грабёж (D-049/D-062)', () => {
  it('бандит + слабый одиночка-loner в поле зрения → выбирает ROB (цель = жертва)', () => {
    const w = createSimWorld(700 as Seed);
    const bandit = placeStalker(w, { loc: 0, home: 0, hunger: 0, thirst: 0, fatigue: 0, fear: 0 });
    setRole(w, bandit, 'bandits');
    const victim = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, victim, 'loners');
    setContacts(w, bandit, [victim]);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[bandit]).toBe(TaskKind.ROB);
    expect(TSK.targetEid[bandit]).toBe(victim);
    expect(TSK.targetLoc[bandit]).toBe(0); // жертва co-located
    // task/selected опубликован при смене задачи + штамп причинности (D-030/D-032).
    const evs = taskEvents(w, bandit);
    expect(evs).toHaveLength(1);
    expect((evs[0]!.payload as { kind: number }).kind).toBe(TaskKind.ROB);
    expect((evs[0]!.payload as { targetEid: number }).targetEid).toBe(victim);
    expect(TSK.causeEvent[bandit]).toBe(evs[0]!.id);
  });

  it('НЕ-бандит (loner) с той же жирной целью в поле зрения → sRob=−∞, НЕ грабит', () => {
    const w = createSimWorld(701 as Seed);
    const loner = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, loner, 'loners');
    const victim = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, victim, 'loners');
    setContacts(w, loner, [victim]);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[loner]).not.toBe(TaskKind.ROB);
  });

  it('бандит + ГРУППА (цель + 2 союзника в локации) → targetStrength высок, НЕ грабит', () => {
    const w = createSimWorld(702 as Seed);
    const bandit = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, bandit, 'bandits');
    const victim = placeStalker(w, { loc: 0, home: 0 });
    const ally1 = placeStalker(w, { loc: 0, home: 0 });
    const ally2 = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, victim, 'loners');
    setRole(w, ally1, 'loners');
    setRole(w, ally2, 'loners');
    setContacts(w, bandit, [victim]);
    evalAt(w, DAY_TICK);
    // Со-локейт союзники поднимают силу цели → sRob < fallback ⇒ ROB не выбран.
    expect(TSK.kind[bandit]).not.toBe(TaskKind.ROB);
  });

  it('одиночка грабится, а та же цель В ГРУППЕ — нет (эмерджентный обход групп)', () => {
    // Одиночка.
    const wa = createSimWorld(703 as Seed);
    const ba = placeStalker(wa, { loc: 0, home: 0 });
    setRole(wa, ba, 'bandits');
    const va = placeStalker(wa, { loc: 0, home: 0 });
    setRole(wa, va, 'loners');
    setContacts(wa, ba, [va]);
    evalAt(wa, DAY_TICK);
    expect(TSK.kind[ba]).toBe(TaskKind.ROB);
    // Та же цель, но с 2 союзниками рядом.
    const wb = createSimWorld(703 as Seed);
    const bb = placeStalker(wb, { loc: 0, home: 0 });
    setRole(wb, bb, 'bandits');
    const vb = placeStalker(wb, { loc: 0, home: 0 });
    const al1 = placeStalker(wb, { loc: 0, home: 0 });
    const al2 = placeStalker(wb, { loc: 0, home: 0 });
    setRole(wb, vb, 'loners');
    setRole(wb, al1, 'loners');
    setRole(wb, al2, 'loners');
    setContacts(wb, bb, [vb]);
    evalAt(wb, DAY_TICK);
    expect(TSK.kind[bb]).not.toBe(TaskKind.ROB);
  });

  it('relationPenalty: положительное отношение к цели (союзник) гасит грабёж', () => {
    const w = createSimWorld(704 as Seed);
    const bandit = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, bandit, 'bandits');
    const friend = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, friend, 'loners');
    setContacts(w, bandit, [friend]);
    // Бандит ЛИЧНО расположен к цели (субстрат 2.15) → штраф гасит sRob.
    setRelation(w.resources, bandit, entitySubject(friend), 0.9);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[bandit]).not.toBe(TaskKind.ROB);
  });

  it('анти-чит: lootProxy идёт по РОЛИ, а НЕ по инвентарю жертвы', () => {
    // Борговая ситуация: цель вооружена, полна hp, с 1 союзником — базовой добычи
    // (обычный сталкер) НЕ хватает перебить риск, а торговой (роль) — хватает.
    // Богатый инвентарь у сталкера НЕ поднимает sRob (иначе AI читал бы чужой карман).

    // (A) СТАЛКЕР с ЖИРНЫМ инвентарём (артефакты) → НЕ грабится (карман не виден).
    const wa = createSimWorld(705 as Seed);
    const ba = placeStalker(wa, { loc: 0, home: 0 });
    setRole(wa, ba, 'bandits');
    const richStalker = placeStalker(wa, { loc: 0, home: 0 });
    setRole(wa, richStalker, 'loners', 'stalker');
    SKILL.shooting[richStalker] = 0.8;
    armWith(wa, richStalker, [{ item: 'artifact_moonlight', qty: 5 }]); // жирный, но невидимый куш
    const allyA = placeStalker(wa, { loc: 0, home: 0 });
    setRole(wa, allyA, 'loners');
    setContacts(wa, ba, [richStalker]);
    evalAt(wa, DAY_TICK);
    expect(TSK.kind[ba]).not.toBe(TaskKind.ROB);

    // (B) ТОРГОВЕЦ с ПУСТЫМ (только оружие) инвентарём → грабится (роль видна).
    const wb = createSimWorld(705 as Seed);
    const bb = placeStalker(wb, { loc: 0, home: 0 });
    setRole(wb, bb, 'bandits');
    const poorTrader = placeStalker(wb, { loc: 0, home: 0 });
    setRole(wb, poorTrader, 'loners', 'trader');
    SKILL.shooting[poorTrader] = 0.8;
    armWith(wb, poorTrader); // то же снаряжение (оружие), без хабара
    const allyB = placeStalker(wb, { loc: 0, home: 0 });
    setRole(wb, allyB, 'loners');
    setContacts(wb, bb, [poorTrader]);
    evalAt(wb, DAY_TICK);
    expect(TSK.kind[bb]).toBe(TaskKind.ROB);
    expect(TSK.targetEid[bb]).toBe(poorTrader);
  });

  it('цель вне видимости (в соседней локации, не co-located) → sRob=−∞, НЕ грабит', () => {
    const w = createSimWorld(706 as Seed);
    const bandit = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, bandit, 'bandits');
    // loc1 — сосед loc0; жертва «на подходе» в контактах, но НЕ co-located.
    const victim = placeStalker(w, { loc: 1, home: 1 });
    setRole(w, victim, 'loners');
    setContacts(w, bandit, [victim]);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[bandit]).not.toBe(TaskKind.ROB);
  });

  it('бандит БЕЗ контактов (никого не видит) → sRob=−∞, НЕ грабит (не idle: fallback)', () => {
    const w = createSimWorld(707 as Seed);
    const bandit = placeStalker(w, { loc: 7, home: 7 }); // loc7 без воды/дичи ⇒ fallback
    setRole(w, bandit, 'bandits');
    evalAt(w, DAY_TICK);
    expect(TSK.kind[bandit]).not.toBe(TaskKind.ROB);
    expect([TaskKind.FORAGE, TaskKind.REST]).toContain(TSK.kind[bandit] as number);
  });

  it('бандит НЕ грабит цель ХИЩНОЙ фракции (своего-бандита)', () => {
    const w = createSimWorld(708 as Seed);
    const bandit = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, bandit, 'bandits');
    const other = placeStalker(w, { loc: 0, home: 0 });
    setRole(w, other, 'bandits'); // тоже хищник ⇒ не цель
    setContacts(w, bandit, [other]);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[bandit]).not.toBe(TaskKind.ROB);
  });

  it('детерминизм: ROB-срез, 3 прогона одного seed → идентичная цель', () => {
    for (let i = 0; i < 3; i++) {
      const w = createSimWorld(709 as Seed);
      const bandit = placeStalker(w, { loc: 0, home: 0 });
      setRole(w, bandit, 'bandits');
      const v1 = placeStalker(w, { loc: 0, home: 0 });
      const v2 = placeStalker(w, { loc: 0, home: 0 });
      // Разные не-хищные фракции ⇒ не союзники друг другу (по 0 союзников) ⇒ равные sRob.
      setRole(w, v1, 'loners');
      setRole(w, v2, 'military');
      setContacts(w, bandit, [v1, v2]);
      evalAt(w, DAY_TICK);
      expect(TSK.kind[bandit]).toBe(TaskKind.ROB);
      // Равные оценки → меньший eid (v1) детерминированно (закон №8).
      expect(TSK.targetEid[bandit]).toBe(v1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ ОБХОДА (задача 2.13, D-050/D-063): часть B перекрывала HUNT/FLEE — здесь
// закрываем ОСТАЛЬНЫЕ виды целей (DRINK/TRADE/SEARCH: «иная цель того же вида»),
// тупик FLEE (все соседи избегаемы → деградация, не idle), no-op на НЕ-кандидатной
// avoid-записи (голдены целы) и полный цикл «ограбление → обход → затухание → возврат»
// сквозь РЕАЛЬНЫЕ RobberyMemory + MemoryDecay. Сценарии — истории Зоны: «где сталкер
// пил воду, его обчистили — куда он пойдёт пить теперь и когда вернётся к роднику?».
// ═══════════════════════════════════════════════════════════════════════════

const FAR_UNTIL = 10_000_000; // обход активен на любом тестовом тике

/** Ctx для прямого вызова системы памяти/затухания на тике `tick`. */
function sysCtxAt(world: SimWorld, tick: number): SystemCtx {
  world.tick = tick as Tick;
  return { world, bus: world.bus, rng: world.rng.fork(`sys@${tick}`), tick: tick as Tick };
}

describe('обход DRINK: избегаемый ближайший источник воды ⇒ путь к следующему', () => {
  it('жажда в loc3 без воды: обход Бара(5) уводит DRINK на Дикую территорию(4)', () => {
    const w = createSimWorld(30 as Seed);
    // loc3 без воды; ближайшая вода — Бар(5, 40), затем Дикая(4, 55).
    const eid = placeStalker(w, { loc: 3, thirst: 95, fatigue: 0, survival: 0 });

    // Контроль: без обхода DRINK ведёт к ближайшей воде — Бар(5).
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.DRINK);
    expect(TSK.targetLoc[eid]).toBe(5);

    // Обход Бара(5) ⇒ DRINK перецеливается на следующую по стоимости воду — loc4.
    addAvoid(w.resources, eid, 5, FAR_UNTIL);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.DRINK); // всё ещё пьёт — жажда не ушла
    expect(TSK.targetLoc[eid]).toBe(4); // иной источник того же вида (обход воды)
    expect(TSK.targetLoc[eid]).not.toBe(5);
  });
});

describe('обход TRADE: избегаемое ближайшее поселение ⇒ торг в другом', () => {
  it('NPC у loc3 с избытком: обход Бара(5) уводит TRADE в Кордон(0)', () => {
    const w = createSimWorld(31 as Seed);
    placeSettlement(w, 5); // Бар — сосед loc3 (40)
    placeSettlement(w, 0); // Кордон — дальше (3→1→0 = 90)
    const eid = placeStalker(w, { loc: 3, home: 3 });
    setInv(w, eid, SURPLUS_INV);

    // Контроль: без обхода TRADE идёт в ближайшее поселение — Бар(5).
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.TRADE);
    expect(TSK.targetLoc[eid]).toBe(5);

    // Обход Бара ⇒ TRADE перецеливается на Кордон(0) — сбыть тот же излишек, но в обход.
    addAvoid(w.resources, eid, 5, FAR_UNTIL);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.TRADE);
    expect(TSK.targetLoc[eid]).toBe(0);
  });

  it('единственное поселение избегаемо ⇒ TRADE недостижим (−∞), выбор иной задачи', () => {
    const w = createSimWorld(32 as Seed);
    placeSettlement(w, 5); // единственный рынок — сосед loc3
    const eid = placeStalker(w, { loc: 3, home: 3 });
    setInv(w, eid, SURPLUS_INV);

    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.TRADE); // контроль: торгует

    addAvoid(w.resources, eid, 5, FAR_UNTIL);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.TRADE); // некуда торговать → другая задача (не idle)
    expect(hasComponent(w.ecs, Task, eid)).toBe(true);
  });
});

describe('обход SEARCH: избегаемое ближайшее аномальное поле ⇒ поход к другому', () => {
  it('NPC у loc3: обход поля в Баре(5) уводит SEARCH к полю в Кордоне(0)', () => {
    const w = createSimWorld(33 as Seed);
    placeArtifactField(w, 5); // ближе (сосед loc3)
    placeArtifactField(w, 0); // дальше
    const eid = placeStalker(w, { loc: 3, home: 3 });

    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.SEARCH);
    expect(TSK.targetLoc[eid]).toBe(5);

    addAvoid(w.resources, eid, 5, FAR_UNTIL);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.SEARCH);
    expect(TSK.targetLoc[eid]).toBe(0); // иное поле того же вида (обход хабара)
  });

  it('единственное поле избегаемо ⇒ SEARCH недостижим (−∞), не idle', () => {
    const w = createSimWorld(34 as Seed);
    placeArtifactField(w, 5);
    const eid = placeStalker(w, { loc: 3, home: 3 });

    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).toBe(TaskKind.SEARCH);

    addAvoid(w.resources, eid, 5, FAR_UNTIL);
    evalAt(w, DAY_TICK);
    expect(TSK.kind[eid]).not.toBe(TaskKind.SEARCH);
    expect(hasComponent(w.ecs, Task, eid)).toBe(true);
  });
});

describe('обход FLEE: ТУПИК (все соседи избегаемы) ⇒ деградация к бегству, НЕ idle (закон №4)', () => {
  it('паника в loc3, обход ВСЕХ соседей {1,4,5} ⇒ всё равно FLEE к безопаснейшему (5)', () => {
    const w = createSimWorld(35 as Seed);
    // loc3 соседи {1(.25),4(.4),5(.1)}; safest = 5.
    const eid = placeStalker(w, { loc: 3, fear: 100, survival: 0 });
    addAvoid(w.resources, eid, 1, FAR_UNTIL);
    addAvoid(w.resources, eid, 4, FAR_UNTIL);
    addAvoid(w.resources, eid, 5, FAR_UNTIL);

    evalAt(w, DAY_TICK);
    // Тупик обхода: выживание важнее обхода — не стоит столбом, бежит к безопаснейшему.
    expect(TSK.kind[eid]).toBe(TaskKind.FLEE);
    expect(TSK.targetLoc[eid]).toBe(5); // деградация к выбору БЕЗ фильтра (safestNeighbor)
    expect(TSK.targetLoc[eid]).not.toBe(3); // цель ≠ текущая ⇒ Movement реально уведёт
  });
});

describe('обход no-op: avoid на НЕ-кандидатной локации не меняет выбор (голдены целы)', () => {
  it('avoid далёкой loc9 (не цель HUNT) ⇒ тот же выбор/цель и та же полезная нагрузка события', () => {
    /** HUNT-срез: голодный в loc1, дичь в 2 и 3; ближайшая — loc2. */
    function huntChoice(withIrrelevantAvoid: boolean): { kind: number; targetLoc: number; targetEid: number; ev: unknown } {
      const w = createSimWorld(36 as Seed);
      const eid = placeStalker(w, { loc: 1, hunger: 90, food: false, survival: 0.7 });
      placeAnimal(w, 2);
      placeAnimal(w, 3);
      // Обход на loc9 (Саркофаг) — НЕ кандидат охоты (дичь в 2/3). Не должен влиять.
      if (withIrrelevantAvoid) addAvoid(w.resources, eid, 9, FAR_UNTIL);
      evalAt(w, DAY_TICK);
      const ev = w.bus.log
        .filter((e) => e.type === 'task/selected' && (e.payload as { eid: number }).eid === eid)
        .map((e) => e.payload);
      return { kind: TSK.kind[eid] as number, targetLoc: TSK.targetLoc[eid] as number, targetEid: TSK.targetEid[eid] as number, ev };
    }
    const clean = huntChoice(false);
    const irrelevant = huntChoice(true);
    // Выбор задачи/цель/жертва и полезная нагрузка task/selected — идентичны.
    expect(irrelevant.kind).toBe(clean.kind);
    expect(irrelevant.kind).toBe(TaskKind.HUNT);
    expect(irrelevant.targetLoc).toBe(clean.targetLoc);
    expect(irrelevant.targetLoc).toBe(2); // ближайшая дичь — прежняя, обход loc9 не сместил
    expect(irrelevant.targetEid).toBe(clean.targetEid);
    expect(irrelevant.ev).toEqual(clean.ev);
  });
});

describe('обход полный цикл: ограбление → обход → затухание (MemoryDecay) → возврат к цели', () => {
  it('RobberyMemory метит место охоты; NPC огибает его; по сроку MemoryDecay снимает — NPC возвращается', () => {
    const w = createSimWorld(37 as Seed);
    // Жертва — голодный охотник в loc1; дичь в соседних 2(ближе) и 3.
    const victim = placeStalker(w, { loc: 1, hunger: 90, food: false, survival: 0.7 });
    placeAnimal(w, 2);
    placeAnimal(w, 3);
    // Грабитель (для faction-отношения; сам в грабеже участия здесь не принимает).
    const robber = spawnEntity(w.ecs);
    addComponent(w.ecs, Human, robber);
    addComponent(w.ecs, Alive, robber);
    w.resources.set<FactionId>('faction', robber, 'bandits' as FactionId);

    // (1) БАЗА: без обхода охотник идёт на ближайшую дичь — loc2.
    evalAt(w, DAY_TICK);
    expect(TSK.kind[victim]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[victim]).toBe(2);

    // (2) ОГРАБЛЕНИЕ в loc2 на тике 600 (tod=день ⇒ и срок истечёт в день, см. ниже);
    // RobberyMemory на 601 читает закоммиченный loot/transferred и метит loc2 обходом.
    const ROB_TICK = 600;
    w.tick = ROB_TICK as Tick;
    w.bus.publish({
      type: 'loot/transferred',
      causedBy: null,
      payload: { from: victim, to: robber, items: [], money: 40, loc: 2 as never },
    });
    w.bus.endTick(ROB_TICK as Tick);
    RobberyMemory.update(sysCtxAt(w, ROB_TICK + 1));

    const until = ROB_TICK + ROBBERY_AVOID_DURATION_TICKS; // 600 + 7·1440 = 10680 (tod=600 ⇒ день)
    expect(getAvoids(w.resources, victim)).toEqual([[2, until]]);

    // (3) ОБХОД активен: охотник огибает loc2 — идёт на дальнюю дичь loc3.
    evalAt(w, 700); // день, обход ещё в силе (until 10680 > 700)
    expect(TSK.kind[victim]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[victim]).toBe(3); // маршрут огибает опасное место

    // (4) ЗАТУХАНИЕ: MemoryDecay на untilTick снимает истёкшую запись обхода (D-058).
    MemoryDecay.update(sysCtxAt(w, until));
    expect(getAvoids(w.resources, victim)).toEqual([]); // обход снят самим MemoryDecay
    expect(isAvoided(w.resources, victim, 2, until)).toBe(false);

    // (5) ВОЗВРАТ: место снова проходимо — охотник опять целит ближайшую дичь loc2.
    evalAt(w, until); // tod(10680)=600 ⇒ день
    expect(TSK.kind[victim]).toBe(TaskKind.HUNT);
    expect(TSK.targetLoc[victim]).toBe(2); // вернулся к бывшей опасной локации
  });
});
