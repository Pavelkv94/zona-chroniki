/**
 * @zona/ui — интерфейс наблюдателя (React 18 + zustand + Web Worker): схематичная карта,
 * радио-лог, летопись, инспектор сущностей, управление временем. Только ЧИТАЕТ виды/дельты
 * из воркера и КОМАНДУЕТ темпом/паузой/шагом/инспекцией — никогда не мутирует симуляцию
 * напрямую (закон №5/№8). Точка входа приложения — `main.tsx` (Vite), не этот barrel.
 *
 * Barrel экспонирует ЧИСТЫЕ/тестируемые части каркаса (задача 4.0): дельта-дифф вида,
 * стор наблюдателя, типизированный клиент моста. Панели (карта/эфир/летопись/инспектор)
 * добавят задачи 4.2–4.7.
 */

export { diffView, applyDelta } from './bridge/delta';
export { createWorkerClient } from './bridge/worker-client';
export type { WorkerClient, WorkerMessageHandler } from './bridge/worker-client';
export { useUiStore, __resetWorkerClientForTest } from './store/store';
export type { UiState, SimStats } from './store/store';
export { default as App } from './App';
