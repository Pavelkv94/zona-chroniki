/**
 * @module @zona/sim/balance/worldgen
 *
 * Балансовые константы генерации стартового мира (закон №7). Worldgen (1.3)
 * читает их и расставляет NPC/животных детерминированно от seed
 * (`rng.fork('worldgen')`, D-021), НЕ возле игрока (игрока нет — закон №1).
 *
 * КЛЮЧЕВОЕ (закон №3): стартовый инвентарь/деньги 20 сталкеров ФИЗИЧЕСКИ
 * приносятся из-за Периметра при входе в Зону (D-021, GDD 4.7) — источник
 * «внесено извне», а не «из воздуха». Ниже — только описание набора (ссылки на
 * itemId из items.json + количества); материализацию с событием-источником
 * делает worldgen. Значения стартовые, тюнит balance-analyst.
 */

import type { ItemId } from '@zona/shared';

/** Число сталкеров на старте (Фаза 1: одна фракция). */
export const STALKER_COUNT = 20;

/** Единица стартового набора: ссылка на предмет + количество. */
export interface StartingItem {
  readonly itemId: ItemId;
  readonly qty: number;
}

/**
 * Стартовый набор одного сталкера (D-021: «внесено из-за Периметра»). ПМ с
 * запасом патронов, немного еды/воды, бинт. Каждый itemId обязан существовать в
 * items.json (проверяется тестом связности balance↔data).
 */
export const STARTING_INVENTORY: readonly StartingItem[] = [
  { itemId: 'pm' as ItemId, qty: 1 },
  { itemId: 'ammo_9mm' as ItemId, qty: 16 },
  { itemId: 'canned' as ItemId, qty: 2 },
  { itemId: 'water' as ItemId, qty: 1 },
  { itemId: 'bandage' as ItemId, qty: 2 },
];

/**
 * Стартовые деньги сталкера (условные единицы). Тоже «внесены извне» — физический
 * приток капитала за Периметром, не эмиссия из воздуха (закон №3).
 */
export const STARTING_MONEY = 2000;

/** id локации, где сталкеры входят в Зону (Кордон — поселение у Периметра). */
export const ENTRY_LOCATION = 0;

/**
 * Сколько стад каждого вида (по species.id) заселить на старте, суммарно по
 * пригодным диким/руинным локациям. Размер каждого стада — в [herdMin,herdMax]
 * вида (species.json), выбирается детерминированно rng worldgen.
 */
export const STARTING_HERDS: readonly { readonly speciesId: number; readonly herds: number }[] = [
  { speciesId: 0, herds: 4 }, // олени — несколько стад по диким территориям
  { speciesId: 1, herds: 3 }, // кабаны — реже, мелкими группами в глубине
];
