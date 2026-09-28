import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';

/** 服务端启动后会写 runtime.json（实际端口 + 本次会话 token）。开发代理需要它，避免 CORS。 */
const RUNTIME_FILE = process.env['PM_RUNTIME'] ?? 'D:/素材库/runtime.json';

function runtime(): { port: number; token: string } {
  const fallback = { port: 8756, token: '' };
  try {
    if (!existsSync(RUNTIME_FILE)) return fallback;
    const raw = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as { port?: number; token?: string };
    return { port: raw.port ?? fallback.port, token: raw.token ?? '' };
  } catch {
    return fallback;
  }
}

const rt = runtime();
const target = `http://127.0.0.1:${rt.port}`;

// 开发模式：Vite 提供前端，/api 与 /media 反代到本地服务，并代填 token（浏览器端拿不到也不需要 token）
const proxy = {
  '/api': { target, headers: { 'x-pm-token': rt.token } },
  '/media': { target, headers: { 'x-pm-token': rt.token } },
  '/thumb': { target, headers: { 'x-pm-token': rt.token } },
};

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // 相对路径：以后被 Electron 套壳加载时不会 404（开发建议 §13.2）
    assetsDir: 'assets',
  },
  base: './',
  server: { port: 5173, proxy },
});
