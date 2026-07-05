/**
 * @module @zona/ui/chronicle/ChronicleLog
 *
 * ПАНЕЛЬ ЛЕТОПИСИ мира (задача 4.4, D-068, GDD §10) — «legends mode» наблюдателя: лента
 * ЗНАЧИМЫХ событий строками «День N: <описание>» (гибель именитого сталкера, заброшенное
 * поселение, крупный бой). Читает ОТДЕЛЬНЫЙ буфер летописи стора (`chronicleLog` —
 * события `chronicle/recorded`, редкие ⇒ переживают шум эфира; см. store.ts) и рендерит
 * каждую запись из её payload (`kind` + `subjects` + `loc`). Клик по записи РАСКРУЧИВАЕТ
 * причинную цепочку назад (§10.1) по окну лога; клик по имени субъекта → инспектор.
 *
 * ── ЗАКОН №5 (DOM только в /ui) ──────────────────────────────────────────────
 * DOM/React живут ЗДЕСЬ. Из `@zona/sim` берём лишь ПУБЛИЧНОЕ ЧИСТОЕ ЧТЕНИЕ контента
 * (`getLocation` — имя локации, `parseSubject` — декод `Subject`) — как
 * RadioLog/Inspector. НИ ОДНА система симуляции не импортируется. Из `@zona/shared` —
 * plain-контракт `SimEvent`.
 *
 * ── ЗАКОН №8 / D-006 (летопись — читатель) ───────────────────────────────────
 * Рендер — ЧИСТОЕ чтение стора (`chronicleLog`/`log`/`names`): те же данные → та же
 * разметка (ни rng, ни Date.now). Панель на симуляцию НЕ влияет. Единственная команда
 * наружу — `inspect(eid)` по клику на имени (read-only запрос детали, D-076).
 *
 * ── ЗАКОН №10 (подписи — не выдумка) ─────────────────────────────────────────
 * Тексты записей НЕ хранит контент: строку собираем из СТРУКТУРНОГО `kind` (презентационная
 * подпись `CHRONICLE_KIND_LABEL`, как `WEATHER_LABEL`/`TASK_LABEL`) + резолва субъектов/
 * локации. Никакого выдуманного нарратива — только человекочитаемая метка типа события.
 *
 * ── РАСКРУТКА ПРИЧИН: ВАРИАНТ A (по окну лога, MVP) ──────────────────────────
 * `unrollCauses(bus,id)` из @zona/sim требует `EventBus` — у UI его нет (закон №5: шина
 * живёт в воркере). Вместо нового канала к воркеру (вариант B) раскручиваем цепочку по
 * ОКНУ лога стора (`log`): от значимого события (`record.eventId`) идём по `causedBy` назад,
 * пока причина НАХОДИТСЯ в окне. Причина вытеснена кольцевым буфером ⇒ помечаем обрыв
 * «…(причина за пределами окна)». Окно (LOG_WINDOW=1000) обычно держит недавние причины —
 * для MVP достаточно; при обрыве наблюдатель явно предупреждён. Контракт воркера НЕ расширяем.
 *
 * ```mermaid
 * flowchart TD
 *   STORE["store.chronicleLog<br/>(chronicle/recorded)"] --> ROWS["записи «День N: …»"]
 *   ROWS -->|клик по записи| CHAIN["раскрутка причин по store.log<br/>(causedBy назад, вариант A)"]
 *   ROWS -->|клик по субъекту| INSPECT["store.inspect(eid)"]
 *   CHAIN -.обрыв за окном.-> MARK["…(причина за пределами окна)"]
 * ```
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { EntityId, LocationId, SimEvent, Subject } from '@zona/shared';
import { getLocation, parseSubject } from '@zona/sim';
import { useUiStore } from '../store/store';
import { makeNameOf } from '../radio/RadioLog';
import { resolveRecentEvent } from '../inspector/Inspector';

/** Летописная запись (событие `chronicle/recorded`). */
type ChronicleRecord = Extract<SimEvent, { type: 'chronicle/recorded' }>;

/** Сколько последних записей летописи рендерить (презентационное окно, не balance). */
const RENDER_WINDOW = 300;
/** Порог «у низа» для умного автоскролла (px): ближе — липнем, дальше — отпускаем. */
const NEAR_BOTTOM_PX = 24;
/**
 * Порог «высокой» значимости для яркой подачи записи (презентация, не balance). Значимость
 * ∈ [0..1] несёт сам record; ярче — заметнее в ленте (легенды выделяются). Не влияет на мир.
 */
const HIGH_SIGNIFICANCE = 0.66;

/**
 * Русские подписи ТИПА значимого события для летописной строки (презентация по
 * СТРУКТУРНОМУ `kind`, как `TASK_LABEL`/`WEATHER_LABEL` — закон №10 про контент, не про метки
 * типов). Нарративный тон «легенд» (бой/гибель/поселение покинуто), отличный от терсе-меток
 * инспектора. Неизвестный `kind` (append-only union) → сам код (робастность).
 */
const CHRONICLE_KIND_LABEL: Readonly<Record<string, string>> = {
  'entity/died': 'гибель',
  'encounter/started': 'бой завязался',
  'encounter/resolved': 'бой',
  'loot/transferred': 'ограбление',
  'settlement/abandoned': 'поселение покинуто',
  'settlement/built': 'стройка завершена',
  'trade/executed': 'сделка',
  'artifact/collected': 'найден артефакт',
  'artifact/spawned': 'рождён артефакт',
  'population/arrived': 'приход в Зону',
  'animal/born': 'рождение',
  'corpse/created': 'смерть',
};

// ── Палитра (согласована с App/RadioLog/Inspector: тёмный фон рации, приглушённо) ──
const C = {
  text: '#c8bfae',
  dim: '#7d7566',
  faint: '#5f5a4e',
  high: '#c9c0ac', // яркая запись (высокая значимость)
  low: '#8a8372', // рутинная запись (низкая значимость)
  day: '#8a9a5b', // «День N» — армейский зелёный
  subject: '#a9b56b', // имя субъекта — кликабельно
  loc: '#7d7566',
  panel: '#1b1815',
  border: '#2a2621',
  accent: '#8a9a5b',
  chain: '#8a8372', // цепочка причин — приглушённо
} as const;

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' };
const scrollBox: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  font: '12px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const entryStyle: CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '2px 0', cursor: 'pointer' };
const dayStyle: CSSProperties = { color: C.day };
const subjectStyle: CSSProperties = { color: C.subject, cursor: 'pointer', textDecoration: 'none' };
const locStyle: CSSProperties = { color: C.loc };
const emptyStyle: CSSProperties = { color: C.dim, fontStyle: 'italic' };
const chainBox: CSSProperties = {
  margin: '1px 0 3px 1rem',
  paddingLeft: '0.6rem',
  borderLeft: `1px solid ${C.border}`,
  color: C.chain,
  fontSize: '11px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
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

// ── ЧИСТЫЕ хелперы (экспортированы для юнит-тестов БЕЗ DOM) ───────────────────

/** Летописная запись? (union-гвард по дискриминанту type). */
export function isChronicle(ev: SimEvent): ev is ChronicleRecord {
  return ev.type === 'chronicle/recorded';
}

/** Подпись типа значимого события; неизвестный `kind` → сам код (робастность). */
export function chronicleKindLabel(kind: string): string {
  return CHRONICLE_KIND_LABEL[kind] ?? kind;
}

/** Имя локации из контента; незнакомая — `#id` (робастность). */
function locName(loc: number): string {
  try {
    return getLocation(loc as never).name;
  } catch {
    return `#${loc}`;
  }
}

/**
 * Отсортированные ЗАПИСИ летописи из буфера: по дню, затем тику, затем id записи (стабильно,
 * детерминизм — закон №8). Буфер уже приходит в порядке публикации, сортировка страхует.
 * Дорезаем видимое окно (RENDER_WINDOW): свежие записи ВНИЗУ (автоскролл липнет к низу).
 */
export function buildEntries(chronicleLog: readonly SimEvent[]): ChronicleRecord[] {
  const records = chronicleLog.filter(isChronicle);
  records.sort((a, b) => {
    if (a.payload.day !== b.payload.day) return a.payload.day - b.payload.day;
    if (a.tick !== b.tick) return (a.tick as number) - (b.tick as number);
    return (a.id as number) - (b.id as number);
  });
  return records.length > RENDER_WINDOW ? records.slice(records.length - RENDER_WINDOW) : records;
}

/**
 * РАСКРУТКА причинной цепочки (вариант A, §10.1): от значимого события `startEventId` идём по
 * `causedBy` назад ПО ОКНУ лога стора. Возвращает id-цепочку `[значимое, причина, …]` и флаг
 * `truncated` — оборвана ли за пределами окна (причина вытеснена кольцевым буфером). Корень
 * (`causedBy === null`) обрывом НЕ считается. Гвард по длине окна: id причины строго меньше id
 * следствия ⇒ прогресс гарантирован, циклов нет. Стартовое событие вне окна → пустая цепочка + truncated.
 */
export function unrollChainInWindow(
  startEventId: number,
  log: readonly SimEvent[],
): { readonly ids: number[]; readonly truncated: boolean } {
  const byId = new Map<number, SimEvent>();
  for (const ev of log) byId.set(ev.id as unknown as number, ev);

  const ids: number[] = [];
  let current: number | null = startEventId;
  const guard = log.length + 1;
  for (let steps = 0; current !== null && steps < guard; steps++) {
    const ev = byId.get(current);
    if (ev === undefined) return { ids, truncated: true }; // причина вытеснена из окна
    ids.push(ev.id as unknown as number);
    current = ev.causedBy as unknown as number | null;
  }
  return { ids, truncated: false };
}

/** Маркер обрыва цепочки за окном лога (презентационная подпись). */
export const CHAIN_TRUNCATED = '…(причина за пределами окна)';

/**
 * ПАНЕЛЬ ЛЕТОПИСИ. Подписана на `chronicleLog`/`log`/`names` стора (дешёвый ре-рендер на
 * дельту). Клик по записи разворачивает/сворачивает причинную цепочку (по окну лога, вариант A);
 * клик по имени субъекта → `inspect(eid)`. Автоскролл к низу — как эфир (липнем, пока пользователь там).
 */
export default function ChronicleLog(): ReactElement {
  const chronicleLog = useUiStore((s) => s.chronicleLog);
  const log = useUiStore((s) => s.log);
  const names = useUiStore((s) => s.names);
  const inspect = useUiStore((s) => s.inspect);

  // Развёрнутая запись (по recordId) — раскрутка причин по клику. null — все свёрнуты.
  const [openId, setOpenId] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const entries = useMemo(() => buildEntries(chronicleLog), [chronicleLog]);
  const nameOf = useMemo(() => makeNameOf(names), [names]);

  // Умный автоскролл: после обновления ленты липнем к низу ТОЛЬКО если пользователь там.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

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

  /** Кликабельные субъекты записи: сущность → имя (→ inspect), фракция → «фракция X». */
  const renderSubjects = (subjects: readonly Subject[]): ReactElement[] => {
    const out: ReactElement[] = [];
    subjects.forEach((s, i) => {
      const p = parseSubject(s);
      if (i > 0) out.push(<span key={`sep-${i}`}>, </span>);
      if (p.kind === 'entity') {
        const eid = p.eid as unknown as number;
        out.push(
          <span
            key={`sub-${i}`}
            style={subjectStyle}
            role="button"
            data-testid="chronicle-subject"
            data-eid={eid}
            onClick={(e) => {
              e.stopPropagation(); // не сворачивать/разворачивать запись при клике по имени
              inspect(eid as unknown as EntityId);
            }}
          >
            {nameOf(eid)}
          </span>,
        );
      } else {
        out.push(
          <span key={`sub-${i}`} style={{ color: C.dim }}>
            фракция {p.faction as unknown as string}
          </span>,
        );
      }
    });
    return out;
  };

  /** Раскрутка причин записи (вариант A): цепочка строк из окна лога + пометка обрыва. */
  const renderChain = (record: ChronicleRecord): ReactElement => {
    const start = record.payload.eventId as unknown as number;
    const { ids, truncated } = unrollChainInWindow(start, log);
    return (
      <div style={chainBox} data-testid="chronicle-chain">
        {ids.length === 0 ? (
          <div>причина не найдена в окне лога</div>
        ) : (
          ids.map((id, i) => (
            <div key={`c-${id}-${i}`} data-testid="chronicle-chain-row">
              {i === 0 ? '' : '← '}
              {resolveRecentEvent(id, log, names)}
            </div>
          ))
        )}
        {truncated ? (
          <div style={{ color: C.faint }} data-testid="chronicle-chain-truncated">
            ← {CHAIN_TRUNCATED}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div style={wrap} data-testid="chronicle-log">
      <div ref={scrollRef} style={scrollBox} onScroll={onScroll} data-testid="chronicle-scroll">
        {entries.length === 0 ? (
          <div style={emptyStyle} data-testid="chronicle-empty">
            …летопись пока пуста — значимых событий не случилось…
          </div>
        ) : (
          entries.map((rec) => {
            const p = rec.payload;
            const recordId = rec.id as unknown as number;
            const high = p.significance >= HIGH_SIGNIFICANCE;
            const open = openId === recordId;
            const loc = p.loc as unknown as LocationId | undefined;
            return (
              <div key={recordId}>
                <div
                  style={{ ...entryStyle, color: high ? C.high : C.low, fontWeight: high ? 600 : 400 }}
                  data-testid="chronicle-entry"
                  data-record={recordId}
                  data-significance={high ? 'high' : 'low'}
                  data-open={open ? '1' : '0'}
                  role="button"
                  onClick={() => setOpenId(open ? null : recordId)}
                >
                  <span style={dayStyle}>День {p.day}: </span>
                  <span>{chronicleKindLabel(p.kind)}</span>
                  {p.subjects.length > 0 ? (
                    <>
                      <span> — </span>
                      {renderSubjects(p.subjects)}
                    </>
                  ) : null}
                  {loc !== undefined ? (
                    <span style={locStyle}> · {locName(loc as unknown as number)}</span>
                  ) : null}
                </div>
                {open ? renderChain(rec) : null}
              </div>
            );
          })
        )}
      </div>

      {!atBottom ? (
        <button type="button" style={jumpStyle} onClick={jumpToBottom} data-testid="chronicle-jump">
          ↓ вниз
        </button>
      ) : null}
    </div>
  );
}
