/**
 * @module @zona/sim/systems/rumors
 *
 * Система Rumors (задача 3.6, D-073) — ЗАМЫКАЕТ нарративный хребет Фазы 3: услышанное в
 * эфире РАСХОДИТСЯ МОЛВОЙ. Слух — УТВЕРЖДЕНИЕ о мире, а НЕ факт (GDD §8.2): слушатель
 * запоминает его СЛАБЕЕ личного наблюдения (isFirsthand=false), доверяет источнику
 * по-разному (друг/враг/незнакомец), а БОЛТЛИВЫЙ слушатель пересказывает дальше — с
 * ИСКАЖЕНИЕМ («двое»→«отряд»→«банда»). Rumors НЕ выдумывает событий (закон №1): она лишь
 * реагирует на уже прозвучавшие `radio/message`/`radio/relayed` — есть кому услышать,
 * рождается память и (может быть) пересказ; нет слушателей — тишина.
 *
 * ── ГЛАВНЫЙ ТЕСТ (закон №1) ───────────────────────────────────────────────────
 * Молва ходит БЕЗ игрока: сталкеры слышат чужие реплики в рацию, помнят их и болтают.
 * Игрок исчез — слухи всё равно расползаются по Зоне, обрастая небылицами. Ни спавна, ни
 * скрипта: система читает ФАКТ эфира в логе и пишет «холодную» память слушателей + эмитит
 * пересказы.
 *
 * ── РЕАКТИВ через шину, ОКНО каденции (закон №6, §5.1 «Rumors каждые 10 тиков») ─
 * `every: RUMOR_CADENCE` (10). За один проход на тике T обрабатывает ОКНО закоммиченных
 * тиков `[T − RUMOR_CADENCE .. T − 1]` (модель двух фаз D-005 — только зафиксированное
 * прошлое). Каденция = размер окна ⇒ идеальная плитка: run@10 читает [0..9], run@20 —
 * [10..19], … каждый тик читается РОВНО раз. Система НЕ зовёт другие системы (закон №6) —
 * реагирует на ФАКТ. Пересказ (`radio/relayed`) эмитится на тике T и попадёт в окно
 * СЛЕДУЮЩЕГО прогона (T+CADENCE) ⇒ лаг ≥1 тик, «запаздывающая картина» P4; в ТОМ ЖЕ окне
 * свой пересказ не перечитывается (окно не включает текущий тик) — петли нет.
 *
 * Для КАЖДОГО `radio/message`/`radio/relayed` в окне (говорящий S, локация вещания L):
 *  1. СЛЫШАЩИЕ (hearers): живые Human (`Human`+`Alive`+`Position`), стоящие в L ИЛИ в
 *     СОСЕДНЕЙ локации (граф MAP, `neighbors(L)`), КРОМЕ говорящего S. Детерминированно —
 *     `queryEntities` сорт. по eid (закон №8). Радиус «своя + соседние» даёт слуху
 *     географию: пересказ вещает уже из ЛОКАЦИИ ретранслятора, поэтому молва ползёт по карте.
 *  2. ПАМЯТЬ СЛУХА (замыкает D-058): каждый слышащий пишет `addMemory(hearer, {kind:'rumor',
 *     subject: главный субъект, isFirsthand:FALSE, salience: BASE_RUMOR_SALIENCE × trust,
 *     tick, causeEvent: messageId})`. `trust` = f(getRelation(hearer→S), factionReputation)
 *     (2.15) ∈ [0..1] (формула в balance/narrative, закон №7): друг → выше salience, враг →
 *     ниже, незнакомец → база. Слух СЛАБЕЕ личного (isFirsthand=false, salience×trust < 1).
 *  3. РЕТРАНСЛЯЦИЯ + ИСКАЖЕНИЕ (§8.2): слышащий с ВЫСОКОЙ болтливостью (`talkativeness >=
 *     RUMOR_RELAY_TALKATIVENESS`, D-071 — гейт `hasComponent(Personality)`) и не на потолке
 *     хопов (`hop < RUMOR_MAX_HOP`) эмитит `radio/relayed {speakerEid: relayer,
 *     sourceMessageId, hop: prevHop+1, templateId, params, isFirsthand:false}`,
 *     `causedBy = sourceMessageId`. ИСКАЖЕНИЕ детерминировано ЧИСТОЙ `fnv(sourceMessageId,
 *     relayerEid, hop)` (D-073, как выбор шаблона Radio D-070 — НЕ rng-поток): (а) `templateId`
 *     перекрашивается в ТОН РЕТРАНСЛЯТОРА с fnv-индексом (пересказ его словами); (б) `count`
 *     раздувается МОНОТОННО с хопом (масштаб преувеличивается); (в) `speaker`→ретранслятор.
 *     «кто»/«где» (`subject`/`loc`) стабильны — искажается масштаб и слова, не факт.
 *
 * ── ЧИСТОЕ ИСКАЖЕНИЕ (D-073, ключевой риск) ───────────────────────────────────
 * ВСЁ искажение — `fnv(sourceMessageId, relayerEid, hop)`: чистая функция СТАБИЛЬНЫХ id (как
 * fork-хеш core/rng), БЕЗ mutable rng-потока. ⇒ resume-safe (тот же source+relayer+hop → то
 * же искажение после save/load) и ПОРЯДКО-НЕЗАВИСИМО (не зависит от того, что ещё в окне).
 * count искажается КОМПАУНДОМ вдоль цепочки: пересказ берёт УЖЕ раздутый `count` источника и
 * добавляет ещё (`>= RUMOR_COUNT_MIN_GROWTH`) — монотонный рост хоп за хопом.
 *
 * ── read-time СТРОКА (закон №5) ────────────────────────────────────────────────
 * Строку слуха собирает `renderMessage(templateId, params)` (3.4) на чтении — params уже
 * искажены, строку система НЕ хранит (только `templateId + params`).
 *
 * ── ИЗОЛЯЦИЯ (батчинг 3.7) ─────────────────────────────────────────────────────
 * Rumors экспортируется как System, но в конвейер (registerPhase*Systems) в 3.6 НЕ
 * подключается — вместе с Chronicle/Radio её включат на 3.7 (батч сдвига голденов). На
 * текущем прогоне не гоняется ⇒ голдены Фазы 3 не двигаются (sim:100days fd0bec10, пустой мир
 * 481914ae). EconomyInvariant не затронут: `radio/relayed` массу/деньги не творит (закон №3),
 * `addMemory` двигает ключ 'memory' — дизъюнктный money/inventory.
 *
 * ```mermaid
 * flowchart TD
 *   WIN["ОКНО bus.at([T−CADENCE .. T−1])<br/>закоммиченные radio/message · radio/relayed"] --> LOOP{"для каждого сообщения M<br/>(говорящий S, loc L)"}
 *   LOOP --> HEAR["слышащие = живые Human в L ∪ neighbors(L),<br/>кроме S (queryEntities сорт. по eid)"]
 *   HEAR --> MEM["addMemory(hearer, isFirsthand:false,<br/>salience = BASE_RUMOR_SALIENCE × trust,<br/>causeEvent = M.id) — trust из relations (2.15)"]
 *   HEAR --> RELAY{"talkativeness >= порог<br/>И hop < RUMOR_MAX_HOP?"}
 *   RELAY -->|да| DIST["искажение fnv(M.id, relayer, hop+1):<br/>тон ретранслятора · count↑ · speaker=relayer"]
 *   DIST --> PUB["publish radio/relayed<br/>{speakerEid:relayer, sourceMessageId:M.id, hop+1, …}<br/>causedBy = M.id (D-030)"]
 *   RELAY -->|нет| SILENT["молчун / потолок хопов — слух дальше не идёт"]
 *   PUB -.след. окно T+CADENCE.-> WIN
 *   PUB -.read-time.-> RENDER["renderMessage(templateId, искажённые params) → строка слуха (3.4)"]
 * ```
 */

import type {
  EntityId,
  EventId,
  FactionId,
  LocationId,
  RadioMessageParams,
  Subject,
  Tick,
} from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { SimWorld } from '../core/world';
import { queryEntities, hasComponent } from '../core/ecs';
import { Position, Human, Alive, Personality, temperamentCode } from '../core/components';
import { neighbors, getTemplatePool } from '../data/index';
import { makeTemplateId, parseTemplateId } from '../narrative/render';
import { addMemory, entitySubject, getRelation, factionReputation } from './memory';
import {
  RUMOR_CADENCE,
  BASE_RUMOR_SALIENCE,
  RUMOR_TRUST_BASE,
  RUMOR_TRUST_SPREAD,
  RUMOR_FACTION_TRUST_WEIGHT,
  RUMOR_RELAY_TALKATIVENESS,
  RUMOR_MAX_HOP,
  RUMOR_COUNT_MIN_GROWTH,
  RUMOR_COUNT_GROWTH_SPREAD,
} from '../balance/narrative';

/** Типы сообщений эфира, которые расходятся слухом (вход системы). */
const RADIO_MESSAGE_TYPE = 'radio/message';
const RADIO_RELAYED_TYPE = 'radio/relayed';

/** Абстрактный id вида памяти-слуха (закон №10 — код оперирует id, D-058). */
const RUMOR_KIND = 'rumor';

/** Обязательный фолбэк-темперамент (совпадает с data/render — базовый пул есть всегда). */
const FALLBACK_TEMPERAMENT = 'neutral';

/** Ключ ResourceStore с наблюдаемой фракцией NPC (как worldgen/RobberyMemory, D-007). */
const FACTION_KEY = 'faction';

/** Типизированные SoA-колонки (как radio.ts): чтение состояния носителя O(1). */
const POS = Position as unknown as { readonly loc: Uint32Array };
const PERS = Personality as unknown as { readonly talkativeness: Float32Array };

// ── FNV-1a (часть хеш-АЛГОРИТМА искажения, НЕ баланс — как в radio.ts/rng.ts) ──
// Стандартные значения спецификации FNV-1a 32-бит, фиксированы определением функции
// (закон №7 касается баланса, не внутренностей хеша). Дают ЧИСТОЕ детерминированное
// искажение из стабильных id (sourceMessageId, relayerEid, hop) БЕЗ mutable rng-потока
// (D-073: resume-safe, порядко-независимо — в отличие от общего rng.fork с продвижением).
/** FNV-1a offset basis (32-бит). */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a prime (32-бит). */
const FNV_PRIME = 0x01000193;

/** FNV-1a хеш строки → uint32 (детерминирован, порядко-независим, закон №8). */
function fnv1a(label: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Кламп в [0..1] (шкала доверия/salience). */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Кламп в [−1..1] (шкала сигнала отношения). */
function clampSignal(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * ДОВЕРИЕ слушателя `hearer` к источнику `speaker` ∈ [0..1] (закон №7 — формула из
 * balance/narrative). `signal ∈ [−1..1]` = личное отношение (`getRelation`, 2.15) + поправка
 * фракционной репутации (`factionReputation`, 2.15) с весом `RUMOR_FACTION_TRUST_WEIGHT`;
 * `trust = clamp01(RUMOR_TRUST_BASE + RUMOR_TRUST_SPREAD × signal)`. Монотонно по отношению:
 * враг < незнакомец(база) < друг. Детерминировано, БЕЗ rng (закон №2).
 */
function trustOf(world: SimWorld, hearer: EntityId, speaker: EntityId): number {
  const personal = getRelation(world.resources, hearer, entitySubject(speaker));
  const speakerFaction = world.resources.get<FactionId>(FACTION_KEY, speaker);
  const faction =
    speakerFaction === undefined ? 0 : factionReputation(world.resources, hearer, speakerFaction);
  const signal = clampSignal(personal + RUMOR_FACTION_TRUST_WEIGHT * faction);
  return clamp01(RUMOR_TRUST_BASE + RUMOR_TRUST_SPREAD * signal);
}

/** Полезная нагрузка сообщения эфира (общая часть radio/message и radio/relayed). */
interface HeardMessage {
  readonly id: EventId;
  readonly speakerEid: EntityId;
  readonly subjects: readonly Subject[];
  readonly loc?: LocationId;
  readonly templateId: string;
  readonly params: RadioMessageParams;
  /** Хоп источника: 0 у первичного radio/message, >=1 у пересказа. */
  readonly hop: number;
}

/**
 * Приводит событие эфира к единой `HeardMessage`. `radio/message` — первичный слух (hop 0);
 * `radio/relayed` несёт свой `hop`. Иные типы система в окне игнорирует.
 */
function asHeard(ev: { readonly type: string; readonly id: EventId; readonly payload: unknown }): HeardMessage | undefined {
  if (ev.type === RADIO_MESSAGE_TYPE) {
    const p = ev.payload as {
      speakerEid: EntityId;
      subjects: readonly Subject[];
      loc?: LocationId;
      templateId: string;
      params: RadioMessageParams;
    };
    return { id: ev.id, speakerEid: p.speakerEid, subjects: p.subjects, loc: p.loc, templateId: p.templateId, params: p.params, hop: 0 };
  }
  if (ev.type === RADIO_RELAYED_TYPE) {
    const p = ev.payload as {
      speakerEid: EntityId;
      subjects: readonly Subject[];
      loc?: LocationId;
      templateId: string;
      params: RadioMessageParams;
      hop: number;
    };
    return { id: ev.id, speakerEid: p.speakerEid, subjects: p.subjects, loc: p.loc, templateId: p.templateId, params: p.params, hop: p.hop };
  }
  return undefined;
}

/**
 * СЛЫШАЩИЕ сообщение из локации `loc`: живые Human в `loc` ИЛИ смежной локации (граф MAP),
 * КРОМЕ говорящего `speaker`. `queryEntities` сорт. по eid ⇒ детерминированный порядок (№8).
 * `loc === undefined` (у слуха нет точки вещания) ⇒ слышать негде — пустой список.
 */
function findHearers(world: SimWorld, loc: LocationId | undefined, speaker: EntityId): readonly EntityId[] {
  if (loc === undefined) return [];
  const audible = new Set<number>([loc as number]);
  for (const n of neighbors(loc)) audible.add(n as number);
  const out: EntityId[] = [];
  for (const eid of queryEntities(world.ecs, [Human, Alive, Position])) {
    if (eid === speaker) continue;
    if (audible.has(POS.loc[eid as number] as number)) out.push(eid);
  }
  return out;
}

/**
 * ГЛАВНЫЙ СУБЪЕКТ слуха как `Subject` (о ком молва): `params.subject` (жертва/новичок), если
 * сообщение его несёт числом; иначе первый из отсортированных `subjects` (min-eid участник).
 * `undefined` только у вырожденного сообщения без участников (в контенте таких нет).
 */
function mainSubject(m: HeardMessage): Subject | undefined {
  const s = m.params.subject;
  if (typeof s === 'number') return entitySubject(s as EntityId);
  return m.subjects.length > 0 ? m.subjects[0] : undefined;
}

/** Болтливость носителя `eid` (гейт hasComponent — страховка reuse-eid, D-071); нет — 0. */
function talkativenessOf(world: SimWorld, eid: EntityId): number {
  if (!hasComponent(world.ecs, Personality, eid)) return 0;
  return PERS.talkativeness[eid as number] ?? 0;
}

/**
 * ИСКАЖЁННЫЕ `params` пересказа. Чистая `fnv(sourceMessageId, relayerEid, hop)`: `speaker`
 * становится ретранслятором; `count` (если есть) раздувается МОНОТОННО (`>= RUMOR_COUNT_MIN_GROWTH`
 * + fnv-разброс) — компаунд вдоль цепочки даёт «двое»→«отряд»→«банда» (§8.2). «кто»/«где»
 * (`subject`/`loc`/`item`) не трогаем (искажается масштаб и слова, не факт).
 */
function distortParams(source: HeardMessage, relayer: EntityId, hop: number): RadioMessageParams {
  const base: RadioMessageParams = { ...source.params, speaker: relayer };
  if (source.params.count === undefined) return base;
  const h = fnv1a(`${source.id}:${relayer}:${hop}`);
  const growth = RUMOR_COUNT_MIN_GROWTH + (h % RUMOR_COUNT_GROWTH_SPREAD);
  return { ...base, count: source.params.count + growth };
}

/**
 * ИСКАЖЁННЫЙ `templateId` пересказа: тип события ИЗ источника, тон РЕТРАНСЛЯТОРА
 * (`temperamentCode`, D-071 — пересказ его словами), индекс = `fnv(sourceMessageId, relayerEid,
 * hop) mod poolSize` (чистая, D-073). Пул под тон, откат на `'neutral'` (templateId кодирует
 * РЕАЛЬНО использованный тон — read-time рендер разрешит тот же пул). Нет пула/битый источник
 * ⇒ переносим `templateId` источника как есть (мягкая деградация, не throw).
 */
function distortTemplate(source: HeardMessage, relayer: EntityId, hop: number, world: SimWorld): string {
  const parsed = parseTemplateId(source.templateId);
  if (parsed === null) return source.templateId;
  const temperament = hasComponent(world.ecs, Personality, relayer)
    ? temperamentCode(relayer)
    : FALLBACK_TEMPERAMENT;
  let usedTemp: string = temperament;
  let pool = getTemplatePool(parsed.eventType, temperament);
  if (pool === undefined || pool.length === 0) {
    usedTemp = FALLBACK_TEMPERAMENT;
    pool = getTemplatePool(parsed.eventType, FALLBACK_TEMPERAMENT);
  }
  if (pool === undefined || pool.length === 0) return source.templateId; // тип не в контенте
  const index = fnv1a(`${source.id}:${relayer}:${hop}`) % pool.length;
  return makeTemplateId(parsed.eventType, usedTemp, index);
}

/**
 * Система Rumors (`every: RUMOR_CADENCE`). РЕАКТИВНО (окно `bus.at([T−CADENCE .. T−1])`, закон
 * №6) распространяет услышанный эфир: каждому слышащему в радиусе (loc + соседи) пишет память
 * слуха (isFirsthand=false, salience×trust), а болтливого слушателя заставляет пересказать с
 * искажением (`radio/relayed`, hop+1). No-op, если сообщений/слушателей в окне нет. НЕ в
 * конвейере до 3.7 (изоляция).
 */
export const Rumors: System = {
  name: 'Rumors',
  schedule: { every: RUMOR_CADENCE },
  update(ctx: SystemCtx): void {
    const { world, bus, tick } = ctx;

    // Нужно полное окно закоммиченного прошлого (D-005). До первого полного окна — no-op.
    if (tick < RUMOR_CADENCE) return;

    // ОКНО [T−CADENCE .. T−1] — плитка каденции, каждый тик читается РОВНО раз (по возрастанию).
    for (let t = (tick - RUMOR_CADENCE) as number; t < tick; t++) {
      for (const ev of bus.at(t as Tick)) {
        const m = asHeard(ev);
        if (m === undefined) continue; // не эфирное сообщение — мимо

        const hearers = findHearers(world, m.loc, m.speakerEid);
        if (hearers.length === 0) continue; // слышать некому — слух не рождается (закон №1)

        const subject = mainSubject(m);

        for (const hearer of hearers) {
          // 1. ПАМЯТЬ СЛУХА: слабее личного (isFirsthand=false), salience × доверие к источнику.
          // Через ЧИСТЫЙ хелпер memory.ts (2.15/D-058) — НОВЫМ отсортированным массивом (D-035),
          // без дублирования логики. `causeEvent = m.id` линкует слух на услышанное сообщение
          // (D-038): read-time раскрутка причин проследит слух → эфир → исходное событие.
          if (subject !== undefined) {
            addMemory(world.resources, hearer, {
              kind: RUMOR_KIND,
              subject,
              salience: BASE_RUMOR_SALIENCE * trustOf(world, hearer, m.speakerEid),
              tick: tick as number,
              causeEvent: m.id as number,
              isFirsthand: false,
            });
          }

          // 2. РЕТРАНСЛЯЦИЯ: болтун и не на потолке хопов пересказывает с искажением (§8.2).
          if (m.hop >= RUMOR_MAX_HOP) continue; // слух выдохся — дальше не идёт
          if (talkativenessOf(world, hearer) < RUMOR_RELAY_TALKATIVENESS) continue; // молчун молчит

          const relayLoc = POS.loc[hearer as number] as LocationId; // вещает из СВОЕЙ локации
          const nextHop = m.hop + 1;
          bus.publish({
            type: 'radio/relayed',
            causedBy: m.id,
            payload: {
              speakerEid: hearer,
              subjects: m.subjects,
              loc: relayLoc,
              sourceMessageId: m.id,
              hop: nextHop,
              templateId: distortTemplate(m, hearer, nextHop, world),
              params: distortParams(m, hearer, nextHop),
              isFirsthand: false,
            },
          });
        }
      }
    }
  },
};
