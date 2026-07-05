// @vitest-environment jsdom
/**
 * jsdom-тест КОНТРОЛОВ СОХРАНЕНИЙ (задача 4.8, D-082). SaveControls — ЧИСТЫЙ читатель
 * стора: на фиксированном состоянии (список сохранений + флаги) кнопки «Сохранить»/
 * «Загрузить»/«Удалить» дёргают ПРАВИЛЬНЫЕ действия стора. Сами действия (персист в
 * IndexedDB, resume воркеру) замоканы `vi.fn` через setState — тут проверяем ТОЛЬКО
 * проводку UI → действие (закон №5/№8: DOM в /ui, содержимое мира не трогаем).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Seed, Tick } from '@zona/shared';
import SaveControls from './SaveControls';
import { useUiStore } from '../store/store';
import type { SaveMeta } from '../persistence/saves';

const actions = {
  requestSave: vi.fn(),
  refreshSaves: vi.fn(),
  loadSave: vi.fn(),
  deleteSave: vi.fn(),
};

function meta(id: string, name: string): SaveMeta {
  return { id, seed: 42 as Seed, tick: 1500 as Tick, name, savedAt: 1_700_000_000_000 };
}

beforeEach(() => {
  for (const f of Object.values(actions)) f.mockClear();
  useUiStore.setState({
    connected: true,
    saves: [meta('id-1', 'привал'), meta('id-2', '')],
    savedIndicator: null,
    ...actions,
  });
});

afterEach(() => cleanup());

describe('SaveControls: проводка UI → действия стора', () => {
  it('«Сохранить» дёргает requestSave с введённым именем', () => {
    render(<SaveControls />);
    const input = screen.getByLabelText('Имя сохранения');
    fireEvent.change(input, { target: { value: 'у костра' } });
    fireEvent.click(screen.getByText('Сохранить'));
    expect(actions.requestSave).toHaveBeenCalledWith('у костра');
  });

  it('«Сохранить» без имени вызывает requestSave с пустой строкой', () => {
    render(<SaveControls />);
    fireEvent.click(screen.getByText('Сохранить'));
    expect(actions.requestSave).toHaveBeenCalledWith('');
  });

  it('«Сохранить» обрезает пробелы вокруг имени (в мир не течёт мусорный whitespace)', () => {
    render(<SaveControls />);
    const input = screen.getByLabelText('Имя сохранения');
    fireEvent.change(input, { target: { value: '  у костра  ' } });
    fireEvent.click(screen.getByText('Сохранить'));
    expect(actions.requestSave).toHaveBeenCalledWith('у костра');
  });

  it('поле имени очищается после сохранения (готово к следующему сейву)', () => {
    render(<SaveControls />);
    const input = screen.getByLabelText('Имя сохранения') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'привал' } });
    fireEvent.click(screen.getByText('Сохранить'));
    expect(input.value).toBe('');
  });

  it('кнопки сохранения заблокированы, пока мост не подключён', () => {
    useUiStore.setState({ connected: false });
    render(<SaveControls />);
    expect((screen.getByText('Сохранить') as HTMLButtonElement).disabled).toBe(true);
  });

  it('«Загрузить ▾» открывает меню и обновляет список (refreshSaves)', () => {
    render(<SaveControls />);
    // Меню закрыто — записей не видно.
    expect(screen.queryByText('привал')).toBeNull();
    fireEvent.click(screen.getByText('Загрузить ▾'));
    expect(actions.refreshSaves).toHaveBeenCalledTimes(1);
    // Записи появились (в т.ч. «(без имени)» для пустого name).
    expect(screen.getByText('привал')).toBeTruthy();
    expect(screen.getByText('(без имени)')).toBeTruthy();
  });

  it('клик «Загрузить» на записи дёргает loadSave(id) и закрывает меню', () => {
    render(<SaveControls />);
    fireEvent.click(screen.getByText('Загрузить ▾'));
    const loadButtons = screen.getAllByText('Загрузить');
    fireEvent.click(loadButtons[0]!); // первая запись — id-1
    expect(actions.loadSave).toHaveBeenCalledWith('id-1');
    // Меню закрылось.
    expect(screen.queryByText('привал')).toBeNull();
  });

  it('клик «✕» дёргает deleteSave(id)', () => {
    render(<SaveControls />);
    fireEvent.click(screen.getByText('Загрузить ▾'));
    fireEvent.click(screen.getByLabelText('Удалить сохранение привал'));
    expect(actions.deleteSave).toHaveBeenCalledWith('id-1');
  });

  it('индикатор «сохранено» виден при savedIndicator', () => {
    useUiStore.setState({ savedIndicator: { id: 'id-1', savedAt: 1 } });
    render(<SaveControls />);
    expect(screen.getByTestId('saved-indicator')).toBeTruthy();
  });

  it('пустой список показывает «нет сохранений»', () => {
    useUiStore.setState({ saves: [] });
    render(<SaveControls />);
    fireEvent.click(screen.getByText('Загрузить ▾'));
    expect(screen.getByText('нет сохранений')).toBeTruthy();
  });
});
