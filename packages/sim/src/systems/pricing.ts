/**
 * @module @zona/sim/systems/pricing
 *
 * ЦЕНА — DERIVED (задача 2.5, D-047). Чистая ДЕТЕРМИНИРОВАННАЯ функция цены товара на
 * складе поселения из его ДЕФИЦИТНОСТИ (закон №2: НЕ «X% шанс», не бросок — арифметика
 * от состояния). Цена НЕ хранится и НЕ эвентится (как день/ночь из tick, D-019): она
 * вычисляется на лету при каждой сделке, поэтому resume-safe без нового поля снапшота
 * (P0). `trade/executed` несёт использованную цену для летописи — но авторитет всегда
 * пересчёт из склада, не запись.
 *
 * ── ФОРМУЛА (закон №2/№7: эластичность/границы — только balance/economy) ──────────
 *   stockRatio = stock / targetStock        // 1 = «норма»; <1 дефицит; >1 избыток
 *   mult       = clamp(1 + PRICE_ELASTICITY × (1 − stockRatio),
 *                      PRICE_MULT_MIN, PRICE_MULT_MAX)
 *   price      = max(PRICE_FLOOR, round(basePrice × mult))
 * МОНОТОННОСТЬ: mult линейно УБЫВАЕТ по stockRatio, значит price НЕ растёт с запасом:
 * пустой склад (ratio→0) → максимум (клампится PRICE_MULT_MAX), норма (ratio=1) →
 * ≈basePrice, избыток (ratio≫1) → минимум (PRICE_MULT_MIN). Так дефицит поднимает цену,
 * избыток опускает (GDD 9.2, замена «вероятностной» динамики на причинную, D-047).
 *
 * ── ЧИСТОТА / ДЕТЕРМИНИЗМ ────────────────────────────────────────────────────────
 * Функция БЕЗ состояния и БЕЗ rng: результат зависит только от (basePrice предмета,
 * stock, targetStock). Один и тот же вход → один и тот же выход (закон №8). Округление
 * до целого держит деньги целочисленными (перевод в Trade точен — суммы сходятся без
 * плавающей ошибки, EconomyInvariant держится). `basePrice` — контент (items.json,
 * закон №10); эластичность/границы/пол — balance/economy (закон №7).
 *
 * Пример:
 * ```ts
 * import { priceOf } from './pricing';
 * const p = priceOf('canned' as ItemId, 5, 40);  // дефицит (5 из нормы 40) → выше basePrice
 * ```
 */

import type { ItemId } from '@zona/shared';
import { getItem } from '../data/index';
import {
  PRICE_ELASTICITY,
  PRICE_MULT_MIN,
  PRICE_MULT_MAX,
  PRICE_FLOOR,
  EXPORT_PRICE_FACTOR,
} from '../balance/economy';

/** Значение, зажатое в отрезок [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Детерминированная цена ЕДИНИЦЫ товара `item` на складе с запасом `stock` при норме
 * `targetStock` (D-047). Дефицит (stock < target) → цена ВЫШЕ basePrice; избыток →
 * НИЖЕ; в границах `[PRICE_MULT_MIN, PRICE_MULT_MAX] × basePrice` и не ниже
 * `PRICE_FLOOR`. Чистая (без rng/состояния), resume-safe (цена не хранится).
 *
 * `targetStock <= 0` (нормировать нечем) трактуется как ПРЕДЕЛЬНЫЙ дефицит
 * (`stockRatio = 0` ⇒ максимальная цена): предмет, для которого у поселения нет
 * эталонного запаса, считается редким/дорогим. Деление на 0 исключено.
 */
export function priceOf(item: ItemId, stock: number, targetStock: number): number {
  const base = getItem(item).basePrice;
  const stockRatio = targetStock > 0 ? stock / targetStock : 0;
  const mult = clamp(1 + PRICE_ELASTICITY * (1 - stockRatio), PRICE_MULT_MIN, PRICE_MULT_MAX);
  const price = Math.round(base * mult);
  return price < PRICE_FLOOR ? PRICE_FLOOR : price;
}

/**
 * ЭКСПОРТНАЯ цена ЕДИНИЦЫ товара `item` за Периметром (задача 2.7, D-055). В отличие
 * от `priceOf`, НЕ зависит от локального склада: за Периметром — ВНЕШНИЙ рынок без
 * «дефицита» симулируемого мира, поэтому цена = `round(basePrice × EXPORT_PRICE_FACTOR)`
 * (не ниже `PRICE_FLOOR`). Чистая, детерминированная (закон №2: функция контент-якоря
 * basePrice и balance-множителя, БЕЗ rng/состояния), resume-safe (цена не хранится).
 * `EXPORT_PRICE_FACTOR` — регулятор money-faucet (balance/economy, закон №7): именно
 * он задаёт, сколько денег ВХОДИТ в экономику за единицу вывезенного хабара.
 */
export function exportPriceOf(item: ItemId): number {
  const base = getItem(item).basePrice;
  const price = Math.round(base * EXPORT_PRICE_FACTOR);
  return price < PRICE_FLOOR ? PRICE_FLOOR : price;
}
