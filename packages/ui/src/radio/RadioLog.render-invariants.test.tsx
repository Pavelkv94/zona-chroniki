// @vitest-environment jsdom
/**
 * @module @zona/ui/radio/RadioLog.render-invariants.test
 *
 * УСИЛЕНИЕ панели эфира (задача 4.3, D-069/D-081) — два инварианта, не покрытых
 * RadioLog.test:
 *  - ДЕТЕРМИНИЗМ РЕНДЕРА (закон №8 / D-069): на ФИКСИРОВАННОМ логе+именах панель даёт
 *    БИТ-В-БИТ ту же разметку дважды (renderMessage чист ⇒ строки эфира стабильны, а
 *    RadioLog — их чистый читатель). buildRows тоже deep-equal 2×.
 *  - УМНЫЙ АВТОСКРОЛЛ, ПОЗИТИВНЫЙ КЕЙС: пока пользователь У НИЗА, НОВАЯ реплика ЛИПНЕТ
 *    (лента доезжает до низа сама, кнопка «вниз» не всплывает). RadioLog.test проверял
 *    лишь «прокрутил вверх → не дёргаем»; здесь — что при чтении «свежего» она следует.
 *
 * Как RadioLog.test: живой воркер не поднимаем, состояние стора ставим напрямую (setState).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { EntityId, EntityName, LocationId, SimEvent, Tick } from '@zona/shared';
import RadioLog, { buildRows } from './RadioLog';
import { useUiStore } from '../store/store';

function msg(
  id: number,
  over: { tick?: number; speakerEid?: number; templateId?: string; params?: Record<string, unknown> } = {},
): SimEvent {
  return {
    id: id as never,
    tick: (over.tick ?? 2) as Tick,
    type: 'radio/message',
    causedBy: null,
    payload: {
      speakerEid: (over.speakerEid ?? 5) as EntityId,
      subjects: [],
      loc: 1 as LocationId,
      templateId: over.templateId ?? 'entity/died|neutral|0',
      params: over.params ?? { subject: 7, loc: 1 },
      isFirsthand: true,
    },
  } as SimEvent;
}

function relayed(id: number, over: { tick?: number; speakerEid?: number } = {}): SimEvent {
  return {
    id: id as never,
    tick: (over.tick ?? 3) as Tick,
    type: 'radio/relayed',
    causedBy: 1 as never,
    payload: {
      speakerEid: (over.speakerEid ?? 6) as EntityId,
      subjects: [],
      loc: 1 as LocationId,
      sourceMessageId: 1 as never,
      hop: 1,
      templateId: 'entity/died|neutral|0',
      params: { subject: 7, loc: 1 },
      isFirsthand: false,
    },
  } as SimEvent;
}

const NAMES: Record<number, EntityName> = {
  5: { first: 'Сергей', last: 'Лисенко', nickname: 'Лис' },
  6: { first: 'Пётр', last: 'Волков', nickname: '' },
  7: { first: 'Иван', last: 'Сорока', nickname: 'Сорока' },
};

function setStore(log: SimEvent[], names: Record<number, EntityName> = NAMES): void {
  useUiStore.setState({ log, names, view: null, detail: null, selectedEid: null });
}

beforeEach(() => setStore([]));
afterEach(() => {
  cleanup();
  useUiStore.setState({ log: [], names: {}, selectedEid: null });
});

describe('RadioLog — детерминизм разметки (закон №8 / D-069)', () => {
  const fixedLog: SimEvent[] = [
    msg(1, { tick: 2, speakerEid: 5 }),
    relayed(2, { tick: 63, speakerEid: 6 }),
    msg(3, { tick: 1502, speakerEid: 7, params: { subject: 5, loc: 1 } }),
  ];

  it('buildRows на фиксированном логе — DEEP-EQUAL дважды', () => {
    const a = buildRows(fixedLog, NAMES, { showFirsthand: true, showRumors: true });
    const b = buildRows(fixedLog, NAMES, { showFirsthand: true, showRumors: true });
    expect(b).toEqual(a);
    expect(a.length).toBe(3); // тест не холостой
  });

  it('DOM-разметка панели идентична при двух независимых рендерах', () => {
    setStore(fixedLog);
    const { unmount } = render(<RadioLog />);
    const first = screen.getByTestId('radio-scroll').innerHTML;
    unmount();

    setStore(fixedLog);
    render(<RadioLog />);
    const second = screen.getByTestId('radio-scroll').innerHTML;

    expect(second).toBe(first);
    expect(first).toContain('Сорока погиб.'); // разметка реально собрана из шаблона
  });
});

describe('RadioLog — автоскролл ЛИПНЕТ у низа (позитивный кейс)', () => {
  function fakeGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
  }

  it('пользователь у низа → новая реплика доезжает ленту к низу, кнопки «вниз» нет', () => {
    setStore([msg(1)]);
    render(<RadioLog />);
    const box = screen.getByTestId('radio-scroll');
    fakeGeometry(box, 1000, 100);

    // Уведомляем панель, что мы у самого низа (dist 0 ≤ NEAR_BOTTOM_PX) — остаёмся «залипшими».
    box.scrollTop = 900; // 1000 - 900 - 100 = 0
    box.dispatchEvent(new Event('scroll'));
    expect(screen.queryByTestId('radio-jump')).toBeNull();

    // Пришла новая реплика — лента ОБЯЗАНА доехать до низа сама (act смывает layout-эффект).
    act(() => setStore([msg(1), msg(2, { tick: 4 })]));
    expect(box.scrollTop).toBe(1000); // прилипли к scrollHeight
    expect(screen.queryByTestId('radio-jump')).toBeNull(); // кнопки возврата нет — мы и так внизу
  });
});
