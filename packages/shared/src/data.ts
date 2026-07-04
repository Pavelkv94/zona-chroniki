/**
 * @module @zona/shared/data
 *
 * Схемы-типы контент-данных Зоны (закон №10: ВЕСЬ контент — карта, предметы,
 * виды, имена — живёт в /sim/data JSON; код оперирует абстрактными id). Здесь —
 * ТОЛЬКО формы данных, без bitecs/DOM/Node (закон №5). Загрузчик `@zona/sim/data`
 * импортирует JSON как модуль, валидирует по этим типам и замораживает результат.
 *
 * Идентификаторы намеренно сырые (`number`/`string`), а не branded: JSON не несёт
 * бренда, а нумерация локаций/видов — это индекс в данных, повышаемый до
 * `LocationId` уже в коде мира. Ссылки на предметы — строки (`ItemId`).
 *
 * Пример:
 * ```ts
 * import type { MapData, ItemData } from '@zona/shared';
 * ```
 */

/** Тип локации. Влияет на укрытие/опасность/наличие людей (worldgen 1.3). */
export type LocationType = 'settlement' | 'wild' | 'anomaly' | 'ruins';

/**
 * Узел графа карты. Все дробные поля — нормированы [0..1], кроме `shelter`
 * (0..10, «уровень крыши над головой») и `id` (индекс 0..N-1, плотный).
 */
export interface LocationData {
  /** Плотный индекс 0..N-1. Совпадает с позицией в массиве `locations`. */
  readonly id: number;
  /** Атмосферное русское имя (закон №10 — контент, не хардкод в коде). */
  readonly name: string;
  readonly type: LocationType;
  /** Есть ли источник воды (питьё без запаса). */
  readonly water: boolean;
  /** Укрытие 0..10: защита от погоды/выбросов, комфорт сна. */
  readonly shelter: number;
  /** Базовая опасность 0..1 (аномалии, мутанты). */
  readonly danger: number;
  /** Обилие дичи 0..1 (потенциал охоты; дичь гуще в глубине). */
  readonly game: number;
  /** Обилие подножного корма 0..1 (собирательство). */
  readonly forage: number;
}

/**
 * Неориентированное ребро графа. `a`/`b` — id локаций (a < b по соглашению
 * загрузчика для канонизации, но валидатор принимает любой порядок).
 */
export interface EdgeData {
  readonly a: number;
  readonly b: number;
  /** Длина перехода в тиках-минутах (~20..120). */
  readonly len: number;
  /** Укрытость маршрута 0..1 (шанс проскочить незамеченным). */
  readonly cover: number;
}

/** Корневая структура `map.json`. */
export interface MapData {
  readonly locations: readonly LocationData[];
  readonly edges: readonly EdgeData[];
}

/** Категория предмета. Определяет, какие опциональные поля обязательны. */
export type ItemKind = 'weapon' | 'ammo' | 'food' | 'drink' | 'medical';

/**
 * Шаблон предмета (`items.json`). Код ссылается на `id` (строка) — конкретные
 * экземпляры создаёт worldgen/крафт с физическим источником (закон №3).
 * Опциональные поля зависят от `kind`: weapon/ammo → `caliber`, food →
 * `nutrition`, drink → `hydration`.
 */
export interface ItemData {
  readonly id: string;
  readonly kind: ItemKind;
  /** Масса единицы в килограммах (>0 — валидатор гарантирует). */
  readonly weight: number;
  /** Калибр (weapon/ammo). Совпадение калибров — условие совместимости. */
  readonly caliber?: string;
  /** Питательность порции (food): сколько единиц голода закрывает. */
  readonly nutrition?: number;
  /** Гидратация порции (drink): сколько единиц жажды закрывает. */
  readonly hydration?: number;
}

/**
 * Вид животного (`species.json`). `id` — плотный индекс (для SoA-компонента
 * Animal в 1.2), `key` — стабильная строка контента.
 */
export interface SpeciesData {
  readonly id: number;
  /**
   * Стабильная строка-ключ вида (ссылка на контент, закон №10 — тип НЕ вшивает
   * перечень видов, единообразно с `ItemData.id`). Валидатор требует непустую
   * строку; конкретные ключи (`'deer'`/`'boar'`/…) живут в species.json.
   */
  readonly key: string;
  /** Минимальный размер стада при спавне (>=1). */
  readonly herdMin: number;
  /** Максимальный размер стада (>= herdMin). */
  readonly herdMax: number;
  /** Убегает ли при угрозе (олень — да, кабан — нет). */
  readonly flees: boolean;
  /** Боевая сила в резолвере (D-022: power комбатанта). */
  readonly power: number;
  /** Урон в упор (melee>0 делает вид опасным без «патронов»). */
  readonly melee: number;
  /** Потолок популяции вида в одной локации (тормоз размножения). */
  readonly reproCap: number;
  /** Длительность беременности в тиках (>0). */
  readonly gestationTicks: number;
  /** Сколько корма особь съедает за тик (нагрузка на forage локации). */
  readonly foragePerTick: number;
  /** Сколько единиц мяса даёт туша (источник предмета `meat`, закон №3). */
  readonly meatYield: number;
}

/**
 * Запись фракции (`factions.json`, закон №10 — фракции это КОНТЕНТ). `id` —
 * абстрактная ссылка (совпадает с `FactionId`), `name` — атмосферное имя. Фаза 1
 * несла одну фракцию (одиночки); Фаза 2 (задача 2.2) добавляет military/duty/bandits
 * и матрицу отношений (`FactionRelation`).
 */
export interface FactionData {
  readonly id: string;
  readonly name: string;
}

/**
 * Ребро матрицы отношений фракций (`factions.json.relations`, закон №10). Хранится
 * ОДИН раз на неупорядоченную пару (канон `a < b` по id) — отношение симметрично
 * (`rel(a,b) === rel(b,a)`), поэтому дублировать обратное ребро незачем. `value` —
 * знаковая шкала [−100..+100]: <0 враждебность, 0 нейтралитет, >0 союзность.
 * Отношение фракции с собой не хранится (подразумевается максимум). `a`/`b` — id
 * из списка `factions` (валидатор проверяет резолвимость).
 */
export interface FactionRelation {
  readonly a: string;
  readonly b: string;
  readonly value: number;
}

/**
 * Корневая структура `factions.json` (закон №10): список фракций + матрица
 * отношений. Загрузчик валидирует резолвимость id/симметрию/диапазон и замораживает.
 */
export interface FactionsData {
  readonly factions: readonly FactionData[];
  readonly relations: readonly FactionRelation[];
}

/**
 * Единица стартового склада/рецепта поселения: ссылка на предмет + количество
 * (закон №3 — предмет реален, itemId существует в items.json). Целое qty>0.
 */
export interface SettlementItemQty {
  readonly item: string;
  readonly qty: number;
}

/**
 * Рецепт производства поселения (`settlements.json`, данные для Economy 2.3): из
 * входного сырья `in` (список предмет+кол-во) за `labor` человеко-тиков труда
 * рождается `out` (готовый предмет). В Фазе 2/2.2 это лишь КОНТЕНТ-данные —
 * материализацию с событием-источником (`item/produced`) делает система 2.3.
 * Все itemId (`out` и каждый `in.item`) существуют в items.json (валидатор).
 */
export interface SettlementRecipe {
  readonly out: string;
  readonly in: readonly SettlementItemQty[];
  readonly labor: number;
}

/** Подушевое потребление поселения (данные для Economy 2.3): еда/вода на жителя. */
export interface SettlementConsumption {
  readonly perCapita: {
    readonly food: number;
    readonly water: number;
  };
}

/**
 * Запись поселения (`settlements.json`, закон №10 — поселения это КОНТЕНТ). `loc` —
 * id локации-поселения (валидатор требует `map.locations[loc].type === 'settlement'`),
 * `faction` — id владеющей фракции (резолвится в factions.json). `shelterBase` —
 * базовое укрытие 0..10. `consumption`/`recipes`/`buildQueue` — данные экономики
 * поселения (потребление/производство/очередь стройки) для систем Фазы 2 (2.3).
 *
 * ── Закон №3: ИСТОЧНИК стартового склада/кассы ──────────────────────────────
 * `startingWarehouse` (предметы) и `startingTreasury` (деньги) ФИЗИЧЕСКИ ВНЕСЕНЫ
 * ИЗ-ЗА ПЕРИМЕТРА при основании поселения (D-021/D-045) — внешний источник, часть
 * БАЗЛАЙНА экономики t0 (worldgen НЕ эмитит леджер для них, D-045). Каждый
 * itemId склада/рецепта существует в items.json.
 */
export interface SettlementData {
  readonly loc: number;
  readonly faction: string;
  readonly shelterBase: number;
  readonly consumption: SettlementConsumption;
  readonly recipes: readonly SettlementRecipe[];
  readonly buildQueue: readonly string[];
  readonly startingWarehouse: readonly SettlementItemQty[];
  readonly startingTreasury: number;
}

/** Корневая структура `settlements.json` (закон №10). */
export interface SettlementsData {
  readonly settlements: readonly SettlementData[];
}

/**
 * Запись профессии (`professions.json`, закон №10). `id` — абстрактная ссылка
 * (worldgen присваивает сталкеру по id), `name` — читаемое имя. Влияние профессии
 * на утилити-веса задач — забота TaskSelection (1.8); здесь лишь контент-запись.
 *
 * `workTasks` (Фаза 2, задача 2.4) — список абстрактных id рабочих задач профессии
 * НА РАБОЧЕМ МЕСТЕ поселения (лечить/чинить/торговать и т.п.; код оперирует id, а
 * не семантикой — закон №10). НЕПУСТОЙ список = профессия «оседлая, ходит на смену»
 * (её носитель-резидент поселения получает Job через assignJobs, а WORK-утилити
 * тянет его на рабочее место днём); ПУСТОЙ (`[]`) = «полевая» профессия (сталкер/
 * охотник/барахольщик) — рабочего места в поселении нет, распорядок дня рождается
 * из нужд (FORAGE/HUNT/рейд), Job не назначается. Что именно делает работник на
 * смене (производство/стройка) — считает Economy (2.3) по труду поселения; здесь —
 * лишь признак трудоустраиваемости и контент-ярлыки задач.
 */
export interface ProfessionData {
  readonly id: string;
  readonly name: string;
  readonly workTasks: readonly string[];
}

/** Шаблон клички по черте характера (`names.json`). */
export interface NicknamePattern {
  readonly trait: string;
  readonly options: readonly string[];
}

/**
 * Пул генерации имён NPC (`names.json`). Комбинация first+last+кличка даёт
 * человека с именем-фамилией (закон №4: NPC без имени запрещён).
 */
export interface NamesData {
  readonly first: readonly string[];
  readonly last: readonly string[];
  readonly nicknamePatterns: readonly NicknamePattern[];
}
