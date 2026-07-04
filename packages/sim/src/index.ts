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
export { priceOf } from './systems/pricing';

// Система ArtifactSpawn (2.9, D-054): аномальные поля рождают артефакты по накоплению
// заряда (наземный лут поля, леджер item/harvested). НЕ входит в registerPhase1Systems
// и не создаётся worldgen (подключит 2.16) — экспорт как System для прогона в отдельном
// планировщике (headless-инвариант 2.9) и будущей интеграции.
export { ArtifactSpawn } from './systems/artifact-spawn';
