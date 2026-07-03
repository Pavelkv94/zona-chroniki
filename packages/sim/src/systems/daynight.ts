/**
 * @module @zona/sim/systems/daynight
 *
 * Производный суточный цикл (задача 1.6, D-019). НЕ система и НЕ состояние: набор
 * ЧИСТЫХ функций от `tick`. День/ночь СОЗНАТЕЛЬНО НЕ хранится в мире (в отличие от
 * погоды) — он однозначно выводится из `tick % TICKS_PER_DAY` относительно порогов
 * `DAWN_TICK`/`DUSK_TICK` (balance/weather). Хранить его = дублировать
 * детерминированную функцию времени состоянием и завести поверхность рассинхрона
 * при save/load (D-019, закон №8). Поэтому здесь нет ни компонента, ни модуля-стейта:
 * любая система (TaskSelection 1.8, Movement-тюнинг, ui) импортирует `isNight`
 * и получает один и тот же ответ на данном тике без чтения мира.
 *
 * ── Модель суток ─────────────────────────────────────────────────────────────
 * 1 тик = 1 игровая минута, сутки = `TICKS_PER_DAY` (1440) тиков (balance/time).
 * «Минута суток» = `tick mod TICKS_PER_DAY` ∈ [0, 1440). ДЕНЬ — полуинтервал
 * `[DAWN_TICK, DUSK_TICK)` (рассвет включительно, закат исключительно); всё
 * остальное — НОЧЬ. При стандартных порогах (DAWN=360=06:00, DUSK=1260=21:00):
 *   ночь: [0,360) ∪ [1260,1440);  день: [360,1260).
 * Границы (закон точности): `isNight(DAWN)=false` (день начинается РОВНО на
 * рассвете), `isNight(DUSK)=true` (ночь начинается РОВНО на закате).
 *
 * ── Детерминизм и чистота (закон №8) ─────────────────────────────────────────
 * Ни `Date.now`, ни rng, ни чтения мира — только арифметика над `tick`. Один и тот
 * же `tick` всегда даёт один и тот же результат; функции переживают save/load
 * тривиально (они не имеют состояния). `tick` в симуляции неотрицателен, но модуль
 * нормализует и отрицательные значения (`((t % D) + D) % D`), чтобы утилита была
 * тотальной и безопасной для ui/тестов.
 *
 * Пример:
 * ```ts
 * import { isNight } from '@zona/sim/systems/daynight';
 * if (isNight(ctx.tick)) score *= NIGHT_FEAR_MULT; // тюнинг поведения (1.8)
 * ```
 */

import type { Tick } from '@zona/shared';
import { TICKS_PER_DAY } from '../balance/time';
import { DAWN_TICK, DUSK_TICK } from '../balance/weather';

/** Фаза суток (грубая, двухчастная — как задают пороги DAWN/DUSK). */
export type DayPhase = 'day' | 'night';

/**
 * Минута внутри суток: `tick mod TICKS_PER_DAY` ∈ [0, TICKS_PER_DAY). Нормализует
 * отрицательные тики в положительный остаток, чтобы результат всегда был в
 * диапазоне (детерминированная тотальная функция, закон №8).
 */
export function minuteOfDay(tick: Tick): number {
  return ((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
}

/**
 * `true`, если на тике `tick` в мире НОЧЬ. День — полуинтервал
 * `[DAWN_TICK, DUSK_TICK)`; ночь — его дополнение в сутках. Чистая функция от
 * `tick` (D-019): состояние дня/ночи не хранится, а выводится.
 */
export function isNight(tick: Tick): boolean {
  const m = minuteOfDay(tick);
  return m < DAWN_TICK || m >= DUSK_TICK;
}

/**
 * Фаза суток на тике `tick`: `'night'`/`'day'`. Опциональная надстройка над
 * `isNight` (контракт 1.6) — читаемый дискриминант для логики/ui без повторения
 * порогов. Возвращает и `minuteOfDay` для потребителей, которым нужна точная
 * позиция внутри суток (например плавная модуляция видимости).
 */
export function timeOfDay(tick: Tick): {
  readonly minuteOfDay: number;
  readonly phase: DayPhase;
  readonly isNight: boolean;
} {
  const night = isNight(tick);
  return { minuteOfDay: minuteOfDay(tick), phase: night ? 'night' : 'day', isNight: night };
}
