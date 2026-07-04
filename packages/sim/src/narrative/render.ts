/**
 * @module @zona/sim/narrative/render
 *
 * ЧИСТЫЙ headless-форматтер радио-сообщений (задача 3.4, GDD §8.3, D-069). Из
 * ССЫЛКИ на шаблон (`templateId`) и параметров (`params`) собирает ГОТОВУЮ строку,
 * читая пул шаблонов из `/sim/data/messages.json` (закон №10 — контент в данных).
 *
 * ── Контракт формы сообщения (D-069) ────────────────────────────────────────
 * Событие/слух НЕСЁТ `templateId + params`, а НЕ готовый текст: строку собирают
 * ПОЗЖЕ (рендер лога) через `renderMessage`. Так один и тот же факт можно
 * перечитать в другом стиле/языке, а снапшот хранит компактную ссылку, не текст.
 *  - `templateId` = `"<eventType>|<temperament>|<index>"` (напр.
 *    `"entity/died|veteran|2"`). Выбор `index` из пула по seed — ЗАДАЧА 3.5 (Radio);
 *    3.4 лишь рендерит УЖЕ выбранный шаблон.
 *  - `params` — сырые значения: имена как `EntityId`(number) ИЛИ строка, `loc` как
 *    `LocationId`(number), `count` как число, `item` как строковый id. Резолв
 *    id→имя/название делает инъектированный `ctx` (`nameOf`/`locOf`/`itemOf`), а
 *    НЕ рендер — так рендер не тянет ECS/ResourceStore (закон №5/№6).
 *
 * ── Закон №5 (КРИТИЧНО) ──────────────────────────────────────────────────────
 * Выход — PLAIN-строка (текст), НЕ DOM/HTML/разметка. Никакого импорта из
 * DOM/React/Node. Стиль/раскраску эфира делает UI Фазы 4 поверх этой строки.
 * Шаблоны в данных не содержат тегов — это гарантирует `validateMessages` (data).
 *
 * ── Закон №8 (детерминизм) ───────────────────────────────────────────────────
 * `renderMessage` ДЕТЕРМИНИРОВАН и БЕЗ rng: индексирует пул по `templateId`,
 * подставляет `params` строкой. Выбор шаблона из пула (seeded) — не здесь (3.5).
 *
 * Фолбэк (не throw в рантайме): невалидный/неизвестный `templateId` (баг 3.5, а не
 * порча контента — её ловит `validateMessages` при загрузке) деградирует мягко —
 * пул темперамента → пул `'neutral'` того же события → служебная строка помех.
 *
 * Пример:
 * ```ts
 * const s = renderMessage(
 *   { templateId: 'entity/died|neutral|0', params: { subject: 42, loc: 1 } },
 *   { nameOf: (r) => (r === 42 ? 'Сергей Лисенко' : String(r)), locOf: (l) => MAP.locations[l].name },
 * );
 * // → "Сергей Лисенко погиб. Свалка."
 * ```
 */

import { getTemplate, getTemplatePool } from '../data/index';

/** Параметры подстановки. Имена — id(number) или готовая строка; loc — LocationId. */
export interface MessageParams {
  /** Говорящий (обычно префикс лога добавляет 3.5/UI; в тексте — редко). */
  readonly speaker?: string | number;
  /** Второе действующее лицо: покойник/жертва/новичок/враг. */
  readonly subject?: string | number;
  /** Локация события (`LocationId`) — резолвится `ctx.locOf`. */
  readonly loc?: number;
  /** Число (враги/потери/штуки). */
  readonly count?: number;
  /** Строковый id предмета/артефакта — резолвится `ctx.itemOf` (или как есть). */
  readonly item?: string;
}

/** Ссылка на шаблон + параметры — то, что ХРАНИТ событие/слух (D-069). */
export interface MessageEntry {
  /** `"<eventType>|<temperament>|<index>"`. */
  readonly templateId: string;
  readonly params: MessageParams;
}

/**
 * Резолверы id→человекочитаемое (инъекция, чтобы рендер не знал про ECS/данные).
 *  - `nameOf(ref)` — `EntityId`→имя NPC, строку — как есть (проброс).
 *  - `locOf(loc)` — `LocationId`→название локации (из MAP).
 *  - `itemOf(id)` — id предмета→название (опц.; нет → используется сам id).
 */
export interface RenderContext {
  readonly nameOf: (ref: string | number) => string;
  readonly locOf: (loc: number) => string;
  readonly itemOf?: (id: string) => string;
}

/** Разобранный `templateId`. */
export interface ParsedTemplateId {
  readonly eventType: string;
  readonly temperament: string;
  readonly index: number;
}

/** Разделитель полей `templateId`. Ни eventType, ни темперамент его не содержат. */
const TEMPLATE_ID_SEP = '|';

/** Обязательный фолбэк-темперамент (совпадает с data — базовый пул есть всегда). */
const FALLBACK_TEMPERAMENT = 'neutral';

/** Служебная строка при полной невозможности собрать сообщение (помехи эфира). */
const FALLBACK_MESSAGE = '…в эфире только треск помех…';

/** Дефолтные подстановки, если параметр не передан (плейсхолдер не течёт в текст). */
const DEFAULTS: Readonly<Record<string, string>> = {
  speaker: 'кто-то',
  subject: 'кто-то',
  loc: 'где-то',
  count: 'несколько',
  item: 'что-то',
};

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/** Собирает канонический `templateId` из компонент (для 3.5/хранения). */
export function makeTemplateId(eventType: string, temperament: string, index: number): string {
  return `${eventType}${TEMPLATE_ID_SEP}${temperament}${TEMPLATE_ID_SEP}${index}`;
}

/**
 * Разбирает `templateId`. Возвращает `null` на кривом формате (не 3 поля, индекс
 * не целое >=0) — вызывающий (`renderMessage`) уходит в фолбэк, а не бросает.
 */
export function parseTemplateId(templateId: string): ParsedTemplateId | null {
  if (typeof templateId !== 'string') return null;
  const parts = templateId.split(TEMPLATE_ID_SEP);
  if (parts.length !== 3) return null;
  const [eventType, temperament, idxRaw] = parts as [string, string, string];
  if (eventType.length === 0 || temperament.length === 0) return null;
  const index = Number(idxRaw);
  if (!Number.isInteger(index) || index < 0) return null;
  return { eventType, temperament, index };
}

/** Резолвит имя действующего лица (id→имя через ctx; строка/undefined — как есть). */
function resolveActor(v: string | number | undefined, ctx: RenderContext, fallback: string): string {
  if (v === undefined) return fallback;
  return ctx.nameOf(v);
}

/**
 * Собирает готовую строку сообщения из `entry` (templateId+params) и `ctx`
 * (резолверы id→имя). ДЕТЕРМИНИРОВАН, без rng/DOM. Неизвестный/битый templateId →
 * мягкий фолбэк (`neutral`-пул того же события → строка помех), НЕ throw.
 */
export function renderMessage(entry: MessageEntry, ctx: RenderContext): string {
  const parsed = parseTemplateId(entry.templateId);
  if (parsed === null) return FALLBACK_MESSAGE;
  const { eventType, temperament, index } = parsed;

  // Пул под темперамент говорящего; нет — откат на обязательный 'neutral'.
  const pool =
    getTemplatePool(eventType, temperament) ?? getTemplatePool(eventType, FALLBACK_TEMPERAMENT);
  if (pool === undefined || pool.length === 0) return FALLBACK_MESSAGE; // eventType не в контенте

  // Точный индекс; вне диапазона — первый шаблон пула (стабильная деградация).
  const template = getTemplate(eventType, temperament, index) ?? pool[index] ?? pool[0];
  if (template === undefined) return FALLBACK_MESSAGE;

  return substitute(template, entry.params, ctx);
}

/** Подставляет плейсхолдеры шаблона значениями params (через ctx-резолверы). */
function substitute(template: string, params: MessageParams, ctx: RenderContext): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: string): string => {
    switch (name) {
      case 'speaker':
        return resolveActor(params.speaker, ctx, DEFAULTS.speaker!);
      case 'subject':
        return resolveActor(params.subject, ctx, DEFAULTS.subject!);
      case 'loc':
        return params.loc === undefined ? DEFAULTS.loc! : ctx.locOf(params.loc);
      case 'count':
        return params.count === undefined ? DEFAULTS.count! : String(params.count);
      case 'item':
        if (params.item === undefined) return DEFAULTS.item!;
        return ctx.itemOf ? ctx.itemOf(params.item) : params.item;
      default:
        // Валидатор данных не пропускает неизвестные плейсхолдеры; на всякий
        // случай оставляем токен как есть (лучше видимый маркер, чем пустота).
        return whole as string;
    }
  });
}
