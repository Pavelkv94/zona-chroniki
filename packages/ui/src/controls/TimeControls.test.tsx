// @vitest-environment jsdom
/**
 * Тесты ТАЙМ-КОНТРОЛОВ (задача 4.6). Живой воркер НЕ поднимается: действия стора
 * (`setSpeed`/`step`) замоканы `vi.fn` через `setState`, проверяем ИМЕННО вызовы —
 * какая кнопка какую команду темпа шлёт (закон №8: только темп/пауза/шаг). Подсветка
 * активной скорости читается из `speed`/`paused` (aria-pressed). Пробел = пауза/плей.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import TimeControls, { SPEED_STEPS } from './TimeControls';
import { useUiStore } from '../store/store';

/** Замок действий: подменяем setSpeed/step на шпионов, задаём темп/паузу. */
function setup(over: { speed?: number; paused?: boolean } = {}): {
  setSpeed: ReturnType<typeof vi.fn>;
  step: ReturnType<typeof vi.fn>;
} {
  const speed = over.speed ?? 0;
  const paused = over.paused ?? speed === 0;
  const setSpeed = vi.fn((tps: number) => {
    // Держим стор согласованным, чтобы подписка компонента отражала эффект команды.
    useUiStore.setState({ speed: tps > 0 ? tps : 0, paused: tps <= 0 });
  });
  const step = vi.fn();
  useUiStore.setState({ speed, paused, setSpeed, step });
  return { setSpeed, step };
}

beforeEach(() => {
  setup();
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ speed: 0, paused: true });
});

describe('TimeControls — команды темпа (закон №8)', () => {
  it('⏸ шлёт setSpeed(0)', () => {
    const { setSpeed } = setup({ speed: 10 });
    render(<TimeControls />);
    fireEvent.click(screen.getByTitle('Пауза (пробел)'));
    expect(setSpeed).toHaveBeenCalledWith(0);
  });

  it('×1/×10/×60/×600 шлют setSpeed с ticksPerRealSecond = множитель', () => {
    for (const mult of SPEED_STEPS) {
      const { setSpeed } = setup({ speed: 0 });
      const { unmount } = render(<TimeControls />);
      fireEvent.click(screen.getByRole('button', { name: `×${mult}` }));
      expect(setSpeed).toHaveBeenCalledWith(mult);
      unmount();
    }
  });

  it('маппинг множителей фиксирован: [1, 10, 60, 600]', () => {
    expect([...SPEED_STEPS]).toEqual([1, 10, 60, 600]);
  });

  it('⏭ шаг шлёт step(1)', () => {
    const { step } = setup({ speed: 0 }); // пауза
    render(<TimeControls />);
    fireEvent.click(screen.getByTitle('Шаг: один тик (на паузе)'));
    expect(step).toHaveBeenCalledWith(1);
  });
});

describe('TimeControls — подсветка активного состояния', () => {
  it('на паузе подсвечена ⏸, ни один множитель не активен', () => {
    setup({ speed: 0, paused: true });
    render(<TimeControls />);
    expect(screen.getByTitle('Пауза (пробел)').getAttribute('aria-pressed')).toBe('true');
    for (const mult of SPEED_STEPS) {
      expect(screen.getByRole('button', { name: `×${mult}` }).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('на ходу подсвечен ТЕКУЩИЙ множитель (speed), пауза не активна', () => {
    setup({ speed: 60, paused: false });
    render(<TimeControls />);
    expect(screen.getByTitle('Пауза (пробел)').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '×60' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '×10' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('TimeControls — шаг осмыслен только на паузе', () => {
  it('на паузе кнопка шага активна (не disabled)', () => {
    setup({ speed: 0, paused: true });
    render(<TimeControls />);
    expect((screen.getByTitle('Шаг: один тик (на паузе)') as HTMLButtonElement).disabled).toBe(false);
  });

  it('на ходу кнопка шага disabled (шаг бессмыслен при живом темпе)', () => {
    setup({ speed: 600, paused: false });
    render(<TimeControls />);
    const btn = screen.getByTitle('Шаг: один тик (на паузе)') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    // Клик по disabled-кнопке команды не шлёт.
    expect(useUiStore.getState().step).not.toHaveBeenCalled();
  });
});

describe('TimeControls — переключение пауза↔плей (пробел)', () => {
  it('на паузе пробел возобновляет ×1 по умолчанию', () => {
    const { setSpeed } = setup({ speed: 0, paused: true });
    render(<TimeControls />);
    fireEvent.keyDown(window, { code: 'Space' });
    expect(setSpeed).toHaveBeenCalledWith(SPEED_STEPS[0]);
  });

  it('на ходу пробел ставит паузу (setSpeed 0)', () => {
    const { setSpeed } = setup({ speed: 60, paused: false });
    render(<TimeControls />);
    fireEvent.keyDown(window, { code: 'Space' });
    expect(setSpeed).toHaveBeenCalledWith(0);
  });

  it('пробел возобновляет ПОСЛЕДНИЙ активный темп, а не всегда ×1', () => {
    // Стартуем на ходу ×60 → компонент запоминает 60; ставим паузу кнопкой; пробел → 60.
    const { setSpeed } = setup({ speed: 60, paused: false });
    render(<TimeControls />);
    fireEvent.click(screen.getByTitle('Пауза (пробел)')); // setSpeed(0), стор → пауза
    fireEvent.keyDown(window, { code: 'Space' });
    expect(setSpeed).toHaveBeenLastCalledWith(60);
  });

  it('пробел в поле ввода игнорируется (не трогает темп)', () => {
    const { setSpeed } = setup({ speed: 0, paused: true });
    render(
      <div>
        <input aria-label="поле" />
        <TimeControls />
      </div>,
    );
    const input = screen.getByLabelText('поле');
    fireEvent.keyDown(input, { code: 'Space' });
    expect(setSpeed).not.toHaveBeenCalled();
  });
});
