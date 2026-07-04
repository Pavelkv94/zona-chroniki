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
