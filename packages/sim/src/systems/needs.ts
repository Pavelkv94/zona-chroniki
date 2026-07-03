/**
 * @module @zona/sim/systems/needs
 *
 * Система Needs (задача 1.5, B.1) — физиология NPC: накопление голода/жажды/
 * усталости, затухание страха и урон истощения. КОРЕНЬ причинной цепочки мира
 * (закон №2): нужды растут из состояния тела, а не по «X% шанс», и порождают
 * события, на которые реагируют остальные системы (TaskSelection 1.8 читает
 * `needs/threshold`, Death 1.11 — падение `Health.hp`). Общение — только через
 * ECS-компоненты и шину с `causedBy` (закон №6).
 *
 * Имя системы — `'Needs'` (метка планировщика/форка rng, D-009). Оно не
 * конфликтует с ОДНОИМЁННЫМ компонентом `Needs`: планировщик различает системы
 * по строке `system.name`, а ECS — по идентичности объекта-компонента; это
 * разные пространства имён.
 *
 * ── Что делает система (только рост + затухание + урон, B.1) ──────────────────
 * Для каждого носителя `Needs` (детерминированный обход `queryEntities`, сорт. по
 * eid, закон №8):
 *  • НАКОПЛЕНИЕ: hunger/thirst/fatigue += ставка/тик из balance/needs, КЛАМП на
 *    `NEED_MAX` (потолок шкалы). Ставки разные (жажда острее голода) — «скорость
 *    жизни» задаёт balance, не эта система (закон №7).
 *  • ЗАТУХАНИЕ СТРАХА: fear -= `FEAR_DECAY_PER_TICK`, КЛАМП снизу на 0. Страх —
 *    единственная нужда, что УБЫВАЕТ здесь; его РОСТ (от угрозы) даёт Perception
 *    (1.7) — не в этой задаче.
 *  • ПОРОГИ: при ПЕРЕСЕЧЕНИИ критического порога ВВЕРХ (prev < crit && next >=
 *    crit) — публикуется `needs/threshold` РОВНО ОДИН раз. «Уже сообщено»
 *    отслеживается БЕЗ доп. поля: сравнением значения ДО и ПОСЛЕ накопления в
 *    этом тике (prev = значение прошлого тика). Пока нужда держится выше — prev
 *    уже >= crit, событие не повторяется; упала ниже и снова выросла — новое
 *    пересечение → новое событие. `causedBy: null` (физиология — корень, №2).
 *  • УРОН ИСТОЩЕНИЯ: hunger >= `HUNGER_CRITICAL` ⇒ hp -= `STARVATION_*`;
 *    thirst >= `THIRST_CRITICAL` ⇒ hp -= `DEHYDRATION_*` (каждый тик, пока выше).
 *    Урон пишется В `Health.hp` ТОЛЬКО носителям Health. Needs НЕ убивает и НЕ
 *    публикует `entity/died`: hp может уйти <= 0, снятие сущности/труп — задача
 *    Death (1.11). hp здесь не клампуется (Death читает уход в <= 0).
 *
 * Усталость имеет критический порог (`FATIGUE_CRITICAL`) → даёт `needs/threshold`,
 * но урона НЕ наносит (изнурённость валит с ног — это забота TaskSelection выбрать
 * сон, а не смерть от усталости). Урон — только голод и жажда.
 *
 * ── Чего система НЕ делает (границы задачи) ───────────────────────────────────
 * ВОССТАНОВЛЕНИЕ нужд (еда/питьё/сон) — не здесь: его применит исполнение задач
 * (TaskSelection 1.8). Регенерация здоровья (`HEALTH_REGEN_*` в balance) в 1.5
 * СОЗНАТЕЛЬНО не подключена — задача строго «рост + урон + затухание страха»; в
 * юнит-тестах нужды только растут, hp только убывает. Порог страха вверх система
 * не публикует (страх здесь лишь затухает) — это делает Perception (1.7).
 *
 * ── Детерминизм (закон №8) ────────────────────────────────────────────────────
 * rng НЕ используется: физиология здесь чисто арифметическая, без разброса
 * (закон №2 — случайность лишь там, где есть физический разброс, напр. выстрел).
 * Поля f32 округляются при записи в `Float32Array` ⇒ два прогона идентичны;
 * значения переживают save/load как обычные компоненты, поэтому resume после
 * deserialize продолжает накопление тождественно.
 */

import type { EntityId, EventId, NeedKind } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import { queryEntities, hasComponent } from '../core/ecs';
import { Needs as NeedsComponent, Health } from '../core/components';
import {
  HUNGER_PER_TICK,
  THIRST_PER_TICK,
  FATIGUE_PER_TICK,
  FEAR_DECAY_PER_TICK,
  HUNGER_CRITICAL,
  THIRST_CRITICAL,
  FATIGUE_CRITICAL,
  STARVATION_DAMAGE_PER_TICK,
  DEHYDRATION_DAMAGE_PER_TICK,
  NEED_MAX,
} from '../balance/needs';

/** Типизированные SoA-колонки `Needs` (все f32). */
const NEED = NeedsComponent as unknown as {
  readonly hunger: Float32Array;
  readonly thirst: Float32Array;
  readonly fatigue: Float32Array;
  readonly fear: Float32Array;
};
/** Типизированная колонка `Health.hp` (f32). */
const HP = Health as unknown as { readonly hp: Float32Array };

/** Значение, зажатое в отрезок [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Публикует `needs/threshold`, ЕСЛИ нужда пересекла критический порог ВВЕРХ на
 * этом тике: `prev < crit && next >= crit`. Одно сравнение значения ДО/ПОСЛЕ
 * накопления заменяет отдельный флаг «уже сообщено» — на следующем тике prev уже
 * >= crit, поэтому повторного события не будет, пока нужда не упадёт ниже и снова
 * не вырастет. `causedBy: null` — физиология корень цепочки (закон №2).
 */
function emitIfCrossed(
  bus: EventBus,
  eid: EntityId,
  need: NeedKind,
  prev: number,
  next: number,
  crit: number,
): void {
  if (prev < crit && next >= crit) {
    bus.publish({
      type: 'needs/threshold',
      causedBy: null,
      payload: { eid, need, level: 'critical' },
    });
  }
}

/**
 * Система Needs (`every: 1`). Обходит носителей `Needs` детерминированно и на
 * каждом тике: накапливает три нужды, затухает страх, публикует пересечения
 * порогов и наносит урон истощения носителям Health.
 */
export const Needs: System = {
  name: 'Needs',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const carriers = queryEntities(world.ecs, [NeedsComponent]);

    for (const eid of carriers) {
      // Значения ДО накопления (= прошлый тик): нужны для детекции пересечения.
      const hungerPrev = NEED.hunger[eid] as number;
      const thirstPrev = NEED.thirst[eid] as number;
      const fatiguePrev = NEED.fatigue[eid] as number;
      const fearPrev = NEED.fear[eid] as number;

      // НАКОПЛЕНИЕ (клампится на потолке шкалы) + ЗАТУХАНИЕ страха (клампится на 0).
      const hunger = clamp(hungerPrev + HUNGER_PER_TICK, 0, NEED_MAX);
      const thirst = clamp(thirstPrev + THIRST_PER_TICK, 0, NEED_MAX);
      const fatigue = clamp(fatiguePrev + FATIGUE_PER_TICK, 0, NEED_MAX);
      const fear = clamp(fearPrev - FEAR_DECAY_PER_TICK, 0, NEED_MAX);

      NEED.hunger[eid] = hunger;
      NEED.thirst[eid] = thirst;
      NEED.fatigue[eid] = fatigue;
      NEED.fear[eid] = fear;

      // ПОРОГИ: ровно одно событие на пересечение вверх (фикс. порядок нужд).
      // Читаем ОКРУГЛЁННЫЕ до f32 значения из колонок, чтобы детекция совпадала
      // с тем, что уйдёт в снапшот (детерминизм после resume, закон №8).
      emitIfCrossed(bus, eid, 'hunger', hungerPrev, NEED.hunger[eid] as number, HUNGER_CRITICAL);
      emitIfCrossed(bus, eid, 'thirst', thirstPrev, NEED.thirst[eid] as number, THIRST_CRITICAL);
      emitIfCrossed(bus, eid, 'fatigue', fatiguePrev, NEED.fatigue[eid] as number, FATIGUE_CRITICAL);

      // УРОН ИСТОЩЕНИЯ (только голод/жажда, только носителям Health). Не клампуем
      // hp снизу: уход в <= 0 — сигнал Death (1.11); Needs лишь пишет число.
      const starving = (NEED.hunger[eid] as number) >= HUNGER_CRITICAL;
      const dehydrated = (NEED.thirst[eid] as number) >= THIRST_CRITICAL;
      if ((starving || dehydrated) && hasComponent(world.ecs, Health, eid)) {
        let hp = HP.hp[eid] as number;
        if (starving) hp -= STARVATION_DAMAGE_PER_TICK;
        if (dehydrated) hp -= DEHYDRATION_DAMAGE_PER_TICK;
        HP.hp[eid] = hp;
      }
    }
  },
};
