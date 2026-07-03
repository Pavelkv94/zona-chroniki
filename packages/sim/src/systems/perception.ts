/**
 * @module @zona/sim/systems/perception
 *
 * Система Perception (задача 1.7, B.1, D-023) — видимость внутри локации и подъём
 * страха от близкой угрозы. Строит для каждой сущности список ВИДИМЫХ контактов и
 * публикует `perception/spotted` на КАЖДЫЙ новый контакт; параллельно поднимает
 * `Needs.fear` тем, рядом с кем стоит агрессивное животное. Общение — только через
 * ECS-компоненты, «холодный» ResourceStore и шину с `causedBy` (закон №6): другие
 * системы Perception напрямую не зовёт (TaskSelection 1.8/Encounter 1.10 читают
 * `contacts` и реагируют на `spotted`/`fear`).
 *
 * ── Партиция по локации (D-023, бюджет 1.6 мс — D-006) ───────────────────────
 * Наивное «каждый видит каждого» — O(N²) по всему миру. Вместо этого носители
 * `Position` РАСКЛАДЫВАЮТСЯ ПО БАКЕТАМ локаций: контакт возможен ТОЛЬКО внутри
 * своей локации (co-located) или со смежной, чья цель — наша локация («замечен на
 * подходе»). Сравнения идут ВНУТРИ бакета (+ бакеты соседей), поэтому стоимость —
 * O(Σ бакет²) ≪ O(N²): сущности из НЕ-смежных локаций никогда не сравниваются.
 * Обход детерминирован (закон №8): бакеты заполняются обходом `queryEntities`
 * (сорт. по eid ⇒ каждый бакет уже отсортирован), локации-ключи обходятся по
 * возрастанию, контакты и события упорядочены по eid.
 *
 * ── Контакты (COLD в ResourceStore, D-023) ───────────────────────────────────
 * Для каждой сущности контакт = ОТСОРТИРОВАННЫЙ массив eid: все ДРУГИЕ co-located
 * (та же `loc`) + сущности из СМЕЖНОЙ локации, идущие сюда (`Position.dest === loc`
 * наблюдателя — приближаются). Пишется `world.resources.set('contacts', eid, …)`.
 * Контакты пишутся КАЖДЫЙ тик для КАЖДОГО носителя Position (в т.ч. пустой `[]`):
 * store всегда отражает текущий тик, поэтому переживает save/load тождественно
 * (иначе устаревший контакт «залип» бы в store — рассинхрон resume, закон №8).
 *
 * ── perception/spotted РОВНО на новый контакт (resume-безопасно, закон №8) ────
 * `spotted` публикуется, только когда `target` ПОЯВИЛСЯ в `contacts[observer]`,
 * которого НЕ было на прошлом тике. «Прошлый тик» берётся ИЗ ResourceStore
 * (`resources.get('contacts', observer)` ДО перезаписи) — НЕ из рантайм-Set.
 * Именно поэтому детекция переживает snapshot: предыдущие контакты СЕРИАЛИЗУЮТСЯ
 * вместе с ResourceStore, и первый тик после load сравнивается с восстановленным
 * прошлым — дубля `spotted` на границе save/load не возникает (прямой аналог того,
 * как Needs 1.5 детектит пересечение порога по prev-значению поля, а не по флагу).
 * Контакт пропал и снова возник ⇒ снова «новый» ⇒ новое событие. `causedBy` —
 * последнее релевантное `move/*` наблюдателя ИЛИ цели из лога (движение свело их
 * в поле зрения), либо `null`.
 *
 * ── Страх от угрозы (закон №2, ставка из balance — закон №7) ──────────────────
 * Если рядом (co-located) есть УГРОЗА — `Needs.fear` носителя растёт на
 * `FEAR_FROM_THREAT_PER_TICK`, клампится на `NEED_MAX`. Угроза Фазы 1 = co-located
 * `Animal` НЕпугливого вида (`getSpecies(species).flees === false` ⇒ кабан;
 * пугливый олень угрозой НЕ считается). Только носители `Needs`. Страх ПОДНИМАЕТ
 * лишь эта система; ЗАТУХАНИЕ — Needs (1.5): вместе рождают эмерджентное «страшно,
 * пока зверь рядом» без флага (ставка подъёма > ставки затухания, balance/needs).
 *
 * rng НЕ используется: восприятие детерминировано (замечаем ВСЕХ co-located, без
 * «X% заметить» — закон №2; случайность только у физического разброса, напр.
 * выстрела). Тайминг в системе не мерится (D-006).
 */

import type { EntityId, EventId, LocationId } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import { queryEntities, hasComponent } from '../core/ecs';
import { Position, Needs, Animal } from '../core/components';
import { neighbors, getSpecies } from '../data/index';
import { FEAR_FROM_THREAT_PER_TICK, NEED_MAX } from '../balance/needs';

/** Ключ ResourceStore, под которым живут контакты (COLD, сериализуется, D-023). */
const CONTACTS_KEY = 'contacts';

/** Типизированные SoA-колонки `Position` (loc/dest — ui32). */
const POS = Position as unknown as {
  readonly loc: Uint32Array;
  readonly dest: Uint32Array;
};
/** Типизированная колонка `Needs.fear` (f32) — Perception только поднимает её. */
const NEED = Needs as unknown as { readonly fear: Float32Array };
/** Типизированная колонка `Animal.species` (ui8) — код вида для getSpecies. */
const ANIM = Animal as unknown as { readonly species: Uint8Array };

/** Значение, зажатое в отрезок [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * true, если `eid` — угроза: несёт `Animal` НЕпугливого вида (кабан,
 * `flees === false`). Пугливые (олень) и не-животные (люди — Фаза 2) — не угроза.
 */
function isThreat(world: SystemCtx['world'], eid: EntityId): boolean {
  if (!hasComponent(world.ecs, Animal, eid)) return false;
  return getSpecies(ANIM.species[eid] as number).flees === false;
}

/**
 * id последнего релевантного `move/departed`/`move/arrived` для `observer` или
 * `target` в append-only логе (движение, сведшее их в поле зрения). Скан с конца
 * → первое совпадение = самое свежее. Лог сериализуется ⇒ причина resume-стабильна
 * (id событий переживают save/load, C-4). Нет — `null` (никого не двигало).
 */
function spottedCause(bus: EventBus, observer: EntityId, target: EntityId): EventId | null {
  const log = bus.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const ev = log[i];
    if (ev === undefined) continue;
    if (ev.type !== 'move/departed' && ev.type !== 'move/arrived') continue;
    const mover = (ev.payload as { readonly eid: EntityId }).eid;
    if (mover === observer || mover === target) return ev.id;
  }
  return null;
}

/**
 * Сливает два ОТСОРТИРОВАННЫХ по возрастанию, НЕПЕРЕСЕКАЮЩИХСЯ списка eid в один
 * сортированный, ИСКЛЮЧАЯ `self` (наблюдатель себя не видит). `coLocated` и
 * `approaching` в разных локациях, поэтому пересечений нет — обычный merge.
 */
function mergeContacts(
  coLocated: readonly EntityId[],
  self: EntityId,
  approaching: readonly EntityId[],
): EntityId[] {
  const out: EntityId[] = [];
  let i = 0;
  let j = 0;
  while (i < coLocated.length || j < approaching.length) {
    const a = i < coLocated.length ? (coLocated[i] as EntityId) : undefined;
    const b = j < approaching.length ? (approaching[j] as EntityId) : undefined;
    if (a !== undefined && (b === undefined || a < b)) {
      if (a !== self) out.push(a);
      i++;
    } else {
      // b определён (иначе цикл бы завершился) и b <= a
      out.push(b as EntityId);
      j++;
    }
  }
  return out;
}

/**
 * Публикует `perception/spotted` для КАЖДОГО eid, что есть в `current`, но НЕ в
 * `prev` — новые контакты этого тика. Оба массива отсортированы по возрастанию ⇒
 * идём двумя указателями (без Set, без аллокаций), выдавая новых в порядке eid.
 */
function emitNewContacts(
  bus: EventBus,
  observer: EntityId,
  loc: number,
  prev: readonly EntityId[],
  current: readonly EntityId[],
): void {
  let i = 0;
  let j = 0;
  while (i < current.length) {
    const cur = current[i] as EntityId;
    const p = j < prev.length ? (prev[j] as EntityId) : undefined;
    if (p !== undefined && p < cur) {
      j++; // контакт из прошлого, которого уже нет в current — пропускаем
    } else if (p === cur) {
      i++; // контакт держится с прошлого тика — не новый
      j++;
    } else {
      // p === undefined или p > cur ⇒ cur отсутствовал в prev ⇒ НОВЫЙ контакт.
      bus.publish({
        type: 'perception/spotted',
        causedBy: spottedCause(bus, observer, cur),
        payload: { observer, target: cur, loc: loc as LocationId },
      });
      i++;
    }
  }
}

/**
 * Система Perception (`every: 1`). Партиционирует носителей Position по локациям,
 * для каждого строит отсортированные контакты (co-located + приближающиеся из
 * смежных), публикует `spotted` на новые контакты (сравнивая с прошлым тиком из
 * ResourceStore) и поднимает страх рядом с угрозой. Детерминизм — из сортировки
 * eid/локаций (закон №8); n² ограничен размером бакета (D-023).
 */
export const Perception: System = {
  name: 'Perception',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus } = ctx;
    const carriers = queryEntities(world.ecs, [Position]);

    // ── ПАРТИЦИЯ: раскладываем носителей по бакетам локаций. Обход carriers —
    // по возрастанию eid (queryEntities сортирует), поэтому каждый бакет уже
    // отсортирован по eid без доп. сортировки (закон №8).
    const buckets = new Map<number, EntityId[]>();
    for (const eid of carriers) {
      const loc = POS.loc[eid] as number;
      let bucket = buckets.get(loc);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(loc, bucket);
      }
      bucket.push(eid);
    }

    // Локации обходим по возрастанию ключа — детерминизм порядка событий (№8).
    const locs = Array.from(buckets.keys()).sort((a, b) => a - b);

    for (const loc of locs) {
      const bucket = buckets.get(loc) as EntityId[];

      // ── ПРИБЛИЖАЮЩИЕСЯ: из смежных локаций те, чей dest — наша loc. n² ограничен
      // бакетом: сканируем только бакеты СОСЕДЕЙ (не всю карту). neighbors —
      // отсортированы; внутри бакета eid отсортированы; итог сортируем (соседи
      // дают eid не в общем порядке).
      const approaching: EntityId[] = [];
      for (const nloc of neighbors(loc as LocationId)) {
        const nb = buckets.get(nloc);
        if (nb === undefined) continue;
        for (const other of nb) {
          if ((POS.dest[other] as number) === loc) approaching.push(other);
        }
      }
      approaching.sort((a, b) => a - b);

      // ── УГРОЗА В БАКЕТЕ: есть ли co-located кабан (для подъёма страха).
      // Считаем один раз на бакет; для конкретного носителя исключаем его самого.
      let threatCount = 0;
      for (const e of bucket) if (isThreat(world, e)) threatCount++;

      for (const observer of bucket) {
        // Текущие контакты: co-located (бакет без себя) + приближающиеся, сорт.
        const current = mergeContacts(bucket, observer, approaching);

        // ПРЕДЫДУЩИЕ контакты — из ResourceStore (сериализуемы ⇒ resume-безопасно),
        // читаем ДО перезаписи. Нет записи (новый носитель/первый тик) ⇒ пусто.
        const prev = world.resources.get<EntityId[]>(CONTACTS_KEY, observer) ?? [];

        // Публикуем spotted на КАЖДЫЙ новый контакт (current \ prev), затем
        // перезаписываем store текущим срезом (в т.ч. пустым — синхрон с тиком).
        emitNewContacts(bus, observer, loc, prev, current);
        world.resources.set(CONTACTS_KEY, observer, current);

        // СТРАХ: co-located угроза, ОТЛИЧНАЯ от самого наблюдателя, поднимает fear.
        if (hasComponent(world.ecs, Needs, observer)) {
          const threatNear = threatCount - (isThreat(world, observer) ? 1 : 0) > 0;
          if (threatNear) {
            NEED.fear[observer] = clamp(
              (NEED.fear[observer] as number) + FEAR_FROM_THREAT_PER_TICK,
              0,
              NEED_MAX,
            );
          }
        }
      }
    }
  },
};
