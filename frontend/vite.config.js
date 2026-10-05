import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import ElementPlus from 'unplugin-element-plus/vite';
export default defineConfig({
  plugins: [
    vue(),
    // 组件在模板中首次使用时才引入，避免把整个 Element Plus 打进首屏。
    Components({
      dirs: [],
      dts: false,
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
    }),
    ElementPlus({ useSource: false }),
  ],
  server: {
    // 允许同一局域网通过本机 IP 访问前端开发页面。
    host: '0.0.0.0',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 1300 },
});
