/**
 * @module @zona/ui/map/visual-config
 *
 * ВИЗУАЛЬНЫЙ МАППИНГ КАРТЫ КАК ДАННЫЕ (закон №10). Загружает `data/visual-config.json`
 * — единственный источник соответствий тип→форма/размер, принадлежность→цвет,
 * состояние→модификатор и раскладки узлов графа [0..1]. Компонент карты (`MapCanvas`)
 * НЕ хардкодит форм/цветов/координат: он спрашивает эти чистые аксессоры. Замена
 * глифов на спрайты в будущем правит только JSON+аксессоры, не логику рендера.
 *
 * ── ГРАНИЦА ПАКЕТОВ (закон №5, D-011) ────────────────────────────────────────
 * `VisualConfig` — UI-контент: пиксельные размеры, hex-цвета, canvas-раскладка. Это
 * презентация, а не контракт симуляции — поэтому тип живёт ЗДЕСЬ, рядом с данными, а
 * НЕ в `@zona/shared` (который остаётся свободен от DOM/пиксельных понятий) и НЕ в
 * `@zona/sim` (ядро о наблюдателе не знает). Другие пакеты этот тип не потребляют.
 *
 * ── РОБАСТНОСТЬ (DoD 4.2) ────────────────────────────────────────────────────
 * Аксессоры НИКОГДА не бросают в рантайме: неизвестный `kind`/`faction`/`loc` →
 * детерминированный ФОЛБЭК (нейтральный глиф/цвет/скрытый узел). Строгую полноту
 * (все локации/фракции/kinds покрыты) проверяет `validateVisualConfig` в тесте
 * загрузки против `map.json`/`factions.json` — фейл контента ловится до релиза, а не
 * молча роняет карту у наблюдателя.
 *
 * ── ЧИСТОТА (закон №8) ───────────────────────────────────────────────────────
 * Все функции здесь — чистые отображения над конфигом и plain-полями `EntityView`;
 * на симуляцию не влияют (карта — читатель, D-006/D-080). Детерминированы (кроме
 * `combatAlpha`, зависящей от презентационного времени кадра — не от состояния мира).
 */

import { TaskKind } from '@zona/sim';
import rawConfig from '../data/visual-config.json';

/** Геометрическая форма глифа (форма = ТИП сущности, визуальный язык ui-engineer). */
export type GlyphShape = 'circle' | 'triangle' | 'diamond' | 'cross' | 'square';

/** Глиф одного вида: форма + базовый размер (px, читаемость на 100% зуме — 8..12). */
export interface KindVisual {
  readonly shape: GlyphShape;
  readonly sizePx: number;
}

/** Цвет принадлежности фракции (приглушённый, без неона). */
export interface FactionVisual {
  readonly color: string;
}

/** Параметры мигания «в бою»: период и минимальная альфа в нижней точке пульсации. */
export interface CombatBlink {
  readonly periodMs: number;
  readonly minAlpha: number;
}

/** Модификаторы состояния поверх базового глифа. */
export interface Modifiers {
  /** Ниже этой доли HP рисуем красную обводку «ранен». */
  readonly woundedThreshold: number;
  readonly woundedRingColor: string;
  readonly combatBlink: CombatBlink;
  /** Цвет точки над глифом «несёт ценный груз». */
  readonly carryDotColor: string;
  /** Полупрозрачность трупа (0..1). */
  readonly corpseAlpha: number;
  /** Текстовый глиф «спит» (рисуется над сущностью). */
  readonly sleepGlyph: string;
}

/** Нормированная [0..1] позиция узла на схеме (UI масштабирует под canvas). */
export interface NodeLayout {
  readonly x: number;
  readonly y: number;
}

/** Цвета фона/графа/подписей (штабная карта: тёмный фон, приглушённые тона). */
export interface Palette {
  readonly background: string;
  readonly edge: string;
  readonly nodeFill: string;
  readonly nodeStroke: string;
  readonly text: string;
  readonly dim: string;
  readonly nodeRadiusPx: number;
  readonly labelPx: number;
}

/** Нейтральные цвета не-фракционных видов (животные/мутанты/зомби/трупы). */
export interface NeutralColors {
  readonly animal: string;
  readonly mutant: string;
  readonly zombie: string;
  readonly corpse: string;
  /** Поселение/строение: не «фракция людей» (цвет=принадлежность — для людей),
   *  а нейтральный структурный тон, ОТЛИЧНЫЙ от FALLBACK (иначе неотличимо от ошибки). */
  readonly settlement: string;
}

/**
 * Стили НАРРАТИВНОГО СЛОЯ карты (задача 4.7, закон №10): череп места смерти, вспышка
 * боя, радио-тост. Только ДАННЫЕ (цвета/пиксели/периоды/пороги) — логика оверлеев
 * живёт в `overlays.ts` (чистая), отрисовка — в `MapCanvas`. Пороги времени: `flashTicks`
 * — ИГРОВЫЕ тики жизни вспышки боя; `durationMs` — РЕАЛЬНЫЕ мс жизни тоста (wall-clock).
 */
export interface NarrativeVisual {
  /** Череп места смерти (символ/цвет/размер + вертикальный сдвиг над узлом). */
  readonly skull: {
    readonly glyph: string;
    readonly color: string;
    readonly sizePx: number;
    readonly offsetPx: number;
    /** Цвет счётчика стопки смертей («×N»). */
    readonly countColor: string;
  };
  /** Вспышка локации боя (цвет/радиус кольца + пульсация + окно жизни в ИГРОВЫХ тиках). */
  readonly combatFlash: {
    readonly color: string;
    readonly radiusPx: number;
    readonly periodMs: number;
    readonly minAlpha: number;
    /** Сколько ИГРОВЫХ тиков вспышка «горит» после `encounter/started`. */
    readonly flashTicks: number;
  };
  /** Радио-тост (плашка у узла говорящего): цвета + окно жизни в РЕАЛЬНЫХ мс. */
  readonly toast: {
    readonly bg: string;
    readonly border: string;
    readonly text: string;
    readonly speaker: string;
    /** Реальные мс жизни одной плашки (wall-clock, презентация). */
    readonly durationMs: number;
    /** Сколько плашек показываем одновременно (стопка без наложения). */
    readonly maxVisible: number;
    readonly maxWidthPx: number;
    readonly offsetPx: number;
    readonly gapPx: number;
  };
}

/** Корневая форма visual-config.json. */
export interface VisualConfig {
  readonly kinds: Readonly<Record<string, KindVisual>>;
  readonly factions: Readonly<Record<string, FactionVisual>>;
  readonly neutralColors: NeutralColors;
  readonly modifiers: Modifiers;
  readonly narrative: NarrativeVisual;
  /** Ключ — строковый id локации ("0".."N-1") → нормированная позиция. */
  readonly layout: Readonly<Record<string, NodeLayout>>;
  /** Рёбра графа для отрисовки, пары id локаций (зеркало топологии map.json). */
  readonly edges: readonly (readonly [number, number])[];
  readonly palette: Palette;
}

/** Загруженный конфиг (типизированное представление JSON-модуля). */
export const VISUAL_CONFIG = rawConfig as unknown as VisualConfig;

// ── Детерминированные фолбэки (робастность — не бросаем в рантайме) ───────────

/** Глиф для неизвестного вида: нейтральный кружок среднего размера. */
export const FALLBACK_GLYPH: KindVisual = { shape: 'circle', sizePx: 9 };

/** Цвет для неизвестного вида/фракции: тускло-серый (не привлекает внимания). */
export const FALLBACK_COLOR = '#8a8272';

// ── Чистые аксессоры (форма=тип, цвет=принадлежность, состояние=модификатор) ──

/**
 * Глиф вида: форма + размер из конфига, иначе `FALLBACK_GLYPH`. Union `EntityKind`
 * пополняется append-only (мутанты/зомби), поэтому дефолт-ветка обязательна.
 */
export function glyphForKind(cfg: VisualConfig, kind: string): KindVisual {
  return cfg.kinds[kind] ?? FALLBACK_GLYPH;
}

/**
 * Цвет сущности = ПРИНАДЛЕЖНОСТЬ (ui-engineer.md: цвет по фракции — для ЛЮДЕЙ):
 * ЖИВОЙ ЧЕЛОВЕК с известной фракцией → цвет фракции; иначе нейтральный цвет по виду
 * (животное/мутант/зомби/труп/поселение); иначе фолбэк (неизвестный вид). Фракц-цвет
 * гейтится ИМЕННО `kind==='human'` — животное/мутант с непустой фракцией (если экспортёр
 * когда-нибудь навесит) НЕ окрасится по-фракционному; труп/поселение — свои нейтрали.
 */
export function colorForEntity(
  cfg: VisualConfig,
  e: { readonly kind: string; readonly faction: string | null },
): string {
  if (e.kind === 'human' && e.faction !== null) {
    const f = cfg.factions[e.faction];
    if (f !== undefined) return f.color;
  }
  switch (e.kind) {
    case 'animal':
      return cfg.neutralColors.animal;
    case 'mutant':
      return cfg.neutralColors.mutant;
    case 'zombie':
      return cfg.neutralColors.zombie;
    case 'corpse':
      return cfg.neutralColors.corpse;
    case 'settlement':
      return cfg.neutralColors.settlement;
    default:
      return FALLBACK_COLOR;
  }
}

/** «Ранен»: живая сущность с HP ниже порога → красная обводка. Трупы не «ранены». */
export function isWounded(cfg: VisualConfig, hpFrac: number, alive: boolean): boolean {
  return alive && hpFrac < cfg.modifiers.woundedThreshold;
}

/** «Спит»: текущая задача — SLEEP (глиф «zzz» над сущностью). */
export function isSleeping(task: number | null): boolean {
  return task === TaskKind.SLEEP;
}

/**
 * Альфа мигания «в бою» на момент времени `nowMs` (презентация, не состояние):
 * косинусная пульсация в [minAlpha..1] с периодом `combatBlink.periodMs`.
 */
export function combatAlpha(cfg: VisualConfig, nowMs: number): number {
  const { periodMs, minAlpha } = cfg.modifiers.combatBlink;
  const phase = ((nowMs % periodMs) / periodMs) * 2 * Math.PI;
  const wave = (Math.cos(phase) + 1) / 2; // 0..1
  return minAlpha + (1 - minAlpha) * wave;
}

/**
 * Позиция узла локации из раскладки, либо `null` если id вне layout (робастность:
 * незнакомая локация просто не рисуется — карта не падает).
 */
export function nodeLayout(cfg: VisualConfig, loc: number): NodeLayout | null {
  return cfg.layout[String(loc)] ?? null;
}

// ── Валидатор полноты (тест загрузки; в рантайме не обязателен) ───────────────

/** Ожидаемое покрытие для строгой проверки (данные читаются из /sim в тесте). */
export interface CoverageExpectation {
  /** id всех локаций map.json (layout обязан покрыть каждую). */
  readonly locationIds: readonly number[];
  /** id всех фракций factions.json (каждая обязана иметь цвет). */
  readonly factionIds: readonly string[];
  /** все значения `EntityKind` (каждый обязан иметь глиф). */
  readonly kinds: readonly string[];
  /** рёбра map.json как пары id (config.edges обязан их зеркалить). */
  readonly edges: readonly (readonly [number, number])[];
}

/**
 * Строгая проверка полноты конфига против контента `@zona/sim`. Возвращает список
 * проблем (пустой = ок) — НЕ бросает: вызывающий тест делает `expect(problems).toEqual([])`.
 * Проверяет: каждый kind имеет глиф; каждая фракция — цвет; layout покрывает все
 * локации; координаты в [0..1]; config.edges == edges map.json (топология не разошлась).
 */
export function validateVisualConfig(cfg: VisualConfig, exp: CoverageExpectation): string[] {
  const problems: string[] = [];

  for (const k of exp.kinds) {
    if (cfg.kinds[k] === undefined) problems.push(`kind без глифа: ${k}`);
  }
  for (const f of exp.factionIds) {
    if (cfg.factions[f] === undefined) problems.push(`фракция без цвета: ${f}`);
  }
  for (const id of exp.locationIds) {
    const pos = cfg.layout[String(id)];
    if (pos === undefined) {
      problems.push(`локация без раскладки: ${id}`);
      continue;
    }
    if (!(pos.x >= 0 && pos.x <= 1 && pos.y >= 0 && pos.y <= 1)) {
      problems.push(`раскладка вне [0..1]: ${id} → (${pos.x}, ${pos.y})`);
    }
  }
  // Раскладка не должна ссылаться на несуществующие локации.
  const known = new Set(exp.locationIds.map((n) => String(n)));
  for (const key of Object.keys(cfg.layout)) {
    if (!known.has(key)) problems.push(`раскладка лишнего узла: ${key}`);
  }
  // Топология рёбер обязана зеркалить map.json (канонизируем как a<b, сортируем).
  const canon = (es: readonly (readonly [number, number])[]): string[] =>
    es.map(([a, b]) => (a <= b ? `${a}-${b}` : `${b}-${a}`)).sort();
  const cfgEdges = canon(cfg.edges);
  const mapEdges = canon(exp.edges);
  if (cfgEdges.join(',') !== mapEdges.join(',')) {
    problems.push(`рёбра разошлись с map.json: config=[${cfgEdges}] map=[${mapEdges}]`);
  }
  return problems;
}
