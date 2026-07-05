/**
 * @module @zona/sim/systems/rumors.test
 *
 * Гейт Rumors (задача 3.6, D-073) — СЛУХИ: услышанный эфир расходится молвой с искажением.
 * Покрывает контракт D-073 СИНТЕТИЧЕСКИ (инъекция radio/message/radio/relayed в лог +
 * расстановка слышащих в ECS + отношения в ResourceStore + прямой вызов Rumors.update, как
 * тесты Radio/Chronicle/RobberyMemory):
 *  - слышащие в loc + СОСЕДНИХ локациях (граф MAP) пишут ПАМЯТЬ СЛУХА isFirsthand=false;
 *    говорящий сам себя не слышит; не-смежная локация слуха не слышит;
 *  - salience = BASE_RUMOR_SALIENCE × trust: доверие ВРАГУ < НЕЗНАКОМЦУ < ДРУГУ (монотонно);
 *    фракционная репутация тоже сдвигает доверие;
 *  - болтун (talkativeness>=порог) → radio/relayed hop+1 с ИСКАЖЁННЫМИ params (count вырос),
 *    causedBy = sourceMessageId; молчун не ретранслирует; гейт hasComponent(Personality);
 *  - hop клампится RUMOR_MAX_HOP (на потолке пересказа нет);
 *  - искажение ДЕТЕРМИНИРОВАНО (fnv, не rng-поток): тот же source+relayer+hop → то же
 *    искажение; порядко-независимо; resume ≡ continuous;
 *  - renderMessage(radio/relayed) даёт искажённую plain-строку (закон №5);
 *  - реактивное окно каденции [T−CADENCE..T−1]: сообщение читается РОВНО раз; tick<CADENCE no-op;
 *  - изоляция: EconomyInvariant не затронут (нет money/inventory/fame); пустой мир 481914ae цел.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, LocationId, Seed, SimEvent, Subject, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, allEntities } from '../core/ecs';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import type { SystemCtx } from '../core/system';
import { Position, Human, Alive, Personality, Temperament } from '../core/components';
import {
  entitySubject,
  factionSubject,
  setRelation,
  getMemory,
} from './memory';
import { Rumors } from './rumors';
import { PHASE1_SYSTEMS, PHASE2_SYSTEMS, PHASE3_SYSTEMS } from '../pipeline';
import { parseTemplateId, renderMessage, makeTemplateId } from '../narrative/render';
import { getTemplatePool } from '../data/index';
import {
  RUMOR_CADENCE,
  BASE_RUMOR_SALIENCE,
  RUMOR_MAX_HOP,
  RUMOR_RELAY_TALKATIVENESS,
  RUMOR_TRUST_BASE,
  RUMOR_TRUST_SPREAD,
  RUMOR_COUNT_MIN_GROWTH,
  RUMOR_COUNT_GROWTH_SPREAD,
} from '../balance/narrative';

const LOC = 1 as LocationId; // Свалка — соседи [0,2,3]
const NEIGHBOR = 2 as LocationId; // Агропром — смежна LOC
const FAR = 5 as LocationId; // Бар «Росток» — НЕ смежна LOC (соседи [2,3,4,6])

/** SoA-колонки для установки состояния в тестах (миры идут последовательно, D-024). */
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const PERS = Personality as unknown as { temperament: Uint8Array; talkativeness: Float32Array };

/** Ручной ctx для прямого вызова Rumors.update на тике `tick`. */
function ctxAt(world: SimWorld, tick: number): SystemCtx {
  world.tick = tick as Tick;
  return { world, bus: world.bus, rng: world.rng.fork(`Rumors@${tick}`), tick: tick as Tick };
}

/** Гоняет Rumors на тике `tick` и КОММИТИТ его сообщения в лог (как планировщик, D-005). */
function runRumors(world: SimWorld, tick: number): void {
  Rumors.update(ctxAt(world, tick));
  world.bus.endTick(tick as Tick);
}

/** Публикует событие на тике `tick` и коммитит его; возвращает выданный id. */
function commit(world: SimWorld, tick: number, e: Omit<SimEvent, 'id' | 'tick'>): EventId {
  world.tick = tick as Tick;
  const id = world.bus.publish(e as never);
  world.bus.endTick(tick as Tick);
  return id;
}

/** Селит ЖИВОГО Human-слушателя (Human+Alive+Position+Personality) в локации `loc`. */
function placeHuman(
  world: SimWorld,
  loc: number,
  talkativeness = 0,
  temperament: number = Temperament.NEUTRAL,
): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Personality, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  PERS.talkativeness[eid] = talkativeness;
  PERS.temperament[eid] = temperament;
  return eid;
}

/** Живой Human БЕЗ Personality (страховка reuse-eid D-071): болтливость трактуется как 0. */
function placeMuteHuman(world: SimWorld, loc: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  return eid;
}

/** radio/message в эфире (первичный слух, hop 0). */
function radioMessage(
  speaker: EntityId,
  subjects: readonly Subject[],
  loc: LocationId,
  opts: { subject?: EntityId; count?: number; templateId?: string } = {},
): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'radio/message',
    causedBy: null,
    payload: {
      speakerEid: speaker,
      subjects,
      loc,
      templateId: opts.templateId ?? makeTemplateId('loot/transferred', 'neutral', 0),
      params: {
        speaker,
        ...(opts.subject === undefined ? {} : { subject: opts.subject }),
        loc,
        ...(opts.count === undefined ? {} : { count: opts.count }),
      },
      isFirsthand: true,
    },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/** radio/relayed в эфире (пересказ на хопе `hop`). */
function radioRelayed(
  speaker: EntityId,
  subjects: readonly Subject[],
  loc: LocationId,
  hop: number,
  sourceMessageId: EventId,
  opts: { count?: number; templateId?: string } = {},
): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'radio/relayed',
    causedBy: sourceMessageId,
    payload: {
      speakerEid: speaker,
      subjects,
      loc,
      sourceMessageId,
      hop,
      templateId: opts.templateId ?? makeTemplateId('encounter/started', 'neutral', 0),
      params: { speaker, loc, ...(opts.count === undefined ? {} : { count: opts.count }) },
      isFirsthand: false,
    },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/** radio/relayed события лога. */
function relayed(world: SimWorld): Extract<SimEvent, { type: 'radio/relayed' }>[] {
  return world.bus.log.filter((e) => e.type === 'radio/relayed') as Extract<
    SimEvent,
    { type: 'radio/relayed' }
  >[];
}

// ═══════════════════════════════════════════════════════════════════════════
describe('Rumors: память слуха у слышащих в loc + соседних локациях (isFirsthand=false)', () => {
  it('слушатели в loc и в СОСЕДНЕЙ локации пишут память слуха; в не-смежной — нет', () => {
    const w = createSimWorld(1 as Seed);
    const speaker = 100 as EntityId; // говорящий (внешний eid, не носитель ECS)
    const subj = 200 as EntityId;
    const here = placeHuman(w, LOC); // в локации вещания
    const near = placeHuman(w, NEIGHBOR); // в соседней локации
    const far = placeHuman(w, FAR); // вне слышимости

    const mid = commit(w, RUMOR_CADENCE - 1, radioMessage(speaker, [entitySubject(subj)], LOC, { subject: subj }));
    runRumors(w, RUMOR_CADENCE); // окно [0 .. CADENCE−1] содержит сообщение

    const subject = entitySubject(subj);
    const hereMem = getMemory(w.resources, here).filter((r) => r.kind === 'rumor');
    const nearMem = getMemory(w.resources, near).filter((r) => r.kind === 'rumor');
    const farMem = getMemory(w.resources, far).filter((r) => r.kind === 'rumor');

    expect(hereMem).toHaveLength(1);
    expect(nearMem).toHaveLength(1);
    expect(farMem).toEqual([]); // не-смежная локация слуха не слышит
    // Запись — слух (isFirsthand=false), о субъекте сообщения, причина = id услышанного эфира.
    expect(hereMem[0]!.isFirsthand).toBe(false);
    expect(hereMem[0]!.subject).toBe(subject);
    expect(hereMem[0]!.causeEvent).toBe(mid); // D-038: слух ← сообщение
  });

  it('говорящий САМ СЕБЯ не слышит (не пишет память о собственном сообщении)', () => {
    const w = createSimWorld(2 as Seed);
    const speaker = placeHuman(w, LOC); // говорящий — носитель ECS в LOC
    const other = placeHuman(w, LOC);
    commit(w, RUMOR_CADENCE - 1, radioMessage(speaker, [entitySubject(300 as EntityId)], LOC, { subject: 300 as EntityId }));
    runRumors(w, RUMOR_CADENCE);

    expect(getMemory(w.resources, speaker).filter((r) => r.kind === 'rumor')).toEqual([]);
    expect(getMemory(w.resources, other).filter((r) => r.kind === 'rumor')).toHaveLength(1);
  });
});

describe('Rumors: доверие к источнику масштабирует salience (враг < незнакомец < друг)', () => {
  function salienceWithRelation(rel: number): number {
    const w = createSimWorld(3 as Seed);
    const speaker = 100 as EntityId;
    const subj = 200 as EntityId;
    const hearer = placeHuman(w, LOC);
    if (rel !== 0) setRelation(w.resources, hearer, entitySubject(speaker), rel);
    commit(w, RUMOR_CADENCE - 1, radioMessage(speaker, [entitySubject(subj)], LOC, { subject: subj }));
    runRumors(w, RUMOR_CADENCE);
    const mem = getMemory(w.resources, hearer).filter((r) => r.kind === 'rumor');
    expect(mem).toHaveLength(1);
    return mem[0]!.salience;
  }

  it('salience(враг) < salience(незнакомец) < salience(друг) — монотонно по отношению', () => {
    const enemy = salienceWithRelation(-0.8);
    const anon = salienceWithRelation(0);
    const friend = salienceWithRelation(0.8);
    expect(enemy).toBeLessThan(anon);
    expect(anon).toBeLessThan(friend);
    // Незнакомец = база доверия × BASE_RUMOR_SALIENCE (нейтральный сигнал 0 → trust 0.5).
    expect(anon).toBeCloseTo(BASE_RUMOR_SALIENCE * 0.5, 6);
    // Слух ВСЕГДА слабее свежей личной памяти (MEMORY_INITIAL_SALIENCE = 1).
    expect(friend).toBeLessThan(1);
  });

  it('фракционная репутация источника тоже сдвигает доверие (враждебная фракция → ниже)', () => {
    // Источник известной фракции; слушатель плохо относится к самой фракции (f:<faction>).
    const wHostile = createSimWorld(4 as Seed);
    const speaker = 100 as EntityId;
    const subj = 200 as EntityId;
    const hearer = placeHuman(wHostile, LOC);
    wHostile.resources.set('faction', speaker, 'bandits');
    setRelation(wHostile.resources, hearer, factionSubject('bandits'), -0.8);
    commit(wHostile, RUMOR_CADENCE - 1, radioMessage(speaker, [entitySubject(subj)], LOC, { subject: subj }));
    runRumors(wHostile, RUMOR_CADENCE);
    const hostile = getMemory(wHostile.resources, hearer).filter((r) => r.kind === 'rumor')[0]!.salience;

    // Контроль: тот же источник, но репутации нет (нейтрал).
    const wNeutral = createSimWorld(4 as Seed);
    const h2 = placeHuman(wNeutral, LOC);
    wNeutral.resources.set('faction', speaker, 'bandits');
    commit(wNeutral, RUMOR_CADENCE - 1, radioMessage(speaker, [entitySubject(subj)], LOC, { subject: subj }));
    runRumors(wNeutral, RUMOR_CADENCE);
    const neutral = getMemory(wNeutral.resources, h2).filter((r) => r.kind === 'rumor')[0]!.salience;

    expect(hostile).toBeLessThan(neutral); // репутация фракции роняет доверие к её вестнику
  });
});

describe('Rumors: ретрансляция болтуном с искажением (§8.2)', () => {
  it('болтун (talkativeness>=порог) → radio/relayed hop+1, count раздут, causedBy=sourceMessageId', () => {
    const w = createSimWorld(5 as Seed);
    const speaker = 100 as EntityId;
    const combatant = 200 as EntityId;
    const talker = placeHuman(w, LOC, RUMOR_RELAY_TALKATIVENESS); // ровно на пороге — ретранслирует
    const baseCount = 2;
    const mid = commit(
      w,
      RUMOR_CADENCE - 1,
      radioMessage(speaker, [entitySubject(combatant)], LOC, {
        count: baseCount,
        templateId: makeTemplateId('encounter/started', 'neutral', 0),
      }),
    );
    runRumors(w, RUMOR_CADENCE);

    const rel = relayed(w);
    expect(rel).toHaveLength(1);
    const p = rel[0]!.payload;
    expect(p.speakerEid).toBe(talker); // ретранслятор говорит от себя
    expect(p.hop).toBe(1); // первый пересказ radio/message (hop 0 → 1)
    expect(p.sourceMessageId).toBe(mid);
    expect(rel[0]!.causedBy).toBe(mid); // причина = услышанное сообщение (D-030)
    expect(p.isFirsthand).toBe(false);
    expect(p.loc).toBe(LOC); // вещает из своей локации
    // ИСКАЖЕНИЕ: count раздут монотонно (§8.2 «двое → отряд»); speaker → ретранслятор.
    expect(p.params.count!).toBeGreaterThan(baseCount);
    expect(p.params.speaker).toBe(talker);
    // subjects/subject не искажены (искажается масштаб/слова, не факт «о ком»).
    expect(p.subjects).toEqual([entitySubject(combatant)]);
  });

  it('молчун (talkativeness<порог) слушает, но НЕ ретранслирует', () => {
    const w = createSimWorld(6 as Seed);
    const quiet = placeHuman(w, LOC, RUMOR_RELAY_TALKATIVENESS - 0.2);
    commit(w, RUMOR_CADENCE - 1, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { subject: 200 as EntityId, count: 2 }));
    runRumors(w, RUMOR_CADENCE);
    expect(relayed(w)).toEqual([]); // пересказа нет
    expect(getMemory(w.resources, quiet).filter((r) => r.kind === 'rumor')).toHaveLength(1); // но помнит
  });

  it('слушатель БЕЗ Personality не ретранслирует (гейт hasComponent, D-071)', () => {
    const w = createSimWorld(7 as Seed);
    placeMuteHuman(w, LOC); // болтливость трактуется как 0 (нет компонента)
    commit(w, RUMOR_CADENCE - 1, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
    runRumors(w, RUMOR_CADENCE);
    expect(relayed(w)).toEqual([]);
  });

  it('темперамент ретранслятора перекрашивает templateId (пересказ его словами)', () => {
    const w = createSimWorld(8 as Seed);
    const talker = placeHuman(w, LOC, 1, Temperament.PANICKY);
    commit(
      w,
      RUMOR_CADENCE - 1,
      radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, {
        count: 2,
        templateId: makeTemplateId('encounter/started', 'veteran', 1),
      }),
    );
    runRumors(w, RUMOR_CADENCE);
    const p = relayed(w)[0]!.payload;
    // Тон пересказа — темперамент РЕТРАНСЛЯТОРА (паникёр), а тип события сохранён.
    expect(parseTemplateId(p.templateId)?.temperament).toBe('panicky');
    expect(parseTemplateId(p.templateId)?.eventType).toBe('encounter/started');
    void talker;
  });
});

describe('Rumors: потолок хопов (RUMOR_MAX_HOP) обрывает молву', () => {
  it('на hop = RUMOR_MAX_HOP пересказа НЕТ; на hop = MAX−1 — ещё есть (hop→MAX)', () => {
    // hop на потолке — цепочка гаснет.
    const wMax = createSimWorld(9 as Seed);
    const talkerMax = placeHuman(wMax, LOC, 1);
    const src = commit(wMax, RUMOR_CADENCE - 1, radioMessage(999 as EntityId, [entitySubject(200 as EntityId)], FAR, { count: 2 }));
    commit(wMax, RUMOR_CADENCE - 1 + 1, radioRelayed(500 as EntityId, [entitySubject(200 as EntityId)], LOC, RUMOR_MAX_HOP, src, { count: 5 }));
    runRumors(wMax, 2 * RUMOR_CADENCE); // окно охватывает оба тика
    expect(relayed(wMax).filter((e) => e.payload.hop > RUMOR_MAX_HOP)).toEqual([]);
    // Слушатель всё же слышал (память есть), но дальше не понёс.
    expect(getMemory(wMax.resources, talkerMax).filter((r) => r.kind === 'rumor').length).toBeGreaterThan(0);

    // hop = MAX−1 → пересказ рождается с hop = MAX.
    const wEdge = createSimWorld(9 as Seed);
    placeHuman(wEdge, LOC, 1);
    const src2 = commit(wEdge, RUMOR_CADENCE - 1, radioMessage(999 as EntityId, [entitySubject(200 as EntityId)], FAR, { count: 2 }));
    commit(wEdge, RUMOR_CADENCE, radioRelayed(500 as EntityId, [entitySubject(200 as EntityId)], LOC, RUMOR_MAX_HOP - 1, src2, { count: 5 }));
    runRumors(wEdge, 2 * RUMOR_CADENCE);
    const edge = relayed(wEdge).filter((e) => e.payload.speakerEid !== (500 as EntityId));
    expect(edge).toHaveLength(1);
    expect(edge[0]!.payload.hop).toBe(RUMOR_MAX_HOP);
  });
});

describe('Rumors: искажение ДЕТЕРМИНИРОВАНО (fnv, не rng-поток; D-073/закон №8)', () => {
  function relayScenario(seed: number): unknown {
    const w = createSimWorld(seed as Seed);
    placeHuman(w, LOC, 1);
    commit(w, RUMOR_CADENCE - 1, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
    runRumors(w, RUMOR_CADENCE);
    const p = relayed(w)[0]!.payload;
    return { tpl: p.templateId, count: p.params.count, hop: p.hop };
  }

  it('тот же source+relayer+hop → то же искажение (два прогона идентичны)', () => {
    expect(relayScenario(30)).toEqual(relayScenario(30));
    // Разный seed мира не влияет: искажение — чистая fnv стабильных id (не rootSeed).
    expect(relayScenario(30)).toEqual(relayScenario(777));
  });

  it('искажение ПОРЯДКО-НЕЗАВИСИМО: соседнее сообщение в окне не сдвигает искажение', () => {
    const solo = createSimWorld(31 as Seed);
    placeHuman(solo, LOC, 1);
    const eSolo = commit(solo, RUMOR_CADENCE - 1, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
    runRumors(solo, RUMOR_CADENCE);
    const tplSolo = relayed(solo).find((e) => e.payload.sourceMessageId === eSolo)!.payload;

    const paired = createSimWorld(31 as Seed);
    placeHuman(paired, LOC, 1);
    paired.tick = (RUMOR_CADENCE - 1) as Tick;
    const ePaired = paired.bus.publish(radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }) as never);
    paired.bus.publish(radioMessage(101 as EntityId, [entitySubject(201 as EntityId)], LOC, { count: 9 }) as never); // сосед по окну
    paired.bus.endTick((RUMOR_CADENCE - 1) as Tick);
    runRumors(paired, RUMOR_CADENCE);

    expect(ePaired).toBe(eSolo); // id первого сообщения не сдвинулся
    const tplPaired = relayed(paired).find((e) => e.payload.sourceMessageId === ePaired)!.payload;
    expect(tplPaired.templateId).toBe(tplSolo.templateId);
    expect(tplPaired.params.count).toBe(tplSolo.params.count); // искажение не зависит от соседа
  });

  it('resume ≡ continuous: снапшот между эфиром и слухом → тот же пересказ', () => {
    function build(seed: number): SimWorld {
      const w = createSimWorld(seed as Seed);
      placeHuman(w, LOC, 1, Temperament.VETERAN); // тон+болтливость должны пережить save/load
      commit(w, RUMOR_CADENCE - 1, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
      return w;
    }
    const cont = build(32);
    runRumors(cont, RUMOR_CADENCE);
    const contRel = relayed(cont)[0]!.payload;

    const resumed = deserialize(serialize(build(32))); // save→load посреди причинной цепочки
    runRumors(resumed, RUMOR_CADENCE);
    const resRel = relayed(resumed)[0]!.payload;

    expect(resRel.templateId).toBe(contRel.templateId);
    expect(resRel.params).toEqual(contRel.params);
    expect(resRel.hop).toBe(contRel.hop);
  });
});

describe('Rumors: renderMessage(radio/relayed) даёт искажённую plain-строку (закон №5)', () => {
  it('пересказ рендерится в непустую НЕ-фолбэк строку без разметки', () => {
    const w = createSimWorld(40 as Seed);
    const talker = placeHuman(w, LOC, 1);
    commit(
      w,
      RUMOR_CADENCE - 1,
      radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, {
        count: 2,
        templateId: makeTemplateId('encounter/started', 'neutral', 0),
      }),
    );
    runRumors(w, RUMOR_CADENCE);
    const p = relayed(w)[0]!.payload;

    const str = renderMessage(
      { templateId: p.templateId, params: p.params },
      { nameOf: (r) => (r === talker ? 'Болтун' : String(r)), locOf: (l) => (l === LOC ? 'Свалка' : String(l)) },
    );
    expect(str.length).toBeGreaterThan(0);
    expect(str).not.toBe('…в эфире только треск помех…'); // валидный шаблон, не фолбэк
    expect(str).not.toContain('{'); // все плейсхолдеры разрешены
    expect(str).not.toMatch(/[<>]/); // plain-текст (закон №5)
  });
});

describe('Rumors: реактивное окно каденции [T−CADENCE..T−1] (закон №6, D-005)', () => {
  it('сообщение читается РОВНО раз; tick<CADENCE — no-op', () => {
    const w = createSimWorld(50 as Seed);
    placeHuman(w, LOC, 1);
    expect(() => Rumors.update(ctxAt(w, 0))).not.toThrow(); // окна нет — no-op

    commit(w, RUMOR_CADENCE - 1, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
    runRumors(w, RUMOR_CADENCE); // окно [0..CADENCE−1] содержит сообщение — ровно один пересказ
    expect(relayed(w)).toHaveLength(1);
    // Следующее окно [CADENCE..2·CADENCE−1] содержит ТОЛЬКО эмитированный пересказ (hop1),
    // а он породит hop2 — но исходное radio/message повторно НЕ читается (окно ушло вперёд).
    const before = relayed(w).filter((e) => e.payload.hop === 1).length;
    runRumors(w, 2 * RUMOR_CADENCE);
    expect(relayed(w).filter((e) => e.payload.hop === 1).length).toBe(before); // hop1 не удвоился
  });
});

describe('Rumors: изоляция — молва не творит массу (EconomyInvariant не затронут, закон №3)', () => {
  it('после слуха нет money/inventory/fame (только память слуха)', () => {
    const w = createSimWorld(60 as Seed);
    placeHuman(w, LOC, 1);
    commit(w, RUMOR_CADENCE - 1, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
    runRumors(w, RUMOR_CADENCE);
    expect(relayed(w).length).toBeGreaterThan(0); // молва прозвучала…
    const keys = w.resources.keys();
    expect(keys).not.toContain('money');
    expect(keys).not.toContain('inventory');
    expect(keys).not.toContain('fame');
    expect(keys).toContain('memory'); // …но лишь память слуха (дизъюнктна массе)
  });

  it('пустой мир 481914ae цел — система вне конвейера, слух по пустоте no-op', () => {
    const empty = createSimWorld(0 as Seed);
    expect(hashSnapshot(serialize(empty))).toBe('481914ae');
    for (let t = RUMOR_CADENCE; t <= 3 * RUMOR_CADENCE; t += RUMOR_CADENCE) runRumors(empty, t);
    expect(relayed(empty)).toEqual([]);
    expect(allEntities(empty.ecs)).toEqual([]);
    expect(empty.resources.keys()).toEqual([]);
    empty.tick = 0 as Tick;
    expect(hashSnapshot(serialize(empty))).toBe('481914ae');
  });
});

describe('Rumors: два прогона одного сценария побитово идентичны (детерминизм, закон №8)', () => {
  it('несколько слышащих (память + пересказы) → одинаковый результат в обоих прогонах', () => {
    function run(seed: number): unknown {
      const w = createSimWorld(seed as Seed);
      placeHuman(w, LOC, 1, Temperament.PANICKY);
      placeHuman(w, NEIGHBOR, 1, Temperament.TALKER);
      placeHuman(w, LOC, 0); // молчун — только помнит
      commit(w, RUMOR_CADENCE - 1, radioMessage(500 as EntityId, [entitySubject(600 as EntityId)], LOC, { count: 2 }));
      runRumors(w, RUMOR_CADENCE);
      return relayed(w).map((e) => ({
        sp: e.payload.speakerEid,
        tpl: e.payload.templateId,
        hop: e.payload.hop,
        params: e.payload.params,
        causedBy: e.causedBy,
      }));
    }
    expect(run(70)).toEqual(run(70));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// УСИЛЕНИЕ 3.6 (D-073): компаунд-искажение вдоль цепочки, эквивалент EconomyInvariant,
// точная формула trust→salience с клампом, границы окна каденции, детерминизм порядка,
// стабильность «где» (params.loc) при кочующем вещании, голден-гварды конвейера.

/**
 * «Молва ползёт по карте линией пересказчиков»: примарный эфир слышит ТОЛЬКО A (loc 1),
 * его пересказ (loc 1) слышит ТОЛЬКО B (loc 0, сосед лишь единицы), пересказ B (loc 0) —
 * снова A. За три окна каденции слух проходит hop 1→2→3 одной цепочкой, без ветвлений:
 * так проверяется КОМПАУНД искажения (§8.2 «двое→отряд→банда») в чистом виде.
 */
function relayChain(
  seed: number,
  baseCount: number,
  eventLoc: LocationId,
): Extract<SimEvent, { type: 'radio/relayed' }>[] {
  const w = createSimWorld(seed as Seed);
  const A = placeHuman(w, 1, 1); // loc 1 — слышит примарный (loc3 сосед единицы)
  const B = placeHuman(w, 0, 1); // loc 0 — сосед ТОЛЬКО единицы, слышит лишь пересказ A
  void A;
  void B;
  // Примарный эфир из loc3: слышит A (loc1 ∈ соседи 3), НЕ слышит B (loc0 ∉ соседи 3).
  commit(
    w,
    RUMOR_CADENCE - 1,
    radioMessage(900 as EntityId, [entitySubject(700 as EntityId)], eventLoc, {
      count: baseCount,
      templateId: makeTemplateId('encounter/started', 'neutral', 0),
    }),
  );
  runRumors(w, RUMOR_CADENCE); // hop1 (A, из loc1)
  runRumors(w, 2 * RUMOR_CADENCE); // hop2 (B, из loc0)
  runRumors(w, 3 * RUMOR_CADENCE); // hop3 (A, из loc1) — потолок
  runRumors(w, 4 * RUMOR_CADENCE); // ничего: hop3 на потолке
  return relayed(w);
}

describe('Rumors: КОМПАУНД искажения вдоль цепочки пересказов (§8.2 «двое→отряд→банда»)', () => {
  it('count раздувается МОНОТОННО хоп за хопом; «где»(params.loc) стабильно, вещание кочует', () => {
    const EVENT_LOC = 3 as LocationId; // место события (в params.loc) ≠ точки вещания хопов
    const BASE = 2; // «двое»
    const chain = relayChain(80, BASE, EVENT_LOC);

    // Ровно один пересказ на каждом хопе (линия без ветвлений): hop 1, 2, 3.
    expect(chain.map((e) => e.payload.hop)).toEqual([1, 2, 3]);

    // Прослеживаем ЛИНИЮ по sourceMessageId: каждый пересказ ссылается на предыдущий,
    // а causedBy == sourceMessageId (цепочка причин ведёт назад к примарному эфиру, D-030).
    const hop1 = chain.find((e) => e.payload.hop === 1)!;
    const hop2 = chain.find((e) => e.payload.hop === 2)!;
    const hop3 = chain.find((e) => e.payload.hop === 3)!;
    expect(hop2.payload.sourceMessageId).toBe(hop1.id);
    expect(hop3.payload.sourceMessageId).toBe(hop2.id);
    expect(hop1.causedBy).toBe(hop1.payload.sourceMessageId);
    expect(hop2.causedBy).toBe(hop2.payload.sourceMessageId);
    expect(hop3.causedBy).toBe(hop3.payload.sourceMessageId);

    // МАСШТАБ раздут строго вверх на каждом хопе (компаунд): base < c1 < c2 < c3.
    const c1 = hop1.payload.params.count!;
    const c2 = hop2.payload.params.count!;
    const c3 = hop3.payload.params.count!;
    expect(c1).toBeGreaterThan(BASE);
    expect(c2).toBeGreaterThan(c1);
    expect(c3).toBeGreaterThan(c2);
    // Прирост каждого хопа в коридоре [MIN .. MIN+SPREAD−1] (fnv-отсебятина поверх минимума).
    for (const [prev, next] of [[BASE, c1], [c1, c2], [c2, c3]] as const) {
      const g = next - prev;
      expect(g).toBeGreaterThanOrEqual(RUMOR_COUNT_MIN_GROWTH);
      expect(g).toBeLessThanOrEqual(RUMOR_COUNT_MIN_GROWTH + RUMOR_COUNT_GROWTH_SPREAD - 1);
    }
    // Итоговый count цепочки = base + Σ приростов ⇒ строго между base+3·MIN и base+3·(MIN+SPREAD−1).
    expect(c3).toBeGreaterThanOrEqual(BASE + 3 * RUMOR_COUNT_MIN_GROWTH);

    // «ГДЕ» (место события в params.loc) НЕ искажается — стабильно вдоль всей цепочки…
    expect(hop1.payload.params.loc).toBe(EVENT_LOC);
    expect(hop2.payload.params.loc).toBe(EVENT_LOC);
    expect(hop3.payload.params.loc).toBe(EVENT_LOC);
    // …а точка ВЕЩАНИЯ (payload.loc) кочует по карте (loc ретранслятора): 1 → 0 → 1.
    expect([hop1.payload.loc, hop2.payload.loc, hop3.payload.loc]).toEqual([1, 0, 1]);
    // «КТО» (subjects — участники исходного события) переносится без изменений.
    for (const e of chain) expect(e.payload.subjects).toEqual([entitySubject(700 as EntityId)]);
  });

  it('вся цепочка ДЕТЕРМИНИРОВАНА (fnv стабильных id): два независимых прогона совпадают', () => {
    const a = relayChain(81, 2, 3 as LocationId).map((e) => ({
      hop: e.payload.hop,
      tpl: e.payload.templateId,
      count: e.payload.params.count,
    }));
    const b = relayChain(81, 2, 3 as LocationId).map((e) => ({
      hop: e.payload.hop,
      tpl: e.payload.templateId,
      count: e.payload.params.count,
    }));
    expect(a).toEqual(b);
  });
});

describe('Rumors: salience = BASE_RUMOR_SALIENCE × trust, клампится в коридор доверия [0.1..0.9]', () => {
  function salienceWithRelation(rel: number): number {
    const w = createSimWorld(90 as Seed);
    const speaker = 100 as EntityId;
    const hearer = placeHuman(w, LOC);
    if (rel !== 0) setRelation(w.resources, hearer, entitySubject(speaker), rel);
    commit(w, RUMOR_CADENCE - 1, radioMessage(speaker, [entitySubject(200 as EntityId)], LOC, { subject: 200 as EntityId }));
    runRumors(w, RUMOR_CADENCE);
    return getMemory(w.resources, hearer).filter((r) => r.kind === 'rumor')[0]!.salience;
  }

  it('точные опорные точки: враг(−1)→0.05, незнакомец(0)→0.25, друг(+1)→0.45', () => {
    // trust = clamp01(BASE + SPREAD·signal); signal ∈ [−1..1] ⇒ trust ∈ [0.1..0.9].
    const trustEnemy = RUMOR_TRUST_BASE - RUMOR_TRUST_SPREAD; // 0.1
    const trustAnon = RUMOR_TRUST_BASE; // 0.5
    const trustFriend = RUMOR_TRUST_BASE + RUMOR_TRUST_SPREAD; // 0.9
    expect(salienceWithRelation(-1)).toBeCloseTo(BASE_RUMOR_SALIENCE * trustEnemy, 6); // 0.05
    expect(salienceWithRelation(0)).toBeCloseTo(BASE_RUMOR_SALIENCE * trustAnon, 6); // 0.25
    expect(salienceWithRelation(1)).toBeCloseTo(BASE_RUMOR_SALIENCE * trustFriend, 6); // 0.45
  });

  it('доверие НЕ обнуляется даже у злейшего врага (враг всё же что-то откладывает)', () => {
    // setRelation клампит rel в [−1..1] ⇒ trust не проваливается ниже BASE−SPREAD>0.
    const worst = salienceWithRelation(-1);
    expect(worst).toBeGreaterThan(0); // враг не стирает слух в ноль
    expect(worst).toBeLessThan(BASE_RUMOR_SALIENCE); // но он заметно бледнее нейтрального
  });
});

/** Локальный аналог headless `worldTotals` (закон №3): Σ money + Σ inventory.qty по item. */
function worldMass(w: SimWorld): { money: number; items: Map<string, number> } {
  let money = 0;
  for (const [, m] of w.resources.entries<number>('money')) money += m;
  const items = new Map<string, number>();
  for (const [, inv] of w.resources.entries<readonly { item: string; qty: number }[]>('inventory')) {
    for (const e of inv) items.set(e.item, (items.get(e.item) ?? 0) + e.qty);
  }
  return { money, items };
}

describe('Rumors: масса мира СОХРАНЯЕТСЯ (эквивалент assertEconomyInvariant, закон №3)', () => {
  it('слух с памятью и пересказами не творит ни денег, ни предметов (Σ до == Σ после)', () => {
    const w = createSimWorld(95 as Seed);
    const talker = placeHuman(w, LOC, 1); // болтун — будет пересказывать
    const quiet = placeHuman(w, NEIGHBOR, 0); // молчун — только память
    // Даём слышащим РЕАЛЬНУЮ массу: деньги и инвентарь (как после worldgen).
    w.resources.set('money', talker, 120);
    w.resources.set('money', quiet, 45);
    w.resources.set('inventory', talker, [{ item: 'ammo', qty: 30 }, { item: 'bread', qty: 2 }]);
    w.resources.set('inventory', quiet, [{ item: 'medkit', qty: 1 }]);

    const before = worldMass(w);
    commit(w, RUMOR_CADENCE - 1, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
    runRumors(w, RUMOR_CADENCE);
    runRumors(w, 2 * RUMOR_CADENCE); // ещё окно (пересказ пересказа) — масса всё равно цела
    const after = worldMass(w);

    expect(relayed(w).length).toBeGreaterThan(0); // молва реально прозвучала…
    // …но замкнутая экономика неизменна — эквивалент проверки assertEconomyInvariant.
    expect(after.money).toBe(before.money);
    expect([...after.items.entries()].sort()).toEqual([...before.items.entries()].sort());
    // Ни одного ledger-события массы (radio/relayed — нарратив, не item/*).
    expect(w.bus.log.filter((e) => e.type.startsWith('item/'))).toEqual([]);
    // Единственный тронутый «экономический» ключ — 'memory' (дизъюнктный money/inventory).
    expect(w.resources.keys()).toContain('memory');
  });
});

describe('Rumors: границы окна каденции [T−CADENCE .. T−1] (закон №6, D-005)', () => {
  it('сообщение на СТАРТЕ окна (tick 0) слышно; на ГРАНИЦЕ tick=T (текущий) — ещё нет, читается позже', () => {
    // Событие на самом раннем тике окна [0..CADENCE−1] — включено (нижняя граница inclusive).
    const wStart = createSimWorld(96 as Seed);
    placeHuman(wStart, LOC, 1);
    commit(wStart, 0, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
    runRumors(wStart, RUMOR_CADENCE);
    expect(relayed(wStart)).toHaveLength(1); // старт окна услышан

    // Событие на тике T (== момент прогона) НЕ входит в окно [T−CADENCE..T−1] (верхняя граница
    // exclusive) — не читается сейчас, но попадёт в СЛЕДУЮЩЕЕ окно ровно один раз (не потеряно).
    const wEdge = createSimWorld(96 as Seed);
    placeHuman(wEdge, LOC, 1);
    commit(wEdge, RUMOR_CADENCE, radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, { count: 2 }));
    runRumors(wEdge, RUMOR_CADENCE); // окно [0..CADENCE−1] — событие тика CADENCE вне окна
    expect(relayed(wEdge)).toEqual([]); // текущий тик не пересказан (нет опережающего чтения)
    runRumors(wEdge, 2 * RUMOR_CADENCE); // окно [CADENCE..2·CADENCE−1] — теперь читается
    expect(relayed(wEdge)).toHaveLength(1); // ровно раз (без пропуска и без задвоения)
  });
});

describe('Rumors: слышащие обрабатываются в порядке eid (детерминизм, закон №8)', () => {
  it('несколько болтунов в loc → пересказы идут по возрастанию eid ретранслятора', () => {
    const w = createSimWorld(97 as Seed);
    const a = placeHuman(w, LOC, 1);
    const b = placeHuman(w, LOC, 1);
    const c = placeHuman(w, NEIGHBOR, 1); // соседняя локация — тоже слышит
    commit(w, RUMOR_CADENCE - 1, radioMessage(999 as EntityId, [entitySubject(300 as EntityId)], LOC, { count: 2 }));
    runRumors(w, RUMOR_CADENCE);
    const speakers = relayed(w).map((e) => e.payload.speakerEid as number);
    expect(speakers).toEqual([a, b, c].map((e) => e as number).sort((x, y) => x - y));
    // Строго возрастает — очередь пересказов детерминирована сортировкой queryEntities.
    for (let i = 1; i < speakers.length; i++) expect(speakers[i]!).toBeGreaterThan(speakers[i - 1]!);
  });
});

describe('Rumors: искажённый масштаб ВИДЕН в plain-строке пересказа (закон №5)', () => {
  // Тон-перекраска (distortTemplate) может выбрать fnv-индексом шаблон БЕЗ {count} —
  // тогда масштаб живёт лишь в params и в строку не течёт (норма контента). Но КОГДА
  // выбрана count-несущая формулировка, молва обязана назвать именно РАЗДУТОЕ число.
  const render = (
    w: SimWorld,
    p: Extract<SimEvent, { type: 'radio/relayed' }>['payload'],
  ): string =>
    renderMessage(
      { templateId: p.templateId, params: p.params },
      { nameOf: (r) => `Болтун#${String(r)}`, locOf: (l) => (l === LOC ? 'Свалка' : String(l)) },
    );

  it('пересказ рендерится в plain-строку; при count-несущем шаблоне звучит именно раздутое число', () => {
    const baseCount = 2;
    let sawCountTemplate = false;
    // Искажение — fnv(sourceMessageId, relayerEid, hop). Свипаем РЕТРАНСЛЯТОРА (сдвигаем eid
    // болтуна филлерами), пока fnv не выберет count-несущую формулировку — детерминированно,
    // без rng-шанса.
    for (let filler = 0; filler < 40; filler++) {
      const w = createSimWorld((98 + filler) as Seed);
      for (let f = 0; f < filler; f++) spawnEntity(w.ecs); // сдвигаем eid болтуна
      placeHuman(w, LOC, 1);
      commit(
        w,
        RUMOR_CADENCE - 1,
        radioMessage(100 as EntityId, [entitySubject(200 as EntityId)], LOC, {
          count: baseCount,
          templateId: makeTemplateId('encounter/started', 'neutral', 0),
        }),
      );
      runRumors(w, RUMOR_CADENCE);
      const p = relayed(w)[0]!.payload;
      const inflated = p.params.count!;
      expect(inflated).toBeGreaterThan(baseCount); // масштаб всегда раздут в params

      const str = render(w, p);
      expect(str.length).toBeGreaterThan(0);
      expect(str).not.toBe('…в эфире только треск помех…'); // валидный шаблон, не фолбэк
      expect(str).not.toContain('{'); // все плейсхолдеры разрешены

      const parsed = parseTemplateId(p.templateId)!;
      const template = getTemplatePool(parsed.eventType, parsed.temperament)![parsed.index]!;
      if (template.includes('{count}')) {
        sawCountTemplate = true;
        expect(str).toContain(String(inflated)); // раздутое число звучит вслух…
        expect(str).not.toContain(String(baseCount)); // …а исходное «двое» — нет
      }
    }
    expect(sawCountTemplate).toBe(true); // хотя бы одна count-несущая формулировка встретилась
  });
});

describe('Rumors: проводка в конвейер — ТОЛЬКО Фаза 3 (D-074), не Фаза 1/2', () => {
  it('Rumors подключена в PHASE3_SYSTEMS, но НЕ в Фазе 1/2 (нарратив — слой Фазы 3)', () => {
    // Задача 3.7 (D-074) включила молву в ЖИВОЙ конвейер — но только в Фазе 3. Ранние
    // конвейеры (Ф1/Ф2) её не знают (иначе поехали бы их физические голдены). Тест
    // фиксирует ИМЕННО эту проводку: Rumors ∈ Phase3, Rumors ∉ Phase1/Phase2.
    expect(PHASE3_SYSTEMS as readonly unknown[]).toContain(Rumors);
    expect(PHASE1_SYSTEMS as readonly unknown[]).not.toContain(Rumors);
    expect(PHASE2_SYSTEMS as readonly unknown[]).not.toContain(Rumors);
    const earlyNames = [...PHASE1_SYSTEMS, ...PHASE2_SYSTEMS].map((s) => s.name);
    expect(earlyNames).not.toContain('Rumors');
  });
});
