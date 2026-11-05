import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";

// 웹 흔적 지우기: 브라우저 기본 우클릭 메뉴는 앱 전체에서 끈다(입력칸만 예외). 자체 메뉴는 각 칸이 띄운다.
window.addEventListener(
	"contextmenu",
	(e) => {
		const t = e.target as HTMLElement | null;
		if (t?.closest("input, textarea")) return;
		e.preventDefault();
	},
	{ capture: true },
);

async function boot() {
	// 일반 브라우저로 개발 서버를 열면(화면 점검) 가짜 백엔드를 붙인다. 배포판에서는 이 분기가 통째로 빠진다
	if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
		const { installMock } = await import("./dev/mock");
		installMock();
	}
	createRoot(document.getElementById("root") as HTMLElement).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
void boot();
