/**
 * @module @zona/sim/worldgen
 *
 * Стартовая генерация мира (задача 1.3; расширена 2.2; рефактор 2.14a — D-059;
 * ОЖИВЛЕНИЕ петель Фазы 2 — 2.16b, D-065). Рождение ОДНОГО человека вынесено в
 * переиспользуемую `spawnStalker(world,rng,cfg)`: worldgen зовёт её в цикле (когорта
 * 20), на торговцев, БАНДИТОВ и РЕЗИДЕНТОВ, а PopulationInflux (2.14/D-051, приток)
 * позже — на новоприбывших. Вызывается РОВНО ОДИН РАЗ при сборке мира (headless-CLI),
 * ДО первого тика планировщика. Населяет пустой `SimWorld`:
 *   • сущность-мир (WorldClock singleton);
 *   • 20 сталкеров-одиночек в Кордоне (фракция loners);
 *   • стада животных в глубоких диких/руинных локациях;
 *   • (2.2) ПОСЕЛЕНИЯ из settlements.json — сущность Settlement+Position со складом
 *     ('inventory') и кассой ('money') + смертный торговец-NPC (D-051);
 *   • (2.16b) АНОМАЛЬНЫЕ ПОЛЯ из anomaly_fields.json — сущность AnomalyField+Position
 *     (charge=0, лут ПУСТ ⇒ базлайн не растёт; артефакты рождает ArtifactSpawn В
 *     ПРОГОНЕ, D-054); БАНДИТЫ в отдельном логове (фракция bandits predatory ⇒ ROB,
 *     D-062); по SETTLEMENT_RESIDENTS оседлых РЕЗИДЕНТОВ на поселение + разовый
 *     `assignJobs` ⇒ census труда Economy > 0 ⇒ поселения ПРОИЗВОДЯТ (D-046).
 * Склад/касса поселения и инвентарь/деньги людей ФИЗИЧЕСКИ внесены из-за Периметра
 * (D-021/D-045, БАЗЛАЙН t0 — worldgen НЕ эмитит леджер). Все добавления Фазы 2
 * генерируются ПОСЛЕДНИМИ (после стад/поселений — поля/бандиты/резиденты в КОНЦЕ
 * потока rng), чтобы не сдвигать поток rng существующих сущностей: сталкеры/стада/
 * поселения/торговцы БИТ-В-БИТ тождественны прежним (закреплено голден-тестом состава).
 *
 * ── Закон №1 (мир живёт без игрока) ──────────────────────────────────────────
 * Игрока НЕТ. Сталкеры расставляются в ENTRY_LOCATION (Кордон, D-025) — точке
 * входа в Зону из-за Периметра, а НЕ «возле игрока». Дальше их распорядок задаёт
 * TaskSelection (1.8) из нужд/обстановки, не скрипт.
 *
 * ── Закон №2 / детерминизм (закон №8) ────────────────────────────────────────
 * Вся случайность генерации — из ОДНОГО подпотока `world.rng.fork('worldgen')`
 * (stateless-форк от seed, D-004/D-009), потребляемого в ФИКСИРОВАННОМ порядке
 * обхода. Это «генерация мира» (легальная категория rng, как погода D-028), а не
 * «X% шанс события у сущности». Одинаковый seed → идентичный мир (eid, имена,
 * позиции, инвентарь, навыки, стада).
 *
 * ── Закон №3 (ничего из воздуха) — ИСТОЧНИК стартового инвентаря (D-021) ──────
 * ПМ + патроны + консервы + вода + бинт и стартовые деньги каждого сталкера
 * ФИЗИЧЕСКИ ВНЕСЕНЫ ИЗ-ЗА ПЕРИМЕТРА при входе в Зону (GDD 4.7 приток одиночек со
 * снаряжением) — это внешний источник, а не эмиссия из ничего. Набор и суммы — в
 * balance/worldgen (STARTING_INVENTORY / STARTING_MONEY); каждый itemId существует
 * в items.json. Мясо/шкуры животных появятся позже физически (разделка туш, 1.10).
 *
 * ── Закон №4 (NPC с именем-фамилией; без idle) ───────────────────────────────
 * Каждый сталкер получает НЕПУСТЫЕ first И last из пула NAMES + кличку; полные
 * дубли (first+last) избегаются линейным пробингом (однофамильцы допустимы —
 * задокументировано). Состояния idle worldgen не создаёт: задачу назначит
 * TaskSelection на первом тике (D-020), поэтому компонент Task здесь НЕ ставится.
 *
 * Фракция/профессия сталкера — КОНТЕНТ в /sim/data (factions.json/professions.json,
 * закон №10); balance/worldgen хранит лишь ССЫЛКИ-id (STARTING_FACTION_ID /
 * STARTING_PROFESSION_IDS), а worldgen кладёт id в ResourceStore. Валидность id
 * (резолв через getFaction/getProfession) закреплена тестом связности balance↔data.
 *
 * ── Личность (задача 3.3, D-071) ─────────────────────────────────────────────
 * Каждому ЧЕЛОВЕКУ (spawnStalker — единая точка рождения, D-059) сидится
 * `Personality {temperament, talkativeness}` детерминированно (D-021): temperament —
 * взвешенный seeded-выбор (TEMPERAMENT_WEIGHTS), talkativeness — seeded rng.range [0..1].
 * Это ДАННЫЕ для нарратива Фазы 3 (окраска эфира Radio 3.5, ретрансляция слухов Rumors
 * 3.6); в тике 3.3 их никто не читает.
 *
 * Зависимости (что читает): balance/worldgen (числа/ссылки расстановки + веса личности),
 * balance/needs (HEALTH_MAX), data (MAP, NAMES, getSpecies), core/components (SoA),
 * core/ecs (spawn/addComponent), world.resources (холодные данные, D-007).
 *
 * Пример:
 * ```ts
 * const world = createSimWorld(42 as Seed);
 * worldgen(world);        // мир заселён; готов к scheduler.tick()
 * ```
 */

import type { EntityId, FactionId, ItemId, LocationId } from '@zona/shared';
import type { SimWorld } from './core/world';
import type { Rng } from './core/rng';
import { spawnEntity, addComponent } from './core/ecs';
import {
  Position,
  Needs,
  Health,
  Skills,
  Home,
  Animal,
  WorldClock,
  Settlement,
  AnomalyField,
  Personality,
  Human,
  Alive,
  WEATHER_CODE,
  EmissionPhase,
} from './core/components';
import { MAP, NAMES, getSpecies, getSettlements, getAnomalyFields } from './data/index';
import type { SettlementData, AnomalyFieldData } from '@zona/shared';
import { assignJobs } from './systems/job-assign';
import { HEALTH_MAX } from './balance/needs';
import {
  STALKER_COUNT,
  STARTING_FACTION_ID,
  STARTING_PROFESSION_IDS,
  STARTING_INVENTORY,
  STARTING_MONEY,
  ENTRY_LOCATION,
  STARTING_HERDS,
  HERD_MIN_GAME,
  HERD_MAX_DANGER,
  ANIMAL_START_HP,
  ANIMAL_HUNGER_MIN,
  ANIMAL_HUNGER_MAX,
  ANIMAL_THIRST_MIN,
  ANIMAL_THIRST_MAX,
  STARTING_HUNGER_MIN,
  STARTING_HUNGER_MAX,
  STARTING_THIRST_MIN,
  STARTING_THIRST_MAX,
  STARTING_FATIGUE_MIN,
  STARTING_FATIGUE_MAX,
  SKILL_MIN,
  SKILL_MAX,
  TEMPERAMENT_WEIGHTS,
  TALKATIVENESS_MIN,
  TALKATIVENESS_MAX,
  SETTLEMENT_START_MORALE,
  SETTLEMENT_START_SECURITY,
  TRADER_PROFESSION_ID,
  BANDIT_COUNT,
  BANDIT_FACTION_ID,
  BANDIT_HAUNT_LOCATION,
  BANDIT_PROFESSION_IDS,
  SETTLEMENT_RESIDENTS,
  RESIDENT_PROFESSION_IDS,
} from './balance/worldgen';

// ── Типизированные проекции SoA-колонок ──────────────────────────────────────
// bitecs-компонент — объект-хранилище { field: TypedArray } (см. core/ecs). Наружу
// его форма не типизирована (ComponentRef = Record<string,FieldArray>), поэтому
// проецируем в узкие типы для записи. Идентичность объекта = идентичность компонента
// (addComponent регистрирует членство и зануляет поля, D-024).
const POS = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
const NEED = Needs as unknown as {
  hunger: Float32Array;
  thirst: Float32Array;
  fatigue: Float32Array;
  fear: Float32Array;
};
const HP = Health as unknown as { hp: Float32Array };
const SKILL = Skills as unknown as {
  shooting: Float32Array;
  survival: Float32Array;
  stealth: Float32Array;
};
const HOME = Home as unknown as { loc: Uint32Array };
const ANIMAL = Animal as unknown as { species: Uint8Array; herd: Uint32Array };
const CLOCK = WorldClock as unknown as {
  weather: Uint8Array;
  weatherSince: Uint32Array;
  zonePressure: Float32Array;
  emissionPhase: Uint8Array;
  phaseSince: Uint32Array;
};
const SETTLE = Settlement as unknown as {
  morale: Float32Array;
  security: Float32Array;
  buildTarget: Uint8Array;
  buildProgress: Float32Array;
};
const FIELD = AnomalyField as unknown as { charge: Float32Array; tier: Uint8Array };
const PERSONA = Personality as unknown as { temperament: Uint8Array; talkativeness: Float32Array };

/** Запись имени сталкера в ResourceStore (D-007). first/last непусты (закон №4). */
interface NameRecord {
  readonly first: string;
  readonly last: string;
  /** Кличка (позывной). В Фазе 1 — детерминированный выбор из пула; привязка к
   *  чертам характера появится с TaskSelection/traits (1.8+). */
  readonly nickname: string;
}

/** Единица инвентаря в ResourceStore: ссылка на предмет + количество (закон №3). */
interface InventoryEntry {
  readonly item: ItemId;
  readonly qty: number;
}

/**
 * КАК выбирается профессия NPC при спавне. Дискриминированный союз, чтобы
 * СОХРАНИТЬ точный порядок потребления rng (закон №8): вариант `pick` тратит
 * ровно один `rng.pick` (как стартовая когорта), `fixed` — НИ ОДНОГО (как
 * торговец, чья профессия предопределена). Смешивать эти пути одним «id | список»
 * нельзя: тогда фикс-путь всё равно продвигал бы rng и сдвигал голдены.
 */
export type ProfessionSpec =
  | { readonly kind: 'fixed'; readonly id: string }
  | { readonly kind: 'pick'; readonly from: readonly string[] };

/**
 * Конфигурация спавна ОДНОГО сталкера/NPC (seam для worldgen 1.3 И
 * PopulationInflux 2.14/D-051). Всё, что различает стартовую когорту, торговца и
 * будущего новоприбывшего, вынесено сюда; общий контракт (Position/Needs/Health/
 * Skills/Home/Human/Alive + холодные имя/деньги/инвентарь, БЕЗ Task — D-020) и
 * все балансовые распределения (нужды/навыки/HP) — внутри spawnStalker.
 *
 * ── SEAM для 2.14 (D-051) ────────────────────────────────────────────────────
 * `loc` — точка входа в Зону (ENTRY_LOCATION, Кордон): worldgen и приток
 * населения расставляют новичков ЗДЕСЬ, а не «возле игрока» (закон №1). `inventory`
 * — фабрика СВЕЖЕЙ копии (см. ниже): 2.14 передаст ту же STARTING_INVENTORY-копию,
 * а САМ факт «принесено из-за Периметра» ЗАЛЕДЖЕРИТ (item/broughtIn) уже ПОСЛЕ
 * вызова, по возвращённому eid — леджер/источник в этой функции НЕ реализован
 * (граница зон: генезис-леджер — economy-engineer, D-052).
 */
export interface SpawnStalkerConfig {
  /** Локация, где NPC стоит на старте (Position.loc === dest ⇒ без движения, D-019). */
  readonly loc: LocationId;
  /** Home.loc — база (сон/хранение). Для когорты/новичков = ENTRY_LOCATION; торговец — при поселении. */
  readonly home: LocationId;
  /** Фракция (id, ОБЯЗАН резолвиться в factions.json, закон №10). */
  readonly faction: FactionId;
  /** Профессия: фикс. id (торговец) ИЛИ seeded-выбор из пула (когорта/новички). */
  readonly profession: ProfessionSpec;
  /** Стартовые деньги (внесены из-за Периметра, D-021; леджер item/broughtIn — вне функции, 2.14). */
  readonly money: number;
  /**
   * Фабрика СВЕЖЕЙ копии инвентаря (новый массив + новые {item,qty}). Вызывается
   * РОВНО ОДИН раз на этого NPC — владелец получает собственную копию, БЕЗ aliasing
   * (прошлый баг: общий ref → расход in-place экономикой тёк на всех, закон №3).
   */
  readonly inventory: () => InventoryEntry[];
  /**
   * Общий Set ключей `"<firstIdx>|<lastIdx>"` (ИНДЕКСЫ в NAMES.first/last, НЕ строки
   * имён) для дедупликации полных имён в пределах когорты (закон №4). ВНИМАНИЕ 2.14
   * (PopulationInflux): чтобы новоприбывшие не столкнулись с ИМЕНАМИ уже живущих NPC,
   * пред-заполняй этот Set ИНДЕКСНЫМИ ключами (конвертируй имя→индексы через NAMES),
   * а не строками "first last" — pickName сверяет индексный ключ, строку он не увидит.
   */
  readonly usedNames: Set<string>;
}

/**
 * Создаёт ОДНОГО сталкера/NPC по контракту стартовой когорты и возвращает его eid.
 * ЕДИНСТВЕННАЯ точка рождения человека в Зоне: и worldgen (стартовые 20 + торговцы),
 * и будущий PopulationInflux (2.14/D-051, приток новичков) идут через неё — так
 * «новоприбывший» БИТ-В-БИТ соответствует стартовому сталкеру. Возвращает eid как
 * seam для 2.14 (леджер item/broughtIn на источник инвентаря — по этому eid, вне
 * функции; D-052).
 *
 * Детерминизм (закон №8): чистая по отношению к переданному `world` (мутирует ECS+
 * ResourceStore, НЕ читает глобалей) и `rng` — весь недетерминизм из переданного
 * подпотока. ПОРЯДОК потребления rng ФИКСИРОВАН: нужды ×3 → навыки ×3 → имя →
 * [профессия pick] → темперамент → talkativeness (задача 3.3, D-071 — личность сидится
 * В КОНЦЕ, +2 rng-вызова на человека; это ЗАКОННО сдвинуло голдены Фазы 1/3, т.к.
 * подпоток worldgen общий и последовательный). Task НЕ ставится (назначит TaskSelection
 * на первом тике, D-020 — не idle).
 */
export function spawnStalker(world: SimWorld, rng: Rng, cfg: SpawnStalkerConfig): EntityId {
  const eid = spawnEntity(world.ecs);

  // Position: стоит на своей loc (dest===loc ⇒ без движения, D-019).
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = cfg.loc;
  POS.dest[eid] = cfg.loc;
  POS.etaTicks[eid] = 0;

  // Needs: строго ниже критических порогов (D-027); страха нет.
  addComponent(world.ecs, Needs, eid);
  NEED.hunger[eid] = rng.range(STARTING_HUNGER_MIN, STARTING_HUNGER_MAX);
  NEED.thirst[eid] = rng.range(STARTING_THIRST_MIN, STARTING_THIRST_MAX);
  NEED.fatigue[eid] = rng.range(STARTING_FATIGUE_MIN, STARTING_FATIGUE_MAX);
  NEED.fear[eid] = 0;

  // Health: входят в Зону здоровыми (D-021).
  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = HEALTH_MAX;

  // Skills: детерминированный разброс в разумных границах.
  addComponent(world.ecs, Skills, eid);
  SKILL.shooting[eid] = rng.range(SKILL_MIN, SKILL_MAX);
  SKILL.survival[eid] = rng.range(SKILL_MIN, SKILL_MAX);
  SKILL.stealth[eid] = rng.range(SKILL_MIN, SKILL_MAX);

  // Home: база (сон/хранение).
  addComponent(world.ecs, Home, eid);
  HOME.loc[eid] = cfg.home;

  // Теги.
  addComponent(world.ecs, Human, eid);
  addComponent(world.ecs, Alive, eid);

  // Холодные данные (D-007). Имя — непустые first+last (закон №4) + кличка.
  const name = pickName(rng, cfg.usedNames);
  world.resources.set<NameRecord>('name', eid, name);
  world.resources.set<FactionId>('faction', eid, cfg.faction);
  // Профессия: pick тратит один rng (как когорта), fixed — ноль (как торговец).
  const profession =
    cfg.profession.kind === 'pick' ? rng.pick(cfg.profession.from) : cfg.profession.id;
  world.resources.set<string>('profession', eid, profession);
  world.resources.set<number>('money', eid, cfg.money);
  // СВЕЖИЙ инвентарь на КАЖДОГО NPC (фабрика зовётся здесь) — своя копия, без
  // aliasing (закон №3, см. SpawnStalkerConfig.inventory).
  world.resources.set<readonly InventoryEntry[]>('inventory', eid, cfg.inventory());

  // Личность (задача 3.3, D-071) — СИДИТСЯ В САМОМ КОНЦЕ потока rng spawnStalker
  // (после [профессии pick]): ровно +2 rng-вызова на человека — temperament
  // (взвешенный выбор, ОДИН rng.int), затем talkativeness (rng.range). Порядок
  // ФИКСИРОВАН (закон №8). Personality несут ТОЛЬКО люди (эта единая точка рождения,
  // D-059), и в тике 3.3 их НИКТО не читает (Radio 3.5 / Rumors 3.6 подключат) ⇒
  // поведение НЕ меняется, добавление лишь ЗАКОННО сдвигает голдены на этот rng-хвост.
  addComponent(world.ecs, Personality, eid); // зануляет поля (D-024)
  PERSONA.temperament[eid] = pickTemperament(rng);
  PERSONA.talkativeness[eid] = rng.range(TALKATIVENESS_MIN, TALKATIVENESS_MAX);

  return eid;
}

/**
 * Взвешенный seeded-выбор кода `Temperament` из `TEMPERAMENT_WEIGHTS` (balance).
 * Тратит РОВНО ОДИН rng-вызов (`rng.int` по «мешку» суммарного веса) — как `rng.pick`,
 * но с неравными весами (закон №2: причинность/детерминизм, не «X% шанс»). Возвращает
 * код 0..N-1 (индекс в TEMPERAMENT_WEIGHTS = код Temperament). Пустой/нулевой мешок
 * невозможен (веса заданы в balance), поэтому цикл всегда возвращает валидный код.
 */
function pickTemperament(rng: Rng): number {
  let total = 0;
  for (const w of TEMPERAMENT_WEIGHTS) total += w;
  let r = rng.int(0, total); // ОДИН rng-вызов на мешок [0,total)
  for (let code = 0; code < TEMPERAMENT_WEIGHTS.length; code++) {
    const w = TEMPERAMENT_WEIGHTS[code] as number;
    if (r < w) return code;
    r -= w;
  }
  return 0; // недостижимо: r < total ⇒ попадёт в один из сегментов
}

/**
 * Заселяет пустой мир стартовым состоянием Зоны. Идемпотентности НЕ гарантирует —
 * вызывать РОВНО ОДИН РАЗ на свежесозданном `createSimWorld(seed)` до первого тика.
 * Мутирует `world` (ECS-сущности + ResourceStore) и НЕ публикует событий: источник
 * предметов задокументирован (D-021), генезис — корень причинности.
 */
export function worldgen(world: SimWorld): void {
  // ЕДИНЫЙ детерминированный подпоток генерации (D-004/D-021). Потребляется строго
  // в порядке ниже: мир → сталкеры → стада → поселения+торговцы. Любая перестановка
  // сломала бы seed→мир.
  //
  // ПОРЯДОК (задача 2.2): поселения/торговцы генерируются ПОСЛЕДНИМИ — так добавление
  // Фазы 2 НЕ сдвигает поток rng сталкеров/стад Фазы 1 (их eid/имена/позиции/стада
  // тождественны прежним); новыми в мире оказываются лишь сущности-поселения и
  // торговцы, дописанные в конец. Стабильность зафиксирована тестом детерминизма.
  const rng = world.rng.fork('worldgen');

  spawnWorldClock(world);
  spawnStalkers(world, rng);
  spawnHerds(world, rng);
  spawnSettlements(world, rng);
  // ── ОЖИВЛЕНИЕ ДРЕМЛЮЩИХ ПЕТЕЛЬ ФАЗЫ 2 (задача 2.16b, В КОНЕЦ потока rng) ─────
  // Всё ниже дописано ПОСЛЕ spawnSettlements — как 2.2 дописала поселения в конец:
  // существующие сталкеры/стада/поселения/торговцы БИТ-В-БИТ те же (их eid/имена/
  // позиции/rng не сдвинуты). Порядок фиксирован: поля (без rng) → бандиты →
  // резиденты → наём. Каждая группа рождает НОСИТЕЛЕЙ дремлющих систем (D-065):
  //   • поля AnomalyField (charge=0, лут ПУСТ) ⇒ ArtifactSpawn/ArtifactSearch/Export;
  //   • бандиты (фракция bandits predatory, D-062) ⇒ ROB/RobberyMemory/MemoryDecay;
  //   • резиденты + assignJobs ⇒ census труда Economy > 0 ⇒ поселения ПРОИЗВОДЯТ.
  spawnAnomalyFields(world);
  spawnBandits(world, rng);
  spawnResidents(world, rng);
  // НАЁМ РАЗОВО (D-046/D-052): assignJobs — не система (в конвейер не входит), а
  // расселение по рабочим местам в генезисе. Зовётся ПОСЛЕ всех резидентов/торговцев
  // (иначе кого-то не увидит) и rng НЕ трогает (наём выводится из состояния, не из
  // кости). Массу не двигает (Job — компонент-состояние ⇒ EconomyInvariant baseline
  // не затронут, закон №3). employer/workplace выставляются СРАЗУ после addComponent
  // (D-046 хвост — иначе ложная приписка к eid 0).
  assignJobs(world);
}

// ── Сущность-мир: WorldClock singleton ───────────────────────────────────────

/**
 * Создаёт сущность-носитель WorldClock (D-019, singleton). Стартовая погода —
 * 'clear' (код 0), `weatherSince = 0`. Ровно ОДИН носитель: система Weather (1.6)
 * бросает при >1 (D-028), поэтому worldgen создаёт его единожды.
 *
 * ФАЗА 5 (задача 5.0): поля эмиссии инициализируются НУЛЁМ —
 * `zonePressure=0`, `emissionPhase=EmissionPhase.BUILDING (0)`, `phaseSince=0`.
 * Это уже гарантирует `addComponent` (зануление, D-024); записи ниже — ЯВНЫЙ
 * контракт стартового состояния (а не «молчаливый дефолт»), как для weather.
 * В 5.0 эти поля НИКЕМ не читаются/пишутся после worldgen (цикл выброса — 5.2).
 */
function spawnWorldClock(world: SimWorld): void {
  const eid = spawnEntity(world.ecs);
  addComponent(world.ecs, WorldClock, eid); // зануляет поля (D-024)
  CLOCK.weather[eid] = WEATHER_CODE.clear; // ясно на старте (индекс 0)
  CLOCK.weatherSince[eid] = 0;
  CLOCK.zonePressure[eid] = 0; // давление Зоны с нуля (Фаза 5, 5.0)
  CLOCK.emissionPhase[eid] = EmissionPhase.BUILDING; // 0 — спокойная фаза
  CLOCK.phaseSince[eid] = 0;
}

// ── Сталкеры (20, Кордон) ────────────────────────────────────────────────────

/**
 * Расставляет STALKER_COUNT сталкеров в ENTRY_LOCATION (Кордон, loc 0 — стартово
 * безопасен, D-025). Каждый: Position(стоит в Кордоне), Needs (ниже критических,
 * D-027), Health (полное), Skills (разброс), Home(Кордон), теги Human+Alive;
 * холодные данные (имя/фракция/профессия/деньги/инвентарь) — в ResourceStore.
 * Task НЕ ставится: назначит TaskSelection на первом тике (D-020).
 */
function spawnStalkers(world: SimWorld, rng: Rng): void {
  const usedNames = new Set<string>(); // ключи "<firstIdx>|<lastIdx>" — избегаем полных дублей

  for (let i = 0; i < STALKER_COUNT; i++) {
    // Стартовая когорта: вход в Кордон, база — Кордон, фракция loners, профессия —
    // seeded-выбор из пула (тратит один rng, как прежний инлайн), деньги/инвентарь
    // «внесены из-за Периметра» (D-021). spawnStalker хранит общий контракт и порядок
    // rng (нужды→навыки→имя→профессия) — БИТ-В-БИТ как раньше (голдены Фазы 1).
    spawnStalker(world, rng, {
      loc: ENTRY_LOCATION as LocationId,
      home: ENTRY_LOCATION as LocationId,
      faction: STARTING_FACTION_ID,
      profession: { kind: 'pick', from: STARTING_PROFESSION_IDS },
      money: STARTING_MONEY,
      inventory: buildStartingInventory,
      usedNames,
    });
  }
}

/**
 * Строит СВЕЖУЮ копию стартового инвентаря (новый массив + новые объекты
 * `{item, qty}`) — вызывается на КАЖДОГО сталкера, чтобы владельцы не разделяли
 * ссылку (см. spawnStalkers: расход in-place экономикой 1.10 иначе течёт из
 * воздуха, закон №3). ОТСОРТИРОВАН по itemId (закон №8 — стабильный канон
 * снапшота). Источник — «внесено из-за Периметра» (D-021, docblock модуля). Все
 * itemId валидны в items.json (тест связности balance↔data).
 */
function buildStartingInventory(): InventoryEntry[] {
  return STARTING_INVENTORY.map((s) => ({ item: s.itemId, qty: s.qty }))
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

/**
 * Детерминированно выбирает имя (first+last+кличка), избегая ПОЛНЫХ дублей
 * (first+last) через линейный пробинг по фамилии/имени БЕЗ доп. rng-вызовов
 * (сохраняет позицию в потоке детерминированной). Однофамильцы (одна фамилия,
 * разные имена) допустимы — пул 20×20 покрывает 20 сталкеров с запасом; при
 * гипотетическом исчерпании пробинг всё равно завершится (полный обход комбинаций).
 */
function pickName(rng: Rng, used: Set<string>): NameRecord {
  const first = NAMES.first;
  const last = NAMES.last;
  let fi = rng.int(0, first.length);
  let li = rng.int(0, last.length);
  // Кличка — детерминированный позывной из пула шаблонов (привязка к чертам — 1.8+).
  const pattern = rng.pick(NAMES.nicknamePatterns);
  const nickname = rng.pick(pattern.options);

  // Пробинг по (li, затем fi) — детерминированный обход комбинаций без rng.
  for (let step = 0; step < first.length * last.length; step++) {
    const key = `${fi}|${li}`;
    if (!used.has(key)) {
      used.add(key);
      break;
    }
    li = (li + 1) % last.length;
    if (li === 0) fi = (fi + 1) % first.length;
  }
  return { first: first[fi] as string, last: last[li] as string, nickname };
}

// ── Стада животных (wild/ruins, game>порога) ─────────────────────────────────

/**
 * Заселяет стада по STARTING_HERDS. Пригодные локации: type ∈ {wild, ruins},
 * game > HERD_MIN_GAME и danger < HERD_MAX_DANGER (D-025 — глубокие дикие
 * территории, но НЕ смертельные зоны; исключение выражено через ДАННЫЕ, не
 * хардкод-id). Каждое стадо получает УНИКАЛЬНЫЙ номер (глобальный счётчик),
 * локацию (rng.pick) и размер ∈ [herdMin, herdMax] вида. Особи: Position(в
 * локации стада), Needs (низкие), Health, Animal(species,herd), тег Alive.
 */
function spawnHerds(world: SimWorld, rng: Rng): void {
  const eligible = eligibleHerdLocations();
  // Пустой набор пригодных локаций = ошибка контента/баланса: стадам негде жить.
  if (eligible.length === 0) {
    throw new Error(
      'worldgen: нет пригодных локаций для стад (wild/ruins с game > HERD_MIN_GAME).',
    );
  }

  let herdNo = 0; // глобальный уникальный номер стада (детерминирован порядком обхода)
  // STARTING_HERDS обходится в объявленном порядке (по возрастанию speciesId) —
  // порядок фиксирован в balance, поток rng детерминирован.
  for (const entry of STARTING_HERDS) {
    const species = getSpecies(entry.speciesId); // бросит на неизвестном виде
    for (let h = 0; h < entry.herds; h++) {
      const loc = rng.pick(eligible);
      const size = rng.int(species.herdMin, species.herdMax + 1); // включительно herdMax
      const herd = herdNo++;
      for (let a = 0; a < size; a++) {
        spawnAnimal(world, rng, species.id, herd, loc);
      }
    }
  }
}

/**
 * Пригодные для стад локации (D-025): habitat wild/ruins, game > HERD_MIN_GAME и
 * danger < HERD_MAX_DANGER. Смертельные зоны (Саркофаг danger=1.0) исключаются
 * ПО ДАННЫМ (`loc.danger`), а не по хардкод-id — future-proof для новых карт.
 * Отсортированы по возрастанию id (детерминизм, закон №8) — rng.pick воспроизводим.
 */
function eligibleHerdLocations(): readonly LocationId[] {
  const out: LocationId[] = [];
  for (const loc of MAP.locations) {
    const habitat = loc.type === 'wild' || loc.type === 'ruins';
    if (habitat && loc.game > HERD_MIN_GAME && loc.danger < HERD_MAX_DANGER) {
      out.push(loc.id as LocationId);
    }
  }
  // MAP.locations уже по возрастанию id (плотный индекс), порядок сохранён.
  return out;
}

/** Создаёт одну особь стада `herd` вида `speciesId` в локации `loc`. */
function spawnAnimal(
  world: SimWorld,
  rng: Rng,
  speciesId: number,
  herd: number,
  loc: LocationId,
): void {
  const eid = spawnEntity(world.ecs);

  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = loc;
  POS.dest[eid] = loc; // стоит (D-019)
  POS.etaTicks[eid] = 0;

  addComponent(world.ecs, Needs, eid);
  NEED.hunger[eid] = rng.range(ANIMAL_HUNGER_MIN, ANIMAL_HUNGER_MAX);
  NEED.thirst[eid] = rng.range(ANIMAL_THIRST_MIN, ANIMAL_THIRST_MAX);
  NEED.fatigue[eid] = 0;
  NEED.fear[eid] = 0;

  addComponent(world.ecs, Health, eid);
  HP.hp[eid] = ANIMAL_START_HP;

  addComponent(world.ecs, Animal, eid);
  ANIMAL.species[eid] = speciesId;
  ANIMAL.herd[eid] = herd;

  addComponent(world.ecs, Alive, eid);
}

// ── Поселения и торговцы (Фаза 2, задача 2.2) ────────────────────────────────

/**
 * Заселяет поселения из settlements.json (закон №10). Для КАЖДОГО поселения (обход
 * в порядке файла — детерминирован):
 *  1) сущность-поселение: Settlement(morale/security из balance; buildTarget/
 *     buildProgress=0 занулением addComponent, D-024) + Position(стоит на своей loc,
 *     dest===loc — чтобы систему/торговцев можно было локализовать);
 *  2) СКЛАД: cold 'inventory' на eid поселения — стартовый набор со склада (закон №3
 *     ИСТОЧНИК: внесено из-за Периметра при основании, D-021/D-045; часть БАЗЛАЙНА
 *     t0, worldgen НЕ эмитит леджер, D-045). КАССА: cold 'money' = startingTreasury.
 *     Оба ключа — те же, что у NPC/трупов (D-046) ⇒ учитываются EconomyInvariant.
 *  3) ТОРГОВЕЦ: смертный Human-NPC на loc поселения (D-051) — обычный сталкер по
 *     контракту (Position/Needs<критич./Health/Skills/Home/Human/Alive + холодные
 *     имя/фракция(поселения)/профессия 'trader'/личные деньги+инвентарь), но БЕЗ
 *     Task (назначит TaskSelection на первом тике, D-020 — торговец не idle).
 *
 * Поселение — НЕ Alive и НЕ Human: инертно для АКТОРНЫХ систем Фазы 1
 * (Movement/Needs/Death/TaskSelection/Encounters/Animals его пропускают — нет
 * Task/Needs/Alive/Animal; проверено QA: 0 из 47 encounter/* за 30 дней ссылаются
 * на поселение, оно не движется). ИСКЛЮЧЕНИЕ: у поселения ЕСТЬ Position, поэтому
 * Perception (обходит всех носителей Position) включает его в бакет локации как
 * ПАССИВНЫЙ контакт — публикуются perception/spotted с ним. Это БЕЗВРЕДНО (ни один
 * потребитель contacts не трактует поселение как цель/угрозу: страх требует
 * co-located Animal, бои — Human/Animal), но создаёт семантический шум в логе
 * («поселение заметило сталкера»). Кандидат на гейт Perception по актёрам
 * (Human/Animal) — будущая правка (актуально с ростом не-акторных Position-носителей:
 * аномальные поля 2.9). Склад/касса статичны до Economy 2.3.
 */
function spawnSettlements(world: SimWorld, rng: Rng): void {
  // Полные имена торговцев не дублируются МЕЖДУ собой (общий Set на все поселения);
  // совпадение с именем сталкера допустимо (однофамильцы, как в spawnStalkers).
  const traderNames = new Set<string>();
  // getSettlements() отдаёт список в порядке файла (детерминирован, закон №8).
  for (const s of getSettlements()) {
    const eid = spawnEntity(world.ecs);

    // Settlement: стартовые мораль/защита (balance); buildTarget/buildProgress=0.
    addComponent(world.ecs, Settlement, eid);
    SETTLE.morale[eid] = SETTLEMENT_START_MORALE;
    SETTLE.security[eid] = SETTLEMENT_START_SECURITY;
    // buildTarget/buildProgress уже занулены addComponent (D-024) — ничего не строит.

    // Position: поселение «стоит» на своей локации (dest===loc, D-019).
    addComponent(world.ecs, Position, eid);
    POS.loc[eid] = s.loc;
    POS.dest[eid] = s.loc;
    POS.etaTicks[eid] = 0;

    // СКЛАД + КАССА (D-046, БАЗЛАЙН t0). Свежая отсортированная копия склада
    // (не делим ссылку с data — Economy 2.3 будет менять его in-place, закон №3/№8).
    world.resources.set<readonly InventoryEntry[]>('inventory', eid, buildWarehouse(s));
    world.resources.set<number>('money', eid, s.startingTreasury);

    spawnTrader(world, rng, s, traderNames);
  }
}

/**
 * Строит СВЕЖУЮ отсортированную по itemId копию стартового склада поселения (новый
 * массив + новые {item,qty}) из settlements.json. Сортировка по itemId — стабильный
 * канон снапшота (закон №8). Все itemId валидны (проверено загрузчиком data). Источник
 * — «внесено из-за Периметра» (D-021/D-045). Отдельная копия на поселение: будущая
 * экономика (2.3) расходует склад in-place, не задевая контент-данные (закон №3).
 */
function buildWarehouse(s: SettlementData): InventoryEntry[] {
  return s.startingWarehouse
    .map((w) => ({ item: w.item as ItemId, qty: w.qty }))
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

/**
 * Создаёт торговца поселения `s` — смертного Human-NPC на loc поселения (D-051).
 * Контракт идентичен сталкеру (spawnStalkers), кроме: профессия 'trader', фракция —
 * фракция поселения (`s.faction`), Home — loc поселения. Личные деньги/инвентарь —
 * «как у сталкера» (STARTING_MONEY/STARTING_INVENTORY, внесено из-за Периметра,
 * D-021); склад/касса ПОСЕЛЕНИЯ — на отдельном eid (spawnSettlements). Task НЕ
 * ставится (назначит TaskSelection, D-020 — торговец живёт как обычный NPC до 2.6).
 */
function spawnTrader(
  world: SimWorld,
  rng: Rng,
  s: SettlementData,
  usedNames: Set<string>,
): void {
  // Торговец — обычный сталкер (spawnStalker), кроме: стоит/живёт при поселении
  // (loc/home = s.loc), фракция = фракция поселения, профессия ПРЕДОПРЕДЕЛЕНА
  // ('trader' ⇒ kind:'fixed' — НЕ тратит rng.pick, как прежний инлайн). Личные
  // деньги/инвентарь «как у сталкера» (D-021); склад/касса ПОСЕЛЕНИЯ — отдельный eid.
  spawnStalker(world, rng, {
    loc: s.loc as LocationId,
    home: s.loc as LocationId,
    faction: s.faction as FactionId,
    profession: { kind: 'fixed', id: TRADER_PROFESSION_ID },
    money: STARTING_MONEY,
    inventory: buildStartingInventory,
    usedNames,
  });
}

// ── Аномальные поля (Фаза 2, задача 2.16b, D-046/D-054/D-065) ─────────────────

/**
 * Материализует носители AnomalyField из anomaly_fields.json (закон №10 — поля это
 * КОНТЕНТ). Для КАЖДОЙ записи (обход в порядке файла — детерминирован):
 *  - сущность-поле: AnomalyField(`charge=0`, `tier` из данных) + Position(стоит на
 *    своей loc, dest===loc — чтобы ArtifactSpawn/SEARCH могли локализовать поле).
 *
 * ── Закон №3 / ПУСТОЙ старт (базлайн EconomyInvariant не растёт) ─────────────
 * Поле НЕ получает cold 'inventory' — наземный лут ПУСТ на t0 (в отличие от склада
 * поселения, который есть базлайн-масса). Артефакты РОЖДАЕТ уже в прогоне ArtifactSpawn
 * (2.9/D-054) с леджером item/harvested(source:'anomaly') — легальный источник массы.
 * Поэтому worldTotals(t0) от полей не увеличивается, и assertEconomyInvariant НЕ
 * бросает из-за них (проверено тестом «поля пусты»).
 *
 * rng НЕ используется (поле — не физиология и не разброс; заряд копит система). Поле —
 * НЕ Alive/Human/Animal ⇒ инертно для акторных систем (как поселение), кроме того что
 * несёт Position (пассивный контакт Perception — безвредно, как у поселения 2.2).
 */
function spawnAnomalyFields(world: SimWorld): void {
  // getAnomalyFields() — список в порядке файла (детерминирован, закон №8).
  for (const f of getAnomalyFields()) {
    spawnAnomalyField(world, f);
  }
}

/** Создаёт один носитель AnomalyField (charge=0, лут пуст) в локации поля `f`. */
function spawnAnomalyField(world: SimWorld, f: AnomalyFieldData): void {
  const eid = spawnEntity(world.ecs);

  addComponent(world.ecs, AnomalyField, eid); // зануляет поля (D-024) ⇒ charge=0
  FIELD.charge[eid] = 0; // явно: поле стартует РАЗРЯЖЕННЫМ (лут пуст, закон №3)
  FIELD.tier[eid] = f.tier;

  // Position: поле «стоит» на своей локации (dest===loc, D-019).
  addComponent(world.ecs, Position, eid);
  POS.loc[eid] = f.loc;
  POS.dest[eid] = f.loc;
  POS.etaTicks[eid] = 0;
  // НЕТ cold 'inventory' и НЕТ 'money' — поле пусто на t0 (базлайн не растёт).
}

// ── Бандиты (Фаза 2, задача 2.16b, D-049/D-062/D-065) ────────────────────────

/**
 * Заселяет BANDIT_COUNT бандитов в ЛОГОВЕ (BANDIT_HAUNT_LOCATION — wild-локация
 * ОТДЕЛЬНО от Кордона, чтобы не было бойни одиночек на t0). Каждый — обычный
 * смертный сталкер (spawnStalker), кроме: фракция bandits (ХИЩНАЯ, predatory:true —
 * активирует ROB, D-062), loc/home = логово, профессия — ПОЛЕВАЯ из BANDIT_PROFESSION_IDS
 * (assignJobs Job им не даст). Инвентарь/деньги — БАЗЛАЙН t0 (STARTING_INVENTORY несёт
 * ПМ+патроны — вооружены, иначе грабить нечем; STARTING_MONEY; D-021 «внесено из-за
 * Периметра», НЕ приток item/broughtIn — это стартовая генерация). Task НЕ ставится
 * (назначит TaskSelection, D-020). Общий Set имён — бандиты не дублируют полные имена
 * МЕЖДУ собой (совпадение с одиночкой допустимо — однофамильцы, как у торговцев).
 */
function spawnBandits(world: SimWorld, rng: Rng): void {
  const usedNames = new Set<string>();
  for (let i = 0; i < BANDIT_COUNT; i++) {
    spawnStalker(world, rng, {
      loc: BANDIT_HAUNT_LOCATION as LocationId,
      home: BANDIT_HAUNT_LOCATION as LocationId,
      faction: BANDIT_FACTION_ID,
      profession: { kind: 'pick', from: BANDIT_PROFESSION_IDS },
      money: STARTING_MONEY,
      inventory: buildStartingInventory,
      usedNames,
    });
  }
}

// ── Резиденты поселений (Фаза 2, задача 2.16b, D-046/D-065) ───────────────────

/**
 * Селит SETTLEMENT_RESIDENTS оседлых резидентов на КАЖДОЕ поселение (Home = loc
 * поселения, профессия ОСЕДЛАЯ из RESIDENT_PROFESSION_IDS — санитар/технарь, чей
 * непустой workTasks Economy использует для производства). Обход поселений и
 * резидентов детерминирован (порядок файла × индекс). Резиденты — обычные смертные
 * сталкеры (spawnStalker), базлайн t0 (D-021). БЕЗ Task (TaskSelection, D-020) и БЕЗ
 * Job здесь — Job навесит assignJobs (зовётся в worldgen ПОСЛЕ всех резидентов), тогда
 * census труда Economy станет > 0 и поселение ЗАРАБОТАЕТ на производство (разворот
 * находки QA-2.16a: без рук поселение только проедает upkeep). Общий Set имён — резиденты
 * не дублируют полные имена между собой (совпадение с другими когортами допустимо).
 */
function spawnResidents(world: SimWorld, rng: Rng): void {
  const usedNames = new Set<string>();
  // getSettlements() — порядок файла (детерминирован, закон №8).
  for (const s of getSettlements()) {
    for (let i = 0; i < SETTLEMENT_RESIDENTS; i++) {
      spawnStalker(world, rng, {
        loc: s.loc as LocationId,
        home: s.loc as LocationId,
        faction: s.faction as FactionId,
        profession: { kind: 'pick', from: RESIDENT_PROFESSION_IDS },
        money: STARTING_MONEY,
        inventory: buildStartingInventory,
        usedNames,
      });
    }
  }
}
