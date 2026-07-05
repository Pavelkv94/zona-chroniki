/**
 * @module @zona/sim/systems/robbery-memory.test
 *
 * Гейт RobberyMemory (задача 2.13, D-063) — ФОРМИРОВАНИЕ памяти об ограблении. Покрывает:
 *  - живая жертва loot/transferred → память 'robbed'(subject=грабитель, causeEvent=id
 *    события, salience=ROBBERY_MEMORY_SALIENCE), отношение к грабителю падает на DELTA,
 *    к его фракции — на FACTION_DELTA, avoidLoc помечена до ev.tick+DURATION;
 *  - «мёртвые не помнят»: жертва без Alive НЕ получает ни памяти, ни отношения, ни обхода;
 *  - грабитель без наблюдаемой фракции → память/личное отношение/обход есть, фракц. нет;
 *  - avoidLoc истекает по сроку (isAvoided false после untilTick);
 *  - реактивное окно: событие тика T обрабатывается на T+1 (at(tick−1)), не раньше/дважды;
 *  - ИЗОЛЯЦИЯ: нет loot/transferred / tick=0 ⇒ полный no-op (0 записей);
 *  - ДЕТЕРМИНИЗМ: два прогона одного сценария → идентичные память/отношения/обход.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, FactionId, MemoryRecord, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import type { SystemCtx } from '../core/system';
import { spawnEntity, addComponent, removeComponent, hasComponent } from '../core/ecs';
import { Human, Alive, Position, Skills, Health, Task, Corpse, TaskKind } from '../core/components';
import { createScheduler } from '../core/scheduler';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import { HEALTH_MAX } from '../balance/needs';
import { Encounters } from './encounters';
import { Death } from './death';
import { MemoryDecay } from './memory-decay';
import { getMemory, getRelation, getRelations, getAvoids, isAvoided, entitySubject, factionSubject } from './memory';
import { RobberyMemory } from './robbery-memory';
import {
  ROBBERY_MEMORY_SALIENCE,
  ROBBERY_RELATION_DELTA,
  ROBBERY_FACTION_RELATION_DELTA,
  ROBBERY_AVOID_DURATION_TICKS,
} from '../balance/social';

const LOC = 3;

/** Селит живого человека (жертву/грабителя) с опциональной фракцией. */
function placeHuman(world: SimWorld, faction?: string): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Position, eid);
  if (faction !== undefined) world.resources.set<FactionId>('faction', eid, faction as FactionId);
  return eid;
}

/** Публикует loot/transferred на тике `tick` и коммитит его в лог. Возвращает id события. */
function commitRobbery(
  world: SimWorld,
  tick: number,
  from: EntityId,
  to: EntityId,
  loc = LOC,
): EventId {
  world.tick = tick as Tick;
  const id = world.bus.publish({
    type: 'loot/transferred',
    causedBy: null,
    payload: { from, to, items: [], money: 50, loc: loc as never },
  });
  world.bus.endTick(tick as Tick);
  return id;
}

/** Ручной ctx для прямого вызова RobberyMemory.update на тике `tick`. */
function ctxAt(world: SimWorld, tick: number): SystemCtx {
  world.tick = tick as Tick;
  return {
    world,
    bus: world.bus,
    rng: world.rng.fork(`RobberyMemory@${tick}`),
    tick: tick as Tick,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('RobberyMemory: живая жертва запоминает грабёж (D-063)', () => {
  it('память robbed + отношение к грабителю/фракции + обход места', () => {
    const w = createSimWorld(1 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w, 'bandits');
    const evId = commitRobbery(w, 10, victim, robber);

    RobberyMemory.update(ctxAt(w, 11));

    // 1. Память 'robbed' о грабителе, causeEvent = id loot/transferred, salience/тик.
    const mem = getMemory(w.resources, victim);
    expect(mem).toHaveLength(1);
    expect(mem[0]).toEqual<MemoryRecord>({
      kind: 'robbed',
      subject: entitySubject(robber),
      salience: ROBBERY_MEMORY_SALIENCE,
      tick: 10, // ev.tick — когда случился грабёж, не тик обработки
      causeEvent: evId as number,
      isFirsthand: true,
    });

    // 2. Отношение к грабителю просело на DELTA; к его фракции — на FACTION_DELTA.
    expect(getRelation(w.resources, victim, entitySubject(robber))).toBeCloseTo(-ROBBERY_RELATION_DELTA, 10);
    expect(getRelation(w.resources, victim, factionSubject('bandits' as FactionId))).toBeCloseTo(
      -ROBBERY_FACTION_RELATION_DELTA,
      10,
    );

    // 3. Место грабежа избегается до ev.tick + срок.
    expect(getAvoids(w.resources, victim)).toEqual([[LOC, 10 + ROBBERY_AVOID_DURATION_TICKS]]);
    expect(isAvoided(w.resources, victim, LOC, 11)).toBe(true);

    // Грабитель памяти/отношений/обхода НЕ получает — помнит только жертва.
    expect(getMemory(w.resources, robber)).toEqual([]);
    expect(getAvoids(w.resources, robber)).toEqual([]);
  });

  it('повторный грабёж дожимает отношение к −1 (кламп) и ОСВЕЖАЕТ одну память (консолидация, D-075)', () => {
    const w = createSimWorld(2 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w, 'bandits');
    commitRobbery(w, 10, victim, robber);
    RobberyMemory.update(ctxAt(w, 11));
    commitRobbery(w, 20, victim, robber);
    RobberyMemory.update(ctxAt(w, 21));

    // Память «меня грабил X» — ОДИН факт (kind:'robbed', subject:e:robber, firsthand),
    // освежённый повтором (addMemory консолидирует по факту, D-075), а не две копии.
    const mem = getMemory(w.resources, victim);
    expect(mem).toHaveLength(1);
    expect(mem[0]!.tick).toBe(20); // освежён на свежайший грабёж
    // Отношение же КОПИТСЯ отдельно (adjustRelation): −0.6 −0.6 = −1.2 → кламп к −1.
    expect(getRelation(w.resources, victim, entitySubject(robber))).toBeCloseTo(-1, 10);
  });
});

describe('RobberyMemory: «мёртвые не помнят» (порядок Encounters<Death)', () => {
  it('жертва без Alive не получает ни памяти, ни отношения, ни обхода', () => {
    const w = createSimWorld(3 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w, 'bandits');
    // Death (в тике грабежа) снял Alive у погибшей жертвы.
    removeComponent(w.ecs, Alive, victim);
    commitRobbery(w, 10, victim, robber);

    RobberyMemory.update(ctxAt(w, 11));

    expect(getMemory(w.resources, victim)).toEqual([]);
    expect(getRelations(w.resources, victim)).toEqual([]);
    expect(getAvoids(w.resources, victim)).toEqual([]);
  });
});

describe('RobberyMemory: фракция грабителя ненаблюдаема', () => {
  it('нет faction у грабителя → память/личное отношение/обход есть, фракц. отношения нет', () => {
    const w = createSimWorld(4 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w); // без фракции
    commitRobbery(w, 10, victim, robber);

    RobberyMemory.update(ctxAt(w, 11));

    expect(getMemory(w.resources, victim)).toHaveLength(1);
    expect(getRelation(w.resources, victim, entitySubject(robber))).toBeCloseTo(-ROBBERY_RELATION_DELTA, 10);
    // Единственная запись отношений — личная к грабителю (фракц. не добавлена).
    expect(getRelations(w.resources, victim)).toHaveLength(1);
    expect(isAvoided(w.resources, victim, LOC, 11)).toBe(true);
  });
});

describe('RobberyMemory: обход истекает по сроку (снимет MemoryDecay)', () => {
  it('isAvoided true до untilTick, false после', () => {
    const w = createSimWorld(5 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w, 'bandits');
    commitRobbery(w, 10, victim, robber);
    RobberyMemory.update(ctxAt(w, 11));

    const until = 10 + ROBBERY_AVOID_DURATION_TICKS;
    expect(isAvoided(w.resources, victim, LOC, until - 1)).toBe(true);
    expect(isAvoided(w.resources, victim, LOC, until)).toBe(false); // until не включ.
    expect(isAvoided(w.resources, victim, LOC, until + 1000)).toBe(false);
  });
});

describe('RobberyMemory: реактивное окно at(tick−1)', () => {
  it('событие тика T обрабатывается на T+1, не раньше и не дважды', () => {
    const w = createSimWorld(6 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w, 'bandits');
    commitRobbery(w, 10, victim, robber);

    // На тике 10 (совпадает с тиком события) — событие ещё не «прошлого тика».
    RobberyMemory.update(ctxAt(w, 10));
    expect(getMemory(w.resources, victim)).toEqual([]);

    // На тике 11 — обрабатывается ровно раз.
    RobberyMemory.update(ctxAt(w, 11));
    expect(getMemory(w.resources, victim)).toHaveLength(1);

    // На тике 12 — окно (at(11)) пусто, повторной записи нет.
    RobberyMemory.update(ctxAt(w, 12));
    expect(getMemory(w.resources, victim)).toHaveLength(1);
  });
});

describe('RobberyMemory: изоляция / no-op (голдены Фазы 1 целы)', () => {
  it('нет loot/transferred в окне ⇒ 0 записей', () => {
    const w = createSimWorld(7 as never);
    const victim = placeHuman(w);
    // Публикуем НЕ-грабёж (посторонний тип) и коммитим.
    w.tick = 10 as Tick;
    w.bus.publish({ type: 'move/arrived', causedBy: null, payload: { eid: victim, at: LOC as never } });
    w.bus.endTick(10 as Tick);

    RobberyMemory.update(ctxAt(w, 11));
    expect(getMemory(w.resources, victim)).toEqual([]);
    expect(getRelations(w.resources, victim)).toEqual([]);
    expect(getAvoids(w.resources, victim)).toEqual([]);
  });

  it('tick=0 ⇒ ранний выход (нет прошлого тика)', () => {
    const w = createSimWorld(8 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w, 'bandits');
    // Прямой вызов на тике 0 — окно at(−1) не читается.
    expect(() => RobberyMemory.update(ctxAt(w, 0))).not.toThrow();
    expect(getMemory(w.resources, victim)).toEqual([]);
    void robber;
  });
});

describe('RobberyMemory: детерминизм (закон №8)', () => {
  it('два прогона одного сценария → идентичные память/отношения/обход', () => {
    function run(seed: number): {
      mem: readonly MemoryRecord[];
      rel: number;
      avoids: readonly (readonly [number, number])[];
    } {
      const w = createSimWorld(seed as never);
      const victim = placeHuman(w);
      const robber = placeHuman(w, 'bandits');
      commitRobbery(w, 10, victim, robber);
      RobberyMemory.update(ctxAt(w, 11));
      return {
        mem: getMemory(w.resources, victim),
        rel: getRelation(w.resources, victim, entitySubject(robber)),
        avoids: getAvoids(w.resources, victim),
      };
    }
    expect(run(42)).toEqual(run(42));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ QA (задача 2.13): «мёртвые не помнят» и «выживший помнит» ЧЕРЕЗ РЕАЛЬНЫЙ
// конвейер Encounters→Death→RobberyMemory (а не ручным removeComponent(Alive)).
// Затухание обхода реальным MemoryDecay 2.15. Resume≡continuous. Структурный закон №6.
// Сценарии читаются как маленькие истории Зоны: «налётчик застрелен, напарник бежит
// и обчищен победителем — кто из двоих носит травму?».
// ═══════════════════════════════════════════════════════════════════════════

// ── SoA-колонки боевого носителя (та же форма, что encounters-rob.test) ───────
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const SKILL = Skills as unknown as { shooting: Float32Array };
const HP = Health as unknown as { hp: Float32Array };
const TSK = Task as unknown as { kind: Uint8Array; targetLoc: Uint32Array; targetEid: Uint32Array; causeEvent: Uint32Array };

interface Inv {
  readonly item: string;
  readonly qty: number;
}

/** Селит стоящего живого бойца (Human) в LOC с навыком/hp/инвентарём/деньгами. */
function placeFighter(
  world: SimWorld,
  o: { shooting?: number; hp?: number; inv?: readonly Inv[]; money?: number } = {},
): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = LOC;
  POS.dest[eid] = LOC; // стоит (D-019) — гейт боя завяжется
  addComponent(world.ecs, Skills, eid);
  SKILL.shooting[eid] = o.shooting ?? 0.6;
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = o.hp ?? HEALTH_MAX;
  if (o.inv !== undefined) world.resources.set<readonly Inv[]>('inventory', eid, o.inv);
  if (o.money !== undefined) world.resources.set<number>('money', eid, o.money);
  return eid;
}

/** Навешивает задачу ROB на `target` (как это сделал бы TaskSelection 2.12). */
function makeRobber(world: SimWorld, eid: EntityId, target: EntityId): void {
  addComponent(world.ecs, Task, eid);
  TSK.kind[eid] = TaskKind.ROB;
  TSK.targetLoc[eid] = LOC;
  TSK.targetEid[eid] = target;
  TSK.causeEvent[eid] = 0;
}

// Конвейер завязки памяти в ДВЕ фазы по реактивной модели RobberyMemory (bus.at(T−1)):
//  • ТИК T (combat): Encounters резолвит бой И эмитит loot/transferred; Death В ТОМ ЖЕ
//    тике снимает Alive у погибшего (порядок Encounters<Death, D-041) — вот почему на
//    T+1 «мёртвые не помнят».
//  • ТИК T+1 (memory): RobberyMemory читает закоммиченный loot/transferred тика T и
//    пишет память ЖИВЫМ жертвам. Encounters здесь НЕ гоняем повторно: в полном конвейере
//    сломленный беглец уже ушёл бы (Movement) и сменил задачу (TaskSelection) — повторный
//    захват его тем же боем на T+1 был бы артефактом отсутствующих в этом гейте систем.

/** Планировщик боевого тика: Encounters(бой+лут) → Death(труп, снятие Alive). */
function combatPhase(): ReturnType<typeof createScheduler> {
  const s = createScheduler();
  s.register(Encounters);
  s.register(Death);
  return s;
}

/** Планировщик тика формирования памяти: одна RobberyMemory (читает прошлый тик). */
function memoryPhase(): ReturnType<typeof createScheduler> {
  const s = createScheduler();
  s.register(RobberyMemory);
  return s;
}

/** loot/transferred события лога (для проверки причинной цепи). */
function lootEvents(world: SimWorld): Extract<SimEvent, { type: 'loot/transferred' }>[] {
  return world.bus.log.filter((e) => e.type === 'loot/transferred') as Extract<
    SimEvent,
    { type: 'loot/transferred' }
  >[];
}

describe('RobberyMemory сквозь конвейер: «мёртвые не помнят» (Encounters→Death→RobberyMemory)', () => {
  it('1v1 — жертва гибнет в грабеже ⇒ у трупа НОЛЬ памяти/отношений/обхода', () => {
    const w = createSimWorld(42 as never);
    // Сильный вооружённый налётчик против слабой безоружной жертвы — 1v1 до смерти.
    const robber = placeFighter(w, { shooting: 0.95, hp: HEALTH_MAX, inv: [{ item: 'ammo_9mm', qty: 16 }, { item: 'pm', qty: 1 }], money: 0 });
    const victim = placeFighter(w, { shooting: 0.1, hp: 12, inv: [{ item: 'canned', qty: 2 }], money: 80 });
    makeRobber(w, robber, victim);

    // Тик 0: бой+смерть+лут; Тик 1: RobberyMemory читает закоммиченный loot/transferred.
    combatPhase().run(w, 1);
    memoryPhase().run(w, 1);

    // Жертва мертва: труп, Alive снят Death'ом В ТИКЕ БОЯ — RobberyMemory на T+1 её отсеял.
    expect(hasComponent(w.ecs, Corpse, victim)).toBe(true);
    expect(hasComponent(w.ecs, Alive, victim)).toBe(false);

    // Событие грабежа СЛУЧИЛОСЬ (from=жертва) — путь реально прошёл, не пустой тест.
    const loot = lootEvents(w);
    expect(loot).toHaveLength(1);
    expect(loot[0]!.payload.from).toBe(victim);
    expect(loot[0]!.payload.to).toBe(robber);

    // ГЛАВНОЕ: «мёртвые не помнят» — у погибшей жертвы НИ памяти, НИ отношений, НИ обхода.
    expect(getMemory(w.resources, victim)).toEqual([]);
    expect(getRelations(w.resources, victim)).toEqual([]);
    expect(getAvoids(w.resources, victim)).toEqual([]);
    // Победитель тоже не «помнит ограбление» — он грабил, а не был ограблен.
    expect(getMemory(w.resources, robber)).toEqual([]);
    expect(getAvoids(w.resources, robber)).toEqual([]);
  });

  it('выживший обчищенный (сломленная группа) ПОМНИТ обидчика; павший напарник — нет', () => {
    // Двое безоружных налётчиков валят сильную вооружённую цель. Цель бьёт мин-eid
    // налётчика насмерть; второй при сломе морали (0.5) БЕЖИТ ЖИВЫМ и обчищен
    // победителем ⇒ он `from` в loot/transferred и НОСИТ травму. Павший — молчит.
    const w = createSimWorld(0 as never);
    const fallen = placeFighter(w, { shooting: 0.9, hp: 12, inv: [{ item: 'canned', qty: 1 }], money: 30 }); // мин-eid — цель бьёт его
    const survivor = placeFighter(w, { shooting: 0.9, hp: 12, inv: [{ item: 'canned', qty: 1 }], money: 30 });
    const defender = placeFighter(w, { shooting: 0.99, hp: HEALTH_MAX, inv: [{ item: 'ammo_9mm', qty: 64 }, { item: 'pm', qty: 1 }], money: 0 });
    makeRobber(w, fallen, defender);
    makeRobber(w, survivor, defender);

    combatPhase().run(w, 1); // тик 0: бой+смерть+лут
    memoryPhase().run(w, 1); // тик 1: RobberyMemory на закоммиченном логе

    // Исход: защитник победил, один налётчик мёртв, второй сбежал живым.
    expect(hasComponent(w.ecs, Alive, fallen)).toBe(false); // пал
    expect(hasComponent(w.ecs, Alive, survivor)).toBe(true); // сбежал живым
    expect(HP.hp[defender]).toBeGreaterThan(0);

    // Обчищены ОБА проигравших; событие с from=survivor — живой обидчик помнит.
    const survivorLoot = lootEvents(w).find((l) => l.payload.from === survivor);
    expect(survivorLoot).toBeDefined();

    // ВЫЖИВШИЙ помнит грабёж: subject=победитель, causeEvent = id ЕГО loot/transferred
    // (причинная линковка D-038 на РЕАЛЬНОЕ событие конвейера, не синтетику).
    const mem = getMemory(w.resources, survivor);
    expect(mem).toHaveLength(1);
    expect(mem[0]!.kind).toBe('robbed');
    expect(mem[0]!.subject).toBe(entitySubject(defender));
    expect(mem[0]!.causeEvent).toBe(survivorLoot!.id);
    expect(mem[0]!.salience).toBe(ROBBERY_MEMORY_SALIENCE);
    expect(mem[0]!.isFirsthand).toBe(true);
    // Отношение к обидчику просело; место грабежа помечено обходом.
    expect(getRelation(w.resources, survivor, entitySubject(defender))).toBeCloseTo(-ROBBERY_RELATION_DELTA, 10);
    expect(isAvoided(w.resources, survivor, LOC, w.tick as number)).toBe(true);

    // ПАВШИЙ напарник (Alive снят) — ни памяти, ни отношений, ни обхода.
    expect(getMemory(w.resources, fallen)).toEqual([]);
    expect(getRelations(w.resources, fallen)).toEqual([]);
    expect(getAvoids(w.resources, fallen)).toEqual([]);
  });
});

describe('RobberyMemory + MemoryDecay: обход места грабежа гаснет по сроку (2.15, D-058)', () => {
  it('RobberyMemory ставит avoid; MemoryDecay снимает его на untilTick — место снова проходимо', () => {
    const w = createSimWorld(11 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w, 'bandits');
    const evId = commitRobbery(w, 100, victim, robber);
    RobberyMemory.update(ctxAt(w, 101));

    const until = 100 + ROBBERY_AVOID_DURATION_TICKS;
    expect(isAvoided(w.resources, victim, LOC, 101)).toBe(true);
    expect(getAvoids(w.resources, victim)).toEqual([[LOC, until]]);
    void evId;

    // MemoryDecay ДО истечения (untilTick ещё в будущем) — обход держится.
    w.tick = (until - 1) as Tick;
    MemoryDecay.update(ctxAt(w, until - 1));
    expect(getAvoids(w.resources, victim)).toEqual([[LOC, until]]); // ещё действует

    // MemoryDecay НА untilTick (until <= tick) — запись обхода истекла и снята.
    w.tick = until as Tick;
    MemoryDecay.update(ctxAt(w, until));
    expect(getAvoids(w.resources, victim)).toEqual([]); // обход снят самим MemoryDecay
    expect(isAvoided(w.resources, victim, LOC, until)).toBe(false);
    // Память об обидчике при этом ещё жива (обход < горизонта памяти) — травма дольше.
    expect(getMemory(w.resources, victim).length).toBeGreaterThan(0);
  });
});

describe('RobberyMemory: resume ≡ continuous (закон №8, P0)', () => {
  it('тот же лог+seed: непрерывный прогон конвейера === split через save/load', () => {
    /** Строит мир с 2 налётчиками vs защитник (выживший обчищен) — как выше. */
    function build(seed: number): SimWorld {
      const w = createSimWorld(seed as never);
      const fallen = placeFighter(w, { shooting: 0.9, hp: 12, inv: [{ item: 'canned', qty: 1 }], money: 30 });
      const survivor = placeFighter(w, { shooting: 0.9, hp: 12, inv: [{ item: 'canned', qty: 1 }], money: 30 });
      const defender = placeFighter(w, { shooting: 0.99, hp: HEALTH_MAX, inv: [{ item: 'ammo_9mm', qty: 64 }, { item: 'pm', qty: 1 }], money: 0 });
      makeRobber(w, fallen, defender);
      makeRobber(w, survivor, defender);
      return w;
    }

    // Непрерывно: бой (тик 0), затем память (тик 1).
    const cont = build(0);
    combatPhase().run(cont, 1);
    memoryPhase().run(cont, 1);

    // Split: тик боя, снапшот/восстановление, тик формирования памяти.
    const split = build(0);
    combatPhase().run(split, 1); // тик 0: бой+смерть+лут
    const restored = deserialize(serialize(split));
    memoryPhase().run(restored, 1); // тик 1: RobberyMemory на восстановленном мире

    // Записи памяти/обхода складываются ПОСЛЕ save/load так же, как без него.
    expect(hashSnapshot(serialize(restored))).toBe(hashSnapshot(serialize(cont)));
  });
});

describe('RobberyMemory: закон №6 — реакция через шину, а не прямой вызов Encounters', () => {
  it('память складывается из ЗАКОММИЧЕННОГО loot/transferred БЕЗ Encounters в планировщике', () => {
    // Развязка (закон №6): RobberyMemory не зовёт и не зависит от системы-источника —
    // она реагирует на ФАКТ в логе (bus.at(tick−1)). Доказательство: планировщик
    // содержит ТОЛЬКО RobberyMemory (ни Encounters, ни Death); событие грабежа кладём
    // в лог напрямую (как если бы его оставила давно отработавшая Encounters). Память
    // всё равно формируется ⇒ связь чисто через шину, а не вызовом Encounters.
    const w = createSimWorld(71 as never);
    const victim = placeHuman(w);
    const robber = placeHuman(w, 'bandits');
    const evId = commitRobbery(w, 5, victim, robber); // событие уже в логе (Encounters нет)

    const onlyMemory = createScheduler();
    onlyMemory.register(RobberyMemory); // ЕДИНСТВЕННАЯ система — источника рядом нет
    w.tick = 6 as Tick;
    onlyMemory.tickOnce(w); // тик 6 читает закоммиченный тик 5

    const mem = getMemory(w.resources, victim);
    expect(mem).toHaveLength(1);
    expect(mem[0]!.causeEvent).toBe(evId as number); // причинная линковка на событие лога
    expect(mem[0]!.subject).toBe(entitySubject(robber));
  });
});
