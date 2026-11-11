import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./styles/ssh-extra.css";
import "./styles/route.css";
import "./styles/assist.css";
import { App } from "./App";

// 마우스 뒤로·앞으로 단추가 웹뷰 페이지 기록을 넘기지 않게(앱 안에서는 트리 뒤로·앞으로로 쓴다)
window.addEventListener(
	"mouseup",
	(e) => {
		if (e.button === 3 || e.button === 4) e.preventDefault();
	},
	{ capture: true },
);

// 도구 막대가 창보다 넓을 때(좁은 창) — 세로 휠로도 옆으로 밀어 가려진 단추에 닿게
window.addEventListener(
	"wheel",
	(e) => {
		const bar = (e.target as HTMLElement | null)?.closest?.(".wb-bar") as HTMLElement | null;
		if (!bar || bar.scrollWidth <= bar.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
		bar.scrollLeft += e.deltaY;
		e.preventDefault();
	},
	{ passive: false },
);

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
