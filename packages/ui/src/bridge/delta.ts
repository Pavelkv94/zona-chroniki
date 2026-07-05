/**
 * @module @zona/ui/bridge/delta
 *
 * ЧИСТЫЙ дельта-дифф двух `WorldView` (задача 4.0, D-078). БЕЗ DOM/React/таймеров —
 * headless-тестируем в Vitest. Отделяет «что изменилось» от транспорта: воркер шлёт
 * `diffView(prev, next)` вместо полного снимка каждый тик (throttle + минимальный
 * трафик, D-078), а стор наблюдателя реконструирует состояние `applyDelta(prev, delta)`.
 *
 * ── ИНВАРИАНТ (закреплён тестом 4.0) ─────────────────────────────────────────
 *   applyDelta(prev, diffView(prev, next))  ===deep===  next
 * для любых `WorldView prev, next`. Именно он позволяет UI держать текущий `WorldView`
 * применением дельт, не гоняя полный снимок по `postMessage` (D-078).
 *
 * ── ЗАКОН №8 (детерминизм) ───────────────────────────────────────────────────
 * `changed` и итоговые `entities` сорт. по eid (как `exportWorldView`), `removed` —
 * тоже по возрастанию eid. Никакой итерации по Map без сортировки ключей: набор eid
 * строим из отсортированных массивов `WorldView.entities`.
 *
 * ── ЗАКОН №5 (граница) ───────────────────────────────────────────────────────
 * Зависит ТОЛЬКО от plain-типов `@zona/shared` (`WorldView`/`EntityView`/`ViewDelta`).
 * Ни одного импорта DOM/bitecs — модуль живёт в UI, но чист и тестируем в Node.
 */

import type { EntityId, EntityView, ViewDelta, WorldView } from '@zona/shared';

/**
 * Поля `EntityView`, по которым сравниваем «изменилась ли сущность». ЯВНЫЙ список
 * (а не `JSON.stringify`) — быстрее и устойчив к порядку ключей. `satisfies
 * readonly (keyof EntityView)[]` проверяет ВАЛИДНОСТЬ каждого ключа, но НЕ ПОЛНОТУ
 * списка: при APPEND-ONLY расширении `EntityView` новое поле сюда надо добавить
 * ВРУЧНУЮ, иначе его изменение станет невидимым для дельты (сущность «телепортнётся»
 * без события). ПОЛНОТУ стережёт рантайм-тест `delta.fields.test.ts` (сверяет ключи
 * реального снимка с этим списком) — при новом поле тест падает громко.
 */
const ENTITY_FIELDS = [
  'kind',
  'faction',
  'loc',
  'dest',
  'etaTicks',
  'hpFrac',
  'task',
  'inCombat',
  'carrying',
  'alive',
] as const satisfies readonly (keyof EntityView)[];

/** true, если два `EntityView` РАВНЫ по всем полям (eid уже совпал у вызывающего). */
function entityEquals(a: EntityView, b: EntityView): boolean {
  for (const f of ENTITY_FIELDS) {
    if (a[f] !== b[f]) return false;
  }
  return true;
}

/** Индекс `eid → EntityView` по массиву (сущности уникальны по eid в `WorldView`). */
function indexByEid(entities: readonly EntityView[]): Map<EntityId, EntityView> {
  const map = new Map<EntityId, EntityView>();
  for (const e of entities) map.set(e.eid, e);
  return map;
}

/** Пересчёт сводки населения по `kind` (производна от набора сущностей). */
function countPopulation(entities: readonly EntityView[]): WorldView['population'] {
  let humans = 0;
  let animals = 0;
  let corpses = 0;
  for (const e of entities) {
    if (e.kind === 'human') humans++;
    else if (e.kind === 'animal') animals++;
    else if (e.kind === 'corpse') corpses++;
  }
  return { humans, animals, corpses };
}

/**
 * Дельта `prev → next` (D-078). `prev === null` (первый снимок) ⇒ ВСЕ сущности `next`
 * — `changed`, `removed` пуст (воркер в этом случае обычно шлёт полный `view`, но дифф
 * от `null` корректен и для теста). Иначе:
 *  - `changed` — сущности `next`, которых НЕ было в `prev` ИЛИ отличающиеся хоть полем;
 *  - `removed` — eid, что были в `prev`, но исчезли в `next`.
 * Оба сорт. по eid (закон №8). Часы/погода — из `next`; `population` в дельту не входит
 * (производна, `applyDelta` пересчитает).
 */
export function diffView(prev: WorldView | null, next: WorldView): ViewDelta {
  const changed: EntityView[] = [];
  const removed: EntityId[] = [];

  if (prev === null) {
    // next.entities уже сорт. по eid (контракт exportWorldView) — копируем как есть.
    for (const e of next.entities) changed.push(e);
  } else {
    const prevMap = indexByEid(prev.entities);
    for (const e of next.entities) {
      const before = prevMap.get(e.eid);
      if (before === undefined || !entityEquals(before, e)) changed.push(e);
    }
    const nextMap = indexByEid(next.entities);
    for (const e of prev.entities) {
      if (!nextMap.has(e.eid)) removed.push(e.eid);
    }
    // prev.entities сорт. по eid ⇒ removed уже по возрастанию; changed собран из
    // сорт. next.entities ⇒ тоже по возрастанию. Явной пересортировки не требуется.
  }

  return {
    tick: next.tick,
    day: next.day,
    weather: next.weather,
    changed,
    removed,
  };
}

/**
 * Реконструкция `WorldView` из базового снимка `base` и дельты `delta` (D-078).
 * Применяет `removed` (убирает eid) и `changed` (вставляет/перезаписывает по eid),
 * сортирует итог по eid и ПЕРЕСЧИТЫВАЕТ `population` по `kind`. Часы/погода — из `delta`.
 * Инвариант: `applyDelta(prev, diffView(prev, next))` deep-equal `next`.
 */
export function applyDelta(base: WorldView, delta: ViewDelta): WorldView {
  const map = indexByEid(base.entities);
  for (const eid of delta.removed) map.delete(eid);
  for (const e of delta.changed) map.set(e.eid, e);

  const entities = [...map.values()].sort((a, b) => (a.eid as number) - (b.eid as number));

  return {
    day: delta.day,
    tick: delta.tick,
    weather: delta.weather,
    entities,
    population: countPopulation(entities),
  };
}
