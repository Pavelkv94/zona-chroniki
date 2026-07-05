/**
 * @module @zona/ui/map/MapCanvas
 *
 * ЦЕНТРАЛЬНАЯ КАРТА наблюдателя (задача 4.2) — схематичный граф Зоны в глифовом
 * визуальном языке (форма=тип, цвет=принадлежность, модификаторы=состояние). Читает
 * `WorldView` из стора и рисует его на Canvas 2D. Эталон подачи — тактическая карта
 * штаба + legends-mode: информативность важнее красоты.
 *
 * ── ЗАКОН №5 (DOM только в /ui) ──────────────────────────────────────────────
 * Canvas/DOM живут ЗДЕСЬ. Из `@zona/sim` берём лишь публичное ЧТЕНИЕ контента
 * (`getLocation`, `WEATHER_TYPES`, `TaskKind`) — ни одна система симуляции не
 * импортируется. Из `@zona/shared` — plain-контракт `WorldView`/`EntityView`.
 *
 * ── ЗАКОН №8 / D-006 (карта — читатель) ──────────────────────────────────────
 * Рендер — чистое чтение стора: карта на симуляцию НЕ влияет. Единственная команда
 * наружу — `inspect(eid)` по клику (read-only запрос детали, D-076). Анимация-
 * интерполяция позиций — ПРЕЗЕНТАЦИЯ (rAF), не состояние мира.
 *
 * ── ЗАКОН №10 (визуал как данные) ────────────────────────────────────────────
 * Формы/цвета/размеры/раскладка узлов — из `visual-config.json` через чистые
 * аксессоры (`glyphForKind`/`colorForEntity`/…). В этом файле НЕТ хардкода форм,
 * цветов принадлежности или координат узлов.
 *
 * ── СЛОИ (60 FPS при 250 сущностях, ×600) ────────────────────────────────────
 *  - СТАТИЧНЫЙ canvas: граф (рёбра + узлы-локации с именами) — перерисовка только
 *    при ресайзе.
 *  - ДИНАМИЧНЫЙ canvas: сущности-глифы — перерисовка в requestAnimationFrame с
 *    интерполяцией позиций между снапшотами (плавное движение вдоль рёбер).
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { EntityView, WorldView, LocationId, EntityId, EntityName } from '@zona/shared';
import { getLocation, WEATHER_TYPES, TICKS_PER_DAY } from '@zona/sim';
import { useUiStore } from '../store/store';
import {
  VISUAL_CONFIG,
  colorForEntity,
  combatAlpha,
  glyphForKind,
  isSleeping,
  isWounded,
  nodeLayout,
  type GlyphShape,
} from './visual-config';
import {
  clusterOffset,
  edgeProgress,
  hitTest,
  layoutToPixels,
  lerpPoint,
  type HitCandidate,
  type Point,
} from './geometry';
import {
  buildRadioToasts,
  collectCombatFlashes,
  collectDeathMarkers,
  enqueueToasts,
  followOffset,
  maxEventId,
  stepToastQueue,
  tooltipLabel,
  visibleToasts,
  EMPTY_TOAST_QUEUE,
  type DeathMarker,
  type CombatFlash,
  type Toast,
  type ToastQueue,
} from './overlays';

// ── Презентационные подписи стабильных код-пространств (глюкод UI, не контент) ──
const WEATHER_LABEL: Readonly<Record<string, string>> = {
  clear: 'ясно',
  overcast: 'облачно',
  rain: 'дождь',
  fog: 'туман',
  storm: 'гроза',
};
const KIND_LABEL: Readonly<Record<string, string>> = {
  human: 'человек',
  animal: 'зверь',
  mutant: 'мутант',
  zombie: 'зомби',
  corpse: 'труп',
  settlement: 'поселение',
};
// Индекс = код TaskKind (стабильное пространство core/components).
const TASK_LABEL: readonly string[] = [
  'спит',
  'ест',
  'пьёт',
  'собирает',
  'охотится',
  'отдыхает',
  'бежит',
  'работает',
  'торгует',
  'грабит',
  'ищет хабар',
];

/** Поле по краям холста (нормированные крайние узлы не липнут к границе). */
const PAD_PX = 40;
/** Радиус кольца кластеризации перекрытых глифов в узле. */
const CLUSTER_RADIUS_PX = 12;
/** Плавность rAF-догона отрисованной позиции к целевой (0..1; выше — быстрее). */
const SMOOTH = 0.2;
/** Плавность rAF-догона «камеры» слежения к целевому центрирующему сдвигу (0..1). */
const CAM_SMOOTH = 0.12;
/** Период тика очереди тостов (мс реального времени; плашки живут секунды). */
const TOAST_TICK_MS = 100;

/** Метаданные размещённого глифа кадра (позиция + флаги модификаторов). */
interface Placement {
  readonly eid: number;
  readonly kind: EntityView['kind'];
  readonly faction: string | null;
  readonly target: Point;
  readonly wounded: boolean;
  readonly sleeping: boolean;
  readonly carrying: boolean;
  readonly inCombat: boolean;
  readonly alive: boolean;
  readonly task: number | null;
}

/**
 * Целевые размещения всех сущностей кадра: стационарные кластеризуются в узле,
 * движущиеся интерполируются вдоль ребра loc→dest по остатку `etaTicks`. `tracker`
 * помнит полную длину текущего перехода (макс. наблюдённый eta) — презентационное
 * состояние (закон №8), на мир не влияет.
 */
export function computePlacements(
  view: WorldView,
  w: number,
  h: number,
  tracker: Map<number, { dest: number; maxEta: number }>,
): Placement[] {
  // Стационарные группируем по локации для кластерной раскладки.
  const stationaryByLoc = new Map<number, number>();
  for (const e of view.entities) {
    const moving = e.dest !== null && e.dest !== e.loc;
    if (!moving) stationaryByLoc.set(e.loc, (stationaryByLoc.get(e.loc) ?? 0) + 1);
  }
  const seenIndex = new Map<number, number>();

  const out: Placement[] = [];
  for (const e of view.entities) {
    const fromPos = nodeLayout(VISUAL_CONFIG, e.loc);
    if (fromPos === null) continue; // незнакомая локация — не рисуем (робастность)
    const from = layoutToPixels(fromPos, w, h, PAD_PX);

    let target: Point;
    const moving = e.dest !== null && e.dest !== e.loc;
    if (moving) {
      const destLayout = nodeLayout(VISUAL_CONFIG, e.dest as number);
      if (destLayout === null) {
        target = from;
        tracker.delete(e.eid);
      } else {
        const to = layoutToPixels(destLayout, w, h, PAD_PX);
        let entry = tracker.get(e.eid);
        if (entry === undefined || entry.dest !== e.dest) {
          entry = { dest: e.dest as number, maxEta: e.etaTicks };
          tracker.set(e.eid, entry);
        } else if (e.etaTicks > entry.maxEta) {
          entry.maxEta = e.etaTicks;
        }
        const t = edgeProgress(e.etaTicks, entry.maxEta);
        target = lerpPoint(from, to, t);
      }
    } else {
      tracker.delete(e.eid);
      const count = stationaryByLoc.get(e.loc) ?? 1;
      const idx = seenIndex.get(e.loc) ?? 0;
      seenIndex.set(e.loc, idx + 1);
      const off = clusterOffset(idx, count, CLUSTER_RADIUS_PX);
      target = { x: from.x + off.x, y: from.y + off.y };
    }

    out.push({
      eid: e.eid,
      kind: e.kind,
      faction: e.faction,
      target,
      wounded: isWounded(VISUAL_CONFIG, e.hpFrac, e.alive),
      sleeping: isSleeping(e.task),
      carrying: e.carrying,
      inCombat: e.inCombat,
      alive: e.alive,
      task: e.task,
    });
  }
  return out;
}

/** Нарисовать геометрическую форму глифа (форма = ТИП сущности). */
function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: GlyphShape,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const r = size / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  switch (shape) {
    case 'circle':
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
      break;
    case 'square':
      ctx.fillRect(x - r, y - r, size, size);
      break;
    case 'triangle':
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      ctx.fill();
      break;
    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      break;
    case 'cross':
      ctx.lineWidth = Math.max(2, r * 0.6);
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r);
      ctx.lineTo(x, y + r);
      ctx.stroke();
      ctx.lineWidth = 1;
      break;
    default:
      // Неизвестная форма (append-only union) — кружок-фолбэк.
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
  }
}

/** Нарисовать один глиф с модификаторами состояния поверх формы. */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  p: Placement,
  nowMs: number,
  selected: boolean,
): void {
  const cfg = VISUAL_CONFIG;
  const glyph = glyphForKind(cfg, p.kind);
  const color = colorForEntity(cfg, { kind: p.kind, faction: p.faction });
  const { x, y } = p.target;
  const size = glyph.sizePx;
  const r = size / 2;

  ctx.save();
  // Труп — полупрозрачный; «в бою» — мигание (пульсация альфы).
  let alpha = 1;
  if (!p.alive) alpha = cfg.modifiers.corpseAlpha;
  else if (p.inCombat) alpha = combatAlpha(cfg, nowMs);
  ctx.globalAlpha = alpha;

  drawShape(ctx, glyph.shape, x, y, size, color);

  // Ранен — красная обводка кольцом.
  if (p.wounded) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = cfg.modifiers.woundedRingColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r + 2.5, 0, 2 * Math.PI);
    ctx.stroke();
  }
  // Несёт ценный груз — точка над глифом.
  if (p.carrying) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = cfg.modifiers.carryDotColor;
    ctx.beginPath();
    ctx.arc(x, y - r - 3, 1.8, 0, 2 * Math.PI);
    ctx.fill();
  }
  // Спит — «zzz» над глифом.
  if (p.sleeping) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = cfg.palette.dim;
    ctx.font = `${Math.round(size * 0.8)}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(cfg.modifiers.sleepGlyph, x + r, y - r);
  }
  // Выбрана (слежение/инспекция) — тонкое белёсое кольцо.
  if (selected) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = cfg.palette.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.restore();
}

/** Экранная позиция узла локации (или `null`, если id вне раскладки). */
function nodePx(loc: number, w: number, h: number): Point | null {
  const pos = nodeLayout(VISUAL_CONFIG, loc);
  if (pos === null) return null;
  return layoutToPixels(pos, w, h, PAD_PX);
}

/**
 * Нарисовать череп места смерти на узле: символ с альфой затухания (за сутки, игровой
 * tick) + счётчик «×N» стопки смертей. Символ/микро-геометрия — презентационная мелочь
 * (как формы глифов); цвет/размер — из narrative-config (закон №10).
 */
function drawDeathMarker(ctx: CanvasRenderingContext2D, m: DeathMarker, w: number, h: number): void {
  const p = nodePx(m.loc, w, h);
  if (p === null || m.alpha <= 0) return;
  const s = VISUAL_CONFIG.narrative.skull;
  ctx.save();
  ctx.globalAlpha = m.alpha;
  ctx.fillStyle = s.color;
  ctx.font = `${s.sizePx}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(s.glyph, p.x, p.y - s.offsetPx);
  if (m.count > 1) {
    ctx.fillStyle = s.countColor;
    ctx.font = `${Math.round(s.sizePx * 0.7)}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`×${m.count}`, p.x + s.sizePx * 0.5, p.y - s.offsetPx);
  }
  ctx.restore();
}

/**
 * Нарисовать вспышку локации боя: пульсирующее (wall-clock) кольцо вокруг узла, пока
 * бой «свеж» в окне тиков. Активность — из лога (игровой tick), пульс — от `nowMs`
 * (презентация, как мигание «в бою» 4.2).
 */
function drawCombatFlash(ctx: CanvasRenderingContext2D, f: CombatFlash, w: number, h: number, nowMs: number): void {
  const p = nodePx(f.loc, w, h);
  if (p === null) return;
  const c = VISUAL_CONFIG.narrative.combatFlash;
  const phase = ((nowMs % c.periodMs) / c.periodMs) * 2 * Math.PI;
  const wave = (Math.cos(phase) + 1) / 2; // 0..1
  const alpha = c.minAlpha + (1 - c.minAlpha) * wave;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = c.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, c.radiusPx, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

/** Нарисовать статичный слой: рёбра графа + узлы-локации с именами. */
function drawStatic(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const cfg = VISUAL_CONFIG;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cfg.palette.background;
  ctx.fillRect(0, 0, w, h);

  // Рёбра.
  ctx.strokeStyle = cfg.palette.edge;
  ctx.lineWidth = 1;
  for (const [a, b] of cfg.edges) {
    const pa = nodeLayout(cfg, a);
    const pb = nodeLayout(cfg, b);
    if (pa === null || pb === null) continue;
    const A = layoutToPixels(pa, w, h, PAD_PX);
    const B = layoutToPixels(pb, w, h, PAD_PX);
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
  }

  // Узлы + имена.
  ctx.font = `${cfg.palette.labelPx}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const key of Object.keys(cfg.layout)) {
    const pos = cfg.layout[key];
    if (pos === undefined) continue;
    const P = layoutToPixels(pos, w, h, PAD_PX);
    ctx.fillStyle = cfg.palette.nodeFill;
    ctx.strokeStyle = cfg.palette.nodeStroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(P.x, P.y, cfg.palette.nodeRadiusPx, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    // Имя из контента (getLocation — публичное чтение /sim).
    let name = key;
    try {
      name = getLocation(Number(key) as LocationId).name;
    } catch {
      /* незнакомый id — оставляем ключ (робастность) */
    }
    ctx.fillStyle = cfg.palette.text;
    ctx.fillText(name, P.x, P.y + cfg.palette.nodeRadiusPx + 3);
  }
}

const containerStyle: CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
};
const canvasStyle: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
const hudStyle: CSSProperties = {
  position: 'absolute',
  top: '0.4rem',
  left: '0.6rem',
  pointerEvents: 'none',
  fontSize: '11px',
  lineHeight: 1.5,
  color: '#c8bfae',
  textShadow: '0 1px 2px #000',
};
const tooltipStyleBase: CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
  background: '#1b1815',
  border: '1px solid #2a2621',
  padding: '2px 6px',
  fontSize: '11px',
  color: '#c8bfae',
  whiteSpace: 'nowrap',
  transform: 'translate(8px, 8px)',
};
// Кнопка «следить» (пример армейской панели: приглушённо, без неона).
const followBtnStyle: CSSProperties = {
  position: 'absolute',
  top: '0.4rem',
  right: '0.5rem',
  background: '#1b1815',
  border: '1px solid #2a2621',
  color: '#c8bfae',
  font: '11px ui-monospace, monospace',
  padding: '2px 8px',
  cursor: 'pointer',
};
// Радио-тост: моноширинная плашка у узла говорящего (штабной эфир, приглушённо).
const toastStyleBase: CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
  background: VISUAL_CONFIG.narrative.toast.bg,
  border: `1px solid ${VISUAL_CONFIG.narrative.toast.border}`,
  color: VISUAL_CONFIG.narrative.toast.text,
  font: '11px/1.35 ui-monospace, monospace',
  padding: '2px 6px',
  maxWidth: `${VISUAL_CONFIG.narrative.toast.maxWidthPx}px`,
  transform: 'translate(-50%, 0)',
  whiteSpace: 'normal',
  wordBreak: 'break-word',
  boxShadow: '0 1px 4px #000a',
};
const toastSpeakerStyle: CSSProperties = { color: VISUAL_CONFIG.narrative.toast.speaker };

/** Внутриигровое время суток из тика (1 тик = 1 минута, TICKS_PER_DAY=1440). */
function clock(tick: number): string {
  const m = tick % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Компонент карты. Подписан на `view` для HUD (дешёвый ре-рендер на снапшот); слои
 * canvas рисуются через rAF чтением `useUiStore.getState()` — вне React-цикла, чтобы
 * темп ×600 не гонял реконсиляцию. Клик → `inspect`; наведение → тултип.
 */
export default function MapCanvas(): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const dynamicRef = useRef<HTMLCanvasElement | null>(null);

  // Презентационное состояние вне React (не триггерит ре-рендер).
  const trackerRef = useRef<Map<number, { dest: number; maxEta: number }>>(new Map());
  const displayRef = useRef<Map<number, Point>>(new Map());
  const candidatesRef = useRef<HitCandidate[]>([]);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  // Сдвиг «камеры» слежения (презентация, закон №8) — вне React, читается в rAF/render.
  const cameraRef = useRef<Point>({ x: 0, y: 0 });
  const toastQueueRef = useRef<ToastQueue>(EMPTY_TOAST_QUEUE);

  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  // Видимые радио-тосты (wall-clock очередь) — реактивно, чтобы плашки появлялись/гасли.
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  // HUD-поля (реактивно).
  const view = useUiStore((s) => s.view);
  const selectedEid = useUiStore((s) => s.selectedEid);
  const following = useUiStore((s) => s.following);
  const names = useUiStore((s) => s.names);

  // ── Замер размера + статичный слой (перерисовка только при ресайзе) ─────────
  useEffect(() => {
    const container = containerRef.current;
    const staticCanvas = staticRef.current;
    const dynamicCanvas = dynamicRef.current;
    if (container === null || staticCanvas === null || dynamicCanvas === null) return;

    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;

    const resize = (): void => {
      // В jsdom clientWidth/Height = 0 → фолбэк-размер, чтобы отрисовка выполнилась.
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      sizeRef.current = { w, h };
      for (const c of [staticCanvas, dynamicCanvas]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const sctx = safeGetContext(staticCanvas);
      if (sctx !== null) {
        sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawStatic(sctx, w, h);
      }
    };
    resize();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resize);
      ro.observe(container);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', resize);
    }
    return () => {
      if (ro !== null) ro.disconnect();
      else if (typeof window !== 'undefined') window.removeEventListener('resize', resize);
    };
  }, []);

  // ── Динамичный слой (rAF: интерполяция + догон + модификаторы) ──────────────
  useEffect(() => {
    const dynamicCanvas = dynamicRef.current;
    if (dynamicCanvas === null) return;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;

    const frame = (nowMs: number): void => {
      const ctx = safeGetContext(dynamicCanvas);
      const { w, h } = sizeRef.current;
      if (ctx === null || w === 0) {
        // размер ещё не замерен — пропускаем кадр
        rafId = requestAnimationFrameSafe(frame);
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const st = useUiStore.getState();
      const v = st.view;
      const sel = st.selectedEid;
      const selNum = sel === null ? null : (sel as unknown as number);
      const following = st.following;
      const cands: HitCandidate[] = [];

      if (v !== null) {
        const placements = computePlacements(v, w, h, trackerRef.current);
        // Прунинг презентационных карт: держим только присутствующие eid.
        const present = new Set(placements.map((p) => p.eid));
        for (const key of displayRef.current.keys()) if (!present.has(key)) displayRef.current.delete(key);
        for (const key of trackerRef.current.keys()) if (!present.has(key)) trackerRef.current.delete(key);

        // ── СЛЕЖЕНИЕ: центрирующий сдвиг «камеры» к выбранной сущности (закон №8:
        //    двигает лишь ВИД). Цель берём из прошлого display выбранной (плавно),
        //    иначе — из целевой позиции этого кадра. Не следим — сдвиг гаснет к 0.
        let desiredCam: Point = { x: 0, y: 0 };
        if (following && selNum !== null) {
          const selP = placements.find((p) => p.eid === selNum);
          if (selP !== undefined) {
            const at = displayRef.current.get(selNum) ?? selP.target;
            desiredCam = followOffset(at, { x: w / 2, y: h / 2 });
          }
        }
        const prevCam = cameraRef.current;
        const cam: Point = {
          x: prevCam.x + (desiredCam.x - prevCam.x) * CAM_SMOOTH,
          y: prevCam.y + (desiredCam.y - prevCam.y) * CAM_SMOOTH,
        };
        cameraRef.current = cam;
        const panning = cam.x !== 0 || cam.y !== 0;
        // Статичный граф панорамируем ДЁШЕВО через CSS-transform (без перерисовки слоя).
        if (staticRef.current !== null) {
          staticRef.current.style.transform = panning ? `translate(${cam.x}px, ${cam.y}px)` : '';
        }
        // Весь динамичный слой (глифы+оверлеи) под тем же сдвигом. Не следим (cam=0) —
        // translate НЕ трогаем (сохраняем поведение слоя без камеры).
        if (panning) ctx.translate(cam.x, cam.y);

        for (const p of placements) {
          // rAF-догон отрисованной позиции к целевой (плавность между снапшотами).
          const prev = displayRef.current.get(p.eid);
          const disp: Point =
            prev === undefined
              ? p.target
              : {
                  x: prev.x + (p.target.x - prev.x) * SMOOTH,
                  y: prev.y + (p.target.y - prev.y) * SMOOTH,
                };
          displayRef.current.set(p.eid, disp);
          const drawn: Placement = { ...p, target: disp };
          const isSel = selNum !== null && selNum === p.eid;
          drawGlyph(ctx, drawn, nowMs, isSel);
          const glyph = glyphForKind(VISUAL_CONFIG, p.kind);
          // Хит-кандидаты — в ЭКРАННЫХ координатах (с учётом сдвига камеры).
          cands.push({ eid: p.eid, x: disp.x + cam.x, y: disp.y + cam.y, r: glyph.sizePx / 2 + 4 });
        }

        // ── НАРРАТИВНЫЕ ОВЕРЛЕИ из окна лога (презентация, чистое чтение) ─────────
        const tick = v.tick as unknown as number;
        const locOf = (eid: number): number | null => {
          const e = v.entities.find((x) => (x.eid as unknown as number) === eid);
          return e === undefined ? null : (e.loc as unknown as number);
        };
        for (const m of collectDeathMarkers(st.log, tick, TICKS_PER_DAY, locOf)) {
          drawDeathMarker(ctx, m, w, h);
        }
        const flashTicks = VISUAL_CONFIG.narrative.combatFlash.flashTicks;
        for (const f of collectCombatFlashes(st.log, tick, flashTicks)) {
          drawCombatFlash(ctx, f, w, h, nowMs);
        }
      }
      candidatesRef.current = cands;
      rafId = requestAnimationFrameSafe(frame);
    };

    let rafId = requestAnimationFrameSafe(frame);
    return () => cancelAnimationFrameSafe(rafId);
  }, []);

  // ── РАДИО-ТОСТ: очередь на РЕАЛЬНОМ времени (wall-clock, презентация, закон №8) ──
  // Тик очереди — на ИНТЕРВАЛЕ (плашки живут секунды — 60 FPS ни к чему; и не мешаем
  // rAF-слою рендера): втягивает НОВЫЕ radio/message из лога (id-водомер), запускает
  // 3-сек таймеры без наложения, снимает истёкшие. Стартовый водомер = max id текущего
  // лога → бэклог НЕ переигрывается, всплывают лишь новые сообщения после монтажа.
  useEffect(() => {
    const cfg = VISUAL_CONFIG.narrative.toast;
    toastQueueRef.current = { items: [], lastId: maxEventId(useUiStore.getState().log) };

    const tick = (): void => {
      const st = useUiStore.getState();
      const now = nowMsSafe();
      let q = toastQueueRef.current;
      const incoming = buildRadioToasts(st.log, st.names, q.lastId);
      if (incoming.length > 0) q = enqueueToasts(q, incoming);
      q = stepToastQueue(q, now, { durationMs: cfg.durationMs, maxVisible: cfg.maxVisible });
      toastQueueRef.current = q;
      const vis = visibleToasts(q);
      // Обновляем React-состояние только при СМЕНЕ набора видимых id (иначе лишний ре-рендер).
      setToasts((prev) => (sameToastIds(prev, vis) ? prev : vis));
    };
    if (typeof setInterval !== 'function') return;
    const id = setInterval(tick, TOAST_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // ── Взаимодействие: клик → inspect, наведение → тултип ──────────────────────
  const localXY = (clientX: number, clientY: number): Point | null => {
    const container = containerRef.current;
    if (container === null) return null;
    const rect = container.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const onClick = (ev: React.MouseEvent): void => {
    const pt = localXY(ev.clientX, ev.clientY);
    if (pt === null) return;
    const eid = hitTest(candidatesRef.current, pt.x, pt.y);
    if (eid !== null) {
      useUiStore.getState().inspect(eid as EntityId);
    }
  };

  const onMove = (ev: React.MouseEvent): void => {
    const pt = localXY(ev.clientX, ev.clientY);
    if (pt === null) return;
    const eid = hitTest(candidatesRef.current, pt.x, pt.y);
    if (eid === null) {
      if (tooltip !== null) setTooltip(null);
      return;
    }
    const st = useUiStore.getState();
    const e = st.view?.entities.find((x) => (x.eid as unknown as number) === eid);
    if (e === undefined) return;
    setTooltip({ x: pt.x, y: pt.y, text: tooltipLabel(e, st.names, KIND_LABEL, TASK_LABEL) });
  };

  const onLeave = (): void => setTooltip(null);

  // Тумблер слежения (закон №8: только команда презентации setFollowing, не воркеру).
  const onToggleFollow = (): void => {
    const st = useUiStore.getState();
    if (st.selectedEid === null) return;
    st.setFollowing(!st.following);
  };

  // HUD-значения.
  const day = view?.day ?? 0;
  const tick = view?.tick ?? 0;
  const weatherKey = WEATHER_TYPES[view?.weather ?? 0] ?? 'clear';
  const weather = WEATHER_LABEL[weatherKey] ?? weatherKey;
  const pop = view?.population ?? { humans: 0, animals: 0, corpses: 0 };
  const total = view?.entities.length ?? 0;

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      onClick={onClick}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      data-testid="map-canvas"
    >
      <canvas ref={staticRef} style={canvasStyle} />
      <canvas ref={dynamicRef} style={canvasStyle} />
      <div style={hudStyle}>
        <div>
          День {day} · {clock(tick)} · {weather}
        </div>
        <div>
          население {total} (люди {pop.humans} · звери {pop.animals} · трупы {pop.corpses})
        </div>
        {selectedEid !== null ? (
          <div>
            выбран #{selectedEid as unknown as number}
            {following ? ' · ведём' : ''}
          </div>
        ) : null}
      </div>

      {/* Режим слежения: клик по сущности выбирает её, кнопка ведёт камеру (закон №8). */}
      <button
        type="button"
        style={{
          ...followBtnStyle,
          color: following ? '#a9b56b' : selectedEid !== null ? '#c8bfae' : '#5f5a4e',
          borderColor: following ? '#4a5a2e' : '#2a2621',
          cursor: selectedEid !== null ? 'pointer' : 'default',
        }}
        onClick={onToggleFollow}
        disabled={selectedEid === null}
        data-testid="map-follow"
        aria-pressed={following}
      >
        {following ? '● слежу' : '○ следить'}
      </button>

      {/* Радио-тосты: последние озвучки у узла говорящего, 3 сек, стопкой без наложения. */}
      {toasts.map((t, i) => {
        const anchor = toastAnchor(t, sizeRef.current, cameraRef.current, i);
        if (anchor === null) return null;
        return (
          <div
            key={t.id}
            style={{ ...toastStyleBase, left: anchor.x, top: anchor.y }}
            data-testid="map-toast"
          >
            <span style={toastSpeakerStyle}>{nameForToast(names, t.speakerEid)}</span>
            <span>: {t.text}</span>
          </div>
        );
      })}

      {tooltip !== null ? (
        <div style={{ ...tooltipStyleBase, left: tooltip.x, top: tooltip.y }}>{tooltip.text}</div>
      ) : null}
    </div>
  );
}

/** Экранный якорь тоста: узел говорящего + сдвиг камеры, со стопкой по индексу i. */
function toastAnchor(
  t: Toast,
  size: { w: number; h: number },
  cam: Point,
  i: number,
): Point | null {
  const cfg = VISUAL_CONFIG.narrative.toast;
  const { w, h } = size;
  if (w === 0) return null;
  const stackDy = i * (22 + cfg.gapPx); // вертикальная стопка (без наложения плашек)
  if (t.loc === null) {
    return { x: w / 2, y: cfg.offsetPx + stackDy };
  }
  const p = nodePx(t.loc, w, h);
  if (p === null) return { x: w / 2, y: cfg.offsetPx + stackDy };
  return { x: p.x + cam.x, y: p.y + cam.y - cfg.offsetPx - stackDy };
}

/** Имя говорящего для плашки тоста (кличка → «Имя Фамилия» → `#eid`, D-081). */
function nameForToast(names: Readonly<Record<number, EntityName>>, eid: number): string {
  const n = names[eid];
  if (n === undefined) return `#${eid}`;
  if (n.nickname.length > 0) return n.nickname;
  return `${n.first} ${n.last}`.trim();
}

/**
 * Безопасно получить 2D-контекст: среды без поддержки canvas (jsdom без npm-пакета
 * `canvas`) БРОСАЮТ из `getContext`, а не возвращают null. Глотаем — карта деградирует
 * до HUD/интерактива без отрисовки, но не роняет приложение (робастность).
 */
function safeGetContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/**
 * Wall-clock ms для очереди тостов (презентация, закон №8: как rAF-время, НЕ время
 * мира). Использует `performance.now`/`Date.now` — это UI-таймер плашек, а НЕ RNG/тик
 * симуляции (запрет Date.now касается ЯДРА, не наблюдателя).
 */
function nowMsSafe(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/** Совпадают ли наборы видимых тостов по id (чтобы не плодить лишние ре-рендеры). */
function sameToastIds(a: readonly Toast[], b: readonly Toast[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id) return false;
  return true;
}

// ── rAF-обёртки с фолбэком (jsdom/тесты без rAF) ─────────────────────────────
function requestAnimationFrameSafe(cb: (t: number) => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  return setTimeout(() => cb(Date.now()), 16) as unknown as number;
}
function cancelAnimationFrameSafe(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}
