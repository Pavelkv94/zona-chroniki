/**
 * @module @zona/ui/main
 *
 * BOOTSTRAP наблюдателя (задача 4.0): монтирует React 18 (`createRoot`) и ПОДНИМАЕТ
 * Worker-мост — единственная точка, где создаётся живой воркер и отдаётся стартовая
 * команда `init` (стор лениво создаёт `WorkerClient`). Отделён от `App` (чистого
 * читателя), чтобы App тестировался в jsdom без живого воркера/таймеров (DoD 4.0).
 *
 * ЗАКОН №8: bootstrap задаёт seed и стартовый темп (пауза) — влияет на ТЕМП/паузу, не
 * на содержимое тиков. Наблюдатель дальше сам управляет скоростью с тайм-бара.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useUiStore } from './store/store';

/** Стартовый seed мира (тот же дефолт, что headless-CLI — сопоставимость историй). */
const DEFAULT_SEED = 42;

const container = document.getElementById('root');
if (container === null) throw new Error('main: контейнер #root не найден');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Поднять мост: собрать мир (стартует на паузе) → воркер пришлёт полный `view`.
useUiStore.getState().init(DEFAULT_SEED);
