/**
 * @module @zona/shared/contacts
 *
 * Контракт ЗАПИСИ КОНТАКТА восприятия (задача 1.7 → ретрофит 1.10a, D-023, D-030).
 * Чистый тип без зависимостей от bitecs/DOM/Node (закон №5): реализацию-производителя
 * знает `@zona/sim/systems/perception`, а потребители (`animals`, будущий `encounter`)
 * читают эту форму из «холодного» ResourceStore под ключом `'contacts'`.
 *
 * ── Что это ──────────────────────────────────────────────────────────────────
 * Perception (1.7) хранит для каждого наблюдателя ОТСОРТИРОВАННЫЙ ПО `target`
 * массив `Contact[]` — кого он сейчас видит (co-located + приближающиеся из
 * смежной локации). Раньше запись была голым `EntityId`; ретрофит 1.10a добавил
 * `spottedEvent`, чтобы реакции на контакт (бегство животного, будущий encounter)
 * могли сослаться на ПОРОДИВШЕЕ событие `perception/spotted` — линковка причинности
 * по конвенции D-030 «id причины в поле записи состояния», без скана лога.
 *
 * ── `spottedEvent` (D-030, resume-safe) ──────────────────────────────────────
 * Это ЧИСЛОВОЙ `EventId` того `perception/spotted`, что был опубликован в момент,
 * когда контакт стал НОВЫМ; `0` — «нет id» (запись без причины). Пока контакт
 * ДЕРЖИТСЯ (target остаётся видимым тик за тиком), `spottedEvent` СТАБИЛЕН — не
 * перештамповывается (id причины постоянен, пока держится контакт, D-030). Контакт
 * пропал и снова возник ⇒ новая запись с новым `spottedEvent`. Значение
 * ui32-совместимо (EventId >= 1; publish: ++eventSeq) и переживает save/load, т.к.
 * живёт в самой записи (ResourceStore сериализуется, D-013) — не в рантайме. Так
 * потребитель после resume читает тот же id, что и непрерывный прогон (закон №8).
 *
 * Пример:
 * ```ts
 * import type { Contact } from '@zona/shared';
 * const c: Contact = { target: 7 as EntityId, spottedEvent: 42 };
 * // 42 = id perception/spotted; consumer: move/departed.causedBy = c.spottedEvent.
 * ```
 */

import type { EntityId } from './ids';

/**
 * Одна запись видимого контакта наблюдателя. Массив таких записей (сорт. по
 * `target`) — значение ResourceStore под ключом `'contacts'` для наблюдателя.
 */
export interface Contact {
  /** eid видимой сущности (co-located или приближающейся). */
  readonly target: EntityId;
  /**
   * Числовой `EventId` породившего `perception/spotted` (стабилен, пока контакт
   * держится, D-030); `0` — причины нет. Consumer берёт его в `causedBy` реакции.
   */
  readonly spottedEvent: number;
}
