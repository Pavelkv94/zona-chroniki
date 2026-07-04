/**
 * @module @zona/sim/pipeline
 *
 * Сборка конвейера Фазы 1 (задача 1.12): регистрация ВСЕХ систем симуляции в
 * планировщике в КАНОНИЧЕСКОМ порядке одного тика (контракт B.1, docs/DECISIONS).
 * Это единственная точка, знающая полный состав и порядок систем живого мира;
 * headless-CLI (1.12) и любые прогоны собирают конвейер через неё, не перечисляя
 * системы вручную (иначе порядок разъехался бы между вызывающими).
 *
 * ── ИНВАРИАНТ ПОРЯДКА (D-032/D-034, закон №8) ────────────────────────────────
 * Порядок исполнения систем = порядок регистрации (scheduler.ts). Он ФИКСИРОВАН
 * и КРИТИЧЕН: производитель штампа/компонента обязан исполниться РАНЬШЕ его
 * потребителя в том же тике, иначе потребитель прочтёт значение прошлого тика
 * (внутритиковая невидимость, D-030/D-032). Стыки причинности, которые этот
 * порядок обязан удовлетворять (закреплено тестом индексов, pipeline.test.ts):
 *   Needs      < Death        (lethalCause от истощения → Death читает его)
 *   Perception < TaskSelection (contacts/fear → выбор задачи)
 *   Perception < Encounters   (contacts → детект столкновения)
 *   Perception < Animals      (contacts → бегство/поведение стада)
 *   TaskSelection < Movement  (Task.causeEvent/dest → departure ставит causedBy)
 *   Encounters < Death        (encounter/resolved.lethalCause → Death)
 *   Movement   < TaskEffects  (прибытие/позиция → эффекты задачи на месте)
 *   Movement   < Animals      (позиция после хода → экология стада)
 *
 * Канонический порядок (B.1 + вставки 1.6–1.11):
 *   Weather → Needs → Perception → TaskSelection → Movement → TaskEffects →
 *   Encounters → Animals → Death.
 *
 * Weather первой (среда — фон тика); Death последней (снимает Alive/Needs/Task с
 * добитых в этом тике — чтобы никто ниже уже не работал с «только что умершим»).
 *
 * ── Закон №6 ─────────────────────────────────────────────────────────────────
 * Системы НЕ вызывают друг друга: pipeline лишь СТАВИТ их в порядок, общение —
 * только через ECS-компоненты и шину (штампы causedBy). Здесь нет логики мира,
 * только оркестрация регистрации.
 *
 * Пример:
 * ```ts
 * const world = createSimWorld(42 as Seed);
 * worldgen(world);
 * const scheduler = createScheduler();
 * registerPhase1Systems(scheduler);
 * scheduler.run(world, TICKS_PER_DAY); // живой мир, не пустые тики
 * ```
 */

import type { Scheduler } from './core/scheduler';
import { Weather } from './systems/weather';
import { Needs } from './systems/needs';
import { Perception } from './systems/perception';
import { TaskSelection } from './systems/task-selection';
import { Movement } from './systems/movement';
import { TaskEffects } from './systems/task-effects';
import { Encounters } from './systems/encounters';
import { Animals } from './systems/animals';
import { Death } from './systems/death';
import { ArtifactSpawn } from './systems/artifact-spawn';
import { RobberyMemory } from './systems/robbery-memory';
import { Trade } from './systems/trade';
import { ArtifactSearch } from './systems/artifact-search';
import { Economy } from './systems/economy';
import { Export } from './systems/export';
import { PopulationInflux } from './systems/population-influx';
import { MemoryDecay } from './systems/memory-decay';

/**
 * Канонический порядок систем Фазы 1 (B.1 + вставки). Экспонируется как данные,
 * чтобы тест инварианта порядка (D-032) проверял ИМЕННО тот список, что
 * регистрируется, а не дублировал его. Порядок массива = порядок регистрации =
 * порядок исполнения на тике (scheduler.ts, закон №8).
 */
export const PHASE1_SYSTEMS = [
  Weather,
  Needs,
  Perception,
  TaskSelection,
  Movement,
  TaskEffects,
  Encounters,
  Animals,
  Death,
] as const;

/**
 * Регистрирует все системы Фазы 1 в `scheduler` в каноническом порядке
 * (см. docblock: инвариант D-032). Вызывается ОДИН раз на свежем планировщике
 * до первого тика. Порядок регистрации фиксирует порядок исполнения — не менять
 * без согласования (перестановка ломает причинность, закреплено тестом).
 */
export function registerPhase1Systems(scheduler: Scheduler): void {
  for (const system of PHASE1_SYSTEMS) {
    scheduler.register(system);
  }
}

/**
 * ЕДИНЫЙ конвейер ФАЗЫ 2 (капстоун 2.16, D-064). Расширяет канон Фазы 1 семью
 * системами Фазы 2 (ArtifactSpawn/RobberyMemory/Trade/ArtifactSearch/Economy/
 * Export/PopulationInflux/MemoryDecay), сохраняя ВСЕ 8 стыков причинности Фазы 1
 * (D-032). Порядок — единственный источник детерминизма причинности (закон №8),
 * зафиксирован тестом индексов (pipeline.test.ts) и обоснован ниже позиция-за-
 * позицией: производитель штампа/компонента обязан исполниться РАНЬШЕ потребителя
 * в том же тике, иначе потребитель прочтёт значение прошлого тика (внутритиковая
 * невидимость, D-005/D-030/D-032).
 *
 * ── ПОРЯДОК 17 СИСТЕМ И ЕГО ОБОСНОВАНИЕ (D-064) ──────────────────────────────
 *   1. Weather        (every:10)  — среда как фон тика (как в Фазе 1).
 *   2. ArtifactSpawn  (60)        — ФИЗИКА СРЕДЫ: заряд поля → рождение артефакта
 *      в наземный лут поля (D-054) РАНЬШЕ, чем TaskSelection/ArtifactSearch увидят
 *      его как достижимую цель SEARCH; артефакт существует до решений о нём.
 *   3. Needs          (1)         — рост нужд/штамп lethalCause истощения ДО Death.
 *   4. Perception     (1)         — contacts/spottedEvent собраны ДО решений/боёв.
 *   5. RobberyMemory  (1)         — РЕАКТИВ на закоммиченный ПРОШЛЫЙ тик
 *      `bus.at(tick−1)` (loot/transferred, D-063): жертва обновляет avoidLoc/
 *      relations РАНЬШЕ, чем TaskSelection решит маршрут этого тика (обход
 *      места грабежа виден выбору цели уже сейчас, а не через тик).
 *   6. TaskSelection  (1)         — utility-AI: штампует Task.causeEvent/targetLoc.
 *   7. Movement       (1)         — departure/arrival по Task (штамп → causedBy).
 *   8. TaskEffects    (1)         — эффекты задачи «на месте» после прибытия.
 *   9. Trade          (1)         — НПС уже СТОИТ у поселения после Movement
 *      (dest===loc) → сделка у стоящего (D-047/D-056); конс. перевод, не леджер.
 *  10. ArtifactSearch (1)         — НПС уже СТОИТ у поля после Movement → подбор
 *      артефакта из лута поля (D-057); конс. перевод, не леджер.
 *  11. Encounters     (1)         — после Perception/TaskSelection/Movement (бой у
 *      сошедшихся стоящих), но ДО Death: лут снимается с проигравшего РАНЬШЕ, чем
 *      Death делает труп ⇒ corpse пуст, масса не задваивается (D-060).
 *  12. Animals        (30)        — экология стада по свежим позициям (Movement<Animals).
 *  13. Economy        (10)        — логистика поселения: census труда по итоговым
 *      позициям тика (после Movement), производство/потребление через леджер (D-045).
 *  14. Export         (1440)      — вывоз хабара ПОСЛЕ Economy (склад уже пополнен
 *      производством этого цикла) — money-faucet через item/exported (D-055).
 *  15. PopulationInflux (240)     — читает ЗАКРЫТОЕ окно лога (прошлые тики, D-061),
 *      поэтому поздно в тике; приток по привлекательности, леджер item/broughtIn.
 *  16. MemoryDecay    (60)        — обслуживание сознания (затухание/prune, D-058),
 *      состояние-only, порядок с соседями не критичен ⇒ поздняя сервисная позиция.
 *  17. Death          (1)         — ПОСЛЕДНЯЯ: снимает Alive/Task/Needs с добитых
 *      этим тиком (истощение Needs / бой Encounters), чтобы никто ниже уже не
 *      работал с «только что умершим» (D-032).
 *
 * ── СОХРАНЁННЫЕ 8 СТЫКОВ ФАЗЫ 1 (D-032) ──────────────────────────────────────
 *   Needs<Death, Perception<{TaskSelection,Encounters,Animals},
 *   TaskSelection<Movement, Movement<{TaskEffects,Animals}, Encounters<Death.
 * НОВЫЕ стыки Фазы 2 (D-064): ArtifactSpawn<TaskSelection<ArtifactSearch;
 *   Movement<{Trade,ArtifactSearch}; RobberyMemory<TaskSelection; Movement<Economy;
 *   Encounters<Death (лут до трупа). Все закреплены тестом индексов.
 *
 * ── Закон №6 ─────────────────────────────────────────────────────────────────
 * registerPhase2Systems ТОЛЬКО упорядочивает регистрацию — логики мира здесь нет,
 * системы общаются исключительно через ECS-компоненты и шину. `assignJobs` — НЕ
 * система (job-assign), она вызывается в worldgen (2.16b) и в конвейер НЕ входит.
 *
 * Пример:
 * ```ts
 * const world = createSimWorld(42 as Seed);
 * worldgen(world);
 * const scheduler = createScheduler();
 * registerPhase2Systems(scheduler);
 * scheduler.run(world, TICKS_PER_DAY); // полный живой мир Фазы 2
 * ```
 */
export const PHASE2_SYSTEMS = [
  Weather,
  ArtifactSpawn,
  Needs,
  Perception,
  RobberyMemory,
  TaskSelection,
  Movement,
  TaskEffects,
  Trade,
  ArtifactSearch,
  Encounters,
  Animals,
  Economy,
  Export,
  PopulationInflux,
  MemoryDecay,
  Death,
] as const;

/**
 * Регистрирует все системы Фазы 2 в `scheduler` в каноническом порядке
 * (см. docblock: инвариант D-064, сохраняющий стыки D-032). Вызывается ОДИН раз
 * на свежем планировщике до первого тика. Порядок регистрации = порядок
 * исполнения на тике (закон №8) — не менять без согласования через sim-architect
 * (перестановка ломает причинность, закреплено тестом pipeline.test.ts).
 */
export function registerPhase2Systems(scheduler: Scheduler): void {
  for (const system of PHASE2_SYSTEMS) {
    scheduler.register(system);
  }
}
