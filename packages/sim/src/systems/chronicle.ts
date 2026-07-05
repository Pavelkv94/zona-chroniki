/**
 * @module @zona/sim/systems/chronicle
 *
 * Система Chronicle (задача 3.2, D-068) — ЛЕТОПИСЬ МИРА: персистентная запись ЗНАЧИМЫХ
 * событий БЕЗ отдельного хранилища. Летопись = read-time фильтр append-only лога по типу
 * `chronicle/recorded` (хелпер `chronicle(bus)`), а не второй стор состояния. Chronicle лишь
 * ПОМЕЧАЕТ значимые события записью-событием в тот же лог — «День N: …» собирается на чтении.
 *
 * ── ГЛАВНЫЙ ТЕСТ (закон №1) ───────────────────────────────────────────────────
 * Летопись пишется БЕЗ игрока: значимость — свойство события мира (смерть, бой, гибель
 * поселения), а не реакция на наблюдателя. Игрок исчез — мир всё равно ведёт хронику своих
 * драм. Порог значимости ПРИЧИНЕН (закон №2): `significance(ev, world)` выводится из состояния
 * (тип события + известность участников), без rng и «X% попасть в летопись».
 *
 * ── РЕАКТИВ через шину (закон №6, как RobberyMemory D-063) ─────────────────────
 * `every: 1`, читает ТОЛЬКО ЗАКОММИЧЕННЫЙ прошлый тик `bus.at(tick−1)` (модель двух фаз D-005):
 * события тика T обрабатываются РОВНО раз — на тике T+1. Система НЕ зовёт другие системы и не
 * знает их арифметики — реагирует на ФАКТ в логе. Для каждого события прошлого тика:
 *  1. `sig = significance(ev, world)` (чистая функция 3.1/D-067).
 *  2. Если `sig >= CHRONICLE_THRESHOLD` (balance/narrative, закон №7) — эмит
 *     `chronicle/recorded { eventId, day, significance, kind, subjects, loc?, templateId? }` с
 *     `causedBy = ev.id` (значимое событие есть причина своей записи, D-030). `day` = из tick
 *     (TICKS_PER_DAY). `subjects` — участники события (`participantsOf`, 3.1), закодированные
 *     `Subject` (memory.ts 2.15), отсортированы+уникальны (детерминизм, закон №8).
 *  3. fame-петля (D-067): на КАЖДОГО eid-субъекта `incFame(resources, eid, FAME_PER_CHRONICLE)`
 *     — каузальный шаг «внесён в летопись → известнее». Это ЗАПУСКАЕТ обратную связь §10.2:
 *     будущая значимость событий этого субъекта (особенно смерти) поднимается лифтом по fame.
 *
 * ── НЕТ ПЕТЛИ ЗАПИСЕЙ ──────────────────────────────────────────────────────────
 * `chronicle/recorded` — неизвестный значимости тип ⇒ `significance` даёт `UNKNOWN_WEIGHT` (0.0)
 * < порога: своя запись НЕ порождает запись о записи. Явный гейт `ev.type === 'chronicle/recorded'`
 * страхует это структурно (не полагаемся только на вес).
 *
 * ── READ-TIME ЛЕТОПИСЬ (не хранить, resume-safe автоматически) ─────────────────
 * `chronicle(bus)` = фильтр лога по `chronicle/recorded` (лог уже сорт. по id ⇒ по времени).
 * `unrollCauses(bus, id)` раскручивает причинную цепочку назад (`causedBy`) для экспорта/UI
 * (§10.1 «раскрутка причин»). Обход read-time (bus.log/findLast), НЕ на тике — состояния
 * летопись не держит ⇒ save/load ≡ непрерывный прогон без спец-логики (закон №8).
 *
 * ── ПОДКЛЮЧЕНА В КОНВЕЙЕР (3.7, D-074) ────────────────────────────────────────
 * Chronicle включена в единый конвейер Фазы 3 (registerPhase3Systems: … Radio → Rumors →
 * Chronicle → Death) вместе с Radio 3.5 / Rumors 3.6 — ЗАПУСТИВ fame-петлю §10.2 (incFame
 * субъектам → значимость их будущих событий выше). Голдены ЗАКОННО сдвинулись: sim:100days
 * fd0bec10 → 561cc138, day1 seed42 3c54d141 → f554331d. Пустой мир 481914ae цел (нет значимых
 * событий ⇒ no-op). EconomyInvariant не затронут (запись массу/деньги не творит; incFame двигает
 * ключ 'fame', дизъюнктный money/inventory, D-067). fame — вход ТОЛЬКО significance() (нет обратной
 * связи в физику ⇒ мир поведенчески тот же). ПЕРФ-ФЛАГ D-074 — балансовый; логику 3.7 НЕ трогала.
 *
 * ```mermaid
 * flowchart TD
 *   PREV["bus.at(tick−1)<br/>закоммиченные события"] --> LOOP{"для каждого ev"}
 *   LOOP --> SIG["significance(ev, world) (3.1)"]
 *   SIG -->|"< CHRONICLE_THRESHOLD"| SKIP["пропуск (рутина)"]
 *   SIG -->|">= CHRONICLE_THRESHOLD"| REC["publish chronicle/recorded<br/>causedBy = ev.id"]
 *   REC --> FAME["incFame(subject, FAME_PER_CHRONICLE)<br/>обратная связь §10.2"]
 *   REC -.read-time.-> CHR["chronicle(bus) — летопись"]
 *   REC -.read-time.-> UNR["unrollCauses(bus, id) — цепочка причин"]
 * ```
 */

import type { EntityId, EventId, LocationId, SimEvent, Subject, Tick } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { EventBus } from '../core/events';
import { significance, participantsOf, incFame } from '../narrative/significance';
import { entitySubject } from './memory';
import { CHRONICLE_THRESHOLD, FAME_PER_CHRONICLE } from '../balance/narrative';
import { TICKS_PER_DAY } from '../balance/time';

/** Тип летописной записи-события (страж от петли «запись о записи»). */
const CHRONICLE_KIND = 'chronicle/recorded';

/**
 * Read-time представление одной строки летописи. Собирается из события `chronicle/recorded`
 * (НЕ хранится отдельно): `recordId`/`tick` — сама запись, остальное — её payload. UI/экспорт
 * рендерит «День {day}: …» по `kind` + `subjects` (+ Radio 3.5 подставит `templateId`).
 */
export interface ChronicleEntry {
  /** id события-записи `chronicle/recorded` (для unrollCauses/дедупа). */
  readonly recordId: EventId;
  /** id ЗНАЧИМОГО события-первопричины (== causedBy записи). */
  readonly eventId: EventId;
  /** Тик, на котором сделана запись (T+1 относительно значимого события). */
  readonly tick: Tick;
  /** День значимого события (`floor(tick / TICKS_PER_DAY)`, 0-based). */
  readonly day: number;
  /** Оценка значимости ∈ [0..1] на момент записи. */
  readonly significance: number;
  /** Тип исходного значимого события (`ev.type`). */
  readonly kind: string;
  /** Участники записи (закодированные `Subject`, сорт.+уникальны). */
  readonly subjects: readonly Subject[];
  /** Локация исходного события, если оно её несёт. */
  readonly loc?: LocationId;
  /** id выбранного шаблона летописной строки (ставит Radio 3.5; в 3.2 опущен). */
  readonly templateId?: string;
}

/**
 * Локация исходного события, если payload её несёт (для `chronicle/recorded.loc`). Многие
 * значимые события пространственны (бой/поселение/грабёж/прибытие); `entity/died` — нет
 * (труп-локацию несёт парное `corpse/created`), тогда `undefined` (поле опускается).
 */
function locOf(ev: SimEvent): LocationId | undefined {
  switch (ev.type) {
    case 'encounter/started':
    case 'artifact/spawned':
    case 'artifact/collected':
    case 'loot/transferred':
    case 'corpse/created':
    case 'animal/born':
    case 'perception/spotted':
    case 'population/arrived':
      return ev.payload.loc;
    case 'move/arrived':
      return ev.payload.at;
    default:
      return undefined;
  }
}

/**
 * Уникальные отсортированные eid-субъекты события (детерминизм + идемпотентный fame-инкремент:
 * один eid в записи — одно упоминание). Источник участников — `participantsOf` (3.1), единый
 * для значимости и летописи.
 */
function subjectEids(ev: SimEvent): readonly EntityId[] {
  const seen = new Set<EntityId>();
  for (const eid of participantsOf(ev)) seen.add(eid);
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Система Chronicle (`every: 1`). РЕАКТИВНО (bus.at(tick−1), закон №6) метит значимые события
 * прошлого тика записью `chronicle/recorded` и поднимает `fame` их субъектам (петля §10.2).
 * No-op, если значимых событий в окне нет. НЕ в конвейере до 3.7 (изоляция).
 */
export const Chronicle: System = {
  name: 'Chronicle',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus, tick } = ctx;

    // Читаем ТОЛЬКО закоммиченный прошлый тик (модель двух фаз D-005): на тике 0 пусто.
    if (tick <= 0) return;
    const events = bus.at((tick - 1) as Tick); // сорт. по id (детерминизм, закон №8)

    for (const ev of events) {
      // Страж от петли: собственная запись не порождает запись о записи (вес и так 0 < порога).
      if (ev.type === CHRONICLE_KIND) continue;

      const sig = significance(ev, world);
      if (sig < CHRONICLE_THRESHOLD) continue; // рутина — мимо летописи

      const eids = subjectEids(ev);
      const subjects: readonly Subject[] = eids.map(entitySubject);
      const day = Math.floor((ev.tick as number) / TICKS_PER_DAY);
      const loc = locOf(ev);

      // Запись летописи: причина = само значимое событие (D-030). `loc` опускаем, если его нет.
      bus.publish({
        type: 'chronicle/recorded',
        causedBy: ev.id as EventId,
        payload:
          loc === undefined
            ? { eventId: ev.id as EventId, day, significance: sig, kind: ev.type, subjects }
            : { eventId: ev.id as EventId, day, significance: sig, kind: ev.type, subjects, loc },
      });

      // fame-петля (D-067): каждый субъект стал известнее ⇒ его будущая значимость выше (§10.2).
      for (const eid of eids) incFame(world.resources, eid, FAME_PER_CHRONICLE);
    }
  },
};

// ══ READ-TIME ЛЕТОПИСЬ (не хранить состояние — resume-safe автоматически) ══════

/**
 * ЛЕТОПИСЬ как read-time проекция лога (D-068): все `chronicle/recorded` в порядке id (= по
 * времени, лог append-only). НЕ хранит отдельного стора ⇒ save/load ≡ непрерывный прогон
 * автоматически (закон №8). Для экспорта в текст/UI: каждой записи — `unrollCauses` для
 * причинной цепочки (§10.1). Пустой лог / нет значимых событий ⇒ `[]`.
 */
export function chronicle(bus: EventBus): readonly ChronicleEntry[] {
  const out: ChronicleEntry[] = [];
  for (const ev of bus.log) {
    if (ev.type !== 'chronicle/recorded') continue;
    const p = ev.payload;
    out.push({
      recordId: ev.id,
      eventId: p.eventId,
      tick: ev.tick,
      day: p.day,
      significance: p.significance,
      kind: p.kind,
      subjects: p.subjects,
      ...(p.loc === undefined ? {} : { loc: p.loc }),
      ...(p.templateId === undefined ? {} : { templateId: p.templateId }),
    });
  }
  return out;
}

/**
 * РАСКРУТКА причинной цепочки события `eventId` назад по `causedBy` (§10.1 «раскрутка причин
 * назад»): `[eventId, причина, причина-причины, …]` до корня (`causedBy === null`) или до
 * события, которого нет в логе (оборвано). READ-TIME обход (bus.log/findLast), НЕ на тике —
 * для экспорта летописи/инспектора. Ограничен длиной лога (id причины строго меньше id
 * следствия ⇒ прогресс гарантирован, циклов нет). Не найден стартовый id ⇒ `[]`.
 */
export function unrollCauses(bus: EventBus, eventId: EventId): readonly EventId[] {
  const chain: EventId[] = [];
  let current: EventId | null = eventId;
  const guard = bus.log.length + 1; // причинность строго убывает по id — верхняя граница длины
  for (let steps = 0; current !== null && steps < guard; steps++) {
    const cur: EventId = current;
    const ev = bus.findLast((e) => e.id === cur); // id уникален (C-4) ⇒ ровно то событие
    if (ev === undefined) break; // причина вне лога (напр. сгоревший id после discardTick)
    chain.push(ev.id);
    current = ev.causedBy;
  }
  return chain;
}
