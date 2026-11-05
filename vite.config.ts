import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri 개발 서버: 고정 포트, 화면 덮개 오류는 끔(앱 창에서 보기 어렵다)
export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	server: { port: 1420, strictPort: true, hmr: { overlay: false } },
	envPrefix: ["VITE_", "TAURI_ENV_"],
	build: {
		target: "es2022",
		sourcemap: false,
		chunkSizeWarningLimit: 1500,
	},
});
