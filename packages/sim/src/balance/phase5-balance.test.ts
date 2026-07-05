/**
 * @module @zona/sim/balance/phase5-balance.test
 *
 * Юниты балансовых констант Фазы 5 (задача 5.1, закон №7): «санитарные» инварианты
 * против опечаток-нулей/вылетов за границы + GUARD-КАНАРЕЙКИ кратности (закон №8):
 * длительности фаз выброса ОБЯЗАНЫ быть кратны каденции системы эмиссии (10), иначе
 * смена фазы «проскочит» между запусками. Не тюнинг баланса — ловля грубых ошибок.
 */

import { describe, it, expect } from 'vitest';
import * as ecology from './ecology';
import * as disease from './disease';
import * as strategy from './strategy';

describe('ecology: константы выброса/эмиссии определены и осмысленны', () => {
  it('пороги давления в (0,1], WARN < BURST', () => {
    expect(ecology.EMISSION_WARN_THRESHOLD).toBeGreaterThan(0);
    expect(ecology.EMISSION_WARN_THRESHOLD).toBeLessThan(ecology.EMISSION_BURST_THRESHOLD);
    expect(ecology.EMISSION_BURST_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('прирост давления >0 и строго меньше порога за один шаг (не проскок)', () => {
    expect(ecology.EMISSION_PRESSURE_PER_CHARGE).toBeGreaterThan(0);
    expect(ecology.EMISSION_PRESSURE_PER_CHARGE * ecology.EMISSION_CADENCE).toBeLessThan(
      ecology.EMISSION_BURST_THRESHOLD,
    );
  });

  it('урон/укрытие/перезарядка полей в разумных границах', () => {
    expect(ecology.EMISSION_DAMAGE_PER_TICK).toBeGreaterThan(0);
    expect(ecology.EMISSION_SHELTER_SAFE).toBeGreaterThanOrEqual(0);
    expect(ecology.EMISSION_SHELTER_SAFE).toBeLessThanOrEqual(10);
    expect(ecology.FIELD_RECHARGE_ON_EMISSION).toBeGreaterThan(0);
  });

  it('GUARD-КАНАРЕЙКА: EMISSION_*_TICKS кратны каденции эмиссии (10)', () => {
    expect(ecology.EMISSION_CADENCE).toBe(10);
    expect(ecology.EMISSION_IMMINENT_TICKS % ecology.EMISSION_CADENCE).toBe(0);
    expect(ecology.EMISSION_ACTIVE_TICKS % ecology.EMISSION_CADENCE).toBe(0);
    expect(ecology.EMISSION_IMMINENT_TICKS).toBeGreaterThan(0);
    expect(ecology.EMISSION_ACTIVE_TICKS).toBeGreaterThan(0);
  });

  it('форедж/реанимация/шум зомби определены и >0', () => {
    expect(ecology.FORAGE_FOOD_YIELD_PER_ABUNDANCE).toBeGreaterThan(0);
    expect(ecology.REANIMATION_DELAY_TICKS).toBeGreaterThan(0);
    expect(ecology.ZOMBIE_NOISE_RADIUS).toBeGreaterThan(0);
  });
});

describe('disease: ставки/пороги болезней', () => {
  it('экспозиция за контакт/холод >0, порог заражения в (0,1]', () => {
    expect(disease.EXPOSURE_PER_SICK_CONTACT).toBeGreaterThan(0);
    expect(disease.EXPOSURE_COLD_WEATHER).toBeGreaterThan(0);
    expect(disease.INFECTION_THRESHOLD).toBeGreaterThan(0);
    expect(disease.INFECTION_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('рост тяжести/урон/лечение определены; летальный порог в (0,1]', () => {
    expect(disease.SEVERITY_RISE_PER_TICK).toBeGreaterThan(0);
    expect(disease.SEVERITY_DAMAGE_MULT).toBeGreaterThan(0);
    expect(disease.RECOVERY_TICKS).toBeGreaterThan(0);
    expect(Number.isInteger(disease.RECOVERY_TICKS)).toBe(true);
    expect(disease.SICKNESS_LETHAL_SEVERITY).toBeGreaterThan(0);
    expect(disease.SICKNESS_LETHAL_SEVERITY).toBeLessThanOrEqual(1);
    expect(disease.TREAT_SEVERITY_DROP).toBeGreaterThan(0);
    expect(disease.TREAT_SEVERITY_DROP).toBeLessThanOrEqual(1);
  });
});

describe('strategy: веса и пороги стратегического AI', () => {
  it('W_STRAT: все веса конечны, числовые, не абсурдны', () => {
    const required = ['threat', 'resourceDeficit', 'relationHostility', 'allyStrength'] as const;
    for (const key of required) {
      const w = strategy.W_STRAT[key];
      expect(w, `вес ${key}`).toBeTypeOf('number');
      expect(Number.isFinite(w)).toBe(true);
      expect(Math.abs(w)).toBeLessThan(10);
    }
  });

  it('пороги действий определены и в разумных границах', () => {
    for (const t of [
      strategy.SWEEP_THRESHOLD,
      strategy.RAID_THRESHOLD,
      strategy.DIPLOMACY_THRESHOLD,
    ]) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(1);
    }
    // Война с людьми (RAID) требует более острого повода, чем зачистка зверья (SWEEP).
    expect(strategy.RAID_THRESHOLD).toBeGreaterThanOrEqual(strategy.SWEEP_THRESHOLD);
  });
});
