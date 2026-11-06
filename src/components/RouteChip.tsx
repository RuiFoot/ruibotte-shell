import { Route as RouteIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type RouteUsed, routes as routeApi } from "../lib/ipc";

/** 경로를 굳이 보일 만한지 — 경로가 여럿이거나, 점프·프록시를 거치거나, 앞 경로에서 넘어왔을 때 */
export function routeWorthShowing(r?: RouteUsed | null): r is RouteUsed {
	return !!r && (r.total > 1 || !!r.note || r.summary.includes(" · "));
}

/** 경로 풀이(툴팁) */
export function routeTitle(r: RouteUsed): string {
	return `경로: ${r.label} — ${r.summary}${r.note ? `\n\n앞서 시도한 경로:\n${r.note}` : ""}`;
}

/** 터미널 상태 줄 — 이 연결이 붙은 경로 */
export function RouteChip({ conn }: { conn: number }) {
	const [r, setR] = useState<RouteUsed | null>(null);
	useEffect(() => {
		let live = true;
		void routeApi
			.ofConn(conn)
			.then((x) => live && setR(x))
			.catch(() => live && setR(null));
		return () => {
			live = false;
		};
	}, [conn]);
	if (!routeWorthShowing(r)) return null;
	return (
		<span className={`route-chip${r.note ? " fell" : ""}`} title={routeTitle(r)}>
			<RouteIcon size={11} /> {r.label}
		</span>
	);
}
