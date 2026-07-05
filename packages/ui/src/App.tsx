/**
 * @module @zona/ui/App
 *
 * КАРКАС интерфейса наблюдателя (задача 4.0) — минимальная оболочка макета GDD §11:
 * КАРТА | РАДИОЭФИР | ЛЕТОПИСЬ/ИНСПЕКТОР | тайм-бар. Панели пока ЗАГЛУШКИ (наполнят
 * задачи 4.2–4.7); задача каркаса — ДОКАЗАТЬ сквозной Worker-мост: живые `day`/`tick`/
 * `weather`/`entityCount` из воркера через стор попадают на экран (init → view → render).
 *
 * ── ЧИСТЫЙ ЧИТАТЕЛЬ (закон №5, тестируемость) ────────────────────────────────
 * App НЕ создаёт воркер и НЕ вызывает `init` — только читает `useUiStore`. Bootstrap
 * (main.tsx) поднимает мост и командует темпом. Поэтому App рендерится в jsdom на
 * фиксированном состоянии стора БЕЗ живого воркера/таймеров (smoke-тест DoD 4.0).
 *
 * Атмосфера — штабная карта/армейская рация: тёмный фон, приглушённые цвета, никакого
 * неона (роль ui-engineer). Стили инлайновые (без CSS-библиотек сверх согласованных).
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, ReactElement } from 'react';
import { useUiStore } from './store/store';
import MapCanvas from './map/MapCanvas';
import RadioLog from './radio/RadioLog';
import Inspector from './inspector/Inspector';
import ChronicleLog from './chronicle/ChronicleLog';
import TimeControls from './controls/TimeControls';
import { TICKS_PER_DAY } from '@zona/sim';

// ── Палитра (тёмный фон #141210-подобный, приглушённые тона) ─────────────────
const COLORS = {
  bg: '#141210',
  panel: '#1b1815',
  border: '#2a2621',
  text: '#c8bfae',
  dim: '#7d7566',
  accent: '#8a9a5b', // приглушённый армейский зелёный
} as const;

const shell: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 22rem',
  gridTemplateRows: '1fr 1fr 2.5rem',
  gridTemplateAreas: `
    "map    radio"
    "map    chronicle"
    "timebar timebar"
  `,
  height: '100vh',
  width: '100vw',
  background: COLORS.bg,
  color: COLORS.text,
  font: '13px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  gap: '1px',
};

const panelBase: CSSProperties = {
  background: COLORS.panel,
  border: `1px solid ${COLORS.border}`,
  padding: '0.6rem 0.8rem',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const heading: CSSProperties = {
  color: COLORS.dim,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontSize: '11px',
  marginBottom: '0.5rem',
};

/** Названия погоды по коду (презентация; полноценный справочник — на панели карты 4.2). */
// Порядок СТРОГО по WEATHER_TYPES (@zona/sim: clear/overcast/rain/fog/storm) —
// индекс = код погоды в WorldView.weather. Рассинхрон дал бы «туман»↔«гроза»
// перепутанными в тайм-баре (карта маппит через WEATHER_TYPES). Выброса как погоды
// пока нет (Фаза 3b) — лишней метки быть не должно.
const WEATHER_LABEL = ['ясно', 'облачно', 'дождь', 'туман', 'гроза'];

function Panel(props: { area: string; title: string; children: ReactNode }): ReactElement {
  return (
    <section style={{ ...panelBase, gridArea: props.area }}>
      <div style={heading}>{props.title}</div>
      {props.children}
    </section>
  );
}

// ── Вкладки «Летопись | Инспектор» (стык 4.4/4.5) ────────────────────────────
// Обе панели делят одну область макета (GDD §11). Контейнер держит активную вкладку
// и АВТО-переключается на «Инспектор» при выборе сущности (клик на карте/в эфире →
// `selectedEid` ≠ null): наблюдатель кликнул — сразу видит карточку. Задача 4.4
// заменит заглушку летописи своим компонентом, не трогая инспектор (append-only).
type TabId = 'chronicle' | 'inspector';

const tabBar: CSSProperties = {
  display: 'flex',
  gap: '0.15rem',
  marginBottom: '0.4rem',
  borderBottom: `1px solid ${COLORS.border}`,
};
const tabBtnBase: CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderBottom: '2px solid transparent',
  color: COLORS.dim,
  font: '11px ui-monospace, monospace',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  padding: '0.2rem 0.5rem',
  cursor: 'pointer',
};

function NarrativePanel(): ReactElement {
  const selectedEid = useUiStore((s) => s.selectedEid);
  const [tab, setTab] = useState<TabId>('chronicle');
  // Авто-переход на инспектор при НОВОМ выборе (selectedEid стал не-null). Ref хранит
  // прошлый выбор — переключаем лишь на ФРОНТ выбора, не на каждый ре-рендер (иначе
  // юзер не смог бы вернуться на «Летопись», пока сущность выбрана).
  const prevSel = useRef<number | null>(null);
  useEffect(() => {
    const cur = selectedEid as unknown as number | null;
    if (cur !== null && cur !== prevSel.current) setTab('inspector');
    prevSel.current = cur;
  }, [selectedEid]);

  const tabBtn = (id: TabId, label: string): ReactElement => {
    const active = tab === id;
    return (
      <button
        type="button"
        style={{
          ...tabBtnBase,
          color: active ? COLORS.text : COLORS.dim,
          borderBottomColor: active ? COLORS.accent : 'transparent',
        }}
        onClick={() => setTab(id)}
        data-testid={`tab-${id}`}
        aria-selected={active}
      >
        {label}
      </button>
    );
  };

  return (
    <section style={{ ...panelBase, gridArea: 'chronicle' }}>
      <div style={tabBar}>
        {tabBtn('chronicle', 'Летопись')}
        {tabBtn('inspector', 'Инспектор')}
      </div>
      {tab === 'inspector' ? <Inspector /> : <ChronicleLog />}
    </section>
  );
}

export default function App(): ReactElement {
  const view = useUiStore((s) => s.view);
  const stats = useUiStore((s) => s.stats);
  const paused = useUiStore((s) => s.paused);
  const speed = useUiStore((s) => s.speed);
  const connected = useUiStore((s) => s.connected);

  // Живые данные из воркера (доказательство сквозного моста init→view→render).
  const day = view?.day ?? 0;
  const tick = view?.tick ?? 0;
  const weatherCode = view?.weather ?? 0;
  const weather = WEATHER_LABEL[weatherCode] ?? `код ${weatherCode}`;
  const entityCount = view?.entities.length ?? 0;
  // Внутриигровое время суток из тика (1 тик = 1 минута; длина суток — из @zona/sim,
  // не хардкод — устраняет дубль балансовой константы TICKS_PER_DAY, находка ревью).
  const minuteOfDay = tick % TICKS_PER_DAY;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');

  return (
    <div style={shell}>
      <Panel area="map" title="Карта — схематичный граф Зоны">
        <MapCanvas />
      </Panel>

      <Panel area="radio" title="Радиоэфир">
        <RadioLog />
      </Panel>

      <NarrativePanel />

      <section
        style={{
          ...panelBase,
          gridArea: 'timebar',
          flexDirection: 'row',
          alignItems: 'center',
          gap: '1.2rem',
          padding: '0 0.8rem',
        }}
      >
        <TimeControls />
        <span style={{ color: paused ? COLORS.dim : COLORS.accent }}>
          {paused ? '⏸ пауза' : `▶ ×${speed}`}
        </span>
        <span>
          День {day} · {hh}:{mm} · {weather}
        </span>
        <span style={{ color: COLORS.dim }}>
          тик {tick} · сущностей {entityCount}
          {stats ? ` · ${stats.tickMs.toFixed(1)} мс/кадр` : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: connected ? COLORS.accent : COLORS.dim }}>
          {connected ? 'мост: активен' : 'мост: не подключён'}
        </span>
      </section>
    </div>
  );
}
