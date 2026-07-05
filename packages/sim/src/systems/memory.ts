/**
 * @module @zona/sim/systems/memory
 *
 * ЧИСТЫЕ ХЕЛПЕРЫ памяти / отношений / обхода (задача 2.15, D-050/D-058) — СУБСТРАТ, на
 * котором будущие задачи строят поведение бандитов: 2.12 (ROB-решение читает отношение),
 * 2.13 (память ограбления + обход маршрута), TaskSelection (обход читает `isAvoided`).
 * Здесь — ТОЛЬКО чтение/запись «холодных» ключей ResourceStore; сам ВЫБОР задач и запись
 * памяти на конкретные события (ограбление) реализуют те задачи, а не этот модуль.
 *
 * Все функции ДЕТЕРМИНИРОВАНЫ (закон №8): массивы держатся ОТСОРТИРОВАННЫМИ, запись идёт
 * НОВЫМ массивом (D-035, не мутация in-place — изоляция ссылок), rng не участвует. Общение
 * — только через ResourceStore (закон №6): хелперы никого не зовут и событий не публикуют
 * (память меняет состояние; события об ограблении/встрече публикуют системы-вызыватели,
 * а их id кладётся в `MemoryRecord.causeEvent`, конвенция D-038).
 *
 * ── СУБЪЕКТ как строковый ключ (D-050) ────────────────────────────────────────
 * Память и отношения адресуют субъекта единым сортируемым `Subject`: `entitySubject(eid)`
 * → `"e:<eid>"`, `factionSubject(faction)` → `"f:<faction>"`. Однородная строка (а не
 * `EntityId | FactionId`) даёт стабильную сортировку массивов (закон №8).
 *
 * ── Фракционная репутация — DERIVED (не хранится) ─────────────────────────────
 * `factionReputation(eid, faction)` НЕ хранит отдельного числа: это АГРЕГАТ (среднее) над
 * `relations` NPC — прямое отношение к самой фракции (`f:<faction>`) плюс отношения к
 * известным сущностям этой фракции (их `'faction'` в ResourceStore == faction). Так
 * репутация выводится из уже записанных отношений (как цена DERIVED из склада, D-047).
 */

import type { EntityId, FactionId, MemoryRecord, RelationEntry, AvoidEntry } from '@zona/shared';
import type { ResourceStore } from '../core/world';
import {
  MEMORY_INITIAL_SALIENCE,
  RELATION_MIN,
  RELATION_MAX,
} from '../balance/social';

/** Ключи «холодного» ResourceStore памяти/отношений/обхода (D-050, на eid NPC). */
export const MEMORY_KEY = 'memory';
export const RELATIONS_KEY = 'relations';
export const AVOID_KEY = 'avoidLoc';

// ── Субъект: кодировка/декодировка единого сортируемого ключа ─────────────────

/** Субъект-сущность: `"e:<eid>"`. */
export function entitySubject(eid: EntityId): string {
  return `e:${eid}`;
}

/** Субъект-фракция: `"f:<factionId>"`. Фракция — id из /sim/data (без `':'`, закон №10). */
export function factionSubject(faction: FactionId): string {
  return `f:${faction}`;
}

/** Разбор субъекта обратно в сущность/фракцию (для агрегатов/летописи). */
export function parseSubject(
  subject: string,
): { readonly kind: 'entity'; readonly eid: EntityId } | { readonly kind: 'faction'; readonly faction: FactionId } {
  const rest = subject.slice(2);
  if (subject.startsWith('e:')) return { kind: 'entity', eid: Number(rest) as EntityId };
  return { kind: 'faction', faction: rest as FactionId };
}

// ── Детерминированный порядок памяти (закон №8) ───────────────────────────────
//
// Полный порядок по (subject, kind, isFirsthand, tick, causeEvent, salience) — так prune
// и сериализация воспроизводимы независимо от порядка добавления записей. `isFirsthand`
// поднят перед tick, чтобы соседствовать с КЛЮЧОМ КОНСОЛИДАЦИИ (kind, subject, isFirsthand,
// см. addMemory) — упорядочивание согласовано с семантикой «один факт = одна запись».
function compareMemory(a: MemoryRecord, b: MemoryRecord): number {
  if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.isFirsthand !== b.isFirsthand) return a.isFirsthand ? -1 : 1;
  if (a.tick !== b.tick) return a.tick - b.tick;
  if (a.causeEvent !== b.causeEvent) return a.causeEvent - b.causeEvent;
  return a.salience - b.salience;
}

function clampSalience(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRelation(v: number): number {
  return v < RELATION_MIN ? RELATION_MIN : v > RELATION_MAX ? RELATION_MAX : v;
}

// ── ПАМЯТЬ ────────────────────────────────────────────────────────────────────

/** Все записи памяти NPC (сорт.); `[]`, если памяти нет. */
export function getMemory(resources: ResourceStore, eid: EntityId): readonly MemoryRecord[] {
  return resources.get<readonly MemoryRecord[]>(MEMORY_KEY, eid) ?? [];
}

// ── КОНСОЛИДАЦИЯ памяти по ФАКТУ (задача 3.8, D-075) ──────────────────────────
//
// Запись памяти адресует ФАКТ о мире: `kind` (вид знания) о `subject` (о ком), полученный
// ЛИЧНО или с чужих слов (`isFirsthand`). NPC держит РОВНО ОДНУ запись на такой факт, а не
// тысячи копий: повторное подкрепление (тот же слух ещё раз, повторный грабёж тем же
// грабителем) НЕ аппендит новую запись, а ОСВЕЖАЕТ существующую. Это одновременно:
//  • СЕМАНТИЧЕСКИ вернее (NPC помнит «банда у Свалки», а не 10 000 раз одно и то же);
//  • структурно ОГРАНИЧИВАЕТ массив памяти числом РАЗЛИЧНЫХ фактов (мало) — снимает
//    квадрат `addMemory` (append+sort) на плотном хабе слухов (перф-катастрофа 3.7, D-074).
//
// КЛЮЧ КОНСОЛИДАЦИИ — (`kind`, `subject`, `isFirsthand`). `isFirsthand` ВХОДИТ в ключ
// НАМЕРЕННО: слух (`isFirsthand=false`, слабее и МОЖЕТ БЫТЬ ЛОЖНЫМ) НЕ сливается с личным
// наблюдением того же факта и не может им притвориться (закон поведения: «isFirsthand=false
// слабее»). Firsthand-память (RobberyMemory 2.13, `kind:'robbed'`) консолидируется тем же
// правилом консистентно: повторный грабёж тем же грабителем освежает одну запись «меня
// грабил X» (отношение/обход двигаются ОТДЕЛЬНО в RobberyMemory и по-прежнему накапливаются).
//
// СЛИЯНИЕ (`mergeMemory`) КОММУТАТИВНО и ПОРЯДКО-НЕЗАВИСИМО (закон №8, resume-safe): все три
// поля берутся max-ом от вклада, поэтому итог не зависит ни от порядка `addMemory`-вызовов,
// ни от save/load посередине: salience = MAX (подкрепление УСИЛИВАЕТ, не ослабляет), tick =
// MAX (самое свежее подкрепление — освежает возраст против prune MemoryDecay), causeEvent —
// от записи с бОльшим tick (свежайшая причина; при равенстве tick — больший causeEvent, тоже
// max/коммутативно). rng не участвует (закон №2).
function mergeMemory(a: MemoryRecord, b: MemoryRecord): MemoryRecord {
  const tick = a.tick >= b.tick ? a.tick : b.tick;
  const causeEvent =
    a.tick > b.tick
      ? a.causeEvent
      : b.tick > a.tick
        ? b.causeEvent
        : a.causeEvent >= b.causeEvent
          ? a.causeEvent
          : b.causeEvent;
  return {
    kind: a.kind,
    subject: a.subject,
    isFirsthand: a.isFirsthand,
    salience: a.salience >= b.salience ? a.salience : b.salience,
    tick,
    causeEvent,
  };
}

/**
 * Добавляет/ОСВЕЖАЕТ запись памяти NPC `eid` НОВЫМ отсортированным массивом (D-035/№8). Поля
 * `salience`/`isFirsthand` опциональны (по умолчанию `MEMORY_INITIAL_SALIENCE` / `true`);
 * `salience` клампится в [0..1].
 *
 * КОНСОЛИДАЦИЯ ПО ФАКТУ (D-075): если у NPC уже есть запись с тем же (`kind`, `subject`,
 * `isFirsthand`), новая НЕ добавляется отдельно — существующая ОСВЕЖАЕТСЯ (`mergeMemory`:
 * salience/tick — max, causeEvent — свежайшая причина). Так NPC хранит одну обновляемую
 * память о факте, а не тысячи копий (структурный + семантический фикс перф-квадрата 3.7).
 * Слияние коммутативно ⇒ детерминизм/resume не зависят от порядка вставок (закон №8).
 */
export function addMemory(
  resources: ResourceStore,
  eid: EntityId,
  record: {
    readonly kind: string;
    readonly subject: string;
    readonly tick: number;
    readonly causeEvent: number;
    readonly salience?: number;
    readonly isFirsthand?: boolean;
  },
): void {
  const incoming: MemoryRecord = {
    kind: record.kind,
    subject: record.subject,
    salience: clampSalience(record.salience ?? MEMORY_INITIAL_SALIENCE),
    tick: record.tick,
    causeEvent: record.causeEvent,
    isFirsthand: record.isFirsthand ?? true,
  };
  // Консолидация по (kind, subject, isFirsthand): осветить существующий факт ИЛИ добавить
  // новый. Обход O(m) по ОГРАНИЧЕННОМУ числу различных фактов (после фикса m мал) — суммарно
  // линейно, без квадрата растущего массива. НОВЫЙ массив (D-035), пересорт (закон №8).
  const cur = getMemory(resources, eid);
  const next: MemoryRecord[] = [];
  let merged = false;
  for (const r of cur) {
    if (r.kind === incoming.kind && r.subject === incoming.subject && r.isFirsthand === incoming.isFirsthand) {
      next.push(mergeMemory(r, incoming));
      merged = true;
    } else {
      next.push(r);
    }
  }
  if (!merged) next.push(incoming);
  next.sort(compareMemory);
  resources.set<readonly MemoryRecord[]>(MEMORY_KEY, eid, next);
}

// ── ОТНОШЕНИЯ ─────────────────────────────────────────────────────────────────

/** Все отношения NPC (сорт. по subject); `[]`, если отношений нет. */
export function getRelations(resources: ResourceStore, eid: EntityId): readonly RelationEntry[] {
  return resources.get<readonly RelationEntry[]>(RELATIONS_KEY, eid) ?? [];
}

/** Отношение NPC `eid` к `subject`; `0` (нейтрал), если записи нет. */
export function getRelation(resources: ResourceStore, eid: EntityId, subject: string): number {
  for (const [s, v] of getRelations(resources, eid)) if (s === subject) return v;
  return 0;
}

/**
 * Устанавливает отношение NPC `eid` к `subject` (клампится в [−1..1]) НОВЫМ отсортированным
 * массивом (D-035/№8). Ровно `0` (нейтрал) — запись УДАЛЯЕТСЯ (нейтрал не хранится, D-050);
 * почти-нейтральные значения коллапсирует к 0 система MemoryDecay по эпсилону (D-058).
 */
export function setRelation(resources: ResourceStore, eid: EntityId, subject: string, value: number): void {
  const clamped = clampRelation(value);
  const cur = getRelations(resources, eid);
  const next: RelationEntry[] = [];
  let placed = false;
  for (const entry of cur) {
    if (entry[0] === subject) {
      if (clamped !== 0) next.push([subject, clamped]);
      placed = true;
    } else {
      next.push(entry);
    }
  }
  if (!placed && clamped !== 0) next.push([subject, clamped]);
  next.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (next.length === 0) resources.delete(RELATIONS_KEY, eid);
  else resources.set<readonly RelationEntry[]>(RELATIONS_KEY, eid, next);
}

/** Сдвигает отношение NPC `eid` к `subject` на `delta` (текущее + delta, кламп в [−1..1]). */
export function adjustRelation(resources: ResourceStore, eid: EntityId, subject: string, delta: number): void {
  setRelation(resources, eid, subject, getRelation(resources, eid, subject) + delta);
}

/**
 * DERIVED фракционная репутация NPC `eid` к фракции `faction` — СРЕДНЕЕ над отношениями:
 * прямое отношение к самой фракции (`f:<faction>`) + отношения к известным сущностям этой
 * фракции (их `'faction'` в ResourceStore == faction). `0` (нейтрал), если вкладов нет.
 * Детерминировано: обход отсортированного `relations`, без rng.
 */
export function factionReputation(resources: ResourceStore, eid: EntityId, faction: FactionId): number {
  let sum = 0;
  let count = 0;
  const target = factionSubject(faction);
  for (const [subject, value] of getRelations(resources, eid)) {
    if (subject === target) {
      sum += value;
      count++;
      continue;
    }
    const parsed = parseSubject(subject);
    if (parsed.kind === 'entity' && resources.get<FactionId>('faction', parsed.eid) === faction) {
      sum += value;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

// ── ОБХОД ЛОКАЦИЙ ─────────────────────────────────────────────────────────────

/** Все записи обхода NPC (сорт. по loc); `[]`, если обходов нет. */
export function getAvoids(resources: ResourceStore, eid: EntityId): readonly AvoidEntry[] {
  return resources.get<readonly AvoidEntry[]>(AVOID_KEY, eid) ?? [];
}

/**
 * Помечает локацию `loc` обходимой NPC `eid` до тика `untilTick` НОВЫМ отсортированным
 * массивом (D-035/№8). Повторная пометка той же `loc` ПРОДЛЕВАЕТ до максимального
 * `untilTick` (обход не сокращается более ранней записью). Читает TaskSelection (обход
 * маршрута), пишет 2.13 (после ограбления).
 */
export function addAvoid(resources: ResourceStore, eid: EntityId, loc: number, untilTick: number): void {
  const cur = getAvoids(resources, eid);
  const next: AvoidEntry[] = [];
  let placed = false;
  for (const [l, until] of cur) {
    if (l === loc) {
      next.push([loc, until > untilTick ? until : untilTick]);
      placed = true;
    } else {
      next.push([l, until]);
    }
  }
  if (!placed) next.push([loc, untilTick]);
  next.sort((a, b) => a[0] - b[0]);
  resources.set<readonly AvoidEntry[]>(AVOID_KEY, eid, next);
}

/** true, если NPC `eid` обходит `loc` на тике `tick` (есть незапёкшая запись `untilTick > tick`). */
export function isAvoided(resources: ResourceStore, eid: EntityId, loc: number, tick: number): boolean {
  for (const [l, until] of getAvoids(resources, eid)) if (l === loc) return until > tick;
  return false;
}
