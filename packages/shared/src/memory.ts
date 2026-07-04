/**
 * @module @zona/shared/memory
 *
 * Контракт ПАМЯТИ / ОТНОШЕНИЙ / ОБХОДА NPC (задача 2.15, D-050 → уточнение D-058).
 * Чистые типы без зависимостей от bitecs/DOM/Node (закон №5): производитель/потребитель —
 * `@zona/sim/systems/memory` (хелперы) и `@zona/sim/systems/memory-decay` (затухание),
 * а форму читают все пакеты монорепо (narrative — летопись/слухи, ui — инспектор NPC).
 *
 * Три «холодных» ключа ResourceStore на eid NPC (plain JSON, сорт. массивы, D-007/D-013,
 * НЕ SoA — как inventory/money по D-046):
 *  - `'memory'`    → `MemoryRecord[]` — что NPC помнит (ограбления, помощь, встречи…);
 *  - `'relations'` → `RelationEntry[]` — отношение NPC к субъектам (eid/фракция);
 *  - `'avoidLoc'`  → `AvoidEntry[]` — локации, которые NPC обходит до `untilTick`.
 *
 * ── СУБЪЕКТ (`Subject`) — единый сортируемый ключ (закон №8) ──────────────────
 * И память, и отношения адресуют «кого это касается» через `Subject` — СТРОКУ с
 * префиксом типа: сущность → `"e:<eid>"`, фракция → `"f:<factionId>"`. Один строковый
 * тип (а не разнородный `EntityId | FactionId`) даёт ОДНОРОДНУЮ сортировку массивов
 * (UTF-16, детерминизм), как inventory сорт. по `item`. Кодировку/декодировку делают
 * чистые хелперы `entitySubject`/`factionSubject`/`parseSubject` в `@zona/sim/systems/memory`
 * (shared держит только форму, как `Contact` без конструкторов). Фракция — строковый id
 * из /sim/data (закон №10), поэтому `':'` в id фракций не используется (валидатор данных).
 *
 * ── ПРИЧИННОСТЬ ЗАПИСИ (`causeEvent`, конвенция D-038/D-030) ──────────────────
 * Каждая `MemoryRecord` несёт `causeEvent` — числовой `EventId` события, ПОРОДИВШЕГО
 * память (ограбление `encounter/resolved`, встреча `perception/spotted`…): линковка
 * причины «id в поле записи состояния», без скана лога. `0` — причины нет (например
 * затравочная память worldgen). Значение переживает save/load (запись сериализуется,
 * D-013) — не рантайм-ссылка. Отношения меняются ТОЛЬКО через события памяти (закон
 * причинности поведения): 2.12/2.13 пишут `MemoryRecord` и двигают `relations` вместе.
 *
 * ── ЗАТУХАНИЕ (система MemoryDecay, D-058) ────────────────────────────────────
 * `salience` записи ДЕТЕРМИНИРОВАННО убывает со временем (чистая функция tick, без rng)
 * и запись выбрасывается, когда `salience` падает ниже порога ИЛИ возраст превысил
 * ~60 дней. `relations.value` затухает к нейтралу (0). `avoidLoc` чистит истёкшие
 * (`untilTick <= tick`). Константы — `@zona/sim/balance/social` (закон №7).
 *
 * Пример:
 * ```ts
 * import type { MemoryRecord } from '@zona/shared';
 * const m: MemoryRecord = {
 *   kind: 'robbed', subject: 'e:7', salience: 1, tick: 1440,
 *   causeEvent: 42, isFirsthand: true,
 * };
 * ```
 */

/**
 * Адресат памяти/отношения — СТРОКА с префиксом типа: `"e:<eid>"` (сущность) или
 * `"f:<factionId>"` (фракция). Единый сортируемый ключ (закон №8); кодировку делают
 * хелперы `entitySubject`/`factionSubject` (@zona/sim/systems/memory).
 */
export type Subject = string;

/**
 * ОДНА запись памяти NPC (значение массива под ключом `'memory'`, сорт.).
 *
 * `kind`       — абстрактный id вида памяти (`'robbed'`/`'helped'`/`'seen'`…) из
 *                пространства поведения (закон №10: код оперирует id, не семантикой);
 * `subject`    — кого касается (`Subject`: eid/фракция);
 * `salience`   — сила памяти в [0..1]: 1 = свежая/яркая, затухает к 0; ниже порога
 *                забвения запись выбрасывается (MemoryDecay, D-058);
 * `tick`       — тик записи памяти (нужен затуханию по ВОЗРАСТУ: старше ~60 дней → prune);
 * `causeEvent` — числовой `EventId` события-причины (D-038); `0` — причины нет;
 * `isFirsthand`— `true`: воспринято ЛИЧНО (Perception/бой) — достоверно; `false`: СЛУХ
 *                (радио/чужой рассказ) — СЛАБЕЕ и МОЖЕТ БЫТЬ ЛОЖНЫМ (seam для 2.x-слухов).
 */
export interface MemoryRecord {
  readonly kind: string;
  readonly subject: Subject;
  readonly salience: number;
  readonly tick: number;
  readonly causeEvent: number;
  readonly isFirsthand: boolean;
}

/**
 * Одна запись отношения (значение массива под ключом `'relations'`, сорт. по `subject`).
 * `value` — в [-1..1]: −1 враг, 0 нейтрал, +1 союзник. Затухает к 0 (MemoryDecay). Нейтрал
 * (0) НЕ хранится (пустая запись = нейтрал по умолчанию), поэтому массив держит только
 * ненулевые отношения. Форма — плоский кортеж `[subject, value]` (как `[eid,value]` D-050).
 */
export type RelationEntry = readonly [subject: Subject, value: number];

/**
 * Одна запись обхода (значение массива под ключом `'avoidLoc'`, сорт. по `loc`). NPC
 * ОБХОДИТ локацию `loc` до тика `untilTick` (после — запись истекла и чистится MemoryDecay).
 * `loc` — числовой `LocationId`; `untilTick` — абсолютный тик. Форма — плоский кортеж
 * `[loc, untilTick]` (D-050). Пишет 2.13 (память ограбления → обход маршрута), читает TaskSelection.
 */
export type AvoidEntry = readonly [loc: number, untilTick: number];
