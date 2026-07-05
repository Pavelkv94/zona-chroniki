/**
 * @module @zona/ui/inspector/Inspector
 *
 * ИНСПЕКТОР СУЩНОСТИ (задача 4.5, D-076) — ГЛАВНЫЙ инструмент наблюдателя/отладки
 * (GDD §11: «кликнув на NPC, видишь полное состояние, включая память и отношения»).
 * Рендерит `EntityDetail` из стора глубокими секциями: шапка (имя/вид/фракция/локация),
 * нужды (полоски hunger/thirst/fatigue/fear + hp), задача, инвентарь/деньги/слава,
 * память (о ком/сила/лично↔слух/день), отношения (враг↔союзник цветом), недавние
 * события. Выбор наводит карта (4.2) и эфир (4.3) через `store.inspect(eid)`.
 *
 * ── ЗАКОН №5 (DOM только в /ui) ──────────────────────────────────────────────
 * DOM/React живут ЗДЕСЬ. Из `@zona/sim` берём лишь ПУБЛИЧНОЕ ЧИСТОЕ ЧТЕНИЕ контента:
 * `getLocation` (имя локации), `parseSubject` (декод `Subject` "e:"/"f:", 2.15),
 * `renderMessage` (текст радио-события, 3.4), `TaskKind` (структурные коды задач).
 * НИ ОДНА система симуляции не импортируется. Из `@zona/shared` — plain-контракты
 * `EntityDetail`/`MemoryRecord`/`RelationEntry`.
 *
 * ── ЗАКОН №8 / D-006 (инспектор — читатель) ──────────────────────────────────
 * Панель — ЧИСТОЕ ЧТЕНИЕ стора (`detail`/`names`/`log`). Запрос детали (`inspect`,
 * D-076) и её вычисление (`exportEntityDetail`) read-only: мир не мутируют, голдены
 * не двигают. Единственная «команда» — `clearSelection` (закрыть), тоже read-side.
 *
 * ── ЗАКОН №10 (подписи — не выдумка) ─────────────────────────────────────────
 * Тексты радио-событий собирает `renderMessage` из шаблонов /sim/data. Подписи задач
 * (`TASK_LABEL`) — ПРЕЗЕНТАЦИЯ по СТРУКТУРНЫМ кодам `TaskKind` (не контент — как
 * `WEATHER_LABEL` в App/headless render). Имя предмета — стабильный `itemId`
 * (items.json отображаемого имени не несёт — как `renderMessage` без `itemOf`, D-081).
 *
 * ── РЕЗОЛВ СУБЪЕКТА (память/отношения, D-050) ────────────────────────────────
 * И память, и отношения адресуют «кого касается» единым `Subject` ("e:<eid>"/
 * "f:<faction>"). `parseSubject` (2.15) декодит; сущность → имя из name-кэша стора
 * (`makeNameOf`, D-081), фракция → её id (getFaction наружу не течёт — id стабилен).
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { EntityDetail, EntityName, MemoryRecord, RelationEntry, SimEvent } from '@zona/shared';
import { getLocation, parseSubject, renderMessage, TaskKind, TICKS_PER_DAY } from '@zona/sim';
import { useUiStore } from '../store/store';
import { makeNameOf } from '../radio/RadioLog';

/**
 * ПРЕЗЕНТАЦИОННАЯ шкала нужд/hp — ширина полоски (доля = value / SCALE). Совпадает с
 * доменом `EntityDetail.needs`/`hp` [0..100] (view.ts: «нужды [0..100]», HEALTH_MAX).
 * НЕ балансовая константа симуляции (закон №7 — про /sim/balance): на мир не влияет,
 * лишь нормирует полоску. Дублировать `NEED_MAX`/`HEALTH_MAX` не можем — /sim их
 * публично не экспортирует, а тянуть balance в UI нельзя (закон №5).
 */
const NEED_SCALE = 100;

/**
 * Русские подписи задач по СТРУКТУРНОМУ коду `TaskKind` (презентация, не контент —
 * как `WEATHER_LABEL`). Полный охват кодов (Фаза 1–2): неизвестный код → «код N».
 */
const TASK_LABEL: Readonly<Record<number, string>> = {
  [TaskKind.SLEEP]: 'сон',
  [TaskKind.EAT]: 'еда',
  [TaskKind.DRINK]: 'водопой',
  [TaskKind.FORAGE]: 'собирательство',
  [TaskKind.HUNT]: 'охота',
  [TaskKind.REST]: 'отдых',
  [TaskKind.FLEE]: 'бегство',
  [TaskKind.WORK]: 'работа',
  [TaskKind.TRADE]: 'торговля',
  [TaskKind.ROB]: 'грабёж',
  [TaskKind.SEARCH]: 'поиск артефакта',
};

/** Русский вид сущности по коду `EntityKind` (презентация; union APPEND-ONLY, D-076). */
const KIND_LABEL: Readonly<Record<string, string>> = {
  human: 'сталкер',
  animal: 'животное',
  corpse: 'труп',
  settlement: 'поселение',
};

/**
 * Краткие подписи НЕ-радио событий для ленты «недавние» (презентация по стабильному
 * `type`). Радио-события (`radio/*`) рендерятся полным текстом через `renderMessage`.
 */
const EVENT_LABEL: Readonly<Record<string, string>> = {
  'entity/died': 'гибель',
  'corpse/created': 'труп появился',
  'encounter/started': 'столкновение',
  'encounter/resolved': 'исход столкновения',
  'loot/transferred': 'ограбление',
  'perception/spotted': 'замечен контакт',
  'move/departed': 'выход в путь',
  'move/arrived': 'прибытие',
  'task/selected': 'смена задачи',
  'trade/executed': 'сделка',
  'item/consumed': 'потребление',
  'item/produced': 'производство',
  'item/harvested': 'сбор',
  'item/broughtIn': 'принесён хабар',
  'item/exported': 'вывоз за Периметр',
  'artifact/collected': 'подобран артефакт',
  'artifact/spawned': 'родился артефакт',
  'animal/born': 'рождение',
  'population/arrived': 'приток населения',
  'settlement/built': 'постройка',
  'settlement/abandoned': 'заброшено',
  'chronicle/recorded': 'запись в летопись',
  'needs/threshold': 'критическая нужда',
  'weather/changed': 'смена погоды',
};

// ── Палитра (согласована с App/RadioLog: тёмный фон рации, приглушённо) ───────
const C = {
  text: '#c8bfae',
  dim: '#7d7566',
  faint: '#5f5a4e',
  panel: '#1b1815',
  border: '#2a2621',
  accent: '#8a9a5b',
  bar: '#3a352c', // трек полоски
  need: '#a98d5b', // заполнение нужды (тёплое, приглушённое)
  hp: '#8a9a5b', // hp — армейский зелёный
  friend: '#7f9a5b', // союзник (+)
  foe: '#a35a4e', // враг (−)
  firsthand: '#a9b56b', // лично — достовернее
  rumor: '#8a8372', // слух — слабее
} as const;

const wrap: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  font: '12px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const emptyStyle: CSSProperties = { color: C.dim, fontStyle: 'italic', padding: '0.4rem 0' };
const sectionTitle: CSSProperties = {
  color: C.dim,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontSize: '10px',
  margin: '0.6rem 0 0.25rem',
};
const rowStyle: CSSProperties = { display: 'flex', gap: '0.5rem', padding: '1px 0', alignItems: 'baseline' };
const labelStyle: CSSProperties = { color: C.dim, minWidth: '5.5rem', flexShrink: 0 };
const headerRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' };
const nameStyle: CSSProperties = { color: C.text, fontSize: '14px' };
const closeBtn: CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  color: C.dim,
  font: '11px ui-monospace, monospace',
  padding: '1px 7px',
  cursor: 'pointer',
  flexShrink: 0,
};

// ── ЧИСТЫЕ хелперы (экспортированы для юнит-тестов БЕЗ DOM) ───────────────────

/** Подпись задачи по коду `TaskKind`; неизвестный код → «код N» (робастность). */
export function taskLabel(kind: number): string {
  return TASK_LABEL[kind] ?? `код ${kind}`;
}

/** Русский вид сущности; неизвестный (append-only union) → сам код. */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** «День N» из тика (1 тик = 1 минута; TICKS_PER_DAY — из @zona/sim). */
export function dayOf(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY);
}

/**
 * Резолв `Subject` (память/отношение) в человекочитаемую метку: сущность → имя из
 * name-кэша (`makeNameOf`: кличка → Имя Фамилия → #eid), фракция → её id (стабильный
 * контент-id; getFaction наружу не течёт). Незнакомый префикс → сама строка.
 */
export function resolveSubject(subject: string, names: Readonly<Record<number, EntityName>>): string {
  const nameOf = makeNameOf(names);
  const p = parseSubject(subject);
  if (p.kind === 'entity') return nameOf(p.eid as unknown as number);
  return `фракция ${p.faction}`;
}

/**
 * Резолв недавнего события `id` в строку: ищем его в окне лога стора. Радио-событие
 * (`radio/*`) → полный текст `renderMessage` (3.4, D-069). Иное → краткая подпись по
 * типу (`EVENT_LABEL`). Событие вне окна лога (вытеснено кольцевым буфером) → «#id».
 */
export function resolveRecentEvent(
  id: number,
  log: readonly SimEvent[],
  names: Readonly<Record<number, EntityName>>,
): string {
  const ev = log.find((e) => (e.id as unknown as number) === id);
  if (ev === undefined) return `событие #${id}`;
  if (ev.type === 'radio/message' || ev.type === 'radio/relayed') {
    const nameOf = makeNameOf(names);
    const locOf = (loc: number): string => {
      try {
        return getLocation(loc as never).name;
      } catch {
        return `#${loc}`;
      }
    };
    const text = renderMessage({ templateId: ev.payload.templateId, params: ev.payload.params }, { nameOf, locOf });
    return `«${text}»`;
  }
  return EVENT_LABEL[ev.type] ?? ev.type;
}

/** Имя локации из контента; незнакомая — `#id` (робастность). */
function locName(loc: number): string {
  try {
    return getLocation(loc as never).name;
  } catch {
    return `#${loc}`;
  }
}

/** Заголовок шапки: кличка «Имя Фамилия» / «Имя Фамилия» / «#eid». */
function headTitle(detail: EntityDetail): string {
  const n = detail.name;
  if (n === undefined) return `#${detail.eid as unknown as number}`;
  const full = `${n.first} ${n.last}`.trim();
  if (n.nickname.length > 0) return full.length > 0 ? `${full} «${n.nickname}»` : `«${n.nickname}»`;
  return full.length > 0 ? full : `#${detail.eid as unknown as number}`;
}

// ── Мелкие презентационные под-компоненты ────────────────────────────────────

function Section(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <div style={sectionTitle}>{props.title}</div>
      {props.children}
    </div>
  );
}

function Field(props: { label: string; children: ReactNode }): ReactElement {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{props.label}</span>
      <span style={{ color: C.text }}>{props.children}</span>
    </div>
  );
}

/** Полоска [0..1] с подписью и цветом (нужда/hp). */
function Bar(props: { label: string; value: number; max: number; color: string }): ReactElement {
  const frac = props.max > 0 ? Math.max(0, Math.min(1, props.value / props.max)) : 0;
  return (
    <div style={{ ...rowStyle, alignItems: 'center' }} data-testid="insp-bar" data-bar={props.label}>
      <span style={labelStyle}>{props.label}</span>
      <span
        style={{ position: 'relative', flex: 1, height: '9px', background: C.bar, borderRadius: '1px', overflow: 'hidden' }}
      >
        <span
          style={{ position: 'absolute', inset: 0, width: `${(frac * 100).toFixed(1)}%`, background: props.color }}
          data-testid="insp-bar-fill"
        />
      </span>
      <span style={{ color: C.dim, minWidth: '2.6rem', textAlign: 'right' }}>{Math.round(props.value)}</span>
    </div>
  );
}

/**
 * Панель инспектора. Подписана на `detail`/`names`/`log` стора (дешёвый ре-рендер на
 * дельту). Нет выбора (`detail === null`) → подсказка. Клик «закрыть» → `clearSelection`.
 */
export default function Inspector(): ReactElement {
  const detail = useUiStore((s) => s.detail);
  const names = useUiStore((s) => s.names);
  const log = useUiStore((s) => s.log);
  const clearSelection = useUiStore((s) => s.clearSelection);

  if (detail === null) {
    return (
      <div style={wrap} data-testid="inspector">
        <div style={emptyStyle}>Кликни сущность на карте или имя в эфире.</div>
      </div>
    );
  }

  const title = headTitle(detail);

  return (
    <div style={wrap} data-testid="inspector">
      {/* ── ШАПКА ── */}
      <div style={headerRow}>
        <span style={nameStyle} data-testid="insp-name">
          {title}
        </span>
        <button type="button" style={closeBtn} onClick={() => clearSelection()} data-testid="insp-close">
          × закрыть
        </button>
      </div>
      <Field label="вид">{kindLabel(detail.kind)}</Field>
      {detail.species !== undefined ? <Field label="вид животного">{detail.species}</Field> : null}
      {detail.faction !== null ? <Field label="фракция">{detail.faction as unknown as string}</Field> : null}
      <Field label="локация">{locName(detail.loc as unknown as number)}</Field>
      {detail.dest !== undefined ? <Field label="идёт в">{locName(detail.dest as unknown as number)}</Field> : null}

      {/* ── НУЖДЫ ── */}
      <Section title="Состояние">
        <Bar label="hp" value={detail.hp} max={NEED_SCALE} color={C.hp} />
        <Bar label="голод" value={detail.needs.hunger} max={NEED_SCALE} color={C.need} />
        <Bar label="жажда" value={detail.needs.thirst} max={NEED_SCALE} color={C.need} />
        <Bar label="усталость" value={detail.needs.fatigue} max={NEED_SCALE} color={C.need} />
        <Bar label="страх" value={detail.needs.fear} max={NEED_SCALE} color={C.need} />
      </Section>

      {/* ── ЗАДАЧА ── */}
      <Section title="Задача">
        {detail.task === undefined ? (
          <div style={emptyStyle} data-testid="insp-task-none">
            без задачи
          </div>
        ) : (
          <>
            <Field label="действие">
              <span data-testid="insp-task">{taskLabel(detail.task.kind)}</span>
            </Field>
            {detail.task.targetLoc !== undefined ? (
              <Field label="цель — место">{locName(detail.task.targetLoc as unknown as number)}</Field>
            ) : null}
            {detail.task.targetEid !== undefined ? (
              <Field label="цель — кто">{makeNameOf(names)(detail.task.targetEid as unknown as number)}</Field>
            ) : null}
          </>
        )}
      </Section>

      {/* ── ИНВЕНТАРЬ ── */}
      <Section title="Инвентарь">
        <Field label="деньги">{detail.money}</Field>
        <Field label="слава">{detail.fame}</Field>
        {detail.inventory.length === 0 ? (
          <div style={emptyStyle}>пусто</div>
        ) : (
          detail.inventory.map(([item, qty]) => (
            <div style={rowStyle} key={item as unknown as string} data-testid="insp-item">
              <span style={{ ...labelStyle, minWidth: '8rem', color: C.text }}>{item as unknown as string}</span>
              <span style={{ color: C.dim }}>×{qty}</span>
            </div>
          ))
        )}
      </Section>

      {/* ── ПАМЯТЬ ── */}
      <Section title="Память">
        {detail.memory.length === 0 ? (
          <div style={emptyStyle}>ничего не помнит</div>
        ) : (
          detail.memory.map((m: MemoryRecord, i) => (
            <div style={{ ...rowStyle, flexWrap: 'wrap' }} key={`${m.kind}:${m.subject}:${m.isFirsthand}:${i}`} data-testid="insp-mem">
              <span style={{ color: C.text, minWidth: '5rem' }}>{m.kind}</span>
              <span style={{ color: C.dim }} data-testid="insp-mem-subject">
                {resolveSubject(m.subject, names)}
              </span>
              <span
                style={{ color: m.isFirsthand ? C.firsthand : C.rumor, fontStyle: m.isFirsthand ? 'normal' : 'italic' }}
                data-testid="insp-mem-src"
              >
                {m.isFirsthand ? 'лично' : 'слух'}
              </span>
              <span style={{ color: C.faint }} title="сила памяти" data-testid="insp-mem-salience">
                сила {m.salience.toFixed(2)}
              </span>
              <span style={{ color: C.faint }}>день {dayOf(m.tick)}</span>
            </div>
          ))
        )}
      </Section>

      {/* ── ОТНОШЕНИЯ ── */}
      <Section title="Отношения">
        {detail.relations.length === 0 ? (
          <div style={emptyStyle}>нейтрален ко всем</div>
        ) : (
          detail.relations.map((r: RelationEntry, i) => {
            const [subject, value] = r;
            const color = value < 0 ? C.foe : value > 0 ? C.friend : C.dim;
            return (
              <div style={rowStyle} key={`${subject}:${i}`} data-testid="insp-rel">
                <span style={{ color: C.text, minWidth: '8rem' }} data-testid="insp-rel-subject">
                  {resolveSubject(subject, names)}
                </span>
                <span style={{ color }} data-testid="insp-rel-value" data-sign={value < 0 ? 'foe' : value > 0 ? 'friend' : 'neutral'}>
                  {value > 0 ? '+' : ''}
                  {value.toFixed(2)}
                </span>
              </div>
            );
          })
        )}
      </Section>

      {/* ── НЕДАВНИЕ СОБЫТИЯ ── */}
      <Section title="Недавние события">
        {detail.recentEvents.length === 0 ? (
          <div style={emptyStyle}>ничего не произошло</div>
        ) : (
          detail.recentEvents.map((id, i) => (
            <div style={{ ...rowStyle, color: C.dim }} key={`${id as unknown as number}:${i}`} data-testid="insp-event">
              {resolveRecentEvent(id as unknown as number, log, names)}
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
