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

/**
 * Категория предмета. Определяет, какие опциональные поля обязательны. `'artifact'`
 * (Фаза 2, задача 2.9, D-054) — хабар, РОЖДАЕМЫЙ аномальным полем по накоплению
 * заряда (не крафт/не приток): у него обязателен `tier` (ступень поля, из которой
 * он выпадает), а `caliber`/`nutrition`/`hydration` неприменимы.
 *
 * `'part'` (Фаза 5, задача 5.0) — ЧАСТЬ туши мутанта (лапа/щупальце/коготь),
 * ДОБЫВАЕМАЯ разделкой убитого мутанта (закон №3: источник — туша, как `meat`).
 * Отдельный вид, а не переиспользование: часть мутанта — не еда/не медикамент/не
 * артефакт, а сырьё/трофей со своей ценностью (`basePrice`), на которое ссылается
 * `SpeciesData.partItem`. Обязательных доп-полей у 'part' нет (как у 'medical'):
 * `caliber`/`nutrition`/`hydration`/`tier` неприменимы. Набор APPEND-ONLY —
 * добавлен В КОНЕЦ, существующие виды не тронуты; в 5.0 items.json ещё без 'part'
 * (наполнит 5.1), поэтому загрузка предметов не меняется.
 */
export type ItemKind = 'weapon' | 'ammo' | 'food' | 'drink' | 'medical' | 'artifact' | 'part';

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
  /**
   * Базовая («якорная») цена единицы в деньгах Зоны (>0 — валидатор гарантирует).
   * Это НЕ фактическая цена сделки, а лишь опорная точка: фактическая цена —
   * DERIVED от локальной дефицитности склада (`priceOf`, задача 2.5, D-047):
   * `price = basePrice × f(stock / targetStock)`. Здесь — только контент-якорь
   * (закон №10: ценность предмета — данные, эластичность/границы — balance).
   */
  readonly basePrice: number;
  /** Калибр (weapon/ammo). Совпадение калибров — условие совместимости. */
  readonly caliber?: string;
  /** Питательность порции (food): сколько единиц голода закрывает. */
  readonly nutrition?: number;
  /** Гидратация порции (drink): сколько единиц жажды закрывает. */
  readonly hydration?: number;
  /**
   * Ступень артефакта (artifact, задача 2.9/D-054): целое >=0, УНИКАЛЬНОЕ среди
   * артефактов. Связывает предмет с `AnomalyField.tier`: поле ступени `t` рождает
   * артефакт с наибольшим `tier <= t` (`getArtifactForTier`, data-driven — код
   * оперирует id, закон №10). Обязателен для kind==='artifact', неприменим иначе.
   */
  readonly tier?: number;
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

  // ── Флаги экосистемы/стратегии (Фаза 5, задача 5.0 — ТОЛЬКО типы) ───────────
  //
  // Все поля ОПЦИОНАЛЬНЫ с дефолтами, сохраняющими текущее поведение: существующие
  // виды (deer/boar) БЕЗ этих флагов грузятся как прежде (закон №10 — контент
  // наполнит species.json в 5.1; код в 5.0 их ещё не читает). Дефолт каждого флага
  // указан явно — «опущено» и «нейтральное поведение» совпадают.

  /** Хищник: охотится на другие виды (дефолт `false` — не хищник, как deer/boar). */
  readonly predator?: boolean;
  /** Пасётся (травоядное, ест forage локации; дефолт `false`). */
  readonly grazes?: boolean;
  /** Ночной: активен ночью, спит днём (дефолт `false` — дневной/безразличный). */
  readonly nocturnal?: boolean;
  /** Реанимированный (зомби/нежить — не размножается обычным путём; дефолт `false`). */
  readonly reanimated?: boolean;
  /**
   * Список ключей видов-ЖЕРТВ (`SpeciesData.key`), на которых охотится хищник
   * (закон №10 — ссылки на контент-ключи, не хардкод). Дефолт `[]`/опущено — жертв
   * нет (для не-хищников неприменимо). Осмыслен при `predator === true`.
   */
  readonly prey?: readonly string[];
  /**
   * Ссылка на предмет-ЧАСТЬ (`ItemData.id`, kind==='part'), добываемый разделкой
   * туши этого вида (закон №3 — источник части — туша; закон №10 — ссылка на
   * контент). Дефолт опущено — вид не даёт особой части (только `meat` по meatYield).
   */
  readonly partItem?: string;
  /**
   * Сколько единиц `partItem` даёт одна туша (целое >0). Дефолт опущено/0 — частей
   * нет. Осмыслен только вместе с `partItem`.
   */
  readonly partYield?: number;
  /**
   * Драйвер перемещения вида (стратегия миграции/группировки, задача 5.1+):
   *  - `'herd'` — стадо (травоядные держатся кучей, как текущие deer/boar);
   *  - `'pack'` — стая (хищники координируют охоту);
   *  - `'solo'` — одиночка (территория без группы);
   *  - `'noise'` — на шум (идёт к источнику звука — выстрелы/бой).
   * Дефолт опущено ⇒ трактуется как `'herd'` (текущее поведение животных 1.9). Код
   * 5.0 поле не читает — семантику вводит система движения экосистемы.
   */
  readonly moveDriver?: 'herd' | 'pack' | 'solo' | 'noise';
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
  /**
   * ХИЩНАЯ диспозиция (Фаза 2, задача 2.12, D-062): `true` ⇒ члены фракции по своей
   * природе ГРАБЯТ (выбирают задачу ROB утилити-AI). Поле ДАННЫХ (закон №10): код
   * поведения читает эту диспозицию из контента, а НЕ хардкодит id 'bandits'. Опущено/
   * `false` ⇒ обычная (не-хищная) фракция — её NPC ROB не выбирают (sRob=−∞). Стартовая
   * когорта worldgen — 'loners' (не хищники), поэтому грабёж дремлет до появления хищных
   * фракций (спавн 2.14/2.16), голдены Фазы 1 не сдвигаются.
   */
  readonly predatory?: boolean;
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
 * Запись аномального поля-НОСИТЕЛЯ (`anomaly_fields.json`, Фаза 2, задача 2.16b,
 * закон №10 — аномальные поля это КОНТЕНТ, а не хардкод-id в коде). `loc` — id
 * локации, где стоит поле (валидатор требует `map.locations[loc].type ∈ {wild,
 * ruins}` — аномалии живут в глубокой Зоне, D-025, выражено через ДАННЫЕ-тип
 * локации, а не через хардкод конкретной локации). `tier` — ступень поля
 * (`AnomalyField.tier`, D-054): целое >=0, отображается в ценность рождаемого
 * артефакта через `getArtifactForTier`.
 *
 * ── Закон №3: поле стартует ПУСТЫМ ─────────────────────────────────────────
 * Поле НЕ несёт стартовой массы (в отличие от склада поселения): `charge=0`,
 * наземный лут пуст. Артефакты РОЖДАЮТСЯ уже В ПРОГОНЕ системой ArtifactSpawn
 * (2.9/D-054) с леджером `item/harvested(source:'anomaly')` — легальный источник
 * массы. Поэтому базлайн EconomyInvariant (t0) от полей НЕ растёт.
 */
export interface AnomalyFieldData {
  readonly loc: number;
  readonly tier: number;
}

/** Корневая структура `anomaly_fields.json` (закон №10). */
export interface AnomalyFieldsData {
  readonly fields: readonly AnomalyFieldData[];
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

/**
 * Код ТЕМПЕРАМЕНТА говорящего — «окраска» радио-сообщения (GDD §8.3, задача 3.4).
 * Один тип события звучит по-разному в зависимости от характера рассказчика:
 * паникёр и ветеран об одном бое сообщают разными словами. Это КОНТРАКТ между
 * контентом (`messages.json`), рендером (`narrative/render.ts`) и системой
 * Personality (задача 3.3, вводит `Personality.{temperament, talkativeness}`):
 *  - `'neutral'` — БАЗОВЫЙ/фолбэк-тон (ровная фактическая речь). ОБЯЗАН
 *    присутствовать у КАЖДОГО типа события в `messages.json` — на него откатывается
 *    рендер, если у события нет пула под конкретный темперамент говорящего.
 *  - `'panicky'` — паникёр (преувеличение угрозы, крик, восклицания).
 *  - `'veteran'` — ветеран (скупо, спокойно, мрачный юмор, профессионально).
 *  - `'talker'` — болтун (многословно, сплетни, шутки, панибратство).
 * Задача 3.3 обязана отобразить свой `temperament` в ЭТИ коды (либо хранить их
 * напрямую), а 3.5 (Radio) — выбирать пул по темпераменту говорящего. Набор
 * APPEND-ONLY: новые темпераменты добавляются, `'neutral'` не удаляется.
 */
export type MessageTemperament = 'neutral' | 'panicky' | 'veteran' | 'talker';

/**
 * Контент радио-шаблонов (`messages.json`, задача 3.4, закон №10). Пул реплик
 * сгруппирован ДВАЖДЫ: сначала по ТИПУ нарративного события (`type` из
 * `@zona/shared/events`, напр. `'entity/died'`), затем по коду темперамента
 * говорящего (`MessageTemperament`). Значение — массив строк-шаблонов с
 * плейсхолдерами `{speaker} {subject} {loc} {count} {item}` (см.
 * `narrative/render.ts`). Строку из (templateId + params) собирает `renderMessage`;
 * ХРАНИТСЯ ссылка (templateId+params), а не готовый текст (D-069). Никакого DOM/
 * разметки — только текст+плейсхолдеры (закон №5, проверяет валидатор загрузки).
 */
export interface MessagesData {
  /** Версия схемы контента (для будущих миграций формата). */
  readonly version: number;
  /**
   * Разрешённые коды темпераментов (ключи второго уровня `templates`). Каждый
   * ключ-темперамент в `templates` обязан быть из этого списка; `'neutral'` —
   * обязателен (фолбэк рендера). Список — данные, а не хардкод в коде (закон №10).
   */
  readonly temperaments: readonly string[];
  /**
   * `eventType → temperament → пул шаблонов`. Индексируется по ключам напрямую
   * (без итерации по порядку вставки — детерминизм рендера, закон №8).
   */
  readonly templates: {
    readonly [eventType: string]: { readonly [temperament: string]: readonly string[] };
  };
}
