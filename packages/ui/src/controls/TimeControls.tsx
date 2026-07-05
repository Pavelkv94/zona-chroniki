/**
 * @module @zona/ui/controls/TimeControls
 *
 * ТАЙМ-КОНТРОЛЫ наблюдателя (задача 4.6, GDD §11: `⏸ ×1 ×10 ×60 ×600 | шаг`). Пульт
 * ТЕМПА для тайм-бара: пауза, множители скорости и одиночный шаг. Кнопки шлют команды
 * `setSpeed`/`step` через СТОР (4.0) → воркер (`sim-worker` пейсит тики по темпу, шагает
 * на паузе). Живой воркер не трогаем — только читаем `speed`/`paused` и дёргаем действия.
 *
 * ── МНОЖИТЕЛЬ = ТИКОВ/РЕАЛЬНУЮ СЕКУНДУ (база ×1 = 1) ─────────────────────────
 * `ticksPerRealSecond` воркера — прямой драйвер темпа (сколько тиков продвинуть за
 * реальную секунду). База ×1 = 1 тик/с (1 тик = 1 игровая минута при TICKS_PER_DAY=1440
 * ⇒ ×1 ≈ игровые сутки за 24 реальных минуты, ×600 — за 2.4 с). Значит множитель РАВЕН
 * `ticksPerRealSecond`: ×1→1, ×10→10, ×60→60, ×600→600 (согласовано со стором:
 * `setSpeed(600)` ⇒ `{ticksPerRealSecond:600}`, D-078). Пауза — `setSpeed(0)`.
 *
 * ── ЗАКОН №5 / №8 ────────────────────────────────────────────────────────────
 * DOM/React только тут (в /ui). Контролы влияют лишь на ТЕМП/паузу/ШАГ обхода тиков —
 * НЕ на содержимое (детерминизм цел: воркер гоняет тот же seeded-конвейер, темп решает
 * лишь КОЛИЧЕСТВО тиков за кадр, как `ms` в headless-CLI, D-006). /sim не импортируем.
 *
 * ── ХОТКЕЙ ───────────────────────────────────────────────────────────────────
 * Пробел — пауза/плей: на паузе возобновляет ПОСЛЕДНИЙ активный темп (или ×1 по
 * умолчанию), на ходу — ставит паузу. Игнорируется в полях ввода (на будущее).
 */

import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import { useUiStore } from '../store/store';

/**
 * Множители темпа (GDD §11). Значение = `ticksPerRealSecond` (база ×1 = 1). Единственный
 * источник маппинга «кнопка → команда»: и рендер кнопок, и хоткей читают этот список.
 */
export const SPEED_STEPS = [1, 10, 60, 600] as const;

/** Темп по умолчанию при возобновлении с паузы (если прошлого активного темпа нет). */
const DEFAULT_RESUME_SPEED = SPEED_STEPS[0];

// ── Палитра (та же штабная рация, что в App) ─────────────────────────────────
const C = {
  text: '#c8bfae',
  dim: '#7d7566',
  border: '#2a2621',
  btnBg: '#211d19',
  activeBg: '#33301f',
  accent: '#8a9a5b',
} as const;

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.3rem' };

function btnStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    font: 'inherit',
    fontSize: '12px',
    lineHeight: 1,
    padding: '0.3rem 0.55rem',
    minWidth: '2.6rem',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? C.dim : active ? C.accent : C.text,
    background: active ? C.activeBg : C.btnBg,
    border: `1px solid ${active ? C.accent : C.border}`,
    borderRadius: 2,
    opacity: disabled ? 0.5 : 1,
    letterSpacing: '0.02em',
  };
}

const sep: CSSProperties = { color: C.border, userSelect: 'none' };

/**
 * Панель тайм-контролов. Читает `speed`/`paused` из стора и шлёт `setSpeed`/`step`.
 * Встраивается в тайм-бар App слева от отображения дня/времени/погоды.
 */
export default function TimeControls(): ReactElement {
  const speed = useUiStore((s) => s.speed);
  const paused = useUiStore((s) => s.paused);
  const setSpeed = useUiStore((s) => s.setSpeed);
  const step = useUiStore((s) => s.step);

  // Последний НЕнулевой темп — чтобы пробел возобновлял «как было», а не всегда ×1.
  const lastSpeedRef = useRef<number>(DEFAULT_RESUME_SPEED);
  useEffect(() => {
    if (speed > 0) lastSpeedRef.current = speed;
  }, [speed]);

  // Хоткей: пробел = пауза/плей. Игнор в полях ввода (задел на будущее).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      e.preventDefault();
      // Читаем актуальный темп прямо из стора (замыкание не устаревает).
      const s = useUiStore.getState();
      if (s.paused) s.setSpeed(lastSpeedRef.current);
      else s.setSpeed(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={row} role="group" aria-label="Управление временем">
      <button
        type="button"
        style={btnStyle(paused, false)}
        aria-pressed={paused}
        title="Пауза (пробел)"
        onClick={() => setSpeed(0)}
      >
        ⏸
      </button>

      <span style={sep}>│</span>

      {SPEED_STEPS.map((mult) => {
        const active = !paused && speed === mult;
        return (
          <button
            key={mult}
            type="button"
            style={btnStyle(active, false)}
            aria-pressed={active}
            title={`Скорость ×${mult} (${mult} тик/с)`}
            onClick={() => setSpeed(mult)}
          >
            ×{mult}
          </button>
        );
      })}

      <span style={sep}>│</span>

      <button
        type="button"
        style={btnStyle(false, !paused)}
        disabled={!paused}
        title="Шаг: один тик (на паузе)"
        onClick={() => step(1)}
      >
        ⏭
      </button>
    </div>
  );
}
