/**
 * @module @zona/sim/systems/encounter-resolver.test
 *
 * Гейт ЕДИНОГО резолвера (задача 1.10b, D-022). Покрывает:
 *  - ДЕТЕРМИНИЗМ от (вход, rng): один вход + один seed → идентичный outcome (deep)
 *    И идентичные мутации Combatant.health;
 *  - ОХОТА: стрелок vs олень → раунды>0, ammoSpent>0, олень в casualties, охотник
 *    survivor, disposition sideWon / winnerSide 0;
 *  - ЕДИНАЯ СИГНАТУРА: две стороны ИЗ ЛЮДЕЙ (ammo>0) резолвятся тем же кодом
 *    (человек-vs-человек заглушка не падает, даёт валидный исход);
 *  - РИСК: кабан (высокий power/melee) убивает слабого охотника (человек в
 *    casualties, животное survivor);
 *  - ЗАКОН №2 (разброс, не шанс): при РАЗНОМ rng исход может отличаться, но при
 *    ФИКСИРОВАННОМ rng полностью детерминирован;
 *  - ammoSpent сорт. по eid; casualties/survivors сорт. по eid.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, LocationId, Seed } from '@zona/shared';
import { createRng } from '../core/rng';
import { resolveEncounter, type Combatant, type EncounterInput } from './encounter-resolver';
import { MAX_ROUNDS } from '../balance/combat';

const LOC = 0 as LocationId;

/** Фабрика бойца (health — изменяемое, резолвер пишет туда итог). */
function mk(
  eid: number,
  side: number,
  power: number,
  ammo: number,
  melee: number,
  health: number,
): Combatant {
  return { eid: eid as EntityId, side, power, ammo, melee, health };
}

/** Свежий forked rng от seed (stateless метка — как в системе Encounters). */
function rngOf(seed: number) {
  return createRng(seed as Seed).fork('encounter@test');
}

/** Строит вход (свежие бойцы каждый раз — резолвер мутирует health). */
function huntInput(seed: number): EncounterInput {
  return {
    loc: LOC,
    sides: [[mk(10, 0, 6, 16, 5, 100)], [mk(20, 1, 2, 0, 3, 100)]],
    cause: null,
    rng: rngOf(seed),
    maxRounds: MAX_ROUNDS,
  };
}

describe('encounter-resolver: охота стрелок vs олень', () => {
  it('раунды идут, патроны тратятся, олень гибнет, охотник уцелел', () => {
    const out = resolveEncounter(huntInput(42));
    expect(out.rounds).toBeGreaterThan(0);
    expect(out.disposition).toBe('sideWon');
    expect(out.winnerSide).toBe(0);
    // Олень (eid20) убит; охотник (eid10) уцелел.
    expect(out.casualties).toContain(20 as EntityId);
    expect(out.survivors).toContain(10 as EntityId);
    // Патроны реально израсходованы стрелком (закон №3 на стороне системы).
    const spentByHunter = out.ammoSpent.find(([e]) => e === (10 as EntityId));
    expect(spentByHunter).toBeDefined();
    expect((spentByHunter as readonly [EntityId, number])[1]).toBeGreaterThan(0);
    // Олень (ammo=0) патроны не тратит.
    expect(out.ammoSpent.find(([e]) => e === (20 as EntityId))).toBeUndefined();
    // loot содержит убитого оленя.
    expect(out.loot.map((l) => l.from)).toContain(20 as EntityId);
  });

  it('детерминизм: один вход+seed → идентичный outcome И идентичные health', () => {
    const inA = huntInput(42);
    const inB = huntInput(42);
    const a = resolveEncounter(inA);
    const b = resolveEncounter(inB);
    expect(a).toEqual(b);
    // Мутации health в переданные Combatant тоже идентичны (out-канал).
    const hpA = inA.sides.flat().map((c) => c.health);
    const hpB = inB.sides.flat().map((c) => c.health);
    expect(hpA).toEqual(hpB);
  });

  it('закон №2: разный rng даёт иной ход, но каждый фикс. rng детерминирован', () => {
    const inA1 = huntInput(42);
    const inA2 = huntInput(42);
    const a1 = resolveEncounter(inA1);
    const a2 = resolveEncounter(inA2);
    // Фикс. rng → бит-в-бит один и тот же исход И те же мутации health.
    expect(a1).toEqual(a2);
    expect(inA1.sides.flat().map((c) => c.health)).toEqual(inA2.sides.flat().map((c) => c.health));

    // Другой разброс (seed 1) → иной ход боя: сам факт исхода выведен из
    // НАКОПЛЕННОГО урона по разбросу, а не «X% шанс убить» (закон №2). Здесь
    // seed42 кончает оленя за 4 выстрела, seed1 — за 6 (разное число раундов).
    const b = resolveEncounter(huntInput(1));
    expect(b.rounds).not.toBe(a1.rounds);
  });
});

describe('encounter-resolver: единая сигнатура (человек-vs-человек заглушка)', () => {
  it('две стороны ИЗ ЛЮДЕЙ (ammo>0) резолвятся тем же кодом, не падая', () => {
    const out = resolveEncounter({
      loc: LOC,
      sides: [[mk(10, 0, 6, 16, 5, 100)], [mk(20, 1, 6, 16, 5, 100)]],
      cause: null,
      rng: rngOf(42),
      maxRounds: MAX_ROUNDS,
    });
    // Валидная развязка (не завис, не бросил): кто-то победил/пат/слом.
    expect(['sideWon', 'mutualBreak', 'stalemate']).toContain(out.disposition);
    // Обе стороны — стрелки: обе тратят патроны, пока живы (сорт. по eid).
    expect(out.ammoSpent.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < out.ammoSpent.length; i++) {
      expect(out.ammoSpent[i]![0]).toBeGreaterThan(out.ammoSpent[i - 1]![0]);
    }
  });
});

describe('encounter-resolver: охота РИСКОВАННА', () => {
  it('кабан (высокий power/melee) убивает слабого охотника', () => {
    // Раненый охотник (hp 20) против здорового кабана (power8, melee14) — состояние
    // мира ведёт к гибели человека (детерминированно, не «X% смерти»).
    const hunter = mk(10, 0, 6, 16, 5, 20);
    const boar = mk(20, 1, 8, 0, 14, 100);
    const out = resolveEncounter({
      loc: LOC,
      sides: [[hunter], [boar]],
      cause: null,
      rng: rngOf(42),
      maxRounds: MAX_ROUNDS,
    });
    expect(out.casualties).toContain(10 as EntityId); // охотник погиб
    expect(out.survivors).toContain(20 as EntityId); // кабан выжил
    expect(out.disposition).toBe('sideWon');
    expect(out.winnerSide).toBe(1);
    expect(hunter.health).toBeLessThanOrEqual(0); // out-канал: hp записан
  });
});

describe('encounter-resolver: лимит раундов = пат, никто не убит из воздуха', () => {
  it('maxRounds достигнут без развязки → stalemate, casualties пусты, патроны = раундам', () => {
    // Живучий олень (hp огромный) и стрелок, чей урон за 6 раундов физически не
    // добивает цель (25×6 << hp). Ни выбывания, ни морали (по одному бойцу, 0
    // потерь) → бой упирается в лимит. Никакой смерти «из воздуха».
    const hunter = mk(10, 0, 6, 999, 5, 10000);
    const deer = mk(20, 1, 2, 0, 3, 10000);
    const out = resolveEncounter({
      loc: LOC,
      sides: [[hunter], [deer]],
      cause: null,
      rng: rngOf(7),
      maxRounds: 6,
    });
    expect(out.disposition).toBe('stalemate');
    expect(out.winnerSide).toBeNull();
    expect(out.rounds).toBe(6);
    expect(out.casualties).toEqual([]); // никто не «убит», хотя развязки нет
    expect(out.survivors).toEqual([10 as EntityId, 20 as EntityId]);
    // Патроны списаны РОВНО по числу раундов стрельбы (закон №3, ничего лишнего).
    expect(out.ammoSpent).toEqual([[10 as EntityId, 6]]);
    // out-канал: оба живы, здоровье записано и положительно.
    expect(hunter.health).toBeGreaterThan(0);
    expect(deer.health).toBeGreaterThan(0);
  });
});

describe('encounter-resolver: сторона без патронов дерётся melee', () => {
  it('ammo=0 → бьёт в упор (melee), расход патронов = 0, урон наносится', () => {
    // Атакующий безоружен по патронам (ammo=0), но melee>0. Пассивная цель
    // (power/melee/ammo = 0) не может ответить — изолируем механику melee.
    const brawler = mk(10, 0, 10, 0, 50, 100);
    const dummy = mk(20, 1, 0, 0, 0, 50);
    const out = resolveEncounter({
      loc: LOC,
      sides: [[brawler], [dummy]],
      cause: null,
      rng: rngOf(7),
      maxRounds: 50,
    });
    // Цель убита melee-ударом; атакующий уцелел.
    expect(out.casualties).toEqual([20 as EntityId]);
    expect(out.winnerSide).toBe(0);
    expect(out.disposition).toBe('sideWon');
    // ЗАКОН №3: melee не тратит патроны — ammoSpent пуст.
    expect(out.ammoSpent).toEqual([]);
  });
});

describe('encounter-resolver: слом морали из СОСТОЯНИЯ (не «X% побега»)', () => {
  it('порог потерь стороны достигнут → уцелевшие бегут (survivors), не гибнут', () => {
    // side0 — двое безответных (passive), side1 — один сильный melee-убийца. Он
    // фокусит мин-eid (eid10) и убивает его. Потери side0 = 1/2 = порог 0.5 →
    // side0 ломается: eid11 ЖИВ, но бежит (survivor), НЕ убит из воздуха.
    const out = resolveEncounter({
      loc: LOC,
      sides: [
        [mk(10, 0, 0, 0, 0, 10), mk(11, 0, 0, 0, 0, 9999)],
        [mk(20, 1, 10, 0, 100, 9999)],
      ],
      cause: null,
      rng: rngOf(7),
      maxRounds: 50,
    });
    expect(out.casualties).toEqual([10 as EntityId]); // погиб ровно мин-eid
    expect(out.survivors).toContain(11 as EntityId); // сломался, но ЖИВ (сбежал)
    expect(out.survivors).toContain(20 as EntityId);
    expect(out.winnerSide).toBe(1); // несломанная сторона победила
    expect(out.disposition).toBe('sideWon');
  });

  it('обе стороны переходят порог одновременно → mutualBreak, беглецы живы', () => {
    // Симметрично: у каждой стороны гибнет мин-eid, вторая половина бежит.
    const out = resolveEncounter({
      loc: LOC,
      sides: [
        [mk(10, 0, 10, 0, 100, 10), mk(11, 0, 0, 0, 0, 9999)],
        [mk(20, 1, 10, 0, 100, 10), mk(21, 1, 0, 0, 0, 9999)],
      ],
      cause: null,
      rng: rngOf(1),
      maxRounds: 50,
    });
    expect(out.disposition).toBe('mutualBreak');
    expect(out.winnerSide).toBeNull();
    expect(out.casualties).toEqual([10 as EntityId, 20 as EntityId]);
    expect(out.survivors).toEqual([11 as EntityId, 21 as EntityId]); // оба беглеца живы
  });

  it('взаимное уничтожение в одном раунде → mutualBreak (livingSides=0)', () => {
    // Два одиночных бойца добивают друг друга синхронно в одном раунде.
    const out = resolveEncounter({
      loc: LOC,
      sides: [[mk(10, 0, 10, 0, 100, 10)], [mk(20, 1, 10, 0, 100, 10)]],
      cause: null,
      rng: rngOf(1),
      maxRounds: 50,
    });
    expect(out.disposition).toBe('mutualBreak');
    expect(out.winnerSide).toBeNull();
    expect(out.casualties).toEqual([10 as EntityId, 20 as EntityId]);
    expect(out.survivors).toEqual([]);
  });
});

describe('encounter-resolver: люди-vs-люди, несколько бойцов на сторону (D-022)', () => {
  it('2 vs 2 стрелка резолвятся тем же кодом; исход валиден и детерминирован', () => {
    const sides = () => [
      [mk(10, 0, 6, 16, 5, 100), mk(11, 0, 6, 16, 5, 100)],
      [mk(20, 1, 6, 16, 5, 100), mk(21, 1, 6, 16, 5, 100)],
    ];
    const run = () =>
      resolveEncounter({ loc: LOC, sides: sides(), cause: null, rng: rngOf(9), maxRounds: MAX_ROUNDS });
    const a = run();
    const b = run();
    expect(a).toEqual(b); // единый вход+seed → идентичный исход (детерминизм)
    expect(['sideWon', 'mutualBreak', 'stalemate']).toContain(a.disposition);
    // casualties/survivors — подмножество исходных eid, без «лишних» сущностей.
    const all = new Set([10, 11, 20, 21]);
    for (const e of [...a.casualties, ...a.survivors]) expect(all.has(e as number)).toBe(true);
    // Каждый выбывший И каждый уцелевший учтён ровно раз (нет дублей/пропаж).
    expect(a.casualties.length + a.survivors.length).toBe(4);
    // Стрелявшие потратили патроны; записи сорт. по eid.
    for (let i = 1; i < a.ammoSpent.length; i++) {
      expect(a.ammoSpent[i]![0]).toBeGreaterThan(a.ammoSpent[i - 1]![0]);
    }
  });
});

describe('encounter-resolver: сортировки и инварианты', () => {
  it('casualties/survivors/ammoSpent отсортированы по eid', () => {
    const out = resolveEncounter({
      loc: LOC,
      sides: [
        [mk(30, 0, 6, 16, 5, 100), mk(10, 0, 6, 16, 5, 100)],
        [mk(20, 1, 8, 0, 14, 100)],
      ],
      cause: null,
      rng: rngOf(3),
      maxRounds: MAX_ROUNDS,
    });
    const sorted = (a: readonly number[]) => a.every((v, i) => i === 0 || v >= a[i - 1]!);
    expect(sorted(out.casualties as readonly number[])).toBe(true);
    expect(sorted(out.survivors as readonly number[])).toBe(true);
    expect(sorted(out.ammoSpent.map((p) => p[0]) as readonly number[])).toBe(true);
  });
});
