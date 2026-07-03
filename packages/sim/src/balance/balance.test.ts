/**
 * @module @zona/sim/balance/balance.test
 *
 * Юниты балансовых констант (задача 1.1): защита от опечаток-нулей и вылетов за
 * разумные границы (порог 0<thr<=100, все ставки>0, веса конечны, стартовый
 * инвентарь ссылается на реальные предметы items.json). Не тюнинг баланса —
 * только «санитарные» инварианты, ловящие грубые ошибки контента.
 */

import { describe, it, expect } from 'vitest';
import * as needs from './needs';
import * as utility from './utility';
import * as combat from './combat';
import * as weather from './weather';
import * as movement from './movement';
import * as worldgen from './worldgen';
import { TICKS_PER_DAY } from './time';
import { getItem, getSpecies } from '../data/index';

describe('needs: ставки и пороги', () => {
  it('все ставки роста нужд строго > 0', () => {
    for (const r of [needs.HUNGER_PER_TICK, needs.THIRST_PER_TICK, needs.FATIGUE_PER_TICK]) {
      expect(r).toBeGreaterThan(0);
    }
  });

  it('критические пороги в (0, 100]', () => {
    for (const thr of [needs.HUNGER_CRITICAL, needs.THIRST_CRITICAL, needs.FATIGUE_CRITICAL]) {
      expect(thr).toBeGreaterThan(0);
      expect(thr).toBeLessThanOrEqual(100);
    }
  });

  it('урон истощения и восстановление > 0', () => {
    for (const v of [
      needs.STARVATION_DAMAGE_PER_TICK,
      needs.DEHYDRATION_DAMAGE_PER_TICK,
      needs.SLEEP_RECOVERY_PER_TICK,
      needs.HEALTH_REGEN_PER_TICK,
    ]) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it('жажда острее голода (обезвоживание быстрее голодания)', () => {
    expect(needs.THIRST_PER_TICK).toBeGreaterThan(needs.HUNGER_PER_TICK);
    expect(needs.DEHYDRATION_DAMAGE_PER_TICK).toBeGreaterThan(needs.STARVATION_DAMAGE_PER_TICK);
  });

  it('здоровье и нужды имеют осмысленный потолок', () => {
    expect(needs.HEALTH_MAX).toBe(100);
    expect(needs.NEED_MAX).toBe(100);
  });
});

describe('utility: веса', () => {
  it('все веса конечны и не абсурдны (|w| < 10)', () => {
    for (const [k, w] of Object.entries(utility.W)) {
      expect(Number.isFinite(w), `вес ${k}`).toBe(true);
      expect(Math.abs(w)).toBeLessThan(10);
    }
  });

  it('fallback-пол строго > 0 (idle запрещён, D-020)', () => {
    expect(utility.FALLBACK_SCORE_FLOOR).toBeGreaterThan(0);
    expect(utility.W.forageBase).toBeGreaterThan(0);
  });

  it('ни один вес не undefined/NaN (иначе score=NaN и argmax сломан)', () => {
    // Каждый драйвер должен иметь ЧИСЛОВОЙ вес: пропуск ключа даёт w=undefined,
    // взвешивание даёт NaN, и детерминированный argmax (D-020) выбирает мусор.
    for (const [k, w] of Object.entries(utility.W)) {
      expect(w, `вес ${k} не число`).toBeTypeOf('number');
      expect(Number.isNaN(w), `вес ${k} === NaN`).toBe(false);
    }
  });

  it('веса заданы для ВСЕХ ожидаемых драйверов задач (нет дыр в наборе)', () => {
    // Явный контракт: если драйвер убрали из W, score его задачи станет NaN.
    const required = [
      'hunger', 'thirst', 'fatigue', 'night', 'safe',
      'food', 'water', 'game', 'skill', 'fear', 'home', 'forageBase',
    ] as const;
    for (const key of required) {
      expect(utility.W[key], `отсутствует вес драйвера "${key}"`).toBeTypeOf('number');
    }
    expect(utility.ROUTE_DANGER_WEIGHT).toBeGreaterThan(0);
  });
});

describe('combat: резолвер', () => {
  it('раунды и расход патронов — положительные целые', () => {
    expect(Number.isInteger(combat.MAX_ROUNDS)).toBe(true);
    expect(combat.MAX_ROUNDS).toBeGreaterThan(0);
    expect(combat.AMMO_PER_ROUND).toBeGreaterThan(0);
  });

  it('точность и её границы в [0,1], min<=base<=max', () => {
    for (const a of [combat.BASE_ACCURACY, combat.MIN_ACCURACY, combat.MAX_ACCURACY]) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
    expect(combat.MIN_ACCURACY).toBeLessThanOrEqual(combat.BASE_ACCURACY);
    expect(combat.BASE_ACCURACY).toBeLessThanOrEqual(combat.MAX_ACCURACY);
    expect(combat.RANGED_HIT_DAMAGE).toBeGreaterThan(0);
  });
});

describe('weather: суточный цикл и длительности', () => {
  it('DAWN < DUSK, оба внутри суток', () => {
    expect(weather.DAWN_TICK).toBeGreaterThan(0);
    expect(weather.DAWN_TICK).toBeLessThan(weather.DUSK_TICK);
    expect(weather.DUSK_TICK).toBeLessThan(TICKS_PER_DAY);
  });

  it('длительности погоды: 0 < min <= max', () => {
    expect(weather.WEATHER_MIN_DURATION).toBeGreaterThan(0);
    expect(weather.WEATHER_MIN_DURATION).toBeLessThanOrEqual(weather.WEATHER_MAX_DURATION);
    expect(weather.WEATHER_TYPES.length).toBeGreaterThan(0);
  });
});

describe('movement', () => {
  it('штрафы скорости >= 1, минимум перехода >= 1', () => {
    expect(movement.NIGHT_SPEED_PENALTY).toBeGreaterThanOrEqual(1);
    expect(movement.FATIGUE_SPEED_PENALTY).toBeGreaterThanOrEqual(1);
    expect(movement.MIN_TRAVEL_TICKS).toBeGreaterThanOrEqual(1);
  });
});

describe('worldgen: связность с данными (закон №3/№10)', () => {
  it('20 сталкеров', () => {
    expect(worldgen.STALKER_COUNT).toBe(20);
  });

  it('каждый itemId стартового набора существует в items.json, qty>0', () => {
    for (const s of worldgen.STARTING_INVENTORY) {
      expect(() => getItem(s.itemId)).not.toThrow();
      expect(s.qty).toBeGreaterThan(0);
    }
  });

  it('стартовые деньги неотрицательны', () => {
    expect(worldgen.STARTING_MONEY).toBeGreaterThanOrEqual(0);
  });

  it('каждый speciesId стартовых стад существует, herds>0', () => {
    for (const h of worldgen.STARTING_HERDS) {
      expect(() => getSpecies(h.speciesId)).not.toThrow();
      expect(h.herds).toBeGreaterThan(0);
    }
  });

  it('точка входа — валидная локация', () => {
    expect(worldgen.ENTRY_LOCATION).toBeGreaterThanOrEqual(0);
    expect(worldgen.ENTRY_LOCATION).toBeLessThan(10);
  });
});
