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

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
