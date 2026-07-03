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

import type { FactionId, ItemId } from '@zona/shared';

/** Число сталкеров на старте (Фаза 1: одна фракция). */
export const STALKER_COUNT = 20;

/**
 * ССЫЛКА на стартовую фракцию всех сталкеров (Фаза 1 — одна фракция, GDD 4.7
 * приток одиночек за Периметром). Содержимое фракции (id+имя) — КОНТЕНТ в
 * data/factions.json (закон №10); здесь лишь id-ссылка, которую worldgen резолвит
 * через getFaction. Тест связности balance↔data проверяет, что id существует.
 */
export const STARTING_FACTION_ID: FactionId = 'loners';

/**
 * ССЫЛКИ на профессии, представленные в стартовой когорте сталкеров (какие
 * профессии спавнятся — это балансовое/дизайнерское решение). Сами профессии
 * (id+имя) — КОНТЕНТ в data/professions.json (закон №10); здесь только id, каждый
 * обязан резолвиться через getProfession (проверяет тест связности balance↔data).
 * worldgen присваивает профессию детерминированно (rng.fork('worldgen')).
 */
export const STARTING_PROFESSION_IDS: readonly string[] = [
  'stalker',
  'hunter',
  'scavenger',
  'medic',
  'mechanic',
];

// ── Стартовые нужды сталкера (шкала 0..100, D-027) ───────────────────────────
//
// СТРОГО НИЖЕ критических порогов (HUNGER_CRITICAL=80, THIRST_CRITICAL=85,
// FATIGUE_CRITICAL=90 в balance/needs): сталкеры входят в Зону здоровыми и сытыми
// (D-021, приток из-за Периметра). Стартовать НА/ВЫШЕ порога нельзя — детекция
// порога в Needs (1.5) `prev<crit && next>=crit` не сработала бы, урон истощения
// пошёл бы с тика 0 → смерть без события-причины (разрыв причинности, закон №6).
// Разброс `[min,max)` детерминирован rng worldgen — старт неоднороден, но безопасен.
export const STARTING_HUNGER_MIN = 5;
export const STARTING_HUNGER_MAX = 25;
export const STARTING_THIRST_MIN = 5;
export const STARTING_THIRST_MAX = 25;
export const STARTING_FATIGUE_MIN = 10;
export const STARTING_FATIGUE_MAX = 35;

// ── Стартовые навыки сталкера (шкала 0..1) ───────────────────────────────────
//
// Детерминированный разброс от rng worldgen в разумных границах: никто не «нулевой»
// (выживший до Зоны имеет базу) и никто не «идеальный» (мастерство растёт в игре).
export const SKILL_MIN = 0.15;
export const SKILL_MAX = 0.75;

// ── Животные (стада) ─────────────────────────────────────────────────────────

/**
 * Минимальное обилие дичи `game` локации, чтобы заселить в неё стадо (строго
 * больше). Отсекает бедные дичью узлы (settlement/руины-пустыри); стада тяготеют к
 * глубоким диким территориям (D-025). При game>0.3 в текущей карте пригодны
 * Агропром/Тёмная долина/Дикая территория.
 */
export const HERD_MIN_GAME = 0.3;

/**
 * Верхняя граница опасности локации для заселения стад (СТРОГО меньше). Выражает
 * «стада не живут в смертельных зонах» (D-025) через ДАННЫЕ (`loc.danger`), а НЕ
 * через хардкод-id конкретной локации: любая будущая зона с danger>=1.0
 * (Саркофаг и т.п.) автоматически исключается. При 1.0 отсекается ровно danger=1.
 */
export const HERD_MAX_DANGER = 1.0;

/** Стартовое здоровье особи (шкала 0..100). Животные входят в мир здоровыми. */
export const ANIMAL_START_HP = 100;

/**
 * Стартовые нужды особи (шкала 0..100): звери тоже голодают/пьют (нагрузка на
 * forage/воду — ecosystem 1.9), но на старте сыты. Разброс детерминирован rng.
 */
export const ANIMAL_HUNGER_MIN = 5;
export const ANIMAL_HUNGER_MAX = 30;
export const ANIMAL_THIRST_MIN = 5;
export const ANIMAL_THIRST_MAX = 30;

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
