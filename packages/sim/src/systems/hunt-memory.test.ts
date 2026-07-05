/**
 * @module @zona/sim/systems/hunt-memory.test
 *
 * Гейт ЛИЧНОЙ ОХОТНИЧЬЕЙ ПАМЯТИ (задача P-5/Б, D-087). Проверяет ЭМЕРДЖЕНТНУЮ недоохоту
 * из ЛИЧНОГО опыта (анти-чит: только воспринятое+память, без мирового знания):
 *  - подкрепление: воспринятая дичь в loc → expectation=1;
 *  - пустой выход: стоя у угодья без дичи → expectation падает; после N выходов угодье
 *    ЗАБЫВАЕТСЯ (снято из памяти) ⇒ выпадает из кандидатов охоты;
 *  - порог MIN и старение (MAX_AGE) забывают угодье;
 *  - сериализуемость: запись переживает serialize/deserialize тождественно (resume-safe);
 *  - детерминизм: два прогона одной последовательности → идентичная память.
 */

import { describe, it, expect } from 'vitest';
import type { EntityId, Seed } from '@zona/shared';
import { createSimWorld, type SimWorld } from '../core/world';
import { spawnEntity, addComponent } from '../core/ecs';
import { Alive } from '../core/components';
import { serialize, deserialize } from '../core/snapshot';
import {
  getHuntGrounds,
  getGroundExpectation,
  updateHuntMemory,
  HUNT_MEMORY_KEY,
  type HuntGroundEntry,
} from './hunt-memory';
import {
  HUNT_GROUND_EMPTY_PENALTY,
  HUNT_GROUND_MIN_EXPECTATION,
  HUNT_GROUND_MAX_AGE_TICKS,
} from '../balance/ecology';

/** Живой охотник-носитель (Alive) — иначе serialize фильтрует его ресурсы (D-012). */
function liveHunter(w: SimWorld): EntityId {
  const eid = spawnEntity(w.ecs);
  addComponent(w.ecs, Alive, eid);
  return eid;
}

describe('охотничья память: подкрепление из ЛИЧНОГО восприятия (закон №1, анти-чит)', () => {
  it('видит дичь в loc → expectation этого угодья = 1', () => {
    const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
    updateHuntMemory(w.resources, HUNTER, 100, new Set([5]), undefined);
    expect(getGroundExpectation(w.resources, HUNTER, 5)).toBe(1);
    // Незнакомое угодье — 0 (не помнит).
    expect(getGroundExpectation(w.resources, HUNTER, 9)).toBe(0);
    // Кандидат-угодье появилось из ЛИЧНОГО наблюдения (не из глобального скана).
    expect(getHuntGrounds(w.resources, HUNTER).map((g) => g[0])).toEqual([5]);
  });

  it('несколько воспринятых угодий → все с expectation 1, сорт. по loc (закон №8)', () => {
    const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
    updateHuntMemory(w.resources, HUNTER, 100, new Set([7, 2, 5]), undefined);
    expect(getHuntGrounds(w.resources, HUNTER).map((g) => g[0])).toEqual([2, 5, 7]);
  });
});

describe('охотничья память: ЭКОНОМИЧЕСКАЯ недоохота — пустые выходы забывают угодье', () => {
  it('N пустых выходов к угодью → expectation падает и угодье ЗАБЫВАЕТСЯ', () => {
    const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
    // Узнали угодье 5 (видели дичь).
    updateHuntMemory(w.resources, HUNTER, 100, new Set([5]), undefined);
    expect(getGroundExpectation(w.resources, HUNTER, 5)).toBe(1);

    // Пустые выходы: стоим у 5, дичи НЕ воспринимаем (perceived пуст, emptyStandLoc=5).
    let exp = 1;
    let trips = 0;
    while (getHuntGrounds(w.resources, HUNTER).some((g) => g[0] === 5)) {
      updateHuntMemory(w.resources, HUNTER, 200 + trips, new Set<number>(), 5);
      trips++;
      const next = getGroundExpectation(w.resources, HUNTER, 5);
      // Пока помнит — монотонно падает на penalty; забыл — стал 0.
      if (getHuntGrounds(w.resources, HUNTER).some((g) => g[0] === 5)) {
        expect(next).toBeCloseTo(exp - HUNT_GROUND_EMPTY_PENALTY, 5);
        exp = next;
      }
      if (trips > 50) break; // страховка
    }
    // Угодье забыто (перевыбитое из личного опыта, БЕЗ мирового счётчика).
    expect(getGroundExpectation(w.resources, HUNTER, 5)).toBe(0);
    // Забвение — НЕ мгновенное (несколько пустых выходов) и НЕ вечное: примерно
    // (1 − MIN)/penalty выходов ± 1 (эмерджентно, детерминировано; точное k чувствительно
    // к FP-накоплению, поэтому проверяем коридор, а не ровное число).
    const approx = (1 - HUNT_GROUND_MIN_EXPECTATION) / HUNT_GROUND_EMPTY_PENALTY;
    expect(trips).toBeGreaterThanOrEqual(Math.floor(approx));
    expect(trips).toBeLessThanOrEqual(Math.ceil(approx) + 1);
  });

  it('пустой выход к НЕзнакомому угодью — no-op (нечего забывать)', () => {
    const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
    updateHuntMemory(w.resources, HUNTER, 100, new Set<number>(), 9);
    expect(getHuntGrounds(w.resources, HUNTER)).toEqual([]);
  });

  it('подкрепление ПОСЛЕ просадки восстанавливает уверенность (снова увидел дичь)', () => {
    const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
    updateHuntMemory(w.resources, HUNTER, 100, new Set([5]), undefined);
    updateHuntMemory(w.resources, HUNTER, 200, new Set<number>(), 5); // один пустой выход
    expect(getGroundExpectation(w.resources, HUNTER, 5)).toBeCloseTo(1 - HUNT_GROUND_EMPTY_PENALTY, 5);
    updateHuntMemory(w.resources, HUNTER, 300, new Set([5]), undefined); // снова видит дичь
    expect(getGroundExpectation(w.resources, HUNTER, 5)).toBe(1);
  });
});

describe('охотничья память: старение (закон №2, детерминированная функция tick)', () => {
  it('запись старше MAX_AGE без подкрепления забывается', () => {
    const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
    updateHuntMemory(w.resources, HUNTER, 100, new Set([5]), undefined);
    // Обновление сильно позже (тик > 100 + MAX_AGE), без подкрепления 5 → 5 стареет.
    updateHuntMemory(w.resources, HUNTER, 100 + HUNT_GROUND_MAX_AGE_TICKS + 1, new Set([8]), undefined);
    expect(getGroundExpectation(w.resources, HUNTER, 5)).toBe(0); // забыто по возрасту
    expect(getGroundExpectation(w.resources, HUNTER, 8)).toBe(1); // свежее — помнит
  });
});

describe('охотничья память: сериализуемость и детерминизм (закон №8, resume-safe)', () => {
  it('память переживает serialize/deserialize тождественно', () => {
    const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
    updateHuntMemory(w.resources, HUNTER, 100, new Set([5, 8]), undefined);
    updateHuntMemory(w.resources, HUNTER, 150, new Set<number>(), 5); // просадка 5
    const before = getHuntGrounds(w.resources, HUNTER) as readonly HuntGroundEntry[];

    const restored = deserialize(serialize(w));
    const after = getHuntGrounds(restored.resources, HUNTER) as readonly HuntGroundEntry[];
    expect(after).toEqual(before);
  });

  it('пустой набор снимает ключ ресурса (нет вечного пустого массива)', () => {
    const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
    updateHuntMemory(w.resources, HUNTER, 100, new Set([5]), undefined);
    // Забываем 5 пустыми выходами.
    for (let i = 0; i < 20 && getHuntGrounds(w.resources, HUNTER).length > 0; i++) {
      updateHuntMemory(w.resources, HUNTER, 200 + i, new Set<number>(), 5);
    }
    expect(w.resources.get(HUNT_MEMORY_KEY, HUNTER)).toBeUndefined();
  });

  it('детерминизм: две идентичные последовательности → идентичная память', () => {
    const run = (): readonly HuntGroundEntry[] => {
      const w = createSimWorld(1 as Seed);
    const HUNTER = liveHunter(w);
      updateHuntMemory(w.resources, HUNTER, 100, new Set([5, 8]), undefined);
      updateHuntMemory(w.resources, HUNTER, 150, new Set([3]), 5);
      updateHuntMemory(w.resources, HUNTER, 160, new Set<number>(), 8);
      return getHuntGrounds(w.resources, HUNTER) as readonly HuntGroundEntry[];
    };
    expect(run()).toEqual(run());
  });
});
