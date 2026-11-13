import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 다듬기 화면 단독 미리보기(목업) — 저장소 맨 위에서: npx vite build -c src/dev/vite.preview.config.ts --mode development --outDir <폴더>
export default defineConfig({
	plugins: [react()],
	base: "./",
	build: { target: "es2022", sourcemap: false, rollupOptions: { input: "src/dev/cleanup-preview.html" } },
});
