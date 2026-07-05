/**
 * Конфиг Vite для `@zona/ui` (задача 4.0). React-плагин + разрешение workspace-алиасов
 * `@zona/*` на исходники (как tsconfig.base paths), чтобы dev/сборка видели ядро без
 * предварительной компиляции пакетов. Воркер (`src/worker/sim-worker.ts`) собирается как
 * ES-module-чанк автоматически по паттерну `new Worker(new URL(...), { type: 'module' })`.
 *
 * Vite здесь — ТОЛЬКО инструмент сборки/дев-сервера UI (закон №5: DOM/Worker живут в
 * `@zona/ui`); `@zona/sim` остаётся headless и в этот конфиг не «протекает».
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const resolve = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@zona/shared': resolve('../shared/src/index.ts'),
      '@zona/sim': resolve('../sim/src/index.ts'),
    },
  },
  worker: {
    format: 'es',
  },
});
