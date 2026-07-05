/**
 * @module @zona/sim/balance/phase5-guard-canary.test
 *
 * УСИЛЕНИЕ guard-канареек баланса Фазы 5 (задача 5.1, законы №7/№8). phase5-balance.test
 * проверяет, что реальные константы СЕЙЧАС осмысленны; здесь дополнительно доказываем,
 * что САМА КАНАРЕЙКА живая — т.е. некратная каденции длительность фазы выброса РЕАЛЬНО
 * была бы отвергнута, а не «прошла бы по недосмотру». Плюс дозакрываем упорядоченность
 * стратегических порогов (дипломатия дешевле войны) и конечность всех ставок болезней.
 *
 * Runtime-guard кратности живёт на верхнем уровне ecology.ts (бросок при загрузке
 * модуля). Подменить литерал-const в живом модуле нельзя (а sim — чистый headless, без
 * доступа к fs), поэтому канарейку проверяем реплика-предикатом: точная копия проверки
 * `ticks % cadence !== 0 → throw` доказывает, что логика ДИСКРИМИНИРУЕТ кратные/некратные
 * и БРОСАЕТ на некратном — плюс сверяем, что реальные константы модуля кратны каденции.
 */

import { describe, it, expect } from 'vitest';
import * as ecology from './ecology';
import * as disease from './disease';
import * as strategy from './strategy';

describe('ecology guard-канарейка: кратность фаз выброса каденции эмиссии', () => {
  it('предикат ДИСКРИМИНИРУЕТ: реальные значения кратны, +1 — уже нет', () => {
    const cadence = ecology.EMISSION_CADENCE;
    // Реальные длительности проходят …
    expect(ecology.EMISSION_IMMINENT_TICKS % cadence).toBe(0);
    expect(ecology.EMISSION_ACTIVE_TICKS % cadence).toBe(0);
    // … а сдвиг на 1 тик (типичная опечатка контента) — предикат бы отверг.
    expect((ecology.EMISSION_IMMINENT_TICKS + 1) % cadence).not.toBe(0);
    expect((ecology.EMISSION_ACTIVE_TICKS + 1) % cadence).not.toBe(0);
    // Канарейка бессмысленна при cadence=1 (тогда кратно всё) — фиксируем cadence=10.
    expect(cadence).toBe(10);
  });

  it('реплика guard-предиката БРОСАЕТ на некратной длительности, молчит на кратной', () => {
    // Точная копия проверки из ecology.ts (верхний уровень модуля). Доказывает, что
    // «некратно → бросок» — не пустая ветка. Реальные значения не должны её задевать.
    const guard = (name: string, ticks: number, cadence: number): void => {
      if (ticks % cadence !== 0) {
        throw new Error(`${name} (${ticks}) должен быть кратен каденции ${cadence}`);
      }
    };
    const cadence = ecology.EMISSION_CADENCE;
    // Реальные длительности проходят guard без броска.
    expect(() => guard('IMMINENT', ecology.EMISSION_IMMINENT_TICKS, cadence)).not.toThrow();
    expect(() => guard('ACTIVE', ecology.EMISSION_ACTIVE_TICKS, cadence)).not.toThrow();
    // Некратная (реальная +1) — guard обязан бросить.
    expect(() => guard('IMMINENT', ecology.EMISSION_IMMINENT_TICKS + 1, cadence)).toThrow(
      /должен быть кратен каденции/,
    );
    expect(() => guard('ACTIVE', ecology.EMISSION_ACTIVE_TICKS + 1, cadence)).toThrow(
      /должен быть кратен каденции/,
    );
  });

  it('прирост давления за окно не проскакивает порог BURST (не мгновенный выброс)', () => {
    // Давление копится причинно (закон №2): один шаг эмиссии добавляет
    // PRESSURE_PER_CHARGE*CADENCE — строго меньше порога срыва.
    const perStep = ecology.EMISSION_PRESSURE_PER_CHARGE * ecology.EMISSION_CADENCE;
    expect(perStep).toBeGreaterThan(0);
    expect(perStep).toBeLessThan(ecology.EMISSION_BURST_THRESHOLD);
  });
});

describe('strategy: упорядоченность порогов и конечность весов (argmax не ломается)', () => {
  it('дипломатия дешевле налёта: DIPLOMACY_THRESHOLD < RAID_THRESHOLD', () => {
    // При меньшем накале фракция выбирает переговоры, а не войну (закон №2).
    expect(strategy.DIPLOMACY_THRESHOLD).toBeLessThan(strategy.RAID_THRESHOLD);
  });

  it('ни один вес W_STRAT не NaN/Infinity — argmax остаётся определён', () => {
    for (const [k, w] of Object.entries(strategy.W_STRAT)) {
      expect(Number.isFinite(w), `вес ${k}`).toBe(true);
    }
    // Драйверы толкают К действию (положительный вклад), а не гасят его.
    for (const [k, w] of Object.entries(strategy.W_STRAT)) {
      expect(w, `вес ${k} должен быть >0`).toBeGreaterThan(0);
    }
  });
});

describe('disease: конечность и знак всех механических ставок', () => {
  it('все ставки заражения/течения — конечные положительные числа', () => {
    const rates: Array<[string, number]> = [
      ['EXPOSURE_PER_SICK_CONTACT', disease.EXPOSURE_PER_SICK_CONTACT],
      ['EXPOSURE_COLD_WEATHER', disease.EXPOSURE_COLD_WEATHER],
      ['SEVERITY_RISE_PER_TICK', disease.SEVERITY_RISE_PER_TICK],
      ['SEVERITY_DAMAGE_MULT', disease.SEVERITY_DAMAGE_MULT],
    ];
    for (const [name, v] of rates) {
      expect(Number.isFinite(v), name).toBe(true);
      expect(v, name).toBeGreaterThan(0);
    }
  });

  it('пороги-доли болезни в (0,1]: заражение, летальная тяжесть, сброс лечением', () => {
    for (const [name, v] of [
      ['INFECTION_THRESHOLD', disease.INFECTION_THRESHOLD],
      ['SICKNESS_LETHAL_SEVERITY', disease.SICKNESS_LETHAL_SEVERITY],
      ['TREAT_SEVERITY_DROP', disease.TREAT_SEVERITY_DROP],
    ] as const) {
      expect(v, name).toBeGreaterThan(0);
      expect(v, name).toBeLessThanOrEqual(1);
    }
  });
});
