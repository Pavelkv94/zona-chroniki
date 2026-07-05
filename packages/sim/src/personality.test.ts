/**
 * @module @zona/sim/personality.test
 *
 * Задача 3.3 (D-071): SoA-компонент `Personality {temperament, talkativeness}` на
 * людях, сид в worldgen (детерминированно, D-021/D-059). Сценарии-проверки:
 *  - worldgen ставит Personality КАЖДОМУ человеку (Human), и НИКОМУ иному (животные/
 *    поселения/поля — без Personality);
 *  - temperament ∈ валидный enum `Temperament`; talkativeness ∈ [0..1];
 *  - тот же seed → тот же temperament/talkativeness (детерминизм, закон №8);
 *  - разные seed дают разное распределение (сид реально работает);
 *  - маппинг `Temperament` → `MessageTemperament` совпадает с messages.json.temperaments
 *    (КОНТРАКТ D-069) и покрывает все коды; `temperamentCode(eid)` согласован;
 *  - Personality переживает round-trip serialize/deserialize (D-018);
 *  - реестр отсортирован (инвариант, D-018).
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed } from '@zona/shared';
import { createSimWorld } from './core/world';
import { worldgen } from './worldgen';
import { serialize, deserialize, hashSnapshot } from './core/snapshot';
import { queryEntities, hasComponent, allEntities } from './core/ecs';
import { createScheduler } from './core/scheduler';
import { registerPhase2Systems } from './pipeline';
import { TICKS_PER_DAY } from './balance/time';
import {
  Human,
  Animal,
  Settlement,
  AnomalyField,
  Personality,
  Temperament,
  TEMPERAMENT_MESSAGE,
  temperamentCode,
  DOMAIN_COMPONENTS,
} from './core/components';
import { assertRegistrySorted } from './core/registry';
import { MESSAGES } from './data/index';
import {
  TEMPERAMENT_WEIGHTS,
  TALKATIVENESS_MIN,
  TALKATIVENESS_MAX,
  STALKER_COUNT,
  BANDIT_COUNT,
  TRADER_PROFESSION_ID,
  RESIDENT_PROFESSION_IDS,
  BANDIT_FACTION_ID,
} from './balance/worldgen';

const PERSONA = Personality as unknown as {
  temperament: Uint8Array;
  talkativeness: Float32Array;
};

/** Множество валидных кодов темперамента (значения enum Temperament). */
const VALID_CODES = new Set<number>(Object.values(Temperament));

function humansOf(seed: number): { world: ReturnType<typeof createSimWorld>; humans: EntityId[] } {
  const world = createSimWorld(seed as Seed);
  worldgen(world);
  const humans = [...queryEntities(world.ecs, [Human])] as EntityId[];
  return { world, humans };
}

describe('Personality: сид в worldgen (задача 3.3, D-071)', () => {
  it('КАЖДЫЙ человек несёт Personality с валидным temperament и talkativeness ∈ [0..1]', () => {
    const { world, humans } = humansOf(42);
    expect(humans.length).toBeGreaterThan(0);
    for (const eid of humans) {
      expect(hasComponent(world.ecs, Personality, eid)).toBe(true);
      const t = PERSONA.temperament[eid] as number;
      const talk = PERSONA.talkativeness[eid] as number;
      expect(VALID_CODES.has(t)).toBe(true);
      expect(talk).toBeGreaterThanOrEqual(0);
      expect(talk).toBeLessThanOrEqual(1);
    }
  });

  it('животные (не-люди) НЕ несут Personality — черта только человеческая', () => {
    const { world } = humansOf(42);
    const animals = queryEntities(world.ecs, [Animal]);
    expect(animals.length).toBeGreaterThan(0);
    for (const eid of animals) {
      expect(hasComponent(world.ecs, Personality, eid)).toBe(false);
    }
  });

  it('детерминизм: тот же seed → идентичные temperament/talkativeness у каждого человека', () => {
    const a = humansOf(42);
    // Свежая проекция того же глобального компонента: пере-генерим в новый мир и
    // сверяем по eid (worldgen детерминирован ⇒ те же eid у людей).
    const snapA = a.humans.map((eid) => ({
      eid,
      t: PERSONA.temperament[eid] as number,
      talk: PERSONA.talkativeness[eid] as number,
    }));
    const b = humansOf(42);
    expect(b.humans).toEqual(a.humans);
    for (const rec of snapA) {
      expect(PERSONA.temperament[rec.eid]).toBe(rec.t);
      expect(PERSONA.talkativeness[rec.eid]).toBe(rec.talk);
    }
  });

  it('сид реально работает: разные seed дают разный профиль личностей', () => {
    const a = humansOf(42);
    const profA = a.humans.map((eid) => `${PERSONA.temperament[eid]}:${PERSONA.talkativeness[eid]}`);
    const b = humansOf(777);
    const profB = b.humans.map((eid) => `${PERSONA.temperament[eid]}:${PERSONA.talkativeness[eid]}`);
    // Хотя бы у одного человека профиль отличается (иначе сид ни на что не влияет).
    expect(profA).not.toEqual(profB);
  });

  it('распределение уважает веса: neutral (наиболее весомый) — самый частый темперамент', () => {
    const { humans } = humansOf(42);
    const counts = new Array<number>(TEMPERAMENT_WEIGHTS.length).fill(0);
    for (const eid of humans) {
      const code = PERSONA.temperament[eid] as number;
      counts[code] = (counts[code] ?? 0) + 1;
    }
    const maxWeightCode = TEMPERAMENT_WEIGHTS.indexOf(Math.max(...TEMPERAMENT_WEIGHTS));
    const argmaxCount = counts.indexOf(Math.max(...counts));
    expect(argmaxCount).toBe(maxWeightCode); // neutral доминирует
    expect(maxWeightCode).toBe(Temperament.NEUTRAL);
  });
});

describe('Personality: маппинг темперамента → MessageTemperament (КОНТРАКТ D-069)', () => {
  it('TEMPERAMENT_MESSAGE совпадает с messages.json.temperaments по порядку и составу', () => {
    expect([...TEMPERAMENT_MESSAGE]).toEqual([...MESSAGES.temperaments]);
  });

  it('коды enum Temperament покрывают ровно индексы TEMPERAMENT_MESSAGE', () => {
    const codes = Object.values(Temperament).sort((x, y) => x - y);
    expect(codes).toEqual(TEMPERAMENT_MESSAGE.map((_, i) => i));
    // Каждый именованный код указывает на ожидаемую строку.
    expect(TEMPERAMENT_MESSAGE[Temperament.NEUTRAL]).toBe('neutral');
    expect(TEMPERAMENT_MESSAGE[Temperament.PANICKY]).toBe('panicky');
    expect(TEMPERAMENT_MESSAGE[Temperament.VETERAN]).toBe('veteran');
    expect(TEMPERAMENT_MESSAGE[Temperament.TALKER]).toBe('talker');
  });

  it('temperamentCode(eid) согласован с колонкой и с TEMPERAMENT_MESSAGE', () => {
    const { humans } = humansOf(42);
    for (const eid of humans) {
      const code = PERSONA.temperament[eid] as number;
      expect(temperamentCode(eid)).toBe(TEMPERAMENT_MESSAGE[code]);
    }
  });

  it('temperamentCode мягко откатывается на neutral для не-носителя', () => {
    // eid без Personality (заведомо вне занятых) → базовый фолбэк-тон.
    expect(temperamentCode(999999 as EntityId)).toBe('neutral');
  });
});

describe('Personality: сериализация (D-018) и реестр', () => {
  it('реестр компонентов остаётся отсортированным с personality', () => {
    expect(() => assertRegistrySorted(DOMAIN_COMPONENTS)).not.toThrow();
    expect(DOMAIN_COMPONENTS.some((m) => m.name === 'personality')).toBe(true);
  });

  it('round-trip serialize/deserialize сохраняет temperament/talkativeness', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const snap = serialize(world);
    // В снапшоте есть колонка personality с носителями = число людей.
    const humans = queryEntities(world.ecs, [Human]);
    const col = (snap.components as Record<string, { eids: number[] } | undefined>)['personality'];
    expect(col).toBeDefined();
    expect(col?.eids.length).toBe(humans.length);

    const restored = deserialize(snap);
    // Хэш восстановленного мира тождествен исходному (полный round-trip).
    expect(hashSnapshot(serialize(restored))).toBe(hashSnapshot(snap));
    // И поля читаются тем же значением у каждого человека.
    for (const eid of humans) {
      expect(hasComponent(restored.ecs, Personality, eid)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// УСИЛЕНИЕ 3.3 (D-071) — сценарии, закрывающие хвосты чек-листа QA.
// ─────────────────────────────────────────────────────────────────────────────

/** Тип-обёртка над снапшот-колонкой компонента (eids + числовые поля). */
type Column = { eids: number[]; fields: Record<string, number[]> };
function personaColumn(world: ReturnType<typeof createSimWorld>): Column {
  const snap = serialize(world);
  const col = (snap.components as Record<string, Column | undefined>)['personality'];
  if (!col) throw new Error('нет колонки personality в снапшоте');
  return col;
}

describe('Personality: черта носится РОВНО людьми — ни одним не-человеком (D-071)', () => {
  it('множество носителей Personality тождественно множеству Human (двусторонне)', () => {
    // Контракт «носитель — ТОЛЬКО люди, и КАЖДЫЙ человек»: обходим ВЕСЬ мир и
    // требуем биекцию Human ⇔ Personality на каждой сущности (людях, животных,
    // поселениях, аномальных полях, трупах — всех).
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const all = allEntities(world.ecs) as EntityId[];
    expect(all.length).toBeGreaterThan(0);
    for (const eid of all) {
      const isHuman = hasComponent(world.ecs, Human, eid);
      const hasPersona = hasComponent(world.ecs, Personality, eid);
      expect(hasPersona).toBe(isHuman);
    }
  });

  it('поселения (склад/касса) и аномальные поля НЕ несут Personality — это не люди', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const settlements = queryEntities(world.ecs, [Settlement]) as EntityId[];
    const fields = queryEntities(world.ecs, [AnomalyField]) as EntityId[];
    expect(settlements.length).toBeGreaterThan(0);
    expect(fields.length).toBeGreaterThan(0);
    for (const eid of [...settlements, ...fields]) {
      expect(hasComponent(world.ecs, Personality, eid)).toBe(false);
    }
  });

  it('ВСЕ классы людей рождены с Personality: сталкеры, торговцы, резиденты, бандиты', () => {
    // spawnStalker — единая точка рождения (D-059): доказываем, что через неё
    // прошли ВСЕ человеческие классы, читая faction/profession носителей.
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const humans = queryEntities(world.ecs, [Human]) as EntityId[];
    const professions = new Set<string>();
    const factions = new Set<string>();
    for (const eid of humans) {
      professions.add(world.resources.get<string>('profession', eid) ?? '?');
      factions.add(world.resources.get<string>('faction', eid) ?? '?');
    }
    // Торговец опознаётся уникальной профессией 'trader'.
    expect(professions.has(TRADER_PROFESSION_ID)).toBe(true);
    // Резиденты — по эксклюзивным профессиям (medic/mechanic).
    expect(RESIDENT_PROFESSION_IDS.some((p) => professions.has(p))).toBe(true);
    // Бандиты — по хищной фракции; сталкеры-одиночки — по базовой.
    expect(factions.has(BANDIT_FACTION_ID)).toBe(true);
    expect(factions.size).toBeGreaterThan(1);
    // Людей не меньше стартовой когорты + логова бандитов (нижняя граница).
    expect(humans.length).toBeGreaterThanOrEqual(STALKER_COUNT + BANDIT_COUNT);
  });
});

describe('Personality: talkativeness внутри балансовой полосы ⊆ [0..1] (D-071)', () => {
  it('полоса TALKATIVENESS_MIN..MAX сама лежит в [0..1]', () => {
    expect(TALKATIVENESS_MIN).toBeGreaterThanOrEqual(0);
    expect(TALKATIVENESS_MAX).toBeLessThanOrEqual(1);
    expect(TALKATIVENESS_MIN).toBeLessThanOrEqual(TALKATIVENESS_MAX);
  });

  it('talkativeness КАЖДОГО человека лежит в [TALKATIVENESS_MIN, TALKATIVENESS_MAX]', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const col = personaColumn(world);
    const talk = col.fields['talkativeness'] as number[];
    expect(talk.length).toBeGreaterThan(0);
    for (const v of talk) {
      expect(v).toBeGreaterThanOrEqual(TALKATIVENESS_MIN);
      expect(v).toBeLessThanOrEqual(TALKATIVENESS_MAX);
    }
  });
});

describe('Personality: распределение ПРИЧИННО и детерминировано (веса [10,4,3,3], D-071)', () => {
  // Многосидовый worldgen: агрегируем темпераменты по большой выборке людей.
  function tally(seeds: number[]): number[] {
    const counts = new Array<number>(TEMPERAMENT_WEIGHTS.length).fill(0);
    for (const seed of seeds) {
      const world = createSimWorld(seed as Seed);
      worldgen(world);
      const col = personaColumn(world);
      for (const code of col.fields['temperament'] as number[]) {
        counts[code] = (counts[code] ?? 0) + 1;
      }
    }
    return counts;
  }
  const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

  it('на большой выборке встречаются ВСЕ четыре кода темперамента', () => {
    const counts = tally(SEEDS);
    for (let code = 0; code < TEMPERAMENT_WEIGHTS.length; code++) {
      expect(counts[code]).toBeGreaterThan(0);
    }
  });

  it('neutral (вес 10 из 20) доминирует над каждым из остальных', () => {
    const counts = tally(SEEDS);
    const neutral = counts[Temperament.NEUTRAL] as number;
    for (let code = 1; code < counts.length; code++) {
      expect(neutral).toBeGreaterThan(counts[code] as number);
    }
  });

  it('распределение детерминировано: повтор той же выборки → тот же расклад', () => {
    expect(tally(SEEDS)).toEqual(tally(SEEDS));
  });
});

describe('Personality: детерминизм по снапшот-колонке (без глобального стора, D-071/№8)', () => {
  it('тот же seed → бит-в-бит та же колонка personality (eids+поля)', () => {
    const a = createSimWorld(42 as Seed);
    worldgen(a);
    const colA = personaColumn(a);
    const b = createSimWorld(42 as Seed);
    worldgen(b);
    const colB = personaColumn(b);
    expect(colB.eids).toEqual(colA.eids);
    expect(colB.fields['temperament']).toEqual(colA.fields['temperament']);
    expect(colB.fields['talkativeness']).toEqual(colA.fields['talkativeness']);
  });

  it('другой seed → иной профиль темперамента ИЛИ болтливости (сид работает)', () => {
    const a = createSimWorld(42 as Seed);
    worldgen(a);
    const colA = personaColumn(a);
    const b = createSimWorld(777 as Seed);
    worldgen(b);
    const colB = personaColumn(b);
    const differs =
      JSON.stringify(colA.fields['temperament']) !== JSON.stringify(colB.fields['temperament']) ||
      JSON.stringify(colA.fields['talkativeness']) !== JSON.stringify(colB.fields['talkativeness']);
    expect(differs).toBe(true);
  });
});

describe('Personality: маппинг темперамента — валидные ключи пулов messages.json (D-069)', () => {
  it('КАЖДЫЙ код TEMPERAMENT_MESSAGE — объявленный ключ-темперамент в КАЖДОМ типе события', () => {
    // Radio 3.5 выбирает пул шаблонов по строковому коду темперамента говорящего;
    // здесь доказываем, что для любого носителя такой ключ существует в контенте.
    const templates = MESSAGES.templates as Record<string, Record<string, unknown>>;
    const eventTypes = Object.keys(templates);
    expect(eventTypes.length).toBeGreaterThan(0);
    for (const code of TEMPERAMENT_MESSAGE) {
      expect(MESSAGES.temperaments).toContain(code);
      for (const et of eventTypes) {
        expect(Object.keys(templates[et] as Record<string, unknown>)).toContain(code);
      }
    }
  });

  it('temperamentCode: neutral для нетронутого/вне-диапазона eid, но stale-код течёт (находка ревью 3.3)', () => {
    // Документированный контракт (docblock temperamentCode, находка ревью 3.3):
    // хелпер читает SoA-колонку НАПРЯМУЮ, без hasComponent. «Мягкий откат на
    // neutral» покрывает ТОЛЬКО код вне диапазона TEMPERAMENT_MESSAGE / нетронутый
    // (out-of-bounds) слот, НЕ не-носителя с валидным stale-кодом. Демонстрируем на
    // РЕАЛЬНОМ in-bounds не-носителе (животное), детерминированно.
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const animal = (queryEntities(world.ecs, [Animal]) as EntityId[])[0] as EntityId;
    expect(hasComponent(world.ecs, Personality, animal)).toBe(false);
    const saved = PERSONA.temperament[animal] as number;
    // (1) код вне набора (>=4) → фолбэк neutral.
    PERSONA.temperament[animal] = 250;
    expect(temperamentCode(animal)).toBe('neutral');
    // (2) out-of-bounds eid (нетронутый слот) → undefined → neutral.
    expect(temperamentCode(99999 as EntityId)).toBe('neutral');
    // (3) валидный «протухший» код на не-носителе → возвращается КАК ЕСТЬ (не neutral).
    //     Это и есть задокументированная опасность reuse-eid: вызывающий (Radio 3.5)
    //     ОБЯЗАН гейтить hasComponent(Personality, eid), а не полагаться на фолбэк.
    PERSONA.temperament[animal] = Temperament.VETERAN;
    expect(temperamentCode(animal)).toBe('veteran');
    PERSONA.temperament[animal] = saved; // восстановить слот
  });

  it('животные — не-носители Personality; гейт hasComponent даёт корректный neutral', () => {
    // Контракт-обязательство вызывающего: перед temperamentCode проверить
    // носительство. Для животных hasComponent(Personality)===false ⇒ трактуем как
    // neutral на стороне потребителя (не читая возможно-протухшую колонку).
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const animals = queryEntities(world.ecs, [Animal]) as EntityId[];
    expect(animals.length).toBeGreaterThan(0);
    for (const eid of animals) {
      expect(hasComponent(world.ecs, Personality, eid)).toBe(false);
      const tone = hasComponent(world.ecs, Personality, eid) ? temperamentCode(eid) : 'neutral';
      expect(tone).toBe('neutral');
    }
  });
});

describe('Personality: round-trip колонки бит-в-бит + resume несёт черту (D-018/D-050)', () => {
  it('serialize→deserialize→serialize: колонка personality идентична', () => {
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const before = personaColumn(world);
    const restored = deserialize(serialize(world));
    const after = personaColumn(restored);
    expect(after.eids).toEqual(before.eids);
    expect(after.fields['temperament']).toEqual(before.fields['temperament']);
    expect(after.fields['talkativeness']).toEqual(before.fields['talkativeness']);
    // eids носителей отсортированы по возрастанию (живые, закон №8).
    const sorted = [...after.eids].sort((x, y) => x - y);
    expect(after.eids).toEqual(sorted);
  });

  it('resume ≡ continuous после нескольких тиков: Personality в снапшоте не рвёт хэш', () => {
    const SPLIT = 20;
    // Непрерывный прогон.
    const cont = createSimWorld(42 as Seed);
    worldgen(cont);
    const cs = createScheduler();
    registerPhase2Systems(cs);
    cs.run(cont, SPLIT * 2);
    // Расщеплённый: половина → снапшот (несёт колонку personality) → добег.
    const half = createSimWorld(42 as Seed);
    worldgen(half);
    const hs = createScheduler();
    registerPhase2Systems(hs);
    hs.run(half, SPLIT);
    // На середине черта уже в снапшоте.
    expect(personaColumn(half).eids.length).toBeGreaterThan(0);
    const resumed = deserialize(serialize(half));
    const rs = createScheduler();
    registerPhase2Systems(rs);
    rs.run(resumed, SPLIT);
    expect(hashSnapshot(serialize(resumed))).toBe(hashSnapshot(serialize(cont)));
  });
});

describe('Personality: голдены-якоря активными assert (D-071)', () => {
  it('пустой мир (0 носителей ⇒ нет колонки personality) остаётся 481914ae', () => {
    const empty = createSimWorld(0 as Seed);
    // Без worldgen: ни одного человека ⇒ personality в снапшот НЕ пишется.
    const snap = serialize(empty);
    expect((snap.components as Record<string, unknown>)['personality']).toBeUndefined();
    expect(hashSnapshot(snap)).toBe('481914ae');
  });

  it('день-1 seed42 на конвейере Фазы 2 (физический базлайн) = 345626cb', () => {
    // ЯКОРЬ конвейера Фазы 2 (createSimWorld → worldgen → registerPhase2Systems → прогон
    // TICKS_PER_DAY): rng-хвост Personality (D-071) закреплён. Задача 3.7 (D-074) подключила
    // нарративный блок в конвейер CLI/phase1-gate — их день-1 голден сдвинулся до f554331d
    // (заполнение лога эфиром/слухами/летописью + fame). Но нарратив ПОВЕДЕНЧЕСКИ ИНЕРТЕН для
    // физики (пишет fame/memory, дизъюнктные positions/inventory), поэтому ФИЗИЧЕСКИЙ голден
    // Фазы 2 держался 3c54d141. 5.0/D-083 (схемы Фазы 5): рост singleton WorldClock 2→5 полей
    // сдвинул канон ЧИСТО СХЕМНО 3c54d141 → 5b06b2f5. 5.2/D-085 (FORAGE→forage_food): ПОВЕДЕНЧЕСКИЙ
    // сдвиг физики (форедж-питание/калибровка охоты меняют траекторию Фазы 2) ⇒ 5b06b2f5 → 345626cb
    // (детерминизм 2×). Физический якорь Фазы 2 отслеживает поведение конвейера, теперь с фореджем.
    const world = createSimWorld(42 as Seed);
    worldgen(world);
    const sched = createScheduler();
    registerPhase2Systems(sched);
    sched.run(world, TICKS_PER_DAY);
    expect(hashSnapshot(serialize(world))).toBe('345626cb');
  });
});
