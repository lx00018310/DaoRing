import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
    open: false,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      // 多页面：index.html 为炼气篇教学关，battle.html 为斗法正式模式
      input: {
        main: 'index.html',
        battle: 'battle.html',
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
