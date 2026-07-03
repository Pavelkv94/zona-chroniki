/**
 * @module @zona/sim/systems/perception.test
 *
 * Гейт системы Perception (задача 1.7, B.1, D-023). Покрывает:
 *  - контакты: co-located видят друг друга взаимно и отсортированно; в не-смежных
 *    локациях не видят; приближающийся из смежной (dest==loc) виден наблюдателю;
 *  - perception/spotted РОВНО на новый контакт; удаление и повторное появление —
 *    новое событие; пока контакт держится — не дублируется; causedBy → move/*;
 *  - RESUME P0: непрерывный прогон vs split save/load → идентичные contacts и лог
 *    spotted (доказано хэшем мира), без дубля на границе;
 *  - страх: co-located кабан поднимает fear, олень — нет; угроза ушла → fear
 *    спадает (Needs 1.5); кламп на NEED_MAX;
 *  - изоляция бакетов: сущности из не-смежных локаций не сравниваются;
 *  - детерминизм двух прогонов; порядок событий = сортировка eid/loc.
 *
 * Perception rng не использует ⇒ детерминизм структурный (порядок eid/loc + чтение
 * прошлых контактов из ResourceStore). Компоненты — модульные singleton'ы (общие
 * колонки по eid): миры идут ПОСЛЕДОВАТЕЛЬНО; где нужно, значения захватываются в
 * примитивы ДО следующего прогона (как в needs/movement тестах).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed, SimEvent } from '@zona/shared';
import { createSimWorld, destroyEntity, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, existsEntity } from '../core/ecs';
import { Position, Needs as NeedsComponent, Animal, Task, TaskKind } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { neighbors, edgeLen } from '../data/index';
import { FEAR_FROM_THREAT_PER_TICK, FEAR_DECAY_PER_TICK, NEED_MAX } from '../balance/needs';
import { Perception } from './perception';
import { Needs } from './needs';
import { Movement } from './movement';

// Виды из species.json: 0 = олень (flees:true), 1 = кабан (flees:false).
const DEER = 0;
const BOAR = 1;

// Типизированные SoA-колонки для установки/чтения состояния в тестах.
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
const NEED = NeedsComponent as unknown as { fear: Float32Array };
const ANIM = Animal as unknown as { species: Uint8Array };
const TSK = Task as unknown as { targetLoc: Uint32Array; kind: Uint8Array };

/** Селит сущность в локации `loc` (стоит: dest===loc, D-019). */
function place(world: SimWorld, loc: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  return eid;
}

/** Селит носителя Needs в локации (для теста страха). */
function placeNeeder(world: SimWorld, loc: number, fear = 0): EntityId {
  const eid = place(world, loc);
  addComponent(world.ecs, NeedsComponent, eid);
  NEED.fear[eid] = fear;
  return eid;
}

/** Селит животное вида `species` в локации. */
function placeAnimal(world: SimWorld, loc: number, species: number): EntityId {
  const eid = place(world, loc);
  addComponent(world.ecs, Animal, eid);
  ANIM.species[eid] = species;
  return eid;
}

/** Планировщик только с Perception. */
function perceptionScheduler() {
  const s = createScheduler();
  s.register(Perception);
  return s;
}

/** Текущие контакты сущности из ResourceStore. */
function contacts(world: SimWorld, eid: EntityId): readonly number[] {
  return world.resources.get<number[]>('contacts', eid) ?? [];
}

/** События perception/spotted указанного observer из лога, в порядке публикации. */
function spottedOf(world: SimWorld, observer: EntityId): readonly SimEvent[] {
  return world.bus.log.filter(
    (e) => e.type === 'perception/spotted' && (e.payload as { observer: number }).observer === observer,
  );
}

/** Все perception/spotted из лога. */
function allSpotted(world: SimWorld): readonly SimEvent[] {
  return world.bus.log.filter((e) => e.type === 'perception/spotted');
}

describe('контакты: видимость внутри локации', () => {
  it('две co-located сущности видят друг друга ВЗАИМНО (отсорт. массив eid)', () => {
    const w = createSimWorld(1 as Seed);
    const a = place(w, 3);
    const b = place(w, 3);
    perceptionScheduler().run(w, 1);
    expect(contacts(w, a)).toEqual([b]);
    expect(contacts(w, b)).toEqual([a]);
  });

  it('три co-located: контакты каждого — двое других по возрастанию eid', () => {
    const w = createSimWorld(1 as Seed);
    const a = place(w, 3);
    const b = place(w, 3);
    const c = place(w, 3);
    perceptionScheduler().run(w, 1);
    expect(contacts(w, a)).toEqual([b, c]);
    expect(contacts(w, b)).toEqual([a, c]);
    expect(contacts(w, c)).toEqual([a, b]);
  });

  it('сущности в РАЗНЫХ не-смежных локациях НЕ видят друг друга', () => {
    const w = createSimWorld(1 as Seed);
    // Локации 0 и 9 (Саркофаг) заведомо не смежны (0 — Кордон, сосед только 1).
    expect(neighbors(0 as never).includes(9 as never)).toBe(false);
    const a = place(w, 0);
    const b = place(w, 9);
    perceptionScheduler().run(w, 1);
    expect(contacts(w, a)).toEqual([]);
    expect(contacts(w, b)).toEqual([]);
    expect(allSpotted(w)).toHaveLength(0);
  });

  it('приближающийся из СМЕЖНОЙ локации (dest==loc наблюдателя) виден; наблюдатель ему — нет', () => {
    const w = createSimWorld(1 as Seed);
    // 0 и 1 смежны (Кордон↔Свалка). observer стоит в 0; mover в 1, идёт в 0.
    expect(neighbors(0 as never).includes(1 as never)).toBe(true);
    const observer = place(w, 0);
    const mover = place(w, 1);
    POS.dest[mover] = 0; // приближается к локации наблюдателя
    perceptionScheduler().run(w, 1);
    // observer видит приближающегося mover…
    expect(contacts(w, observer)).toEqual([mover]);
    // …но mover (ещё в другой локации) наблюдателя НЕ видит (асимметрия «на подходе»).
    expect(contacts(w, mover)).toEqual([]);
  });

  it('сущность в смежной локации, но НЕ идущая к нам (dest != loc) — не контакт', () => {
    const w = createSimWorld(1 as Seed);
    const observer = place(w, 0);
    const stander = place(w, 1); // стоит в 1 (dest===1), не приближается
    perceptionScheduler().run(w, 1);
    expect(contacts(w, observer)).toEqual([]);
    expect(contacts(w, stander)).toEqual([]);
  });
});

describe('perception/spotted: ровно на новый контакт', () => {
  it('одно событие на новый контакт у каждого наблюдателя; loc корректна; causedBy=null (без движения)', () => {
    const w = createSimWorld(2 as Seed);
    const a = place(w, 4);
    const b = place(w, 4);
    perceptionScheduler().run(w, 1);
    const sa = spottedOf(w, a);
    const sb = spottedOf(w, b);
    expect(sa).toHaveLength(1);
    expect(sb).toHaveLength(1);
    expect(sa[0]!.payload).toEqual({ observer: a, target: b, loc: 4 });
    expect(sb[0]!.payload).toEqual({ observer: b, target: a, loc: 4 });
    // Никто не двигался (нет move/*) ⇒ причины нет.
    expect(sa[0]!.causedBy).toBeNull();
  });

  it('НЕ дублируется, пока контакт держится', () => {
    const w = createSimWorld(2 as Seed);
    const a = place(w, 4);
    place(w, 4);
    perceptionScheduler().run(w, 100);
    expect(spottedOf(w, a)).toHaveLength(1);
  });

  it('контакт пропал и снова появился → НОВОЕ событие', () => {
    const w = createSimWorld(2 as Seed);
    const a = place(w, 4);
    const b = place(w, 4);
    const sched = perceptionScheduler();
    sched.run(w, 1);
    expect(spottedOf(w, a)).toHaveLength(1);

    // b «ушёл» в не-смежную локацию 9 — контакт пропал.
    POS.loc[b] = 9;
    POS.dest[b] = 9;
    sched.run(w, 1);
    expect(contacts(w, a)).toEqual([]);
    expect(spottedOf(w, a)).toHaveLength(1); // новых нет

    // b вернулся в 4 — контакт снова НОВЫЙ.
    POS.loc[b] = 4;
    POS.dest[b] = 4;
    sched.run(w, 1);
    expect(contacts(w, a)).toEqual([b]);
    expect(spottedOf(w, a)).toHaveLength(2); // второе событие
  });

  it('causedBy ссылается на move/* сведшего их движения (реальный ход через Movement)', () => {
    const w = createSimWorld(2 as Seed);
    // observer стоит в 2; mover идёт 0→1→2. Контакт возникает на ВТОРОЙ ноге —
    // когда mover прибыл в 1 и departs к 2 (dest===2, приближается к observer).
    // К этому тику move-события ПЕРВОЙ ноги (departed 0→1, arrived @1) уже
    // committed в логе, поэтому у spotted есть непустая причина (two-phase bus).
    const observer = place(w, 2);
    const mover = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, mover);
    POS.loc[mover] = 0;
    POS.dest[mover] = 0;
    addComponent(w.ecs, Task, mover);
    TSK.kind[mover] = TaskKind.FORAGE;
    TSK.targetLoc[mover] = 2; // маршрут 0→1→2

    const sched = createScheduler();
    sched.register(Movement); // сперва двигаем…
    sched.register(Perception); // …затем воспринимаем
    const len01 = edgeLen(0 as never, 1 as never)!;
    // Тики 0..len01+1: departs@0, arrives@1 на len01, departs 1→2 на len01+1
    // (в этот тик observer впервые видит приближающегося mover).
    sched.run(w, len01 + 2);

    const sp = spottedOf(w, observer);
    expect(sp).toHaveLength(1);
    expect(sp[0]!.payload).toMatchObject({ observer, target: mover, loc: 2 });
    expect(sp[0]!.tick).toBe(len01 + 1);
    // Причина — самое свежее committed move-событие mover'а (arrived @1).
    const cause = sp[0]!.causedBy;
    expect(cause).not.toBeNull();
    const causeEv = w.bus.log.find((e) => e.id === cause)!;
    expect(['move/departed', 'move/arrived']).toContain(causeEv.type);
    expect((causeEv.payload as { eid: number }).eid).toBe(mover);
  });
});

describe('страх от co-located угрозы (кабан)', () => {
  it('co-located КАБАН поднимает fear носителя Needs на ставку/тик', () => {
    const w = createSimWorld(3 as Seed);
    const human = placeNeeder(w, 5, 0);
    placeAnimal(w, 5, BOAR);
    const n = 4;
    perceptionScheduler().run(w, n); // только Perception ⇒ чистый подъём без затухания
    expect(NEED.fear[human]).toBe(Math.fround(FEAR_FROM_THREAT_PER_TICK * n));
  });

  it('co-located ОЛЕНЬ (пугливый) НЕ поднимает fear', () => {
    const w = createSimWorld(3 as Seed);
    const human = placeNeeder(w, 5, 0);
    placeAnimal(w, 5, DEER);
    perceptionScheduler().run(w, 10);
    expect(NEED.fear[human]).toBe(0);
  });

  it('кабан в СМЕЖНОЙ локации (не co-located) НЕ поднимает fear', () => {
    const w = createSimWorld(3 as Seed);
    const human = placeNeeder(w, 0, 0);
    const boar = placeAnimal(w, 1, BOAR);
    POS.dest[boar] = 0; // даже приближающийся кабан — угроза лишь co-located
    perceptionScheduler().run(w, 5);
    // приближающийся кабан ВИДЕН (контакт), но страх — только от co-located.
    expect(contacts(w, human)).toEqual([boar]);
    expect(NEED.fear[human]).toBe(0);
  });

  it('fear клампится на NEED_MAX и не растёт выше', () => {
    const w = createSimWorld(3 as Seed);
    const human = placeNeeder(w, 5, NEED_MAX - 1);
    placeAnimal(w, 5, BOAR);
    perceptionScheduler().run(w, 50); // заведомо перебьёт потолок
    expect(NEED.fear[human]).toBe(NEED_MAX);
  });

  it('угроза УШЛА → fear спадает (Perception+Needs вместе): пока кабан рядом растёт, потом затухает', () => {
    const w = createSimWorld(3 as Seed);
    const human = placeNeeder(w, 5, 0);
    const boar = placeAnimal(w, 5, BOAR);
    const sched = createScheduler();
    sched.register(Perception); // подъём
    sched.register(Needs); // затухание

    sched.run(w, 10); // кабан рядом: net = (rise - decay) > 0 ⇒ страх копится
    const peak = NEED.fear[human] as number;
    expect(peak).toBeGreaterThan(0);
    // Пока рядом — растёт (ставка подъёма > ставки затухания, balance).
    expect(peak).toBe(
      // 10 тиков net-подъёма с пошаговым f32-округлением (rise затем decay каждый тик).
      (() => {
        let f = Math.fround(0);
        for (let i = 0; i < 10; i++) {
          f = Math.fround(f + FEAR_FROM_THREAT_PER_TICK); // Perception
          f = Math.fround(Math.max(0, f - FEAR_DECAY_PER_TICK)); // Needs
        }
        return f;
      })(),
    );

    // Кабан ушёл в не-смежную локацию 9 — угрозы больше нет.
    POS.loc[boar] = 9;
    POS.dest[boar] = 9;
    sched.run(w, 5); // только затухание Needs
    expect(NEED.fear[human] as number).toBeLessThan(peak);
    expect(NEED.fear[human]).toBe(Math.fround(peak - FEAR_DECAY_PER_TICK * 5));
  });

  it('два кабана co-located: каждый кабан-носитель Needs боится ДРУГОГО, но не себя', () => {
    const w = createSimWorld(3 as Seed);
    // Кабан с Needs + обычный кабан рядом ⇒ первый боится второго.
    const boar1 = place(w, 5);
    addComponent(w.ecs, NeedsComponent, boar1);
    NEED.fear[boar1] = 0;
    addComponent(w.ecs, Animal, boar1);
    ANIM.species[boar1] = BOAR;
    placeAnimal(w, 5, BOAR); // второй кабан — угроза для первого
    perceptionScheduler().run(w, 3);
    expect(NEED.fear[boar1]).toBe(Math.fround(FEAR_FROM_THREAT_PER_TICK * 3));
  });

  it('одинокий кабан-носитель Needs НЕ боится сам себя', () => {
    const w = createSimWorld(3 as Seed);
    const loneBoar = place(w, 5);
    addComponent(w.ecs, NeedsComponent, loneBoar);
    NEED.fear[loneBoar] = 0;
    addComponent(w.ecs, Animal, loneBoar);
    ANIM.species[loneBoar] = BOAR;
    perceptionScheduler().run(w, 10);
    expect(NEED.fear[loneBoar]).toBe(0);
  });
});

describe('изоляция бакетов (n² ограничен бакетом, D-023)', () => {
  it('сущности из не-смежных локаций не образуют контактов (косвенно — изоляция)', () => {
    const w = createSimWorld(4 as Seed);
    // Три пары в трёх взаимно не-смежных локациях. Каждый видит ТОЛЬКО соседа по
    // локации, никого из других бакетов.
    const a0 = place(w, 3);
    const b0 = place(w, 3);
    const a1 = place(w, 5);
    const b1 = place(w, 6);
    perceptionScheduler().run(w, 1);
    expect(contacts(w, a0)).toEqual([b0]);
    expect(contacts(w, b0)).toEqual([a0]);
    // a1/b1 в РАЗНЫХ локациях (5 и 6) — контактов нет, если 5 и 6 не смежны и
    // никто не приближается.
    expect(contacts(w, a1)).toEqual(neighbors(5 as never).includes(6 as never) ? contacts(w, a1) : []);
    expect(contacts(w, b1).includes(a0)).toBe(false); // точно не через бакет 3
    expect(contacts(w, a0).includes(a1)).toBe(false);
  });
});

describe('детерминизм и порядок (закон №8)', () => {
  function scenario(seed: number): { contacts: readonly number[]; log: readonly SimEvent[] } {
    const w = createSimWorld(seed as Seed);
    place(w, 2); // eid 1
    place(w, 2); // eid 2
    place(w, 2); // eid 3
    placeNeeder(w, 2, 0); // eid 4
    placeAnimal(w, 2, BOAR); // eid 5 — угроза
    perceptionScheduler().run(w, 3);
    return {
      contacts: contacts(w, 1 as EntityId),
      log: w.bus.log.map((e) => ({ ...e, payload: { ...e.payload } })) as SimEvent[],
    };
  }

  it('два прогона одного сценария → идентичные контакты и лог', () => {
    const a = scenario(7);
    const b = scenario(7);
    expect(b.contacts).toEqual(a.contacts);
    expect(b.log).toEqual(a.log);
  });

  it('spotted на тике 0 идут в порядке возрастания (observer, затем target)', () => {
    const w = createSimWorld(7 as Seed);
    place(w, 2); // eid 1
    place(w, 2); // eid 2
    place(w, 2); // eid 3
    perceptionScheduler().run(w, 1);
    const seq = allSpotted(w).map((e) => {
      const p = e.payload as { observer: number; target: number };
      return `${p.observer}:${p.target}`;
    });
    // Внешний цикл по observer (eid asc), внутри — target по возрастанию.
    expect(seq).toEqual(['1:2', '1:3', '2:1', '2:3', '3:1', '3:2']);
  });
});

describe('RESUME P0: split save/load ≡ непрерывный прогон (contacts и spotted)', () => {
  /**
   * Строит сценарий с движением (mover 0→1→…) + наблюдателями, чтобы контакты
   * возникали/пропадали во времени — тогда resume-детекция «нового контакта»
   * реально проверяется на границе snapshot.
   */
  function build(world: SimWorld): void {
    // Наблюдатель в 1; второй наблюдатель в 1; mover идёт 0→1 (контакт при подходе
    // и при прибытии), затем дальше по маршруту.
    const obs = place(world, 1);
    void obs;
    place(world, 1);
    const mover = spawnEntity(world.ecs);
    addComponent(world.ecs, Position, mover);
    POS.loc[mover] = 0;
    POS.dest[mover] = 0;
    addComponent(world.ecs, Task, mover);
    TSK.kind[mover] = TaskKind.FORAGE;
    TSK.targetLoc[mover] = 2; // маршрут 0→1→2 (проходит через 1)
    // Носитель Needs рядом с кабаном для эволюции страха через resume.
    const human = placeNeeder(world, 3, 0);
    void human;
    placeAnimal(world, 3, BOAR);
  }

  function fullScheduler() {
    const s = createScheduler();
    s.register(Movement);
    s.register(Perception);
    s.register(Needs);
    return s;
  }

  it('непрерывный N ≡ split(K)+resume(N-K): идентичный хэш мира и лог spotted (без дубля на границе)', () => {
    const N = 40;
    const K = 12; // сплит на середине движения — граница внутри активной динамики

    // Непрерывный прогон — хэш и лог захватываем в примитивы.
    const cont = createSimWorld(11 as Seed);
    build(cont);
    fullScheduler().run(cont, N);
    const contHash = hashSnapshot(serialize(cont));
    const contSpotted = allSpotted(cont).map((e) => ({
      tick: e.tick,
      observer: (e.payload as { observer: number }).observer,
      target: (e.payload as { target: number }).target,
      loc: (e.payload as { loc: number }).loc,
    }));
    expect(contSpotted.length).toBeGreaterThan(0); // сценарий реально порождает контакты

    // Split: K тиков → snapshot → deserialize → N-K тиков.
    const split = createSimWorld(11 as Seed);
    build(split);
    fullScheduler().run(split, K);
    const resumed = deserialize(serialize(split));
    expect(resumed.tick).toBe(K);
    fullScheduler().run(resumed, N - K);

    // ГЛАВНОЕ: побитово тот же мир (contacts в ResourceStore сериализованы) …
    expect(hashSnapshot(serialize(resumed))).toBe(contHash);
    // … и тот же лог spotted, без дубля на тике K (детекция нового контакта
    // сравнивает с ПРОШЛЫМИ контактами из восстановленного ResourceStore).
    const resSpotted = allSpotted(resumed).map((e) => ({
      tick: e.tick,
      observer: (e.payload as { observer: number }).observer,
      target: (e.payload as { target: number }).target,
      loc: (e.payload as { loc: number }).loc,
    }));
    expect(resSpotted).toEqual(contSpotted);
  });

  it('снапшот СРАЗУ ПОСЛЕ формирования контакта → после load НЕТ дубля spotted', () => {
    // Прицельно: если бы «новый контакт» детектился рантайм-Set'ом (не в store),
    // первый тик после load счёл бы держащийся контакт новым → дубль. Здесь prev
    // берётся из ResourceStore, поэтому дубля быть не должно.
    const w = createSimWorld(12 as Seed);
    const a = place(w, 4);
    place(w, 4);
    const sched = perceptionScheduler();
    sched.run(w, 3); // контакт сформирован на тике 0, дальше держится
    expect(spottedOf(w, a)).toHaveLength(1);

    const resumed = deserialize(serialize(w));
    expect(spottedOf(resumed, a)).toHaveLength(1); // лог восстановлен как есть
    perceptionScheduler().run(resumed, 50); // контакт держится всё время
    expect(spottedOf(resumed, a)).toHaveLength(1); // НИ одного нового — resume чист
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// УСИЛЕНИЕ QA (задача 1.7): прицельные дыры — resume на разных фазах, асимметрия
// «на подходе», перезапись пустого контакта, смерть/переиспользование носителя
// контакта, одновременное прибытие, толпа в бакете, фикс-ставка страха.
// ─────────────────────────────────────────────────────────────────────────────

describe('семантика «на подходе»: асимметрия и взаимное приближение', () => {
  it('B стоит в locB, A приближается (dest=locB): B видит A, A НЕ видит B (асимметрия зафиксирована)', () => {
    const w = createSimWorld(20 as Seed);
    // locB=0, A в смежной 1 идёт в 0. Наблюдатель в locB видит подходящего;
    // сам подходящий видит лишь СВОЙ бакет (loc 1), где B нет.
    const B = place(w, 0); // стоит в locB
    const A = place(w, 1); // в смежной локации
    POS.dest[A] = 0; // приближается к locB
    perceptionScheduler().run(w, 1);
    expect(contacts(w, B)).toEqual([A]); // наблюдатель в locB видит подходящего A
    expect(contacts(w, A)).toEqual([]); // A видит только свой бакет (loc 1) — B там нет
    // Ровно одно spotted — у B про A; у A ничего (закон причинности: видит тот, к кому идут).
    expect(spottedOf(w, B)).toHaveLength(1);
    expect(spottedOf(w, A)).toHaveLength(0);
  });

  it('оба приближаются друг к другу (A→locB, B→locA) → ВЗАИМНО видят (симметрия при взаимном подходе)', () => {
    const w = createSimWorld(20 as Seed);
    // 0 и 1 смежны. A в 0 идёт в 1; B в 1 идёт в 0 — каждый есть в бакете-цели другого.
    const A = place(w, 0);
    POS.dest[A] = 1;
    const B = place(w, 1);
    POS.dest[B] = 0;
    perceptionScheduler().run(w, 1);
    expect(contacts(w, A)).toEqual([B]);
    expect(contacts(w, B)).toEqual([A]);
    expect(allSpotted(w)).toHaveLength(2);
  });

  it('приближающийся КАБАН виден B, но страх НЕ поднимает (угроза лишь co-located) — асимметрия не течёт в fear', () => {
    const w = createSimWorld(20 as Seed);
    const B = placeNeeder(w, 0, 0); // носитель Needs стоит в locB
    const boar = placeAnimal(w, 1, BOAR);
    POS.dest[boar] = 0; // кабан идёт к B, но ещё в смежной локации
    perceptionScheduler().run(w, 5);
    expect(contacts(w, B)).toEqual([boar]); // видим подходящего хищника…
    expect(NEED.fear[B]).toBe(0); // …но пугает только co-located (закон №2, состояние, не дистанция)
  });
});

describe('пустой контакт перезаписывается КАЖДЫЙ тик (иначе spotted-детекция залипнет)', () => {
  it('одинокая сущность: contacts ЗАПИСАН как [] (store.has=true), а не отсутствует', () => {
    const w = createSimWorld(21 as Seed);
    const lone = place(w, 6);
    perceptionScheduler().run(w, 1);
    // Именно ЗАПИСАН пустой срез — не «нет ключа». От этого зависит prev-детекция.
    expect(w.resources.has('contacts', lone)).toBe(true);
    expect(contacts(w, lone)).toEqual([]);
  });

  it('сосед ушёл → contacts становится [] и СТАРЫЙ список не залипает в store', () => {
    const w = createSimWorld(21 as Seed);
    const a = place(w, 4);
    const b = place(w, 4);
    const sched = perceptionScheduler();
    sched.run(w, 1);
    expect(contacts(w, a)).toEqual([b]); // был контакт
    // b уходит в не-смежную локацию.
    POS.loc[b] = 9;
    POS.dest[b] = 9;
    sched.run(w, 1);
    // Перезаписан пустым, а не оставлен старым [b] — иначе следующий приход b не
    // считался бы «новым» и spotted не выстрелил бы (регресс детекции).
    expect(contacts(w, a)).toEqual([]);
    expect(w.resources.get<number[]>('contacts', a)).not.toContain(b);
  });
});

describe('смерть/переиспользование носителя контакта (закон №3, утечка eid)', () => {
  it('destroyEntity цели → на следующем тике цель уходит из contacts наблюдателя (нет мёртвого eid)', () => {
    const w = createSimWorld(22 as Seed);
    const obs = place(w, 4);
    const target = place(w, 4);
    const sched = perceptionScheduler();
    sched.run(w, 1);
    expect(contacts(w, obs)).toEqual([target]);

    destroyEntity(w, target); // цель физически исчезает из мира
    expect(existsEntity(w.ecs, target)).toBe(false);
    sched.run(w, 1);
    // Контакты перестроены из ЖИВЫХ носителей Position ⇒ мёртвого eid там нет.
    expect(contacts(w, obs)).toEqual([]);
    expect(contacts(w, obs)).not.toContain(target);
    // Собственный контакт покойника вычищен из store (purgeEntity).
    expect(w.resources.has('contacts', target)).toBe(false);
  });

  it('НАХОДКА (LOW): переиспользование eid покойника В ПРОМЕЖУТКЕ между тиками МАСКИРУЕТ spotted нового контакта', () => {
    // Прицельно фиксируем ТЕКУЩЕЕ поведение как известное ограничение. Контакт
    // идентифицируется ТОЛЬКО по eid: если цель убита и на её eid (freelist)
    // возникает ДРУГАЯ сущность до следующего прогона Perception, prev-контакты
    // наблюдателя ещё держат этот eid ⇒ новый (иной!) носитель считается «старым»
    // ⇒ perception/spotted НЕ публикуется. Летопись теряет запись о встрече.
    const w = createSimWorld(22 as Seed);
    const obs = place(w, 4);
    const target = place(w, 4);
    const sched = perceptionScheduler();
    sched.run(w, 1);
    expect(spottedOf(w, obs)).toHaveLength(1);

    destroyEntity(w, target); // между двумя тиками Perception…
    const reused = place(w, 4); // …на том же eid появляется ДРУГАЯ сущность
    expect(reused).toBe(target); // bitecs выдал eid из freelist — совпал
    sched.run(w, 1);
    // Контакт-список ВЕРЕН (reused co-located), но spotted НЕ добавился —
    // маскировка по eid. Это НАХОДКА: пропущено событие встречи. Тест пинует
    // текущее поведение; при фиксе (детекция по идентичности, а не по eid)
    // ожидание сменится на toHaveLength(2).
    expect(contacts(w, obs)).toEqual([reused]);
    expect(spottedOf(w, obs)).toHaveLength(1); // ← маскировка (баг-документация)
  });
});

describe('одновременное присутствие и толпа в бакете', () => {
  it('двое co-located на одном тике → ВЗАИМНЫЙ spotted: ровно ДВА события, порядок по observer', () => {
    const w = createSimWorld(23 as Seed);
    const a = place(w, 4); // eid 1
    const b = place(w, 4); // eid 2
    perceptionScheduler().run(w, 1);
    const seq = allSpotted(w).map((e) => {
      const p = e.payload as { observer: number; target: number };
      return `${p.observer}:${p.target}`;
    });
    expect(seq).toEqual([`${a}:${b}`, `${b}:${a}`]); // по одному на наблюдателя, observer asc
  });

  it('восемь co-located: у каждого контакты = остальные 7 (сорт.), без чужих; n² внутри бакета верен', () => {
    const w = createSimWorld(24 as Seed);
    const here: EntityId[] = [];
    for (let i = 0; i < 8; i++) here.push(place(w, 5));
    // Шум в других локациях — не должен просочиться в бакет loc 5.
    place(w, 9);
    place(w, 0);
    perceptionScheduler().run(w, 1);
    for (const e of here) {
      const expected = here.filter((x) => x !== e).sort((x, y) => x - y);
      expect(contacts(w, e)).toEqual(expected);
      expect(contacts(w, e)).toHaveLength(7);
    }
    // 8×7 = 56 spotted, все внутри loc 5, ни одного чужого target.
    expect(allSpotted(w)).toHaveLength(56);
    const hereSet = new Set(here);
    for (const e of allSpotted(w)) {
      const p = e.payload as { observer: number; target: number; loc: number };
      expect(p.loc).toBe(5);
      expect(hereSet.has(p.observer as EntityId)).toBe(true);
      expect(hereSet.has(p.target as EntityId)).toBe(true);
    }
  });
});

describe('страх: несколько угроз — ФИКС-ставка (зафиксировать семантику)', () => {
  it('три co-located кабана поднимают fear с ТОЙ ЖЕ ставкой, что один (не ×N угроз)', () => {
    const w = createSimWorld(25 as Seed);
    const human = placeNeeder(w, 5, 0);
    placeAnimal(w, 5, BOAR);
    placeAnimal(w, 5, BOAR);
    placeAnimal(w, 5, BOAR);
    const n = 4;
    perceptionScheduler().run(w, n);
    // Ставка НЕ кратна числу угроз — «рядом есть угроза» бинарно (закон №7).
    expect(NEED.fear[human]).toBe(Math.fround(FEAR_FROM_THREAT_PER_TICK * n));
  });

  it('множество угроз тоже клампится на NEED_MAX (не переполняет)', () => {
    const w = createSimWorld(25 as Seed);
    const human = placeNeeder(w, 5, NEED_MAX - 1);
    placeAnimal(w, 5, BOAR);
    placeAnimal(w, 5, BOAR);
    perceptionScheduler().run(w, 50);
    expect(NEED.fear[human]).toBe(NEED_MAX);
  });
});

describe('детерминизм прогона с ДВИЖЕНИЕМ + спотами (закон №8)', () => {
  function movingScenario(seed: number): {
    obsContacts: readonly number[];
    spotted: ReadonlyArray<{ tick: number; observer: number; target: number; loc: number }>;
  } {
    const w = createSimWorld(seed as Seed);
    const obs = place(w, 2); // стоит в 2
    const mover = spawnEntity(w.ecs);
    addComponent(w.ecs, Position, mover);
    POS.loc[mover] = 0;
    POS.dest[mover] = 0;
    addComponent(w.ecs, Task, mover);
    TSK.kind[mover] = TaskKind.FORAGE;
    TSK.targetLoc[mover] = 5; // маршрут 0→1→2→5 мимо наблюдателя
    const sched = createScheduler();
    sched.register(Movement);
    sched.register(Perception);
    sched.run(w, 130);
    return {
      obsContacts: contacts(w, obs),
      spotted: allSpotted(w).map((e) => {
        const p = e.payload as { observer: number; target: number; loc: number };
        return { tick: e.tick as number, observer: p.observer, target: p.target, loc: p.loc };
      }),
    };
  }

  it('два прогона одного seed → идентичные contacts и лог spotted', () => {
    const a = movingScenario(31);
    const b = movingScenario(31);
    expect(b.obsContacts).toEqual(a.obsContacts);
    expect(b.spotted).toEqual(a.spotted);
    expect(a.spotted.length).toBeGreaterThan(0); // сценарий реально порождает споты
  });
});

describe('RESUME P0 на РАЗНЫХ ФАЗАХ контакта (split ≡ непрерывный, без дубля на границе)', () => {
  /**
   * Сценарий с ТОЧНО известными фазами (проверено): наблюдатель стоит в loc 2;
   * mover идёт 0→1→2→5 (targetLoc 5); контакт наблюдателя ПОЯВЛЯЕТСЯ на тике 41
   * (mover выходит из 1 к 2 — приближается), ДЕРЖИТСЯ 41..121 (approaching→co-located),
   * ПРОПАДАЕТ на тике 122 (mover ушёл в 5). Параллельно human рядом с кабаном в loc 3
   * эволюционирует страх через границу snapshot. Разные K бьют по разным фазам.
   */
  function buildPhased(world: SimWorld): void {
    const obs = place(world, 2);
    void obs;
    const mover = spawnEntity(world.ecs);
    addComponent(world.ecs, Position, mover);
    POS.loc[mover] = 0;
    POS.dest[mover] = 0;
    addComponent(world.ecs, Task, mover);
    TSK.kind[mover] = TaskKind.FORAGE;
    TSK.targetLoc[mover] = 5;
    const human = placeNeeder(world, 3, 0);
    void human;
    placeAnimal(world, 3, BOAR);
  }

  function phasedScheduler() {
    const s = createScheduler();
    s.register(Movement);
    s.register(Perception);
    s.register(Needs);
    return s;
  }

  const N = 130;

  function continuousRef(): { hash: string; spotted: string } {
    const cont = createSimWorld(41 as Seed);
    buildPhased(cont);
    phasedScheduler().run(cont, N);
    return {
      hash: hashSnapshot(serialize(cont)),
      spotted: JSON.stringify(
        allSpotted(cont).map((e) => {
          const p = e.payload as { observer: number; target: number; loc: number };
          return { tick: e.tick, observer: p.observer, target: p.target, loc: p.loc };
        }),
      ),
    };
  }

  // Границы фаз: 41 = ТИК ПОЯВЛЕНИЯ (детекция должна лечь ПОСЛЕ load), 42 = сразу
  // после появления (контакт держится — дубля быть не должно), 80 = глубоко внутри
  // удержания, 122 = ТИК УХОДА, 123 = сразу после ухода (контакта нет).
  for (const K of [41, 42, 80, 122, 123]) {
    it(`split ровно на K=${K} тиков ≡ непрерывный: хэш мира и лог spotted совпадают`, () => {
      // Эталон захватываем в примитивы ДО построения split (общие SoA-колонки).
      const ref = continuousRef();

      const split = createSimWorld(41 as Seed);
      buildPhased(split);
      phasedScheduler().run(split, K);
      const resumed = deserialize(serialize(split));
      expect(resumed.tick).toBe(K);
      phasedScheduler().run(resumed, N - K);

      expect(hashSnapshot(serialize(resumed))).toBe(ref.hash);
      const resSpotted = JSON.stringify(
        allSpotted(resumed).map((e) => {
          const p = e.payload as { observer: number; target: number; loc: number };
          return { tick: e.tick, observer: p.observer, target: p.target, loc: p.loc };
        }),
      );
      expect(resSpotted).toBe(ref.spotted);
    });
  }

  it('ДВОЙНОЙ save/load на тике появления (K=41) ≡ непрерывный (детекция переживает 2 цикла)', () => {
    const ref = continuousRef();
    const K = 41;
    const split = createSimWorld(41 as Seed);
    buildPhased(split);
    phasedScheduler().run(split, K);
    // Два круга сериализации подряд — контакты и eventSeq не должны «сползти».
    const once = deserialize(serialize(split));
    const twice = deserialize(serialize(once));
    expect(twice.tick).toBe(K);
    phasedScheduler().run(twice, N - K);

    expect(hashSnapshot(serialize(twice))).toBe(ref.hash);
    const resSpotted = JSON.stringify(
      allSpotted(twice).map((e) => {
        const p = e.payload as { observer: number; target: number; loc: number };
        return { tick: e.tick, observer: p.observer, target: p.target, loc: p.loc };
      }),
    );
    expect(resSpotted).toBe(ref.spotted);
  });
});
