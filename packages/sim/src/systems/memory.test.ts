/**
 * @module @zona/sim/systems/memory.test
 *
 * Гейт ХЕЛПЕРОВ памяти/отношений/обхода (задача 2.15, D-050/D-058). Покрывает:
 *  - форма MemoryRecord: addMemory заполняет дефолты (salience/isFirsthand) и клампит;
 *  - subject: entitySubject/factionSubject/parseSubject — round-trip и сортируемость;
 *  - relations: getRelation нейтрал по умолчанию, setRelation кламп/удаление нейтрала,
 *    adjustRelation аддитивен; массив сорт. по subject;
 *  - factionReputation DERIVED: агрегат прямого отношения + отношений к членам фракции;
 *  - avoidLoc: addAvoid продлевает до максимума, isAvoided по сроку;
 *  - ДЕТЕРМИНИЗМ/СОРТ: массивы отсортированы независимо от порядка добавления;
 *  - запись НОВЫМ массивом (D-035): исходная ссылка не мутируется.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, FactionId, MemoryRecord, RelationEntry, AvoidEntry, Seed } from '@zona/shared';
import { createSimWorld } from '../core/world';
import {
  entitySubject,
  factionSubject,
  parseSubject,
  getMemory,
  addMemory,
  getRelations,
  getRelation,
  setRelation,
  adjustRelation,
  factionReputation,
  getAvoids,
  addAvoid,
  isAvoided,
  MEMORY_KEY,
  RELATIONS_KEY,
} from './memory';
import { MEMORY_INITIAL_SALIENCE } from '../balance/social';

const NPC = 5 as EntityId;

// ── SUBJECT ───────────────────────────────────────────────────────────────────
describe('subject: единый сортируемый ключ (D-050)', () => {
  it('entitySubject/factionSubject кодируют с префиксом типа', () => {
    expect(entitySubject(7 as EntityId)).toBe('e:7');
    expect(factionSubject('loners' as FactionId)).toBe('f:loners');
  });

  it('parseSubject — обратный разбор (round-trip)', () => {
    expect(parseSubject(entitySubject(7 as EntityId))).toEqual({ kind: 'entity', eid: 7 });
    expect(parseSubject(factionSubject('bandits' as FactionId))).toEqual({ kind: 'faction', faction: 'bandits' });
  });
});

// ── ПАМЯТЬ ────────────────────────────────────────────────────────────────────
describe('addMemory: форма MemoryRecord + дефолты + кламп', () => {
  it('заполняет salience=MEMORY_INITIAL_SALIENCE и isFirsthand=true по умолчанию', () => {
    const w = createSimWorld(1 as Seed);
    addMemory(w.resources, NPC, { kind: 'robbed', subject: entitySubject(7 as EntityId), tick: 100, causeEvent: 42 });
    const mem = getMemory(w.resources, NPC);
    expect(mem).toHaveLength(1);
    const r = mem[0]!;
    expect(r).toEqual<MemoryRecord>({
      kind: 'robbed',
      subject: 'e:7',
      salience: MEMORY_INITIAL_SALIENCE,
      tick: 100,
      causeEvent: 42,
      isFirsthand: true,
    });
  });

  it('salience клампится в [0..1]; isFirsthand=false для слуха', () => {
    const w = createSimWorld(2 as Seed);
    addMemory(w.resources, NPC, { kind: 'seen', subject: 'f:bandits', tick: 1, causeEvent: 0, salience: 9, isFirsthand: false });
    addMemory(w.resources, NPC, { kind: 'seen', subject: 'f:bandits', tick: 2, causeEvent: 0, salience: -3 });
    const mem = getMemory(w.resources, NPC);
    expect(mem[0]!.salience).toBe(1); // tick=1, clamp сверху
    expect(mem[0]!.isFirsthand).toBe(false);
    expect(mem[1]!.salience).toBe(0); // tick=2, clamp снизу
  });

  it('память сорт. детерминированно независимо от порядка добавления', () => {
    const w1 = createSimWorld(3 as Seed);
    addMemory(w1.resources, NPC, { kind: 'b', subject: 'e:2', tick: 5, causeEvent: 1 });
    addMemory(w1.resources, NPC, { kind: 'a', subject: 'e:1', tick: 9, causeEvent: 2 });
    const w2 = createSimWorld(3 as Seed);
    addMemory(w2.resources, NPC, { kind: 'a', subject: 'e:1', tick: 9, causeEvent: 2 });
    addMemory(w2.resources, NPC, { kind: 'b', subject: 'e:2', tick: 5, causeEvent: 1 });
    expect(getMemory(w1.resources, NPC)).toEqual(getMemory(w2.resources, NPC));
    // сорт. по subject: e:1 раньше e:2
    expect(getMemory(w1.resources, NPC).map((r) => r.subject)).toEqual(['e:1', 'e:2']);
  });

  it('запись НОВЫМ массивом (D-035): прежняя ссылка не мутируется', () => {
    const w = createSimWorld(4 as Seed);
    addMemory(w.resources, NPC, { kind: 'a', subject: 'e:1', tick: 1, causeEvent: 0 });
    const before = getMemory(w.resources, NPC);
    addMemory(w.resources, NPC, { kind: 'b', subject: 'e:2', tick: 2, causeEvent: 0 });
    expect(before).toHaveLength(1); // старый снимок не вырос
    expect(getMemory(w.resources, NPC)).toHaveLength(2);
  });
});

// ── ОТНОШЕНИЯ ─────────────────────────────────────────────────────────────────
describe('relations: getRelation/setRelation/adjustRelation', () => {
  it('нейтрал (0) по умолчанию, если записи нет', () => {
    const w = createSimWorld(5 as Seed);
    expect(getRelation(w.resources, NPC, 'e:7')).toBe(0);
  });

  it('setRelation клампит в [−1..1]', () => {
    const w = createSimWorld(6 as Seed);
    setRelation(w.resources, NPC, 'e:7', 5);
    expect(getRelation(w.resources, NPC, 'e:7')).toBe(1);
    setRelation(w.resources, NPC, 'e:7', -5);
    expect(getRelation(w.resources, NPC, 'e:7')).toBe(-1);
  });

  it('setRelation в ровно 0 — удаляет запись (нейтрал не хранится, D-050)', () => {
    const w = createSimWorld(7 as Seed);
    setRelation(w.resources, NPC, 'e:7', 0.5);
    expect(getRelations(w.resources, NPC)).toHaveLength(1);
    setRelation(w.resources, NPC, 'e:7', 0);
    expect(getRelations(w.resources, NPC)).toHaveLength(0);
    expect(w.resources.has(RELATIONS_KEY, NPC)).toBe(false); // пустой ключ удалён
  });

  it('adjustRelation аддитивен и клампит', () => {
    const w = createSimWorld(8 as Seed);
    adjustRelation(w.resources, NPC, 'e:7', 0.4);
    adjustRelation(w.resources, NPC, 'e:7', 0.3);
    expect(getRelation(w.resources, NPC, 'e:7')).toBeCloseTo(0.7, 10);
    adjustRelation(w.resources, NPC, 'e:7', 1); // 1.7 → кламп 1
    expect(getRelation(w.resources, NPC, 'e:7')).toBe(1);
  });

  it('relations сорт. по subject детерминированно', () => {
    const w = createSimWorld(9 as Seed);
    setRelation(w.resources, NPC, 'e:3', 0.1);
    setRelation(w.resources, NPC, 'e:1', 0.2);
    setRelation(w.resources, NPC, 'f:bandits', -0.5);
    expect(getRelations(w.resources, NPC).map((r) => r[0])).toEqual(['e:1', 'e:3', 'f:bandits']);
  });
});

// ── DERIVED ФРАКЦИОННАЯ РЕПУТАЦИЯ ─────────────────────────────────────────────
describe('factionReputation: DERIVED агрегат отношений по фракции', () => {
  it('0 (нейтрал), если вкладов нет', () => {
    const w = createSimWorld(10 as Seed);
    expect(factionReputation(w.resources, NPC, 'bandits' as FactionId)).toBe(0);
  });

  it('среднее прямого отношения к фракции и отношений к её известным членам', () => {
    const w = createSimWorld(11 as Seed);
    // Две сущности во фракции bandits, одна — в loners.
    w.resources.set<FactionId>('faction', 20 as EntityId, 'bandits' as FactionId);
    w.resources.set<FactionId>('faction', 21 as EntityId, 'bandits' as FactionId);
    w.resources.set<FactionId>('faction', 30 as EntityId, 'loners' as FactionId);
    setRelation(w.resources, NPC, factionSubject('bandits' as FactionId), -0.6); // прямое
    setRelation(w.resources, NPC, entitySubject(20 as EntityId), -0.4); // член bandits
    setRelation(w.resources, NPC, entitySubject(21 as EntityId), -0.2); // член bandits
    setRelation(w.resources, NPC, entitySubject(30 as EntityId), 0.9); // НЕ bandits — не вклад
    // среднее (−0.6, −0.4, −0.2) = −0.4
    expect(factionReputation(w.resources, NPC, 'bandits' as FactionId)).toBeCloseTo(-0.4, 10);
    // loners: только член 30
    expect(factionReputation(w.resources, NPC, 'loners' as FactionId)).toBeCloseTo(0.9, 10);
  });

  it('детерминирована: два независимых мира — одинаковый агрегат', () => {
    const build = (): number => {
      const w = createSimWorld(12 as Seed);
      w.resources.set<FactionId>('faction', 20 as EntityId, 'bandits' as FactionId);
      setRelation(w.resources, NPC, entitySubject(20 as EntityId), -0.3);
      setRelation(w.resources, NPC, factionSubject('bandits' as FactionId), -0.5);
      return factionReputation(w.resources, NPC, 'bandits' as FactionId);
    };
    expect(build()).toBe(build());
  });
});

// ── ОБХОД ─────────────────────────────────────────────────────────────────────
describe('avoidLoc: addAvoid/isAvoided', () => {
  it('isAvoided true до untilTick, false на/после', () => {
    const w = createSimWorld(13 as Seed);
    addAvoid(w.resources, NPC, 4, 1000);
    expect(isAvoided(w.resources, NPC, 4, 999)).toBe(true);
    expect(isAvoided(w.resources, NPC, 4, 1000)).toBe(false); // untilTick исключающий
    expect(isAvoided(w.resources, NPC, 4, 1001)).toBe(false);
    expect(isAvoided(w.resources, NPC, 5, 999)).toBe(false); // другая локация
  });

  it('повторный addAvoid ПРОДЛЕВАЕТ до максимума (не сокращает)', () => {
    const w = createSimWorld(14 as Seed);
    addAvoid(w.resources, NPC, 4, 1000);
    addAvoid(w.resources, NPC, 4, 500); // короче — игнорируется
    expect(isAvoided(w.resources, NPC, 4, 800)).toBe(true);
    addAvoid(w.resources, NPC, 4, 2000); // дольше — продлевает
    expect(isAvoided(w.resources, NPC, 4, 1500)).toBe(true);
    expect(getAvoids(w.resources, NPC)).toHaveLength(1); // одна запись на loc
  });

  it('avoidLoc сорт. по loc детерминированно', () => {
    const w = createSimWorld(15 as Seed);
    addAvoid(w.resources, NPC, 9, 100);
    addAvoid(w.resources, NPC, 2, 100);
    addAvoid(w.resources, NPC, 5, 100);
    expect(getAvoids(w.resources, NPC).map((a) => a[0])).toEqual([2, 5, 9]);
  });
});

// ── УСИЛЕНИЕ 2.15: субъект round-trip на непростых id ─────────────────────────
describe('subject: round-trip на многозначных eid и фракциях с цифрами', () => {
  it('многозначный eid переживает parseSubject', () => {
    expect(parseSubject(entitySubject(123456 as EntityId))).toEqual({ kind: 'entity', eid: 123456 });
  });

  it('фракция с цифрами/подчёркиванием разбирается как строковый id (не число)', () => {
    const f = 'duty_2' as FactionId;
    const parsed = parseSubject(factionSubject(f));
    expect(parsed).toEqual({ kind: 'faction', faction: 'duty_2' });
  });

  it('сортировка субъектов однородна: все e:* раньше всех f:* (закон №8)', () => {
    const subs = [factionSubject('a' as FactionId), entitySubject(9 as EntityId), entitySubject(1 as EntityId)];
    expect([...subs].sort()).toEqual(['e:1', 'e:9', 'f:a']);
  });
});

// ── УСИЛЕНИЕ 2.15: отношения — знаковый переход и новые ссылки (D-035) ────────
describe('relations: adjustRelation через нейтрал и запись новым массивом', () => {
  it('adjustRelation переносит отношение из вражды в союзничество через 0', () => {
    const w = createSimWorld(16 as Seed);
    setRelation(w.resources, NPC, 'e:7', -0.4);
    adjustRelation(w.resources, NPC, 'e:7', 0.9); // −0.4 + 0.9 = +0.5
    expect(getRelation(w.resources, NPC, 'e:7')).toBeCloseTo(0.5, 10);
  });

  it('adjustRelation, приводящий РОВНО к 0, удаляет запись (нейтрал не хранится)', () => {
    const w = createSimWorld(17 as Seed);
    setRelation(w.resources, NPC, 'e:7', 0.3);
    adjustRelation(w.resources, NPC, 'e:7', -0.3); // ровно 0
    expect(getRelations(w.resources, NPC)).toHaveLength(0);
    expect(w.resources.has(RELATIONS_KEY, NPC)).toBe(false);
  });

  it('setRelation пишет НОВЫМ массивом (D-035): прежний снимок не мутируется', () => {
    const w = createSimWorld(18 as Seed);
    setRelation(w.resources, NPC, 'e:1', 0.5);
    const before = getRelations(w.resources, NPC);
    setRelation(w.resources, NPC, 'e:2', -0.5);
    expect(before).toHaveLength(1); // старый снимок не вырос
    expect(getRelations(w.resources, NPC)).not.toBe(before);
  });
});

// ── УСИЛЕНИЕ 2.15: factionReputation — порядко-независимость агрегата ─────────
describe('factionReputation: агрегат независим от порядка добавления', () => {
  it('одинаковое среднее при разном порядке вставки вкладов', () => {
    const build = (order: 'ab' | 'ba'): number => {
      const w = createSimWorld(19 as Seed);
      w.resources.set<FactionId>('faction', 20 as EntityId, 'bandits' as FactionId);
      w.resources.set<FactionId>('faction', 21 as EntityId, 'bandits' as FactionId);
      if (order === 'ab') {
        setRelation(w.resources, NPC, entitySubject(20 as EntityId), -0.2);
        setRelation(w.resources, NPC, entitySubject(21 as EntityId), -0.6);
        setRelation(w.resources, NPC, factionSubject('bandits' as FactionId), -0.4);
      } else {
        setRelation(w.resources, NPC, factionSubject('bandits' as FactionId), -0.4);
        setRelation(w.resources, NPC, entitySubject(21 as EntityId), -0.6);
        setRelation(w.resources, NPC, entitySubject(20 as EntityId), -0.2);
      }
      return factionReputation(w.resources, NPC, 'bandits' as FactionId);
    };
    expect(build('ab')).toBeCloseTo(-0.4, 10);
    expect(build('ab')).toBe(build('ba')); // порядок вставки не влияет
  });

  it('член фракции, сменивший фракцию, перестаёт быть вкладом (DERIVED из состояния)', () => {
    const w = createSimWorld(21 as Seed);
    w.resources.set<FactionId>('faction', 20 as EntityId, 'bandits' as FactionId);
    setRelation(w.resources, NPC, entitySubject(20 as EntityId), -0.8);
    expect(factionReputation(w.resources, NPC, 'bandits' as FactionId)).toBeCloseTo(-0.8, 10);
    // eid 20 перешёл в loners → его отношение больше не вклад в репутацию bandits.
    w.resources.set<FactionId>('faction', 20 as EntityId, 'loners' as FactionId);
    expect(factionReputation(w.resources, NPC, 'bandits' as FactionId)).toBe(0);
  });
});

// ── УСИЛЕНИЕ 2.15: обход — новая ссылка массива (D-035) ───────────────────────
describe('avoidLoc: запись новым массивом (D-035)', () => {
  it('addAvoid не мутирует прежний снимок', () => {
    const w = createSimWorld(22 as Seed);
    addAvoid(w.resources, NPC, 4, 100);
    const before = getAvoids(w.resources, NPC);
    addAvoid(w.resources, NPC, 5, 100);
    expect(before).toHaveLength(1);
    expect(getAvoids(w.resources, NPC)).not.toBe(before);
  });
});

// Ссылки на типы (документируют форму значений ResourceStore).
const _rel: RelationEntry = ['e:1', 0.5];
const _avoid: AvoidEntry = [4, 100];
void _rel;
void _avoid;
