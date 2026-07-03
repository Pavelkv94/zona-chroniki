/**
 * @module @zona/sim/core/system
 *
 * Контракты `System` и `SystemCtx` — единица логики симуляции и контекст, с
 * которым планировщик (`core/scheduler.ts`, задача 0.2) её исполняет.
 *
 * Системы НЕ вызывают друг друга напрямую (закон №6): единственный вход —
 * `update(ctx)`, а общение идёт через ECS-компоненты (`ctx.world.ecs`) и шину
 * событий (`ctx.bus`). `SystemCtx` СОЗНАТЕЛЬНО не даёт ссылки ни на другую
 * систему, ни на планировщик — только на состояние мира, его шину и
 * персональный PRNG. Периодичность запуска описывается `SystemSchedule`
 * (условие `(t - phase) % every === 0` при `t >= phase`, задача 0.2).
 *
 * Контекст собирает планировщик заново на каждом запуске (см. scheduler.ts):
 *  - `world` — корневой контейнер состояния (ECS + ресурсы + tick + seed);
 *  - `bus`   — шина событий мира (`world.bus`), единственный канал общения
 *              помимо ECS-компонентов (закон №6, D-005);
 *  - `rng`   — ПЕРСОНАЛЬНЫЙ подпоток PRNG `world.rng.fork(`${name}@${tick}`)`
 *              (D-009): метка форка включает НОМЕР ТИКА, поэтому поток различается
 *              по тикам, но детерминирован от `(rootSeed, name, tick)`;
 *  - `tick`  — номер текущего тика (дубликат `world.tick` для удобства систем).
 *
 * Пример:
 * ```ts
 * const hunger: System = {
 *   name: 'hunger',
 *   schedule: { every: 10 },
 *   update(ctx) {
 *     const jitter = ctx.rng.range(0.9, 1.1);      // физиология (закон №2)
 *     ctx.bus.publish({ type: 'sim/tickStarted',   // общение через шину (№6)
 *       causedBy: null, payload: { tick: ctx.tick } });
 *   },
 * };
 * ```
 */

import type { SystemName, SystemSchedule, Tick } from '@zona/shared';
import type { SimWorld } from './world';
import type { EventBus } from './events';
import type { Rng } from './rng';

/**
 * Контекст, передаваемый системе на каждом запуске. Собирается планировщиком
 * заново каждый тик; система не хранит его между вызовами.
 */
export interface SystemCtx {
  /** Мир, над которым работает система (ECS + ресурсы + tick + seed). */
  readonly world: SimWorld;
  /**
   * Шина событий мира (`world.bus`). Единственный канал общения систем помимо
   * ECS-компонентов (закон №6, D-005). Продублирована в контексте, чтобы
   * система не тянула её через `world` вручную.
   */
  readonly bus: EventBus;
  /**
   * Персональный PRNG системы на ЭТОТ тик: `world.rng.fork(`${name}@${tick}`)`
   * (D-009). Метка включает номер тика, поэтому поток различается по тикам
   * (иначе первый `next()` повторялся бы каждый тик — скрытый недетерминизм),
   * оставаясь детерминированным от `(rootSeed, name, tick)`. Без состояния между
   * тиками, поэтому сериализация (0.5) не хранит per-system rng.
   */
  readonly rng: Rng;
  /** Номер текущего тика (дубликат `world.tick` для удобства систем). */
  readonly tick: Tick;
}

/**
 * Единица логики симуляции. Планировщик (0.2) вызывает `update` на тех тиках,
 * которые разрешает `schedule`, В ПОРЯДКЕ РЕГИСТРАЦИИ. `name` уникален и служит
 * меткой для `rng.fork` (D-009).
 */
export interface System {
  /** Уникальное имя системы (метка для детерминированного fork PRNG, D-009). */
  readonly name: SystemName;
  /** Когда система исполняется: `(t - phase) % every === 0` при `t >= phase`. */
  readonly schedule: SystemSchedule;
  /** Шаг логики. Единственная точка входа (закон №6). */
  update(ctx: SystemCtx): void;
}
