/**
 * @module @zona/sim/systems/radio
 *
 * Система Radio (задача 3.5, D-070) — СЕРДЦЕ МИРА (GDD §8.1): значимые события мира
 * ОЗВУЧИВАЮТСЯ в эфир их НАБЛЮДАТЕЛЯМИ. Сообщение = событие + наблюдатель + окраска
 * характером говорящего. Radio НЕ выдумывает событий (закон №1): она лишь реагирует на
 * ФАКТ в логе — если есть кому говорить, звучит реплика; нет наблюдателя — тишина (которая
 * в драматургии боя тоже сообщение).
 *
 * ── ГЛАВНЫЙ ТЕСТ (закон №1) ───────────────────────────────────────────────────
 * Эфир пишется БЕЗ игрока: сталкеры комментируют в рацию то, что видят сами. Игрок исчез —
 * мир всё равно переговаривается о своих драмах. Сообщение эмитится ТОЛЬКО при живом
 * Human-наблюдателе в локации события; наблюдателя нет ⇒ сообщения нет (некому в эфир).
 *
 * ── РЕАКТИВ через шину (закон №6, как Chronicle D-068 / RobberyMemory D-063) ───
 * `every:1`, читает ТОЛЬКО ЗАКОММИЧЕННЫЙ прошлый тик `bus.at(tick−1)` (модель двух фаз D-005):
 * события тика T обрабатываются РОВНО раз — на T+1. Система НЕ зовёт другие системы напрямую
 * и не знает их арифметики. Для каждого события прошлого тика:
 *  1. `sig = significance(ev, world)` (чистая функция 3.1/D-067); `sig < RADIO_THRESHOLD` — мимо.
 *  2. ВЫБОР ГОВОРЯЩЕГО (причинно+детерминированно, закон №2/№8): говорящий — ЖИВОЙ Human,
 *     co-located в ЛОКАЦИИ события (реально мог видеть — присутствие в loc), НЕ являющийся
 *     жертвой (для смерти — свидетель, не покойник). Дедуп — МИН-eid такой человек
 *     (`queryEntities` сорт. по eid ⇒ первый match = минимальный). Нет такого ⇒ сообщения нет.
 *  3. ПОМЕХИ ПОГОДОЙ (§8.1): если текущая погода среды глушит эфир (`RADIO_JAMMING_WEATHER`,
 *     закон №7 — гроза) — сообщение ТЕРЯЕТСЯ (не эмитится). Детерминировано из состояния
 *     Weather (WorldClock.weather), НЕ rng (закон №8). Политика «потеря, а не искажение»:
 *     искажение услышанного — забота Rumors 3.6; первичный эфир под грозой просто не проходит.
 *  4. ВЫБОР ШАБЛОНА (D-069/D-070, seeded БЕЗ rng-потока): `temperament = temperamentCode(speaker)`
 *     (тон говорящего, D-071 — гейт `hasComponent(Personality)` для страховки от reuse-eid);
 *     `index = fnv(eventId, speakerEid) mod poolSize` — ЧИСТАЯ функция стабильных id (как fork-хеш
 *     rng.ts): resume-safe и ПОРЯДКО-НЕЗАВИСИМА. НЕ общий rng.fork с потоком (D-070 — иначе порядок
 *     значим/resume хрупок). `templateId = "<eventType>|<temperament>|<index>"` (makeTemplateId).
 *  5. `params` (для renderMessage 3.4): speaker=наблюдатель, subject=жертва/новичок (если тип его
 *     несёт), loc, count=размер вражеской стороны (для боя), item (для находки). СТРОКУ НЕ храним
 *     (закон №5) — только `templateId + params`; plain-строку соберёт read-time рендер.
 *  6. Эмит `radio/message { speakerEid, subjects, loc, templateId, params, isFirsthand: true }`,
 *     `causedBy = ev.id` (D-030). `isFirsthand=true` (лично воспринято) — сид для Rumors 3.6,
 *     где ретрансляция даст `false`.
 *
 * ── НЕТ ПЕТЛИ ЭФИРА ────────────────────────────────────────────────────────────
 * `radio/message` — неизвестный значимости тип ⇒ `significance` даёт `UNKNOWN_WEIGHT` (0.0) <
 * порога: собственная реплика НЕ порождает реплику о реплике. Явный страж `ev.type ===
 * 'radio/message'` (и `'chronicle/recorded'`) дублирует это структурно.
 *
 * ── ВЫБОР ЛОКАЦИИ СОБЫТИЯ ───────────────────────────────────────────────────────
 * Многие события несут `loc` в payload (бой/находка/грабёж/прибытие). Те, что не несут
 * (`entity/died`, `encounter/resolved`, `settlement/abandoned`), локацию ВЫВОДЯТ из `Position`
 * участника: труп покойника/поле боя/сущность-поселение стоят на своей локации — там и
 * наблюдатели. Нет ни payload-loc, ни участника с Position (напр. разрешение боя без потерь) ⇒
 * локация неопределима ⇒ наблюдатель не ищется ⇒ тишина (редкий бескровный исход менее драматичен).
 *
 * ── ИЗОЛЯЦИЯ (батчинг 3.7) ─────────────────────────────────────────────────────
 * Radio экспортируется как System, но в конвейер (registerPhase*Systems) в 3.5 НЕ подключается —
 * вместе с Chronicle 3.2 / Rumors 3.6 её включат на 3.7 (батч сдвига голденов). На текущем
 * прогоне не гоняется ⇒ голдены Фазы 3 не двигаются (sim:100days fd0bec10, пустой мир 481914ae);
 * EconomyInvariant не затронут (radio/message массу/деньги не творит, закон №3).
 *
 * ```mermaid
 * flowchart TD
 *   PREV["bus.at(tick−1)<br/>закоммиченные события (D-005)"] --> LOOP{"для каждого ev<br/>(кроме radio/message, chronicle/recorded)"}
 *   LOOP --> SIG["significance(ev, world) (3.1)"]
 *   SIG -->|"< RADIO_THRESHOLD"| SKIP1["пропуск (рутина)"]
 *   SIG -->|">= RADIO_THRESHOLD"| LOC["локация события<br/>(payload.loc | Position участника)"]
 *   LOC -->|нет| SKIP2["тишина (некуда/некому)"]
 *   LOC --> SPK["min-eid живой Human в loc,<br/>НЕ жертва (queryEntities сорт.)"]
 *   SPK -->|нет наблюдателя| SKIP3["тишина (закон №1)"]
 *   SPK --> JAM{"погода глушит?<br/>RADIO_JAMMING_WEATHER"}
 *   JAM -->|да (гроза)| LOST["потеря (помехи §8.1)"]
 *   JAM -->|нет| TPL["temperament = temperamentCode(speaker) (D-071)<br/>index = fnv(eventId, speakerEid) mod poolSize (D-070)"]
 *   TPL --> PUB["publish radio/message<br/>{speakerEid, subjects, loc, templateId, params, isFirsthand:true}<br/>causedBy = ev.id (D-030)"]
 *   PUB -.read-time.-> RENDER["renderMessage(templateId, params) → строка эфира (3.4)"]
 * ```
 */

import type { EntityId, EventId, LocationId, SimEvent, Subject, Tick } from '@zona/shared';
import type { System, SystemCtx } from '../core/system';
import type { SimWorld } from '../core/world';
import type { MessageParams } from '../narrative/render';
import { queryEntities, hasComponent } from '../core/ecs';
import {
  Position,
  Human,
  Alive,
  Personality,
  WorldClock,
  WEATHER_CODE,
  temperamentCode,
} from '../core/components';
import { significance, participantsOf } from '../narrative/significance';
import { entitySubject } from './memory';
import { makeTemplateId } from '../narrative/render';
import { getTemplatePool } from '../data/index';
import { RADIO_THRESHOLD, RADIO_JAMMING_WEATHER } from '../balance/narrative';

/** Собственные нарративные типы: их эфир не переозвучивает (страж от петли, дубль веса 0). */
const RADIO_MESSAGE_TYPE = 'radio/message';
const CHRONICLE_RECORDED_TYPE = 'chronicle/recorded';

/** Обязательный фолбэк-темперамент (совпадает с data/render — базовый пул есть всегда). */
const FALLBACK_TEMPERAMENT = 'neutral';

/** Типизированная SoA-колонка `Position.loc` (ui32) — локация носителя. */
const POS = Position as unknown as { readonly loc: Uint32Array };
/** Типизированная SoA-колонка `WorldClock.weather` (ui8) — код текущей погоды среды. */
const CLOCK = WorldClock as unknown as { readonly weather: Uint8Array };

// ── Константы FNV-1a (часть хеш-АЛГОРИТМА выбора шаблона, НЕ баланс) ────────────
// Как в core/rng.ts (fork): FNV-1a 32-бит offset basis + prime — стандартные значения
// спецификации FNV, фиксированы определением функции, тюнингу не подлежат (закон №7
// касается баланса, не внутренностей хеша). Даём ЧИСТЫЙ детерминированный индекс шаблона
// из стабильных id (eventId, speakerEid) БЕЗ mutable rng-потока (D-070: resume-safe,
// порядко-независимо — в отличие от общего rng.fork с продвижением состояния).
/** FNV-1a offset basis (32-бит). */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a prime (32-бит). */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a хеш строки → uint32 (детерминирован, не зависит от порядка коллекций, закон №8).
 * Идентичен `fnv1a` в core/rng.ts, но локален: Radio самодостаточна и не тянет приватную
 * функцию ядра. Используется ТОЛЬКО для чистого выбора индекса шаблона.
 */
function fnv1a(label: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * ЧИСТЫЙ индекс шаблона в пуле размера `poolSize` из стабильной пары (eventId, speakerEid)
 * (D-070). Тот же eventId+speaker → тот же index на ЛЮБОМ прогоне и после resume (не зависит
 * от порядка обработки и от mutable rng-потока). `poolSize > 0` гарантирует вызывающий.
 */
function templateIndex(eventId: EventId, speakerEid: EntityId, poolSize: number): number {
  return fnv1a(`${eventId}:${speakerEid}`) % poolSize;
}

/** Погода `weatherCode` глушит эфир? (коды из RADIO_JAMMING_WEATHER, закон №7). */
function isJammingWeather(weatherCode: number): boolean {
  for (const w of RADIO_JAMMING_WEATHER) {
    if (WEATHER_CODE[w as keyof typeof WEATHER_CODE] === weatherCode) return true;
  }
  return false;
}

/**
 * Текущая погода среды (singleton WorldClock, D-019). Погода — ГЛОБАЛЬНОЕ состояние среды
 * (не per-location), поэтому глушилка действует по всему миру, пока гроза бушует. Нет носителя
 * WorldClock (мир ещё не сгенерирован / синтетический тест без часов) ⇒ `undefined` (не глушим).
 */
function currentWeather(world: SimWorld): number | undefined {
  const clocks = queryEntities(world.ecs, [WorldClock]);
  if (clocks.length === 0) return undefined;
  return CLOCK.weather[clocks[0] as number] as number;
}

/**
 * Локация события: payload-loc, если событие её несёт (бой/находка/грабёж/прибытие); иначе
 * ВЫВОДИМ из `Position` первого участника с координатой (труп покойника/поле боя/поселение
 * стоят на своей локации). Нет ни того, ни другого ⇒ `undefined` (наблюдатель не ищется).
 */
function eventLoc(world: SimWorld, ev: SimEvent): LocationId | undefined {
  const direct = directLoc(ev);
  if (direct !== undefined) return direct;
  for (const eid of participantsOf(ev)) {
    if (hasComponent(world.ecs, Position, eid)) return POS.loc[eid] as LocationId;
  }
  return undefined;
}

/** Локация из payload, если тип события её несёт (иначе undefined — выведем из участника). */
function directLoc(ev: SimEvent): LocationId | undefined {
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
 * eid'ы, которые НЕ могут говорить об этом событии — жертвы/выбывшие (для смерти говорит
 * СВИДЕТЕЛЬ, не покойник). Мёртвые уже теряют тег `Alive` (Death 1.11), но исключаем явно
 * ради устойчивости и синтетических тестов (где жертва может остаться Alive).
 */
function nonSpeakers(ev: SimEvent): ReadonlySet<EntityId> {
  switch (ev.type) {
    case 'entity/died':
    case 'corpse/created':
      return new Set([ev.payload.eid]);
    case 'encounter/resolved':
      return new Set(ev.payload.casualties);
    default:
      return new Set();
  }
}

/**
 * ГОВОРЯЩИЙ: МИН-eid ЖИВОЙ Human в локации `loc`, не входящий в `exclude` (жертвы).
 * `queryEntities` сорт. по eid ⇒ первый подходящий = минимальный (детерминизм дедупа, №8).
 * Нет такого ⇒ `undefined` (некому в эфир — тишина, закон №1).
 */
function findSpeaker(
  world: SimWorld,
  loc: LocationId,
  exclude: ReadonlySet<EntityId>,
): EntityId | undefined {
  const candidates = queryEntities(world.ecs, [Human, Alive, Position]);
  for (const eid of candidates) {
    if ((POS.loc[eid] as number) !== loc) continue;
    if (exclude.has(eid)) continue;
    return eid;
  }
  return undefined;
}

/**
 * Основной «второй» субъект для плейсхолдера `{subject}` (жертва/новичок), если тип его
 * несёт. Иные типы `{subject}` не используют — тогда undefined (дефолт не течёт в текст).
 */
function subjectEid(ev: SimEvent): EntityId | undefined {
  switch (ev.type) {
    case 'entity/died':
    case 'population/arrived':
      return ev.payload.eid;
    case 'loot/transferred':
      return ev.payload.from; // обобранный
    default:
      return undefined;
  }
}

/** Размер ВРАЖЕСКОЙ (для говорящего) стороны боя — для `{count}` в encounter/started. */
function enemyCount(sides: ReadonlyArray<readonly EntityId[]>, speaker: EntityId): number {
  let ownSide = -1;
  for (let i = 0; i < sides.length; i++) {
    if ((sides[i] as readonly EntityId[]).includes(speaker)) {
      ownSide = i;
      break;
    }
  }
  let c = 0;
  for (let i = 0; i < sides.length; i++) {
    if (i !== ownSide) c += (sides[i] as readonly EntityId[]).length;
  }
  return c;
}

/** Строковый id предмета/артефакта для `{item}` (находка), если тип его несёт. */
function itemOf(ev: SimEvent): string | undefined {
  switch (ev.type) {
    case 'artifact/collected':
      return ev.payload.item;
    default:
      return undefined;
  }
}

/** Уникальные отсортированные `Subject` участников события (детерминизм, закон №8). */
function subjectsOf(ev: SimEvent): readonly Subject[] {
  const eids = new Set<EntityId>();
  for (const eid of participantsOf(ev)) eids.add(eid);
  return Array.from(eids)
    .sort((a, b) => a - b)
    .map(entitySubject);
}

/** Собирает `params` подстановки (опущенные поля не текут дефолтом в текст). */
function buildParams(ev: SimEvent, speaker: EntityId, loc: LocationId | undefined): MessageParams {
  const subj = subjectEid(ev);
  const cnt = ev.type === 'encounter/started' ? enemyCount(ev.payload.sides, speaker) : undefined;
  const itm = itemOf(ev);
  return {
    speaker,
    ...(subj === undefined ? {} : { subject: subj }),
    ...(loc === undefined ? {} : { loc }),
    ...(cnt === undefined ? {} : { count: cnt }),
    ...(itm === undefined ? {} : { item: itm }),
  };
}

/**
 * Система Radio (`every:1`). РЕАКТИВНО (bus.at(tick−1), закон №6) озвучивает значимые события
 * прошлого тика от имени живого Human-наблюдателя в локации события. No-op, если значимых
 * событий/наблюдателей в окне нет или эфир заглушён грозой. НЕ в конвейере до 3.7 (изоляция).
 */
export const Radio: System = {
  name: 'Radio',
  schedule: { every: 1 },
  update(ctx: SystemCtx): void {
    const { world, bus, tick } = ctx;

    // Читаем ТОЛЬКО закоммиченный прошлый тик (D-005): на тике 0 окна прошлого нет.
    if (tick <= 0) return;

    // ПОМЕХИ: погода — глобальное состояние среды (D-019). Гроза глушит весь эфир тика.
    const weather = currentWeather(world);
    if (weather !== undefined && isJammingWeather(weather)) return; // потеря сообщений (§8.1)

    const events = bus.at((tick - 1) as Tick); // сорт. по id (детерминизм, закон №8)

    for (const ev of events) {
      // Страж от петли эфира/летописи (их значимость и так 0 < порога).
      if (ev.type === RADIO_MESSAGE_TYPE || ev.type === CHRONICLE_RECORDED_TYPE) continue;

      if (significance(ev, world) < RADIO_THRESHOLD) continue; // рутина — мимо эфира

      const loc = eventLoc(world, ev);
      if (loc === undefined) continue; // локация неопределима — некуда слать наблюдателя

      const speaker = findSpeaker(world, loc, nonSpeakers(ev));
      if (speaker === undefined) continue; // нет живого свидетеля — тишина (закон №1)

      // Тон говорящего (D-071). Гейт hasComponent(Personality) — страховка от reuse-eid:
      // говорящий — живой Human ⇒ носитель, но не полагаемся на прямое чтение SoA-колонки.
      const temperament = hasComponent(world.ecs, Personality, speaker)
        ? temperamentCode(speaker)
        : FALLBACK_TEMPERAMENT;

      // Пул шаблонов под тон; нет — откат на 'neutral' (templateId кодирует РЕАЛЬНО
      // использованный темперамент, чтобы read-time рендер разрешил тот же пул).
      let usedTemp: string = temperament;
      let pool = getTemplatePool(ev.type, temperament);
      if (pool === undefined || pool.length === 0) {
        usedTemp = FALLBACK_TEMPERAMENT;
        pool = getTemplatePool(ev.type, FALLBACK_TEMPERAMENT);
      }
      if (pool === undefined || pool.length === 0) continue; // тип не в контенте — молчим

      // ЧИСТЫЙ seeded-выбор (D-070): fnv(eventId, speaker) mod poolSize, без rng-потока.
      const index = templateIndex(ev.id as EventId, speaker, pool.length);
      const templateId = makeTemplateId(ev.type, usedTemp, index);

      bus.publish({
        type: 'radio/message',
        causedBy: ev.id as EventId,
        payload: {
          speakerEid: speaker,
          subjects: subjectsOf(ev),
          loc, // определена (при undefined выше continue)
          templateId,
          params: buildParams(ev, speaker, loc),
          isFirsthand: true, // лично воспринято; ретрансляция (слух 3.6) даст false
        },
      });
    }
  },
};
