/**
 * @module @zona/sim/core/components
 *
 * Доменные SoA-компоненты симуляции (задача 1.2, D-019). ЕДИНСТВЕННОЕ место, где
 * объявляются «горячие» числовые компоненты мира и их порядок полей; отсюда они
 * попадают в `COMPONENT_REGISTRY` (registry.ts) для детерминированной сериализации
 * (закон №8) и импортируются системами 1.3–1.11 напрямую (внутри @zona/sim —
 * наружу тип bitecs-компонента не течёт, см. index.ts).
 *
 * ── Раскладка данных (D-019, опирается на D-007) ─────────────────────────────
 * В SoA-компонентах здесь — ТОЛЬКО числа (позиция, нужды, здоровье, задача, навыки,
 * дом, видо-данные животного, часы мира). «Холодное» объектное (имя/фракция/
 * профессия/инвентарь/деньги) живёт в ResourceStore (D-007), НЕ здесь. День/ночь
 * НЕ хранится — выводится из `tick % TICKS_PER_DAY` (D-019); погода хранится в
 * WorldClock (марковский процесс с длительностью). Транзит без sentinel:
 * `Position.dest === loc` ⇒ сущность стоит на месте (D-019).
 *
 * ── Теги vs данные (D-019) ───────────────────────────────────────────────────
 * `Human`/`Corpse`/`Alive` — ТЕГИ (маркеры без полей, `defineTag`): булевы
 * состояния, которым колонка-флаг в SoA не нужна. ОТДЕЛЬНОГО тега `Animal` НЕТ:
 * носительство ДАННЫХ-компонента `Animal` (species/herd) само отделяет животных от
 * людей; у человека видо-специфичных числовых полей нет (его «холодное» — в
 * ResourceStore), поэтому `Human` — чистый тег.
 *
 * ── Порядок полей ────────────────────────────────────────────────────────────
 * Порядок полей в схеме компонента = порядок в `ComponentMeta.fields` = порядок
 * записи/чтения снапшота. Менять его нельзя без роста версии формата снапшота
 * (иначе старые снимки прочитаются криво). Порядок ЗАФИКСИРОВАН здесь.
 *
 * Пример (как система 1.4 двигает сущность):
 * ```ts
 * import { Position } from './components';
 * const p = Position as unknown as { loc: Uint32Array; dest: Uint32Array; etaTicks: Float32Array };
 * if (p.dest[eid] !== p.loc[eid]) p.etaTicks[eid] -= 1; // в пути
 * ```
 */

import type { EntityId, MessageTemperament } from '@zona/shared';
import { defineComponentT, defineTag, Types, type ComponentRef } from './ecs';
import type { ComponentMeta } from './registry';
import { WEATHER_TYPES, type WeatherType } from '../balance/weather';

// ── Ёмкость колонок мира (жёсткий потолок числа ОДНОВРЕМЕННЫХ сущностей) ───────
//
// Типизированные массивы SoA имеют фиксированную длину, поэтому ёмкость выбирается
// при объявлении компонента и становится ЖЁСТКИМ потолком: `addComponent` для
// eid ≥ ёмкости бросает (guard в ecs.ts), а не тихо портит память (закон №8).
//
// Сколько нужно Фазе 1? bitecs переиспользует освобождённые eid из freelist —
// `maxId` растёт лишь до ПИКА ОДНОВРЕМЕННО живых сущностей (не до суммы за прогон),
// поэтому оценивать надо пик, а не оборот рождений/смертей.
//   • ~20 сталкеров (D-021) + 1 сущность-мир (WorldClock singleton);
//   • стада животных в wild/ruins (D-025): олени 3–8, кабаны 1–4 на стадо, потолок
//     популяции вида в локации — reproCap (олень 20, кабан 12, species.json);
//   • трупы (тег Corpse) — временные сущности до разделки/распада.
// Даже щедро (20 людей + ~300 животных + ~100 трупов + мир) пик ≈ 400–450 ≪ 4096.
// 10-дневный прогон не приближается к потолку: запас ~10×. Память дешёвая
// (Float32Array(4096) = 16 КБ на поле; все поля вместе ≈ сотни КБ). Значение
// задано ЯВНО (не «молчаливый дефолт»): это осознанный потолок Фазы 1, а не
// случайность. Перф-бюджет (250 сущностей / 1.6 мс — забота balance-analyst) —
// ОТДЕЛЬНАЯ метрика; capacity лишь гарантирует отсутствие тихой порчи памяти при
// всплеске популяции. При выходе за него addComponent падает ГРОМКО (см. тест
// границы) — сигнал поднять WORLD_CAPACITY, а не молча терять данные.
export const WORLD_CAPACITY = 4096;

// ── Перечисления-КОДЫ (структура, не контент и не баланс) ─────────────────────

/**
 * Код вида задачи (`Task.kind`, хранится как ui8). Это СТРУКТУРНЫЙ код (не баланс —
 * не тюнится числом; не контент — не в /sim/data), поэтому живёт рядом с компонентом
 * Task, а не в /sim/balance или /sim/data.
 *
 * ВНИМАНИЕ (стабильность формата): значения — коды ui8, попадающие в снапшот.
 * Набор APPEND-ONLY: новые виды задач добавляются в КОНЕЦ с новым числом;
 * переиспользовать/переставлять существующие коды НЕЛЬЗЯ (сломает чтение старых
 * снимков — как порядок полей). Начальный набор покрывает 4 нужды (hunger→EAT,
 * thirst→DRINK, fatigue→SLEEP/REST, fear→FLEE) + добычу еды (FORAGE/HUNT).
 * FORAGE и REST — гарантированные fallback'и (D-020: idle запрещён, всегда есть
 * задача со score>0). АВТОРИТЕТНУЮ семантику/полноту таксономии задач фиксирует
 * task-selection (1.8, behavior-engineer) через sim-architect; здесь — стабильное
 * кодовое пространство, на которое ссылается поле компонента.
 *
 * ФАЗА 2 (задача 2.1/2.8): коды 7–10 добавлены APPEND-ONLY в конец (существующие
 * 0–6 НЕ тронуты, порядок формата снапшота стабилен, закон №8): WORK/TRADE/ROB/
 * SEARCH — работа на поселение (2.4), торговля (2.6), грабёж (2.12), поход за
 * артефактом (2.10). Семантику этих задач фиксируют их системы Фазы 2; здесь —
 * лишь стабильные ui8-коды, на которые ссылается `Task.kind`.
 */
export const TaskKind = {
  /** Спать (восстановление fatigue, обычно дома). */
  SLEEP: 0,
  /** Есть (закрыть hunger из инвентаря). */
  EAT: 1,
  /** Пить (закрыть thirst у источника воды). */
  DRINK: 2,
  /** Собирательство (добыть еду; fallback, D-020). */
  FORAGE: 3,
  /** Охота на животное (мясо, targetEid — жертва). */
  HUNT: 4,
  /** Отдых вне дома (снизить fatigue; fallback, D-020). */
  REST: 5,
  /** Бегство от угрозы (fear). */
  FLEE: 6,
  /** Работа на поселение-работодателя (Job.employer; система 2.4). */
  WORK: 7,
  /** Торговля с торговцем/поселением (targetEid — контрагент; система 2.6). */
  TRADE: 8,
  /** Грабёж цели (targetEid — жертва; система 2.12). */
  ROB: 9,
  /** Поход за артефактом в аномальное поле (targetLoc/targetEid — поле; система 2.10). */
  SEARCH: 10,
} as const;

/** Тип кода задачи (значение `TaskKind.*`). */
export type TaskKind = (typeof TaskKind)[keyof typeof TaskKind];

/**
 * Код погоды (`WorldClock.weather`, хранится как ui8) = ИНДЕКС в `WEATHER_TYPES`
 * (balance/weather). Единый источник порядка погод — там; здесь лишь ПРОИЗВОДНЫЙ
 * обратный индекс, чтобы системы писали код семантически (`WEATHER_CODE.rain`), а
 * не «магическим числом» (закон №7), не дублируя список (закон №10). Порядок
 * массива детерминирован → индексы стабильны (закон №8).
 */
export const WEATHER_CODE: Readonly<Record<WeatherType, number>> = Object.freeze(
  Object.fromEntries(WEATHER_TYPES.map((w, i) => [w, i])),
) as Readonly<Record<WeatherType, number>>;

/**
 * Код ТЕМПЕРАМЕНТА личности (`Personality.temperament`, хранится как ui8). Это
 * СТРУКТУРНЫЙ код (не баланс, не контент), поэтому живёт рядом с компонентом
 * Personality, как `TaskKind` рядом с Task. Значения ОТОБРАЖАЮТСЯ в строковые коды
 * `MessageTemperament` (@zona/shared, D-069) через `TEMPERAMENT_MESSAGE` — тон
 * радио-реплики (Radio 3.5 выбирает пул messages.json по темпераменту говорящего).
 *
 * ВНИМАНИЕ (стабильность формата + КОНТРАКТ D-069): значения — коды ui8 в снапшоте;
 * их ПОРЯДОК ОБЯЗАН совпадать с `messages.json.temperaments`
 * (`['neutral','panicky','veteran','talker']`) и с `MessageTemperament` — закреплено
 * тестом. Набор APPEND-ONLY: новые темпераменты добавляются в КОНЕЦ с новым числом,
 * `NEUTRAL=0` (базовый/фолбэк-тон, D-069) не переиспользуется/не переставляется.
 */
export const Temperament = {
  /** Нейтральный — ровная фактическая речь (базовый/фолбэк-тон, D-069). */
  NEUTRAL: 0,
  /** Паникёр — преувеличение угрозы, крик, восклицания. */
  PANICKY: 1,
  /** Ветеран — скупо, спокойно, мрачный юмор, профессионально. */
  VETERAN: 2,
  /** Болтун — многословно, сплетни, шутки, панибратство. */
  TALKER: 3,
} as const;

/** Тип кода темперамента (значение `Temperament.*`). */
export type Temperament = (typeof Temperament)[keyof typeof Temperament];

/**
 * Отображение кода `Temperament` → строковый `MessageTemperament` (D-069). Индекс
 * массива = код (0=neutral…3=talker), поэтому порядок ОБЯЗАН совпадать с enum
 * Temperament И с `messages.json.temperaments` (тест это проверяет). Radio 3.5 берёт
 * пул шаблонов по этому строковому коду; хелпер `temperamentCode(eid)` — обёртка над
 * ним для носителя. Заморожен: коды стабильны (закон №8).
 */
export const TEMPERAMENT_MESSAGE: readonly MessageTemperament[] = Object.freeze([
  'neutral',
  'panicky',
  'veteran',
  'talker',
]) as readonly MessageTemperament[];

// Примечание про species: `Animal.species` (ui8) — это `SpeciesData.id` (плотный
// индекс из species.json, 0=deer, 1=boar, …). ОТДЕЛЬНОГО enum здесь НЕТ намеренно:
// перечень видов — контент (/sim/data, закон №10), дублировать его кодом запрещено.
// Системы берут вид через `getSpecies(Animal.species[eid])` из @zona/sim/data.

// ── Компоненты с данными (числовые SoA) ──────────────────────────────────────

/**
 * Положение сущности на графе локаций. `dest === loc` ⇒ стоит на месте (без
 * sentinel, D-019); в пути `etaTicks` — сколько тиков-минут осталось до `dest`.
 *
 * ИНВАРИАНТ ИНИЦИАЛИЗАЦИИ: `addComponent` зануляет поля (D-024), поэтому у свежего
 * носителя `loc = dest = 0`, что по контракту «без sentinel» читается как «стоит в
 * локации 0» (ENTRY_LOCATION = Кордон, D-025), а НЕ «не инициализирован». Значение
 * валидно только ПОСЛЕ того, как worldgen (1.3) выставит `loc`. Системы не должны
 * читать Position у сущности до её инициализации worldgen.
 *
 * ПОЛЕ ПРИЧИННОСТИ (D-030, задача 1.2b): `moveCause` — EventId события `move/departed`,
 * начавшего текущий переход (0 = «нет причины», D-031). Живёт ВЕСЬ переход и читается
 * при прибытии, чтобы Movement (1.10) выставил `move/arrived.causedBy = moveCause`.
 * ui32-код, штампуется через `stampCause` при смене состояния (D-032). Тип ui32:
 * EventId помещается в Uint32 (guard >0xFFFFFFFF, D-031). Поле в КОНЦЕ схемы —
 * append сохраняет порядок снапшота (закон №8).
 */
export const Position: ComponentRef = defineComponentT(
  { loc: Types.ui32, dest: Types.ui32, etaTicks: Types.f32, moveCause: Types.ui32 },
  WORLD_CAPACITY,
);

/** Физиологические нужды 0..1 (растут со временем; закрываются задачами). */
export const Needs: ComponentRef = defineComponentT(
  { hunger: Types.f32, thirst: Types.f32, fatigue: Types.f32, fear: Types.f32 },
  WORLD_CAPACITY,
);

/**
 * Здоровье. `hp` — очки жизни (0 ⇒ смерть, переход в тег Corpse).
 *
 * ПОЛЕ ПРИЧИННОСТИ (D-030, задача 1.2b): `lethalCause` — EventId события, добившего
 * `hp ≤ 0` (0 = «нет причины», D-031). Читается системой Death (1.11), чтобы выставить
 * `entity/died.causedBy = lethalCause` — смерть наследует причину от урона/голода,
 * добравшего носителя. ui32-код, штампуется через `stampCause` тем, кто наносит
 * летальный урон (D-032). Поле в КОНЦЕ схемы (append, закон №8).
 */
export const Health: ComponentRef = defineComponentT(
  { hp: Types.f32, lethalCause: Types.ui32 },
  WORLD_CAPACITY,
);

/**
 * Текущая задача сущности (результат task-selection 1.8). `kind` — код `TaskKind`;
 * `targetLoc` — целевая локация (если задача про место), `targetEid` — целевая
 * сущность (жертва охоты/торговец, ссылка-eid без ремапа при load, D-011);
 * `startedTick` — тик начала (для тайм-аутов/прогресса).
 *
 * ПОЛЕ ПРИЧИННОСТИ (D-030, задача 1.2b): `causeEvent` — EventId события `task/selected`,
 * выбравшего текущую задачу (0 = «нет причины», D-031). Читается системой Movement
 * (1.10), чтобы порождённые задачей события (например `move/departed`) ссылались на
 * причину: `causedBy = causeEvent`. ui32-код, штампуется через `stampCause` в
 * task-selection (1.8) ПРИ СМЕНЕ задачи (D-032). Поле в КОНЦЕ схемы (append, закон №8).
 */
export const Task: ComponentRef = defineComponentT(
  {
    kind: Types.ui8,
    targetLoc: Types.ui32,
    targetEid: Types.eid,
    startedTick: Types.ui32,
    causeEvent: Types.ui32,
  },
  WORLD_CAPACITY,
);

/** Навыки 0..1: меткость (разброс выстрела), выживание, скрытность. */
export const Skills: ComponentRef = defineComponentT(
  { shooting: Types.f32, survival: Types.f32, stealth: Types.f32 },
  WORLD_CAPACITY,
);

/** Дом сущности: `loc` — локация-база (сон/хранение). */
export const Home: ComponentRef = defineComponentT({ loc: Types.ui32 }, WORLD_CAPACITY);

/**
 * Видо-данные животного: `species` — `SpeciesData.id` (species.json), `herd` —
 * id стада (группировка для миграции/размножения). Носительство ЭТОГО компонента
 * отделяет животных от людей (отдельного тега Animal нет, D-019).
 */
export const Animal: ComponentRef = defineComponentT(
  { species: Types.ui8, herd: Types.ui32 },
  WORLD_CAPACITY,
);

/**
 * Часы мира — SINGLETON на сущности-мире (её создаёт worldgen 1.3; аллокацию eid
 * и его тождество держит worldgen, не этот модуль). `weather` — код `WEATHER_CODE`;
 * `weatherSince` — тик начала текущей погоды (для длительности марковского перехода).
 */
export const WorldClock: ComponentRef = defineComponentT(
  { weather: Types.ui8, weatherSince: Types.ui32 },
  WORLD_CAPACITY,
);

/**
 * Личность человека (задача 3.3, D-071) — нарративная окраска NPC. Носитель —
 * ТОЛЬКО люди (сталкеры/бандиты/резиденты/торговцы/новички; сидит `spawnStalker`,
 * D-059). `temperament` — код `Temperament` (ui8), тон радио-реплики (Radio 3.5
 * маппит его в `MessageTemperament` через `TEMPERAMENT_MESSAGE`/`temperamentCode`);
 * `talkativeness` — склонность ретранслировать услышанный слух [0..1] (Rumors 3.6
 * будет читать). Оба поля СИДЯТСЯ детерминированно в worldgen (D-021) и в тике 3.3
 * НИКЕМ не читаются — чистые ДАННЫЕ на сущности до подключения Radio/Rumors, поэтому
 * их появление не меняет поведение (лишь rng-сдвиг от сида; D-071). Поля в объявленном
 * порядке: temperament, talkativeness (= порядок снапшота, закон №8).
 */
export const Personality: ComponentRef = defineComponentT(
  { temperament: Types.ui8, talkativeness: Types.f32 },
  WORLD_CAPACITY,
);

/**
 * Хелпер для Radio (3.5) и летописи: строковый `MessageTemperament` носителя `eid`
 * из `Personality.temperament` (D-069). Читает SoA-колонку O(1) и мягко откатывается
 * на `'neutral'` при коде вне набора — не бросает, чтобы рендер эфира деградировал
 * предсказуемо. ВНИМАНИЕ (находка ревью 3.3): читает колонку НАПРЯМУЮ, без
 * `hasComponent(Personality, eid)`. Для НЕ-носителя с переиспользованным eid (бывший
 * носитель умер → eid переиспользован не-человеком без Personality) колонка сохранит
 * УСТАРЕВШИЙ код (SoA не зануляется при reuse без addComponent, D-024). Поэтому ВЫЗЫВАЮЩИЙ
 * (Radio 3.5) ОБЯЗАН звать temperamentCode ТОЛЬКО на живых людях-носителях (говорящий
 * эфира — всегда живой Human-наблюдатель ⇒ носитель); для гарантированного 'neutral' на
 * произвольном eid — гейтить `hasComponent(Personality, eid)` на стороне вызова.
 */
export function temperamentCode(eid: EntityId): MessageTemperament {
  const store = Personality as unknown as { temperament: Uint8Array };
  const code = store.temperament[eid as number] ?? 0;
  return TEMPERAMENT_MESSAGE[code] ?? 'neutral';
}

// ── Фаза 2: SoA data-компоненты без тега (носительство = тип, D-046) ──────────
//
// Settlement/AnomalyField/Job — как Animal: наличие ДАННЫХ-компонента само задаёт
// «роль» сущности (поселение / аномальное поле / трудоустроенный NPC), отдельного
// тега нет (D-046, D-019). «Холодное» носительство (склад/касса поселения, наземный
// лут поля) живёт под теми же ключами ResourceStore 'inventory'/'money' на ТЕХ ЖЕ
// eid (D-046, D-007) — здесь только числовые SoA-поля. Здесь лишь ОПРЕДЕЛЕНИЯ; их
// создаёт/наполняет worldgen 2.2 и системы 2.2/2.3/2.9 (в текущем прогоне носителей
// нет → в снапшот эти компоненты не пишутся, голдены стабильны).

/**
 * Поселение-сущность (D-046). `morale` — боевой дух/довольство 0..1 (падает от
 * голода/угроз, растёт от достатка); `security` — защищённость 0..1 (гарнизон/
 * стены, снижает успех грабежа 2.12); `buildTarget` — код текущего проекта
 * стройки (ui8; 0 = ничего не строится — совпадает с занулением addComponent,
 * D-024); `buildProgress` — прогресс стройки 0..1. Склад/касса поселения — cold
 * 'inventory'/'money' на этом же eid (D-046), НЕ здесь. Экономический AI/строй
 * фиксирует система 2.3; здесь — стабильная раскладка полей (порядок = снапшот,
 * закон №8). Поля в объявленном порядке: morale, security, buildTarget, buildProgress.
 */
export const Settlement: ComponentRef = defineComponentT(
  {
    morale: Types.f32,
    security: Types.f32,
    buildTarget: Types.ui8,
    buildProgress: Types.f32,
  },
  WORLD_CAPACITY,
);

/**
 * Аномальное поле (D-046). `charge` — заряд/интенсивность 0..1 (растёт к выбросу,
 * опасность прохода 2.10); `tier` — уровень поля (ui8; влияет на ценность
 * рождаемых артефактов). Наземный лут поля (артефакты до подбора) — cold
 * 'inventory' на этом же eid (D-046), НЕ здесь. Генезис/жизненный цикл полей
 * фиксирует система 2.9 (ecosystem); здесь — стабильная раскладка полей. Поля в
 * объявленном порядке: charge, tier.
 */
export const AnomalyField: ComponentRef = defineComponentT(
  { charge: Types.f32, tier: Types.ui8 },
  WORLD_CAPACITY,
);

/**
 * Трудоустройство NPC (D-046). Носительство = «сущность работает на поселение»
 * (как Animal отделяет животных): у безработных NPC компонента нет. `workplace` —
 * локация рабочего места (ui32, `Location.id`); `employer` — eid поселения-
 * работодателя (ссылка-eid БЕЗ ремапа при load, D-011, как `Task.targetEid`).
 * Экономику труда (наём/увольнение/зарплата) фиксирует система 2.4; здесь —
 * стабильная раскладка полей. Поля в объявленном порядке: workplace, employer.
 */
export const Job: ComponentRef = defineComponentT(
  { workplace: Types.ui32, employer: Types.eid },
  WORLD_CAPACITY,
);

// ── Теги (маркеры без полей, D-019) ──────────────────────────────────────────

/** Тег: сущность — человек (NPC-сталкер). «Холодные» данные — в ResourceStore. */
export const Human: ComponentRef = defineTag(WORLD_CAPACITY);

/** Тег: сущность — труп (источник мяса/лута до разделки/распада). */
export const Corpse: ComponentRef = defineTag(WORLD_CAPACITY);

/** Тег: сущность жива (снимается при смерти; удобный фильтр запросов). */
export const Alive: ComponentRef = defineTag(WORLD_CAPACITY);

// ── Реестр доменных компонентов (ОТСОРТИРОВАН по name, закон №8) ──────────────
//
// `name` — стабильный ключ снапшота (lowercase, не зависит от имени переменной).
// `fields` — ФИКСИРОВАННЫЙ порядок полей (= порядок схемы выше); теги дают `[]`.
// Массив ЗАРАНЕЕ отсортирован по name по возрастанию — `assertRegistrySorted`
// (в registry.ts, при загрузке модуля) это проверяет и падает на нарушении.
export const DOMAIN_COMPONENTS: readonly ComponentMeta[] = [
  { name: 'alive', ref: Alive, fields: [] },
  { name: 'animal', ref: Animal, fields: ['species', 'herd'] },
  // Фаза 2 (D-046): 'anomalyfield' сортируется между 'animal' (ani…) и 'corpse'
  // (ano… > ani…, < c…). Поля в объявленном порядке.
  { name: 'anomalyfield', ref: AnomalyField, fields: ['charge', 'tier'] },
  { name: 'corpse', ref: Corpse, fields: [] },
  // causality-поля (D-030, 1.2b) добавлены В КОНЕЦ списков полей — append сохраняет
  // порядок снапшота (закон №8): lethalCause/moveCause/causeEvent.
  { name: 'health', ref: Health, fields: ['hp', 'lethalCause'] },
  { name: 'home', ref: Home, fields: ['loc'] },
  { name: 'human', ref: Human, fields: [] },
  // Фаза 2 (D-046): 'job' между 'human' и 'needs'.
  { name: 'job', ref: Job, fields: ['workplace', 'employer'] },
  { name: 'needs', ref: Needs, fields: ['hunger', 'thirst', 'fatigue', 'fear'] },
  // Задача 3.3 (D-071): 'personality' сортируется между 'needs' и 'position'
  // ('pe…' < 'po…'). Поля в объявленном порядке.
  { name: 'personality', ref: Personality, fields: ['temperament', 'talkativeness'] },
  { name: 'position', ref: Position, fields: ['loc', 'dest', 'etaTicks', 'moveCause'] },
  // Фаза 2 (D-046): 'settlement' между 'position' и 'skills' (se… < sk…).
  { name: 'settlement', ref: Settlement, fields: ['morale', 'security', 'buildTarget', 'buildProgress'] },
  { name: 'skills', ref: Skills, fields: ['shooting', 'survival', 'stealth'] },
  { name: 'task', ref: Task, fields: ['kind', 'targetLoc', 'targetEid', 'startedTick', 'causeEvent'] },
  { name: 'worldclock', ref: WorldClock, fields: ['weather', 'weatherSince'] },
] as const;
