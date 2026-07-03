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

// Примечание про species: `Animal.species` (ui8) — это `SpeciesData.id` (плотный
// индекс из species.json, 0=deer, 1=boar, …). ОТДЕЛЬНОГО enum здесь НЕТ намеренно:
// перечень видов — контент (/sim/data, закон №10), дублировать его кодом запрещено.
// Системы берут вид через `getSpecies(Animal.species[eid])` из @zona/sim/data.

// ── Компоненты с данными (числовые SoA) ──────────────────────────────────────

/**
 * Положение сущности на графе локаций. `dest === loc` ⇒ стоит на месте (без
 * sentinel, D-019); в пути `etaTicks` — сколько тиков-минут осталось до `dest`.
 */
export const Position: ComponentRef = defineComponentT(
  { loc: Types.ui32, dest: Types.ui32, etaTicks: Types.f32 },
  WORLD_CAPACITY,
);

/** Физиологические нужды 0..1 (растут со временем; закрываются задачами). */
export const Needs: ComponentRef = defineComponentT(
  { hunger: Types.f32, thirst: Types.f32, fatigue: Types.f32, fear: Types.f32 },
  WORLD_CAPACITY,
);

/** Здоровье. `hp` — очки жизни (0 ⇒ смерть, переход в тег Corpse). */
export const Health: ComponentRef = defineComponentT({ hp: Types.f32 }, WORLD_CAPACITY);

/**
 * Текущая задача сущности (результат task-selection 1.8). `kind` — код `TaskKind`;
 * `targetLoc` — целевая локация (если задача про место), `targetEid` — целевая
 * сущность (жертва охоты/торговец, ссылка-eid без ремапа при load, D-011);
 * `startedTick` — тик начала (для тайм-аутов/прогресса).
 */
export const Task: ComponentRef = defineComponentT(
  { kind: Types.ui8, targetLoc: Types.ui32, targetEid: Types.eid, startedTick: Types.ui32 },
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
  { name: 'corpse', ref: Corpse, fields: [] },
  { name: 'health', ref: Health, fields: ['hp'] },
  { name: 'home', ref: Home, fields: ['loc'] },
  { name: 'human', ref: Human, fields: [] },
  { name: 'needs', ref: Needs, fields: ['hunger', 'thirst', 'fatigue', 'fear'] },
  { name: 'position', ref: Position, fields: ['loc', 'dest', 'etaTicks'] },
  { name: 'skills', ref: Skills, fields: ['shooting', 'survival', 'stealth'] },
  { name: 'task', ref: Task, fields: ['kind', 'targetLoc', 'targetEid', 'startedTick'] },
  { name: 'worldclock', ref: WorldClock, fields: ['weather', 'weatherSince'] },
] as const;
