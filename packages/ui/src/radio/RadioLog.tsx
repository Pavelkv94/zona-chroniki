/**
 * @module @zona/ui/radio/RadioLog
 *
 * ПАНЕЛЬ ЭФИРА наблюдателя (задача 4.3, D-069/D-081) — нарративная кульминация
 * интерфейса (GDD §8/§11). Читает окно лога стора, фильтрует радио-события
 * (`radio/message` — личная озвучка, `radio/relayed` — слух), собирает МОНОШИРИННУЮ
 * строку `[День N, ЧЧ:ММ] Имя: текст` через ЧИСТЫЙ `renderMessage` (3.4) и выводит
 * лентой с умным автоскроллом. Эстетика — армейская рация/штабной лог: приглушённо,
 * без неона.
 *
 * ── ЗАКОН №5 (DOM только в /ui) ──────────────────────────────────────────────
 * DOM/React живут ЗДЕСЬ. Из `@zona/sim` берём лишь ПУБЛИЧНОЕ ЧИСТОЕ ЧТЕНИЕ контента
 * (`renderMessage` — plain-строка из templateId+params; `getLocation` — имя локации;
 * `TICKS_PER_DAY` — арифметика времени) — как MapCanvas (4.2). НИ ОДНА система
 * симуляции не импортируется. Из `@zona/shared` — plain-контракт `SimEvent`.
 *
 * ── ЗАКОН №8 / D-006 (эфир — читатель) ───────────────────────────────────────
 * Рендер — чистое чтение стора: строки эфира ДЕТЕРМИНИРОВАНЫ (`renderMessage` чист,
 * D-069 — тот же templateId+params → та же строка). Панель на симуляцию НЕ влияет.
 * Единственная команда наружу — `inspect(speakerEid)` по клику на имени (read-only
 * запрос детали, D-076): передаёт эстафету инспектору (4.5).
 *
 * ── ЗАКОН №10 (тексты — данные) ──────────────────────────────────────────────
 * Тексты реплик собирает `renderMessage` из шаблонов `/sim/data/messages.json` — UI
 * их НЕ хардкодит. Здесь лишь ПРЕЗЕНТАЦИОННЫЕ подписи фильтров/времени.
 *
 * ── РЕЗОЛВ ИМЁН (D-081) ──────────────────────────────────────────────────────
 * `renderMessage.ctx.nameOf(eid)` требует СТРОКУ-имя, но `EntityView`/лог имён НЕ несут
 * (лёгкий снимок). Имена СТАБИЛЬНЫ (задаются при спавне) ⇒ воркер шлёт лёгкий индекс
 * `eid → EntityName` (`exportNames`, дельтой), стор кэширует (`names`). Здесь строим
 * `nameOf`: кличка → «Имя Фамилия» → `#eid` (нет записи). Локацию резолвим
 * `getLocation(loc).name`; `itemOf` не даём (в items.json нет отображаемого имени —
 * `renderMessage` подставит стабильный id предмета).
 *
 * ── УМНЫЙ АВТОСКРОЛЛ ─────────────────────────────────────────────────────────
 * Лента липнет к низу, ПОКА пользователь у низа (в пределах `NEAR_BOTTOM_PX`). Стоит
 * прокрутить вверх (читает прошлое) — автоскролл ОТКЛЮЧАЕТСЯ (не дёргаем), всплывает
 * кнопка «↓ вниз» для возврата. Окно рендера — последние `RENDER_WINDOW` строк (лог
 * на 100 днях огромен; кольцевой буфер стора уже ≤ LOG_WINDOW, здесь дорезаем видимое).
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { EntityId, EntityName, SimEvent } from '@zona/shared';
import { renderMessage, getLocation, TICKS_PER_DAY } from '@zona/sim';
import { useUiStore } from '../store/store';

/** Радио-события эфира (личная озвучка + слух). */
type RadioEvent = Extract<SimEvent, { type: 'radio/message' } | { type: 'radio/relayed' }>;

/** Сколько последних строк эфира рендерить (презентационное окно, не balance). */
const RENDER_WINDOW = 200;
/** Порог «у низа» для умного автоскролла (px): ближе — липнем, дальше — отпускаем. */
const NEAR_BOTTOM_PX = 24;

// ── Палитра (согласована с App: тёмный фон, приглушённые тона рации) ──────────
const C = {
  text: '#c8bfae',
  dim: '#7d7566',
  rumor: '#8a8372', // слух — приглушённее (непроверено)
  speaker: '#a9b56b', // имя говорящего — армейский зелёный, кликабельно
  time: '#5f5a4e',
  panel: '#1b1815',
  border: '#2a2621',
  accent: '#8a9a5b',
} as const;

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' };
const filterBar: CSSProperties = {
  display: 'flex',
  gap: '0.8rem',
  fontSize: '11px',
  color: C.dim,
  paddingBottom: '0.4rem',
  flexWrap: 'wrap',
  alignItems: 'center',
};
const filterLabel: CSSProperties = { display: 'inline-flex', gap: '0.3rem', alignItems: 'center', cursor: 'pointer', userSelect: 'none' };
const scrollBox: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  font: '12px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const rowStyle: CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '1px 0' };
const timeStyle: CSSProperties = { color: C.time };
const speakerStyle: CSSProperties = { color: C.speaker, cursor: 'pointer', textDecoration: 'none' };
const emptyStyle: CSSProperties = { color: C.dim, fontStyle: 'italic' };
const jumpStyle: CSSProperties = {
  position: 'absolute',
  right: '0.6rem',
  bottom: '0.6rem',
  background: C.panel,
  border: `1px solid ${C.border}`,
  color: C.accent,
  font: '11px ui-monospace, monospace',
  padding: '2px 8px',
  cursor: 'pointer',
};

/** Готовая к отрисовке строка эфира. */
interface Row {
  readonly id: number;
  readonly time: string;
  readonly speaker: string;
  readonly speakerEid: EntityId;
  readonly text: string;
  readonly rumor: boolean;
}

/** Радио-событие? (union-гвард по дискриминанту type). */
function isRadio(ev: SimEvent): ev is RadioEvent {
  return ev.type === 'radio/message' || ev.type === 'radio/relayed';
}

/** «[День N, ЧЧ:ММ]» из тика (1 тик = 1 минута, TICKS_PER_DAY). */
export function timeLabel(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY);
  const minuteOfDay = ((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return `День ${day}, ${hh}:${mm}`;
}

/** Резолвер имени: кличка → «Имя Фамилия» → `#eid` (нет записи в индексе). */
export function makeNameOf(names: Readonly<Record<number, EntityName>>): (ref: string | number) => string {
  return (ref) => {
    if (typeof ref === 'string') return ref; // params уже строка — проброс
    const n = names[ref];
    if (n === undefined) return `#${ref}`;
    if (n.nickname.length > 0) return n.nickname;
    return `${n.first} ${n.last}`.trim();
  };
}

/** Имя локации из контента (публичное чтение /sim); незнакомая — `#id` (робастность). */
function locName(loc: number): string {
  try {
    return getLocation(loc as never).name;
  } catch {
    return `#${loc}`;
  }
}

/**
 * ЧИСТО собирает строки эфира из окна лога: фильтр по типу (личное/слух), сборка текста
 * `renderMessage`, префикс времени/имени. Экспортирована для юнит-теста БЕЗ рендера DOM.
 */
export function buildRows(
  log: readonly SimEvent[],
  names: Readonly<Record<number, EntityName>>,
  opts: { readonly showFirsthand: boolean; readonly showRumors: boolean },
): Row[] {
  const nameOf = makeNameOf(names);
  const ctx = { nameOf, locOf: locName };
  const out: Row[] = [];
  for (const ev of log) {
    if (!isRadio(ev)) continue;
    const rumor = ev.payload.isFirsthand === false;
    if (rumor && !opts.showRumors) continue;
    if (!rumor && !opts.showFirsthand) continue;
    out.push({
      id: ev.id as unknown as number,
      time: timeLabel(ev.tick as unknown as number),
      speaker: nameOf(ev.payload.speakerEid),
      speakerEid: ev.payload.speakerEid,
      text: renderMessage({ templateId: ev.payload.templateId, params: ev.payload.params }, ctx),
      rumor,
    });
  }
  // Окно рендера: только последние RENDER_WINDOW (лог огромен на длинных прогонах).
  return out.length > RENDER_WINDOW ? out.slice(out.length - RENDER_WINDOW) : out;
}

/**
 * Панель радиоэфира. Подписана на `log`/`names` стора (дешёвый ре-рендер на дельту);
 * автоскролл — императивно через layout-эффект (липнем к низу, пока пользователь там).
 */
export default function RadioLog(): ReactElement {
  const log = useUiStore((s) => s.log);
  const names = useUiStore((s) => s.names);
  const inspect = useUiStore((s) => s.inspect);

  const [showFirsthand, setShowFirsthand] = useState(true);
  const [showRumors, setShowRumors] = useState(true);
  // atBottom управляет видимостью кнопки «вниз»; pinnedRef — «липнуть ли» в layout-эффекте.
  const [atBottom, setAtBottom] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const rows = useMemo(
    () => buildRows(log, names, { showFirsthand, showRumors }),
    [log, names, showFirsthand, showRumors],
  );

  // Умный автоскролл: после обновления ленты липнем к низу ТОЛЬКО если пользователь там.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = dist <= NEAR_BOTTOM_PX;
    pinnedRef.current = pinned;
    setAtBottom(pinned);
  };

  const jumpToBottom = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div style={wrap} data-testid="radio-log">
      <div style={filterBar}>
        <label style={filterLabel}>
          <input
            type="checkbox"
            checked={showFirsthand}
            onChange={(e) => setShowFirsthand(e.target.checked)}
            data-testid="radio-filter-firsthand"
          />
          сообщения
        </label>
        <label style={filterLabel}>
          <input
            type="checkbox"
            checked={showRumors}
            onChange={(e) => setShowRumors(e.target.checked)}
            data-testid="radio-filter-rumors"
          />
          слухи
        </label>
      </div>

      <div ref={scrollRef} style={scrollBox} onScroll={onScroll} data-testid="radio-scroll">
        {rows.length === 0 ? (
          <div style={emptyStyle}>…тишина в эфире…</div>
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              style={{ ...rowStyle, color: r.rumor ? C.rumor : C.text, fontStyle: r.rumor ? 'italic' : 'normal' }}
              data-testid="radio-row"
              data-rumor={r.rumor ? '1' : '0'}
            >
              <span style={timeStyle}>[{r.time}] </span>
              <span
                style={speakerStyle}
                onClick={() => inspect(r.speakerEid)}
                data-testid="radio-speaker"
                data-eid={r.speakerEid as unknown as number}
                role="button"
              >
                {r.speaker}
              </span>
              <span>: </span>
              <span>{r.text}</span>
              {r.rumor ? <span style={{ color: C.dim }}> (слух)</span> : null}
            </div>
          ))
        )}
      </div>

      {!atBottom ? (
        <button type="button" style={jumpStyle} onClick={jumpToBottom} data-testid="radio-jump">
          ↓ вниз
        </button>
      ) : null}
    </div>
  );
}
