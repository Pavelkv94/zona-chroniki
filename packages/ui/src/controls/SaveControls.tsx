/**
 * @module @zona/ui/controls/SaveControls
 *
 * КОНТРОЛЫ СОХРАНЕНИЙ наблюдателя (задача 4.8, D-082) для тайм-бара: «Сохранить» (опц.
 * имя), меню «Загрузить ▾» (список сохранений → загрузить/удалить) и индикатор «сохранено».
 * Кнопки дёргают действия СТОРА (`requestSave`/`refreshSaves`/`loadSave`/`deleteSave`),
 * которые говорят с IndexedDB (персист-слой) и воркером (resume). Живой воркер/БД не трогаем
 * напрямую — только читаем `saves`/`savedIndicator` и вызываем действия.
 *
 * ── ЗАКОН №5 / №8 ────────────────────────────────────────────────────────────
 * DOM/React и IndexedDB — только в /ui. Сохранение/загрузка НЕ влияют на содержимое мира:
 * save = сериализация текущего состояния, load = `deserialize` того же снапшота (resume
 * бит-в-бит, D-008/C-4). Метки id/имя/время — презентация, в мир не текут (закон №8).
 * `@zona/sim` здесь не импортируется (день выводим из tick через TICKS_PER_DAY — публичная
 * балансовая константа, как в App/TimeControls; логика симуляции не трогается).
 */

import { useState, type CSSProperties, type ReactElement } from 'react';
import { useUiStore } from '../store/store';
import type { SaveMeta } from '../persistence/saves';
import { TICKS_PER_DAY } from '@zona/sim';

// ── Палитра (та же штабная рация, что в App/TimeControls) ─────────────────────
const C = {
  text: '#c8bfae',
  dim: '#7d7566',
  border: '#2a2621',
  panel: '#1b1815',
  btnBg: '#211d19',
  activeBg: '#33301f',
  accent: '#8a9a5b',
} as const;

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.3rem', position: 'relative' };

function btnStyle(disabled = false): CSSProperties {
  return {
    font: 'inherit',
    fontSize: '12px',
    lineHeight: 1,
    padding: '0.3rem 0.55rem',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? C.dim : C.text,
    background: C.btnBg,
    border: `1px solid ${C.border}`,
    borderRadius: 2,
    opacity: disabled ? 0.5 : 1,
    letterSpacing: '0.02em',
  };
}

const nameInput: CSSProperties = {
  font: 'inherit',
  fontSize: '12px',
  width: '7rem',
  padding: '0.28rem 0.4rem',
  color: C.text,
  background: '#100e0c',
  border: `1px solid ${C.border}`,
  borderRadius: 2,
};

const menu: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 0.35rem)',
  left: 0,
  minWidth: '18rem',
  maxHeight: '16rem',
  overflowY: 'auto',
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 3,
  padding: '0.3rem',
  zIndex: 10,
  boxShadow: '0 -4px 16px rgba(0,0,0,0.5)',
};

const saveRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.25rem 0.3rem',
};

/** Внутриигровые сутки из tick (1 тик = 1 игровая минута; TICKS_PER_DAY — из @zona/sim). */
function dayTimeLabel(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY);
  const minute = tick % TICKS_PER_DAY;
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `День ${day} · ${hh}:${mm}`;
}

/** Локальное человекочитаемое время сохранения (UI-метка savedAt). */
function savedAtLabel(savedAt: number): string {
  const d = new Date(savedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Панель сохранений тайм-бара. Читает `saves`/`savedIndicator`; шлёт `requestSave`/
 * `refreshSaves`/`loadSave`/`deleteSave`. Меню «Загрузить» открывается по кнопке (при
 * открытии обновляет список из IndexedDB).
 */
export default function SaveControls(): ReactElement {
  const saves = useUiStore((s) => s.saves);
  const savedIndicator = useUiStore((s) => s.savedIndicator);
  const connected = useUiStore((s) => s.connected);
  const requestSave = useUiStore((s) => s.requestSave);
  const refreshSaves = useUiStore((s) => s.refreshSaves);
  const loadSave = useUiStore((s) => s.loadSave);
  const deleteSave = useUiStore((s) => s.deleteSave);

  const [name, setName] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const onSave = (): void => {
    requestSave(name.trim());
    setName('');
  };

  const toggleMenu = (): void => {
    const next = !menuOpen;
    setMenuOpen(next);
    if (next) refreshSaves(); // при открытии подтягиваем актуальный список из IndexedDB
  };

  const onLoad = (id: string): void => {
    loadSave(id);
    setMenuOpen(false);
  };

  return (
    <div style={row} role="group" aria-label="Сохранения">
      <input
        style={nameInput}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="имя сейва"
        aria-label="Имя сохранения"
        disabled={!connected}
      />
      <button
        type="button"
        style={btnStyle(!connected)}
        disabled={!connected}
        title="Сохранить мир в браузер (IndexedDB)"
        onClick={onSave}
      >
        Сохранить
      </button>

      <button
        type="button"
        style={btnStyle(false)}
        aria-expanded={menuOpen}
        title="Список сохранений"
        onClick={toggleMenu}
      >
        Загрузить ▾
      </button>

      {savedIndicator !== null && (
        <span style={{ color: C.accent, fontSize: '11px' }} data-testid="saved-indicator">
          ✓ сохранено
        </span>
      )}

      {menuOpen && (
        <div style={menu} role="menu" aria-label="Сохранения">
          {saves.length === 0 ? (
            <div style={{ color: C.dim, padding: '0.3rem', fontSize: '12px' }}>нет сохранений</div>
          ) : (
            saves.map((s: SaveMeta) => (
              <div key={s.id} style={saveRow} role="menuitem">
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ color: C.text }}>{s.name || '(без имени)'}</span>{' '}
                  <span style={{ color: C.dim, fontSize: '11px' }}>
                    {dayTimeLabel(s.tick as unknown as number)} · сохр. {savedAtLabel(s.savedAt)}
                  </span>
                </span>
                <button
                  type="button"
                  style={btnStyle(false)}
                  title="Загрузить это сохранение (resume)"
                  onClick={() => onLoad(s.id)}
                >
                  Загрузить
                </button>
                <button
                  type="button"
                  style={{ ...btnStyle(false), color: '#b5765f' }}
                  title="Удалить сохранение"
                  aria-label={`Удалить сохранение ${s.name || s.id}`}
                  onClick={() => deleteSave(s.id)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
