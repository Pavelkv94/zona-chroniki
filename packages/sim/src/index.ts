/**
 * @module @zona/sim
 *
 * Headless-ядро симуляции (ECS на bitecs, планировщик, PRNG, шина событий,
 * сериализация). Публичный, минимальный и стабильный API: другие пакеты зависят
 * от него, ломающие изменения согласуются через sim-architect.
 *
 * ЗАКОН №5: пакет НЕ импортирует ничего из DOM/React/Node и обязан запускаться
 * headless. Соблюдение проверяется компилятором (в tsconfig нет `lib: DOM`,
 * `types: node`).
 *
 * Публичная поверхность 0.1 намеренно узкая:
 *  - `createSimWorld` — создать мир;
 *  - `destroyEntity(world, eid)` — ЕДИНСТВЕННЫЙ способ удалить сущность
 *    (убирает и из ECS, и из ResourceStore; см. world.ts);
 *  - типы `SimWorld`, `ResourceStore`, контракты `System`/`SystemCtx`.
 *
 * Низкоуровневая обёртка bitecs (`core/ecs.ts`) и тип `EcsWorld` НЕ
 * реэкспортируются: тип движка не должен течь в контракты ui/headless. Код
 * внутри пакета (системы, сериализация) импортирует ecs-хелперы из `core/ecs`
 * напрямую. PRNG (0.3) добавлен: `createRng`/`restoreRng`/`Rng`. Шина событий
 * (0.4) добавлена: `createEventBus`/`EventBus` (реэкспорт типов `SimEvent`/
 * `SimEventBase` — из `@zona/shared`). Планировщик (0.2) добавлен:
 * `createScheduler`/`Scheduler` (исполняет `System` по `schedule`, D-006/D-009).
 * Сериализация write-path (0.5a) добавлена: `serialize`/`hashSnapshot`/
 * `canonicalize` + типы `SnapshotJSON`/`JsonValue` (из `@zona/shared`).
 * Низкоуровневый `exportEntityIndex` (core/ecs) НЕ реэкспортируется (D-011).
 * Сериализация read-path (0.5b) добавлена: `deserialize` (`SnapshotJSON →
 * SimWorld`). Низкоуровневый `createEcsWorldFromIndex` (core/ecs) и внутренний
 * `createResourceStore` (core/world) НЕ реэкспортируются (D-008/D-011).
 *
 * SoA-компоненты (1.0, D-018): `serialize`/`deserialize` получили ОПЦИОНАЛЬНЫЙ
 * второй аргумент `registry` (по умолчанию — глобальный `COMPONENT_REGISTRY`) —
 * публичная сигнатура обратно совместима (CLI/прежние вызовы не меняются). Обёртки
 * компонентов (`defineComponentT`/`addComponent`/`hasComponent`/`removeComponent`/
 * `queryEntities`, `core/ecs`) и сам реестр (`core/registry`) — ВНУТРЕННИЕ: их
 * импортируют системы/сериализация внутри пакета, наружу они не текут (тип движка
 * bitecs не должен попасть в контракты ui/headless). Публично добавлен лишь тип
 * формы колонки `ComponentColumnJSON` (из `@zona/shared`) — документирует
 * `SnapshotJSON.components`.
 */

export { createSimWorld, destroyEntity } from './core/world';
export type { SimWorld, ResourceStore } from './core/world';

export { createRng, restoreRng } from './core/rng';
export type { Rng } from './core/rng';

export { createEventBus } from './core/events';
export type { EventBus } from './core/events';

export { createScheduler } from './core/scheduler';
export type { Scheduler } from './core/scheduler';

export type { System, SystemCtx } from './core/system';

export { serialize, deserialize, hashSnapshot, canonicalize } from './core/snapshot';
export type { SnapshotJSON, JsonValue, ComponentColumnJSON } from '@zona/shared';

// Балансовые константы времени (закон №7). Публичны: headless-CLI переводит
// `--days N` в тики через `TICKS_PER_DAY`, не хардкодя 1440.
export { TICKS_PER_DAY } from './balance/time';

// Стартовая генерация мира (1.3). Вызывается ОДИН раз при сборке мира (CLI 1.12)
// до первого тика: населяет пустой SimWorld сталкерами/животными/часами мира.
export { worldgen } from './worldgen';

// Сборка конвейера Фазы 1 (1.12). Регистрирует все системы в каноническом
// порядке (инвариант D-032). CLI собирает живой мир через неё, не перечисляя
// системы вручную. `PHASE1_SYSTEMS` — тот же список данными для теста порядка.
export { registerPhase1Systems, PHASE1_SYSTEMS } from './pipeline';
// Конвейер Фазы 2 (капстоун 2.16, D-064): 17 систем в каноническом порядке,
// расширяет Фазу 1 семью системами 2.x, сохраняя стыки D-032. Данные-массив
// PHASE2_SYSTEMS экспонируются для теста инварианта порядка (как PHASE1_SYSTEMS).
export { registerPhase2Systems, PHASE2_SYSTEMS } from './pipeline';

// ── Презентационные справочники (1.12, D-006) ────────────────────────────────
// Реэкспорт для ЧЕЛОВЕКОЧИТАЕМОГО рендера лога в headless (флаг --log verbose):
// имя локации, вид животного, коды задач/погоды → русские подписи. Это ЧТЕНИЕ
// контента (закон №10), рендер живёт в headless и мир НЕ трогает (D-006). Сам
// перечень видов/локаций — данные (/sim/data), коды — стабильное пространство.
export { getLocation, getSpecies } from './data/index';
export { WEATHER_TYPES } from './balance/weather';
export type { WeatherType } from './balance/weather';
export { TaskKind } from './core/components';

// Сериализация read-path для resume-прогонов CLI (save/load через весь конвейер).
export type { SimEvent } from '@zona/shared';

// Система Economy (2.3): жизнь поселений (потребление/производство/стройка/мораль).
// НЕ входит в registerPhase1Systems (подключит 2.16) — экспортируется как System,
// чтобы её можно было прогнать в отдельном планировщике (headless-инвариант 2.3).
export { Economy } from './systems/economy';

// Хелпер найма assignJobs (2.4): назначает Job резидентам поселений с оседлой
// профессией. НЕ система и НЕ в конвейере/worldgen (вызовет FactionAI/2.16) —
// экспортируется как чистая функция, чтобы интеграция Фазы 2 включила наём.
export { assignJobs } from './systems/job-assign';

// Система Trade (2.5): исполнение сделок NPC↔поселение (перевод, D-047). Цена —
// DERIVED (priceOf). НЕ входит в registerPhase1Systems (подключит 2.16) — экспорт как
// System (прогон в отдельном планировщике) + чистая priceOf для тестов/анализа.
export { Trade } from './systems/trade';
export { priceOf, exportPriceOf } from './systems/pricing';

// Система Export (2.7, D-055): экспорт хабара за Периметр — ЕДИНСТВЕННЫЙ money-faucet
// замкнутой экономики (леджер item/exported: товар −, деньги +). НЕ входит в
// registerPhase1Systems/worldgen (подключит 2.16) — экспорт как System для прогона в
// отдельном планировщике (headless-инвариант 2.7) и будущей интеграции.
export { Export } from './systems/export';

// Система ArtifactSpawn (2.9, D-054): аномальные поля рождают артефакты по накоплению
// заряда (наземный лут поля, леджер item/harvested). НЕ входит в registerPhase1Systems
// и не создаётся worldgen (подключит 2.16) — экспорт как System для прогона в отдельном
// планировщике (headless-инвариант 2.9) и будущей интеграции.
export { ArtifactSpawn } from './systems/artifact-spawn';

// Система ArtifactSearch (2.10, D-057): исполнение подбора артефакта стоящим в
// аномальном поле NPC (Task=SEARCH) — перевод лута поля в инвентарь (масса сохраняется,
// D-047, НЕ леджер). НЕ входит в registerPhase1Systems и не создаётся worldgen (носителей
// AnomalyField нет до 2.16) — экспорт как System для прогона в отдельном планировщике
// (headless-инвариант 2.10) и будущей интеграции.
export { ArtifactSearch } from './systems/artifact-search';

// Память/отношения/обход (2.15, D-050/D-058) — СУБСТРАТ цепочки бандитов (2.11–2.13).
// Система MemoryDecay: затухание salience памяти / остывание отношений к нейтралу / чистка
// истёкшего обхода. НЕ входит в registerPhase1Systems и не создаётся worldgen (записей
// memory/relations/avoidLoc нет до 2.16) ⇒ no-op на живом мире, голдены Фазы 1 целы.
// Чистые хелперы (addMemory/getRelation/adjustRelation/addAvoid/isAvoided/factionReputation
// + кодировка subject) — API для 2.12/2.13/TaskSelection; здесь НЕ реализуют ROB-выбор.
export { MemoryDecay } from './systems/memory-decay';
export {
  entitySubject,
  factionSubject,
  parseSubject,
  getMemory,
  addMemory,
  getRelations,
  getRelation,
  setRelation,
  adjustRelation,
  factionReputation,
  getAvoids,
  addAvoid,
  isAvoided,
  MEMORY_KEY,
  RELATIONS_KEY,
  AVOID_KEY,
} from './systems/memory';
export type { Subject, MemoryRecord, RelationEntry, AvoidEntry } from '@zona/shared';

// Система RobberyMemory (2.13, D-063): ФОРМИРОВАНИЕ памяти об ограблении — реагирует на
// `loot/transferred` (Encounters 2.11/D-060) и записывает ЖИВОЙ жертве память 'robbed' о
// грабителе (causeEvent), портит к нему (и его фракции) отношение и метит место грабежа
// избегаемым (addAvoid → обход маршрута читает TaskSelection). НЕ входит в
// registerPhase1Systems и не создаётся worldgen (бандитов/ROB в живом мире нет ⇒
// loot/transferred не эмитится ⇒ no-op) — экспорт как System для прогона в отдельном
// планировщике и интеграции 2.16. Голдены Фазы 1 не сдвигаются.
export { RobberyMemory } from './systems/robbery-memory';

// Рождение ОДНОГО сталкера/NPC (рефактор 2.14a, D-059). Публична — чтобы
// PopulationInflux (2.14/D-051, приток населения) спавнил новоприбывших ТЕМ ЖЕ
// кодом, что и worldgen (новичок = стартовый сталкер бит-в-бит). Возвращает eid как
// seam для леджера item/broughtIn (источник инвентаря — вне функции, D-052).
export { spawnStalker } from './worldgen';
export type { SpawnStalkerConfig, ProfessionSpec } from './worldgen';

// Система PopulationInflux (2.14, D-061): ПРИЧИННЫЙ приток населения из-за Периметра
// (порог привлекательности из окна событий, НЕ «X% спавн/тик»). Закрывает демо-петлю
// Фазы 1 (D-043 спираль смерти). НЕ входит в registerPhase1Systems и не создаётся
// worldgen (подключит 2.16) — экспорт как System для прогона в отдельном планировщике
// (headless-инвариант 2.14) и будущей интеграции. Голдены Фазы 1 не сдвигаются.
export { PopulationInflux, computeAttractiveness } from './systems/population-influx';
export type { Attractiveness } from './systems/population-influx';

// Нарративный хребет Фазы 3 (3.1, D-067): ЧИСТАЯ оценка значимости события
// `significance(ev, world)` ∈ [0..1] + хранимый аккумулятор известности `fame`
// (`getFame`/`incFame`, ключ ResourceStore 'fame', автосериализуется как money/memory).
// НЕ система (в конвейер не входит, worldgen не зовёт, fame нигде не инкрементится в 3.1)
// ⇒ голдены Фазы 3 не двигаются; EconomyInvariant не затронут ('fame' дизъюнктен
// 'money'/'inventory'). Позовут Chronicle 3.2 (порог значимости → запись летописи) и
// Radio 3.5 (окраска эфира), они же поднимут fame упомянутым сущностям.
export { significance, getFame, incFame, FAME_KEY } from './narrative/significance';
