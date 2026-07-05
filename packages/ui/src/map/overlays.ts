/**
 * @module @zona/ui/map/overlays
 *
 * НАРРАТИВНЫЙ СЛОЙ КАРТЫ (задача 4.7) — ЧИСТАЯ ЛОГИКА оверлеев поверх глифовой карты
 * (4.2): череп в месте смерти, вспышка локации боя, очередь радио-тостов, слежение,
 * усиленный тултип. Все функции здесь — ДЕТЕРМИНИРОВАННЫЕ отображения над ОКНОМ ЛОГА
 * (`SimEvent[]`), `WorldView` и презентационным временем; без DOM/canvas/состояния мира.
 * Отрисовку (canvas/DOM) и презентационные ref'ы держит `MapCanvas`, сюда не течёт.
 *
 * ── ЗАКОН №5 (DOM только в /ui) ──────────────────────────────────────────────
 * Из `@zona/sim` берём лишь ПУБЛИЧНОЕ ЧИСТОЕ ЧТЕНИЕ контента (`renderMessage` — plain-
 * строка из templateId+params, как RadioLog 4.3; `getLocation` — имя локации). НИ ОДНА
 * система симуляции не импортируется. Из `@zona/shared` — plain-контракты событий/вида.
 *
 * ── ЗАКОН №8 (оверлеи — ПРЕЗЕНТАЦИЯ, читатель) ───────────────────────────────
 * Всё здесь — чистое ЧТЕНИЕ лога/вида: на симуляцию НЕ влияет (D-006/D-080, голдены
 * целы). ДВА времени затухания РАЗНЫЕ по природе:
 *  - ЧЕРЕП/ВСПЫШКА — по ИГРОВОМУ tick (детерминировано от состояния мира: `skullAlpha`
 *    зависит лишь от deathTick/currentTick — тот же лог → тот же кадр, resume-safe).
 *  - РАДИО-ТОСТ — по РЕАЛЬНОМУ времени (wall-clock ms), как rAF-анимация 4.2: это
 *    презентация «плашка живёт 3 сек», НЕ состояние мира. Время инъектируется
 *    параметром `nowMs` — функции остаются чистыми и тестируются с мок-временем.
 *
 * ── ЗАКОН №10 (стили — данные) ───────────────────────────────────────────────
 * Цвета/периоды/пороги оверлеев — в `visual-config.json` (секция `narrative`); здесь
 * лишь ЧИСТАЯ логика отбора/затухания/очереди. Символ черепа/микро-геометрию рисует
 * `MapCanvas` (презентационная мелочь, как формы глифов 4.2).
 */

import type { EntityName, EntityView, LocationId, SimEvent } from '@zona/shared';
import { renderMessage, getLocation } from '@zona/sim';
import type { Point } from './geometry';

// ── 1. ЧЕРЕП МЕСТА СМЕРТИ (затухает за 1 ИГРОВЫЕ сутки, по tick) ──────────────

/** Маркер-череп на узле: место смерти, стопка смертей, альфа от самой свежей. */
export interface DeathMarker {
  /** Локация смерти (узел графа). */
  readonly loc: number;
  /** Tick САМОЙ СВЕЖЕЙ смерти на узле (драйвер альфы/затухания). */
  readonly deathTick: number;
  /** Сколько смертей на узле ещё в окне затухания (стопка/счётчик). */
  readonly count: number;
  /** Прозрачность черепа [0..1] от самой свежей смерти. */
  readonly alpha: number;
}

/**
 * Прозрачность черепа: линейное затухание за РОВНО одни игровые сутки.
 *  - age = 0        → 1 (только что);
 *  - age = сутки    → 0 (исчез);
 *  - age > суток    → 0 (черепа нет);
 *  - age < 0 (будущее, не должно быть) → 0 (робастность).
 * Чистая функция ИГРОВОГО времени (tick) — детерминирована от состояния мира.
 */
export function skullAlpha(deathTick: number, currentTick: number, ticksPerDay: number): number {
  const age = currentTick - deathTick;
  if (age < 0) return 0;
  if (age >= ticksPerDay) return 0;
  return 1 - age / ticksPerDay;
}

/**
 * Собирает черепа-маркеры из окна лога: каждое `entity/died` в окне затухания даёт
 * череп на узле смерти. Локацию берём из парного `corpse/created` (несёт `loc`,
 * авторитетно), иначе — из `locOf` (текущая позиция трупа во `WorldView`). Несколько
 * смертей на узле — стопка (count) с альфой самой свежей. Сорт. по loc (детерминизм).
 */
export function collectDeathMarkers(
  log: readonly SimEvent[],
  currentTick: number,
  ticksPerDay: number,
  locOf: (eid: number) => number | null,
): DeathMarker[] {
  // eid → loc из corpse/created (место смерти несёт именно оно, entity/died — нет).
  const corpseLoc = new Map<number, number>();
  for (const ev of log) {
    if (ev.type === 'corpse/created') {
      corpseLoc.set(ev.payload.eid as unknown as number, ev.payload.loc as unknown as number);
    }
  }
  const byLoc = new Map<number, { deathTick: number; count: number }>();
  for (const ev of log) {
    if (ev.type !== 'entity/died') continue;
    const tick = ev.tick as unknown as number;
    if (skullAlpha(tick, currentTick, ticksPerDay) <= 0) continue; // выпал из окна суток
    const eid = ev.payload.eid as unknown as number;
    const loc = corpseLoc.get(eid) ?? locOf(eid);
    if (loc === null || loc === undefined) continue; // место смерти не восстановимо
    const cur = byLoc.get(loc);
    if (cur === undefined) byLoc.set(loc, { deathTick: tick, count: 1 });
    else {
      cur.count += 1;
      if (tick > cur.deathTick) cur.deathTick = tick;
    }
  }
  const out: DeathMarker[] = [];
  for (const [loc, v] of byLoc) {
    out.push({ loc, deathTick: v.deathTick, count: v.count, alpha: skullAlpha(v.deathTick, currentTick, ticksPerDay) });
  }
  out.sort((a, b) => a.loc - b.loc);
  return out;
}

// ── 2. ВСПЫШКА ЛОКАЦИИ БОЯ (краткая, пока бой «свеж» в окне tick) ─────────────

/** Активная вспышка боя на узле: локация + tick завязки (для затухания). */
export interface CombatFlash {
  readonly loc: number;
  /** Tick самого свежего `encounter/started` на узле. */
  readonly startTick: number;
}

/**
 * Активные вспышки боя из окна лога: `encounter/started` считается «горящим», пока с
 * его тика прошло < `flashTicks` ИГРОВЫХ тиков (столкновение 1-тиковое, D-076 — держим
 * краткую вспышку). Несколько боёв на узле сливаются в один флаг (самый свежий tick).
 * Активность ДЕТЕРМИНИРОВАНА игровым временем; пульсация-мигание (wall-clock) — в
 * рендере. Сорт. по loc (детерминизм, закон №8).
 */
export function collectCombatFlashes(
  log: readonly SimEvent[],
  currentTick: number,
  flashTicks: number,
): CombatFlash[] {
  const byLoc = new Map<number, number>();
  for (const ev of log) {
    if (ev.type !== 'encounter/started') continue;
    const tick = ev.tick as unknown as number;
    const age = currentTick - tick;
    if (age < 0 || age >= flashTicks) continue;
    const loc = ev.payload.loc as unknown as number;
    const cur = byLoc.get(loc);
    if (cur === undefined || tick > cur) byLoc.set(loc, tick);
  }
  const out: CombatFlash[] = [];
  for (const [loc, startTick] of byLoc) out.push({ loc, startTick });
  out.sort((a, b) => a.loc - b.loc);
  return out;
}

// ── 3. РАДИО-ТОСТ (очередь, wall-clock 3 сек, без наложений) ──────────────────

/** Плашка радио-тоста: одно радио-сообщение, всплывающее у узла говорящего. */
export interface Toast {
  /** id события лога (стабильный ключ дедупа/очереди). */
  readonly id: number;
  /** Локация говорящего (узел размещения плашки), либо `null` (событие без loc). */
  readonly loc: number | null;
  readonly speakerEid: number;
  /** Готовая plain-строка (renderMessage), уже с резолвом имён/локаций. */
  readonly text: string;
  /**
   * Wall-clock ms момента, когда плашка СТАЛА видимой (её 3-сек таймер пошёл), либо
   * `null` — ещё в очереди (не показана). Презентация: НЕ состояние мира.
   */
  readonly shownAt: number | null;
}

/** Состояние очереди тостов: элементы + высшая обработанная id (антидубль-водомер). */
export interface ToastQueue {
  readonly items: readonly Toast[];
  /** Наибольшая уже проглоченная id события — новые берём только строго выше. */
  readonly lastId: number;
}

/** Пустая очередь (стартовое презентационное состояние). */
export const EMPTY_TOAST_QUEUE: ToastQueue = { items: [], lastId: -1 };

/** Резолвер имени говорящего (кличка → «Имя Фамилия» → `#eid`), как RadioLog (D-081). */
function resolveName(names: Readonly<Record<number, EntityName>>, ref: string | number): string {
  if (typeof ref === 'string') return ref;
  const n = names[ref];
  if (n === undefined) return `#${ref}`;
  if (n.nickname.length > 0) return n.nickname;
  return `${n.first} ${n.last}`.trim();
}

/** Имя локации из контента (публичное чтение /sim); незнакомая → `#id` (робастность). */
function locName(loc: number): string {
  try {
    return getLocation(loc as LocationId).name;
  } catch {
    return `#${loc}`;
  }
}

/** Наибольшая id события в окне лога, либо `-1` (пусто) — для инициализации `lastId`. */
export function maxEventId(log: readonly SimEvent[]): number {
  let m = -1;
  for (const ev of log) {
    const id = ev.id as unknown as number;
    if (id > m) m = id;
  }
  return m;
}

/**
 * Строит тосты из окна лога для `radio/message` с id > `sinceId` (только НОВЫЕ, чтобы
 * не переигрывать бэклог). Текст собирает ЧИСТЫЙ `renderMessage` (D-069, как RadioLog)
 * — плашка НЕ хардкодит строк (закон №10). Слухи (`radio/relayed`) в тосты НЕ берём:
 * их поток огромен (десятки тысяч) — плашки-тосты для ЛИЧНОЙ озвучки события, слух
 * читается в панели эфира. Все новые — с `shownAt: null` (встают в очередь).
 */
export function buildRadioToasts(
  log: readonly SimEvent[],
  names: Readonly<Record<number, EntityName>>,
  sinceId: number,
): Toast[] {
  const ctx = { nameOf: (r: string | number) => resolveName(names, r), locOf: locName };
  const out: Toast[] = [];
  for (const ev of log) {
    if (ev.type !== 'radio/message') continue;
    const id = ev.id as unknown as number;
    if (id <= sinceId) continue;
    out.push({
      id,
      loc: ev.payload.loc ?? null,
      speakerEid: ev.payload.speakerEid as unknown as number,
      text: renderMessage({ templateId: ev.payload.templateId, params: ev.payload.params }, ctx),
      shownAt: null,
    });
  }
  return out;
}

/**
 * Добавляет новые тосты в очередь (дедуп по id-водомеру: берём строго id > `lastId`,
 * двигаем водомер до максимума виденного). Порядок FIFO (в порядке лога). Чистая.
 */
export function enqueueToasts(state: ToastQueue, incoming: readonly Toast[]): ToastQueue {
  let maxId = state.lastId;
  const add: Toast[] = [];
  for (const t of incoming) {
    if (t.id <= state.lastId) continue;
    add.push(t);
    if (t.id > maxId) maxId = t.id;
  }
  if (add.length === 0) return maxId === state.lastId ? state : { items: state.items, lastId: maxId };
  return { items: [...state.items, ...add], lastId: maxId };
}

/**
 * Продвигает очередь на момент `nowMs` (wall-clock): (1) снимает тосты, чьи 3 сек
 * истекли (`nowMs − shownAt >= durationMs`); (2) запускает таймер у ГОЛОВНЫХ ещё не
 * показанных, пока видимых < `maxVisible` — так БЕЗ НАЛОЖЕНИЯ показываем стопку по
 * одному/несколько, остальные ждут. FIFO (порядок очереди). Чистая, детерминирована
 * от `nowMs` (мок-время в тесте). Возвращает ТУ ЖЕ ссылку, если ничего не изменилось.
 */
export function stepToastQueue(
  state: ToastQueue,
  nowMs: number,
  opts: { readonly durationMs: number; readonly maxVisible: number },
): ToastQueue {
  const kept = state.items.filter((t) => t.shownAt === null || nowMs - t.shownAt < opts.durationMs);
  let visible = 0;
  for (const t of kept) if (t.shownAt !== null) visible += 1;
  let changed = kept.length !== state.items.length;
  const next: Toast[] = [];
  for (const t of kept) {
    if (t.shownAt === null && visible < opts.maxVisible) {
      next.push({ ...t, shownAt: nowMs });
      visible += 1;
      changed = true;
    } else {
      next.push(t);
    }
  }
  if (!changed) return state;
  return { items: next, lastId: state.lastId };
}

/** Видимые сейчас тосты (таймер запущен) — то, что рисует MapCanvas. */
export function visibleToasts(state: ToastQueue): readonly Toast[] {
  return state.items.filter((t) => t.shownAt !== null);
}

// ── 4. СЛЕЖЕНИЕ (центрирование вида на сущности) ──────────────────────────────

/**
 * Смещение «камеры», центрирующее сущность в позиции `target` на точку `center`
 * (обычно центр холста). После сдвига `target + offset === center`. Read-only
 * презентация (закон №8): двигает лишь ВИД, не мир. Плавность (lerp к этому offset)
 * — в рендере (rAF-догон, как интерполяция глифов 4.2).
 */
export function followOffset(target: Point, center: Point): Point {
  return { x: center.x - target.x, y: center.y - target.y };
}

// ── 5. ТУЛТИП (имя из names / вид + текущая задача) ───────────────────────────

/**
 * Подпись тултипа наведённой сущности: у ЧЕЛОВЕКА — ИМЯ (из кэша `names`, D-081) +
 * задача; у зверя/мутанта/зомби — ВИД + задача; у трупа — просто «труп». Имени нет в
 * кэше → откат на вид. Чистая: то же наведение → та же строка (закон №8).
 */
export function tooltipLabel(
  e: EntityView,
  names: Readonly<Record<number, EntityName>>,
  kindLabel: Readonly<Record<string, string>>,
  taskLabel: readonly string[],
): string {
  const kind = kindLabel[e.kind] ?? e.kind;
  if (e.kind === 'corpse') return kind;
  const task = e.task !== null && e.task !== undefined ? taskLabel[e.task] : undefined;
  let head = kind;
  if (e.kind === 'human') {
    const n = names[e.eid as unknown as number];
    if (n !== undefined) {
      const nm = n.nickname.length > 0 ? n.nickname : `${n.first} ${n.last}`.trim();
      if (nm.length > 0) head = nm;
    }
  }
  return task !== undefined ? `${head} · ${task}` : head;
}
