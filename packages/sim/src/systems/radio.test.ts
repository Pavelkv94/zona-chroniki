/**
 * @module @zona/sim/systems/radio.test
 *
 * Гейт Radio (задача 3.5, D-070) — РАДИО-ЭФИР: озвучка значимых событий их НАБЛЮДАТЕЛЯМИ.
 * Покрывает контракт D-070 СИНТЕТИЧЕСКИ (инъекция событий в лог + расстановка наблюдателей
 * в ECS + прямой вызов Radio.update, как тесты Chronicle/RobberyMemory):
 *  - значимое событие с наблюдателем → radio/message с правильными speaker/subjects/loc/
 *    templateId/causedBy/isFirsthand=true; ниже порога → нет сообщения; нет наблюдателя → нет;
 *  - смерть → говорит СВИДЕТЕЛЬ, а не жертва (даже если жертва ещё Alive и меньше по eid);
 *  - templateId детерминирован: тот же eventId+speaker → тот же index (fnv, не rng-поток);
 *    порядко-независим, два прогона идентичны;
 *  - окраска temperament: паникёр → пул panicky (templateId несёт 'panicky');
 *  - гроза глушит эфир (RADIO_JAMMING_WEATHER) — сообщений нет;
 *  - renderMessage(radio/message.templateId, params) даёт осмысленную (не фолбэк) строку;
 *  - реактивное окно at(tick−1): событие тика T звучит на T+1, не раньше/дважды; tick=0 no-op;
 *  - нет петли эфира (radio/message сам не переозвучивается);
 *  - изоляция: Radio не трогает money/inventory (EconomyInvariant не затронут).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, EventId, ItemId, LocationId, Seed, SimEvent, Tick } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent, allEntities } from '../core/ecs';
import { serialize, deserialize, hashSnapshot } from '../core/snapshot';
import type { SystemCtx } from '../core/system';
import {
  Position,
  Human,
  Alive,
  Personality,
  WorldClock,
  WEATHER_CODE,
  Temperament,
} from '../core/components';
import { entitySubject } from './memory';
import { Radio } from './radio';
import { parseTemplateId, renderMessage } from '../narrative/render';
import { RADIO_THRESHOLD } from '../balance/narrative';

const LOC = 4 as LocationId;
const OTHER_LOC = 2 as LocationId;

/** SoA-колонки для установки состояния в тестах (миры идут последовательно, D-024). */
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array };
const PERS = Personality as unknown as { temperament: Uint8Array };
const CLOCK = WorldClock as unknown as { weather: Uint8Array; weatherSince: Uint32Array };

/** Ручной ctx для прямого вызова Radio.update на тике `tick`. */
function ctxAt(world: SimWorld, tick: number): SystemCtx {
  world.tick = tick as Tick;
  return { world, bus: world.bus, rng: world.rng.fork(`Radio@${tick}`), tick: tick as Tick };
}

/** Гоняет Radio на тике `tick` и КОММИТИТ его сообщения в лог (как планировщик, D-005). */
function runRadio(world: SimWorld, tick: number): void {
  Radio.update(ctxAt(world, tick));
  world.bus.endTick(tick as Tick);
}

/** Публикует событие на тике `tick` и коммитит его; возвращает выданный id. */
function commit(world: SimWorld, tick: number, e: Omit<SimEvent, 'id' | 'tick'>): EventId {
  world.tick = tick as Tick;
  const id = world.bus.publish(e as never);
  world.bus.endTick(tick as Tick);
  return id;
}

/** Селит ЖИВОГО Human-наблюдателя (Human+Alive+Position+Personality) в локации `loc`. */
function placeHuman(world: SimWorld, loc: number, temperament: number = Temperament.NEUTRAL): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  addComponent(world.ecs, Personality, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  PERS.temperament[eid] = temperament;
  return eid;
}

/** Создаёт singleton WorldClock с погодой `weatherCode`; возвращает его eid (для смены погоды). */
function placeWeather(world: SimWorld, weatherCode: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, WorldClock, eid);
  CLOCK.weather[eid] = weatherCode;
  CLOCK.weatherSince[eid] = 0;
  return eid;
}

/**
 * Селит ЖИВОГО Human БЕЗ Personality (Human+Alive+Position, страховка reuse-eid D-071):
 * говорящий-носитель без личности обязан получить фолбэк-тон 'neutral', а не читать
 * устаревшую SoA-колонку темперамента. Ставится ПЕРВЫМ ⇒ min-eid ⇒ гарантированно спикер.
 */
function placeMuteHuman(world: SimWorld, loc: number): EntityId {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, Position, eid);
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc;
  return eid;
}

/** Прибытие новичка (sig 0.22 >= порога): несёт loc и eid-новичка как subject. */
function arrived(newcomer: EntityId, loc: LocationId): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'population/arrived',
    causedBy: null,
    payload: { eid: newcomer, loc, reason: 'привлекательность Зоны выше порога' },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/** radio/message события лога. */
function messages(world: SimWorld): Extract<SimEvent, { type: 'radio/message' }>[] {
  return world.bus.log.filter((e) => e.type === 'radio/message') as Extract<
    SimEvent,
    { type: 'radio/message' }
  >[];
}

/** Грабёж (loot/transferred): sig 0.28 >= порога, несёт loc и subjects [from,to]. */
function loot(from: EntityId, to: EntityId, loc: LocationId): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'loot/transferred',
    causedBy: null,
    payload: { from, to, items: [], money: 10, loc },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/** Смерть NPC (sig 0.48 >= порога), БЕЗ loc в payload — локация выводится из Position жертвы. */
function diedNpc(victim: EntityId): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'entity/died',
    causedBy: null,
    payload: { eid: victim, name: 'Сидоров', cause: 'combat' },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

/** Рутинная сделка (sig 0.06 < порога). */
function tradeRoutine(buyer: EntityId, seller: EntityId): Omit<SimEvent, 'id' | 'tick'> {
  return {
    type: 'trade/executed',
    causedBy: null,
    payload: { buyer, seller, item: 'ammo' as ItemId, qty: 1, price: 10, money: 10 },
  } as Omit<SimEvent, 'id' | 'tick'>;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('Radio: значимое событие + наблюдатель → radio/message (D-070)', () => {
  it('грабёж с co-located наблюдателем → одно сообщение с speaker/subjects/loc/templateId/causedBy/isFirsthand', () => {
    const w = createSimWorld(1 as Seed);
    const from = 5 as EntityId;
    const to = 6 as EntityId;
    const observer = placeHuman(w, LOC); // живой Human в локации события
    const evId = commit(w, 10, loot(from, to, LOC));

    runRadio(w, 11);

    const msgs = messages(w);
    expect(msgs).toHaveLength(1);
    const p = msgs[0]!.payload;
    expect(p.speakerEid).toBe(observer);
    expect(p.loc).toBe(LOC);
    expect(p.isFirsthand).toBe(true);
    expect(msgs[0]!.causedBy).toBe(evId); // событие → его озвучка (D-030)
    // Субъекты = участники грабежа (from,to), сорт.+уникальны, как Subject.
    expect(p.subjects).toEqual([entitySubject(from), entitySubject(to)]);
    // templateId кодирует тип события; params несут наблюдателя, жертву (from), loc.
    expect(parseTemplateId(p.templateId)?.eventType).toBe('loot/transferred');
    expect(p.params.speaker).toBe(observer);
    expect(p.params.subject).toBe(from);
    expect(p.params.loc).toBe(LOC);
  });

  it('событие ниже порога (рутинная сделка) → нет сообщения даже при наблюдателе', () => {
    const w = createSimWorld(2 as Seed);
    placeHuman(w, LOC);
    // trade/executed sig 0.06 < RADIO_THRESHOLD; premise-проверка порога.
    expect(0.06).toBeLessThan(RADIO_THRESHOLD);
    commit(w, 10, tradeRoutine(5 as EntityId, 6 as EntityId));
    runRadio(w, 11);
    expect(messages(w)).toEqual([]);
  });

  it('нет наблюдателя в локации события → тишина (закон №1)', () => {
    const w = createSimWorld(3 as Seed);
    placeHuman(w, OTHER_LOC); // человек есть, но в ДРУГОЙ локации
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);
    expect(messages(w)).toEqual([]);
  });
});

describe('Radio: смерть озвучивает СВИДЕТЕЛЬ, не жертва', () => {
  it('жертва (меньший eid, ещё Alive) исключена — говорит witness', () => {
    const w = createSimWorld(4 as Seed);
    // Жертва селится ПЕРВОЙ (меньший eid). Дадим ей Position в LOC (труп остаётся на месте),
    // и даже оставим Alive — правило nonSpeakers обязано её исключить независимо от тега.
    const victim = placeHuman(w, LOC);
    const witness = placeHuman(w, LOC);
    expect(victim).toBeLessThan(witness); // min-eid выбрал бы жертву, если бы не исключение
    commit(w, 10, diedNpc(victim));

    runRadio(w, 11);

    const msgs = messages(w);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.payload.speakerEid).toBe(witness); // СВИДЕТЕЛЬ, не покойник
    expect(msgs[0]!.payload.params.subject).toBe(victim); // покойник — субъект реплики
    expect(parseTemplateId(msgs[0]!.payload.templateId)?.eventType).toBe('entity/died');
  });
});

describe('Radio: templateId детерминирован (fnv, не rng-поток; D-070/закон №8)', () => {
  it('тот же eventId+speaker → тот же templateId (два независимых прогона)', () => {
    function scenario(seed: number): string {
      const w = createSimWorld(seed as Seed);
      placeHuman(w, LOC);
      commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
      runRadio(w, 11);
      return messages(w)[0]!.payload.templateId;
    }
    // Один seed для обоих (одинаковые eid/eventId) ⇒ один templateId. И даже разный seed
    // не влияет (index зависит только от eventId+speaker, не от rootSeed).
    expect(scenario(42)).toBe(scenario(42));
    expect(scenario(42)).toBe(scenario(999));
  });

  it('весь radio/message воспроизводится побитово при повторе сценария', () => {
    function scenario(seed: number): unknown {
      const w = createSimWorld(seed as Seed);
      placeHuman(w, LOC);
      commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
      runRadio(w, 11);
      const p = messages(w)[0]!.payload;
      return { speaker: p.speakerEid, tpl: p.templateId, subjects: p.subjects, params: p.params };
    }
    expect(scenario(7)).toEqual(scenario(7));
  });
});

describe('Radio: окраска темпераментом говорящего (D-071)', () => {
  it('говорящий-паникёр → templateId несёт пул panicky', () => {
    const w = createSimWorld(5 as Seed);
    placeHuman(w, LOC, Temperament.PANICKY);
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);
    const tpl = parseTemplateId(messages(w)[0]!.payload.templateId);
    expect(tpl?.temperament).toBe('panicky');
  });

  it('говорящий-ветеран → пул veteran; нейтральный → neutral', () => {
    const wv = createSimWorld(6 as Seed);
    placeHuman(wv, LOC, Temperament.VETERAN);
    commit(wv, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(wv, 11);
    expect(parseTemplateId(messages(wv)[0]!.payload.templateId)?.temperament).toBe('veteran');

    const wn = createSimWorld(7 as Seed);
    placeHuman(wn, LOC, Temperament.NEUTRAL);
    commit(wn, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(wn, 11);
    expect(parseTemplateId(messages(wn)[0]!.payload.templateId)?.temperament).toBe('neutral');
  });
});

describe('Radio: помехи — гроза глушит эфир (§8.1, RADIO_JAMMING_WEATHER)', () => {
  it('погода storm → сообщение теряется (нет radio/message)', () => {
    const w = createSimWorld(8 as Seed);
    placeHuman(w, LOC);
    placeWeather(w, WEATHER_CODE.storm);
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);
    expect(messages(w)).toEqual([]); // гроза заглушила
  });

  it('ясная погода → сообщение проходит (контроль к тесту грозы)', () => {
    const w = createSimWorld(9 as Seed);
    placeHuman(w, LOC);
    placeWeather(w, WEATHER_CODE.clear);
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);
    expect(messages(w)).toHaveLength(1);
  });
});

describe('Radio: renderMessage(templateId, params) даёт осмысленную строку эфира (3.4)', () => {
  it('эмитированный radio/message рендерится в непустую НЕ-фолбэк строку', () => {
    const w = createSimWorld(10 as Seed);
    const observer = placeHuman(w, LOC);
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);
    const p = messages(w)[0]!.payload;

    const str = renderMessage(
      { templateId: p.templateId, params: p.params },
      {
        nameOf: (r) => (r === observer ? 'Наблюдатель' : r === 5 ? 'Жертва' : String(r)),
        locOf: (l) => (l === LOC ? 'Свалка' : String(l)),
      },
    );
    expect(str.length).toBeGreaterThan(0);
    expect(str).not.toBe('…в эфире только треск помех…'); // валидный шаблон, не фолбэк
    // Плейсхолдеры разрешились (не осталось сырых токенов), локация подставилась.
    expect(str).not.toContain('{');
    expect(str).toContain('Свалка');
  });
});

describe('Radio: реактивное окно at(tick−1) (закон №6, D-005)', () => {
  it('событие тика T звучит на T+1, не раньше и не дважды; tick=0 no-op', () => {
    const w = createSimWorld(11 as Seed);
    placeHuman(w, LOC);
    expect(() => Radio.update(ctxAt(w, 0))).not.toThrow(); // окна прошлого нет

    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 10); // совпадает с событием — ещё не «прошлый тик»
    expect(messages(w)).toHaveLength(0);
    runRadio(w, 11); // ровно раз
    expect(messages(w)).toHaveLength(1);
    runRadio(w, 12); // окно at(11) не содержит грабежа (только radio/message) — повтора нет
    expect(messages(w)).toHaveLength(1);
  });
});

describe('Radio: нет петли эфира (radio/message сам не переозвучивается)', () => {
  it('собственное сообщение не порождает сообщение о сообщении', () => {
    const w = createSimWorld(12 as Seed);
    placeHuman(w, LOC);
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11); // сообщение сделано и закоммичено на тике 11
    runRadio(w, 12); // читаем закоммиченный тик 11 (там radio/message) — нового нет
    expect(messages(w)).toHaveLength(1);
  });
});

describe('Radio: изоляция — эфир не трогает массу (EconomyInvariant не затронут, закон №3)', () => {
  it('после эмиссии ресурсных ключей money/inventory/fame не возникло', () => {
    const w = createSimWorld(13 as Seed);
    placeHuman(w, LOC);
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);
    expect(messages(w)).toHaveLength(1);
    // Radio состояние мира не мутирует (только шину) — ни одного ресурсного ключа.
    expect(w.resources.keys()).toEqual([]);
  });

  it('эфир не рождает и не удаляет сущностей, не двигает наблюдателя (мир физически цел, закон №3)', () => {
    const w = createSimWorld(14 as Seed);
    const observer = placeHuman(w, LOC);
    const entsBefore = allEntities(w.ecs);
    const posBefore = POS.loc[observer as number];
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);
    expect(messages(w)).toHaveLength(1); // эфир прозвучал…
    // …но НИ одной сущности не прибавилось/убыло (спикер не «спавнится», закон №4/№1),
    expect(allEntities(w.ecs)).toEqual(entsBefore);
    // наблюдатель не телепортировался (позицию Radio не трогает — только читает),
    expect(POS.loc[observer as number]).toBe(posBefore);
    // ресурсных ключей (money/inventory/fame) как не было, так и нет.
    expect(w.resources.keys()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Radio: несколько наблюдателей → ровно один голос (дедуп min-eid, закон №8)', () => {
  it('два co-located свидетеля → одно сообщение от МЕНЬШЕГО eid', () => {
    const w = createSimWorld(20 as Seed);
    const first = placeHuman(w, LOC); // меньший eid — он и заговорит
    const second = placeHuman(w, LOC);
    expect(first).toBeLessThan(second);
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);

    const msgs = messages(w);
    expect(msgs).toHaveLength(1); // НЕ два эха одного факта — ровно один в эфир
    expect(msgs[0]!.payload.speakerEid).toBe(first); // детерминированный дедуп (min-eid)
  });
});

describe('Radio: порог — событие чуть ВЫШЕ RADIO_THRESHOLD звучит', () => {
  it('прибытие новичка (sig 0.22 >= 0.2) → сообщение; новичок — subject реплики', () => {
    const w = createSimWorld(21 as Seed);
    const observer = placeHuman(w, LOC);
    const newcomer = 77 as EntityId;
    expect(0.22).toBeGreaterThanOrEqual(RADIO_THRESHOLD); // premise: над порогом
    commit(w, 10, arrived(newcomer, LOC));
    runRadio(w, 11);

    const msgs = messages(w);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.payload.speakerEid).toBe(observer);
    expect(parseTemplateId(msgs[0]!.payload.templateId)?.eventType).toBe('population/arrived');
    expect(msgs[0]!.payload.params.subject).toBe(newcomer); // «в Зону пришёл {subject}»
  });
});

describe('Radio: выбор шаблона ПОРЯДКО-НЕЗАВИСИМ (D-070 — fnv, не rng-поток; КРИТИЧНО)', () => {
  it('templateId события E тот же, звучит ли E в одиночку или в одном окне с другим событием', () => {
    // E ЗВУЧИТ ПЕРВЫМ (меньший id) в обоих мирах ⇒ eventId E совпадает. Если бы выбор
    // шаблона тянул общий продвигающийся rng-поток, наличие/обработка второго события в том же
    // окне сдвинула бы индекс E. Чистый fnv(eventId,speaker) — нет: E получает тот же templateId.
    const solo = createSimWorld(22 as Seed);
    placeHuman(solo, LOC);
    const eSolo = commit(solo, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(solo, 11);
    const tplSolo = messages(solo).find((m) => m.causedBy === eSolo)!.payload.templateId;

    const paired = createSimWorld(22 as Seed);
    placeHuman(paired, LOC);
    // Публикуем E ПЕРВЫМ (тот же id), затем второе значимое событие F в ТОМ ЖЕ тике.
    paired.tick = 10 as Tick;
    const ePaired = paired.bus.publish(loot(5 as EntityId, 6 as EntityId, LOC) as never);
    paired.bus.publish(loot(7 as EntityId, 8 as EntityId, LOC) as never); // F — сосед по окну
    paired.bus.endTick(10 as Tick);
    runRadio(paired, 11);

    expect(ePaired).toBe(eSolo); // eventId E не сдвинулся от соседа
    expect(messages(paired)).toHaveLength(2); // оба факта озвучены
    const tplPaired = messages(paired).find((m) => m.causedBy === ePaired)!.payload.templateId;
    expect(tplPaired).toBe(tplSolo); // выбор шаблона E не зависит от соседа по окну
  });
});

describe('Radio: resume ≡ continuous (save/load в середине не меняет эфир, D-070/закон №8)', () => {
  it('снапшот после события → deserialize → тот же templateId и payload, что без сохранения', () => {
    function build(seed: number): SimWorld {
      const w = createSimWorld(seed as Seed);
      placeHuman(w, LOC, Temperament.VETERAN); // тон должен пережить save/load
      commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC)); // событие закоммичено в лог
      return w;
    }
    // Непрерывный прогон: озвучиваем сразу на тике 11.
    const cont = build(23);
    runRadio(cont, 11);
    const contMsg = messages(cont)[0]!.payload;

    // Resume: сериализуем МЕЖДУ событием и озвучкой, поднимаем новый мир, озвучиваем на 11.
    const src = build(23);
    const resumed = deserialize(serialize(src)); // save→load посреди причинной цепочки
    runRadio(resumed, 11);
    const resMsg = messages(resumed)[0]!.payload;

    expect(resMsg.templateId).toBe(contMsg.templateId); // выбор шаблона resume-safe
    expect(resMsg.speakerEid).toBe(contMsg.speakerEid);
    expect(resMsg.subjects).toEqual(contMsg.subjects);
    expect(resMsg.params).toEqual(contMsg.params);
    expect(parseTemplateId(resMsg.templateId)?.temperament).toBe('veteran'); // тон уцелел
  });
});

describe('Radio: два прогона одного сценария побитово идентичны (детерминизм лога, закон №8)', () => {
  it('мульти-событийный тик → одинаковый список radio/message в обоих прогонах', () => {
    function run(seed: number): unknown {
      const w = createSimWorld(seed as Seed);
      placeHuman(w, LOC, Temperament.PANICKY);
      // Три значимых факта в одном тике: смерть, грабёж, прибытие — все озвучит спикер.
      w.tick = 10 as Tick;
      w.bus.publish(diedNpc(5 as EntityId) as never);
      w.bus.publish(loot(6 as EntityId, 7 as EntityId, LOC) as never);
      w.bus.publish(arrived(8 as EntityId, LOC) as never);
      w.bus.endTick(10 as Tick);
      runRadio(w, 11);
      return messages(w).map((m) => ({
        causedBy: m.causedBy,
        tpl: m.payload.templateId,
        speaker: m.payload.speakerEid,
        subjects: m.payload.subjects,
        params: m.payload.params,
      }));
    }
    expect(run(24)).toEqual(run(24)); // одинаковый seed ⇒ побитово тот же эфир
  });
});

describe('Radio: страховка тона — говорящий БЕЗ Personality звучит нейтрально (D-071)', () => {
  it('живой Human-носитель без Personality → templateId с temperament=neutral (гейт hasComponent)', () => {
    const w = createSimWorld(25 as Seed);
    const mute = placeMuteHuman(w, LOC); // min-eid, но без компонента Personality
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);

    const msgs = messages(w);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.payload.speakerEid).toBe(mute);
    // Гейт hasComponent(Personality) не даёт прочесть устаревшую SoA-колонку — фолбэк 'neutral'.
    expect(parseTemplateId(msgs[0]!.payload.templateId)?.temperament).toBe('neutral');
  });
});

describe('Radio: смена погоды меняет эфир ПРИЧИННО (§8.1, помехи детерминированы)', () => {
  it('в грозу тот же факт теряется, в прояснение — звучит (один мир, меняем погоду)', () => {
    const w = createSimWorld(26 as Seed);
    placeHuman(w, LOC);
    const clock = placeWeather(w, WEATHER_CODE.storm);

    // Гроза: факт значим, наблюдатель есть, но эфир заглушён — потеря (не искажение).
    commit(w, 10, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 11);
    expect(messages(w)).toHaveLength(0);

    // Гроза прошла (состояние среды изменилось) — тот же тип факта теперь проходит в эфир.
    CLOCK.weather[clock as number] = WEATHER_CODE.clear;
    commit(w, 12, loot(5 as EntityId, 6 as EntityId, LOC));
    runRadio(w, 13);
    expect(messages(w)).toHaveLength(1); // поведение изменилось ПРИЧИННО от погоды, не rng
  });
});

describe('Radio: renderMessage смерти даёт осмысленную plain-строку (закон №5, другой тип)', () => {
  it('radio/message о смерти рендерится в непустую НЕ-фолбэк строку без разметки', () => {
    const w = createSimWorld(27 as Seed);
    const victim = placeHuman(w, LOC); // жертва (min-eid) — исключена из спикеров
    const witness = placeHuman(w, LOC);
    commit(w, 10, diedNpc(victim));
    runRadio(w, 11);
    const p = messages(w)[0]!.payload;
    expect(p.speakerEid).toBe(witness);

    const str = renderMessage(
      { templateId: p.templateId, params: p.params },
      {
        nameOf: (r) => (r === witness ? 'Свидетель' : r === victim ? 'Сидоров' : String(r)),
        locOf: (l) => (l === LOC ? 'Свалка' : String(l)),
      },
    );
    expect(str.length).toBeGreaterThan(0);
    expect(str).not.toBe('…в эфире только треск помех…'); // валидный шаблон, не фолбэк
    expect(str).not.toContain('{'); // все плейсхолдеры разрешены
    expect(str).not.toMatch(/[<>]/); // plain-текст, без DOM/разметки (закон №5)
    expect(str).toContain('Сидоров'); // покойник назван в эфире
  });
});

describe('Radio: эфир не творит массу; пустой мир 481914ae цел даже с Radio (D-074/закон №3)', () => {
  it('пустой мир сериализуется в 481914ae, а прогон Radio по пустоте его не оскверняет', () => {
    // ПИН окружения (D-064): чистый мир без worldgen — эталонный пустой снапшот.
    const empty = createSimWorld(0 as Seed);
    expect(hashSnapshot(serialize(empty))).toBe('481914ae');

    // Radio по пустому миру (нет событий, нет наблюдателей) — строго no-op: эфир молчит,
    // сущности не рождаются, лог/ресурсы пусты. Голден остаётся 481914ae после прогона.
    for (let t = 1; t <= 3; t++) runRadio(empty, t);
    expect(messages(empty)).toEqual([]);
    expect(allEntities(empty.ecs)).toEqual([]);
    expect(empty.resources.keys()).toEqual([]);
    empty.tick = 0 as Tick; // прогон двигал только курсор тика — вернём к точке снимка
    expect(hashSnapshot(serialize(empty))).toBe('481914ae'); // снапшот не осквернён Radio
  });
});
