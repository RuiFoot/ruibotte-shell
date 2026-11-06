import { CheckCircle2, CircleDashed, CircleSlash, ClipboardCopy, Info, Loader2, RefreshCw, Stethoscope, TriangleAlert, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type DiagReport, type DiagStep, routes as routeApi } from "../lib/ipc";

const ICON: Record<DiagStep["status"], React.ReactNode> = {
	ok: <CheckCircle2 size={14} className="dg-ic ok" />,
	fail: <XCircle size={14} className="dg-ic fail" />,
	warn: <TriangleAlert size={14} className="dg-ic warn" />,
	skip: <CircleSlash size={14} className="dg-ic skip" />,
	info: <Info size={14} className="dg-ic info" />,
};
const MARK: Record<DiagStep["status"], string> = { ok: "✓", fail: "✗", warn: "!", skip: "-", info: "·" };

/** 진단 결과를 글로(복사용) */
export function diagText(r: DiagReport): string {
	const lines = [`RuiBotte Shell 접속 진단 — ${r.profile} (계정 ${r.account}) · ${new Date(r.at).toLocaleString()}`];
	const net = [
		r.net.gateways.length ? `게이트웨이 ${r.net.gateways.join(", ")}` : "",
		r.net.dnsSuffixes.length ? `DNS 접미사 ${r.net.dnsSuffixes.join(", ")}` : "",
		r.net.wifi.length ? `Wi-Fi ${r.net.wifi.join(", ")}` : "",
	].filter(Boolean);
	if (net.length) lines.push(`이 PC 의 망: ${net.join(" · ")}`);
	for (const x of r.routes) {
		lines.push("", `[${x.ok ? "✓" : "✗"}] ${x.label} — ${x.summary}${x.cond ? ` (${x.cond})` : ""}`);
		for (const s of x.steps) {
			lines.push(`  ${MARK[s.status]} ${s.name}${s.ms != null ? ` ${s.ms}ms` : ""} — ${s.detail}`);
			if (s.hint) lines.push(`      → ${s.hint}`);
		}
	}
	return lines.join("\n");
}

/**
 * 접속 진단 — 경로마다 이름 풀이 → TCP(3회 평균) → SSH 인사 → 키 교환·호스트 키 → 인증까지 어디서 막혔는지.
 * 처음 보는 호스트 키면 인증은 시험하지 않는다. 저장한 비밀만 쓰고 묻지 않는다.
 */
export function DiagSheet({ profileId, accountId, title, onClose }: { profileId: number; accountId?: number | null; title: string; onClose: () => void }) {
	const [rep, setRep] = useState<DiagReport | null>(null);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const run = useCallback(async () => {
		setBusy(true);
		setErr("");
		try {
			setRep(await routeApi.diagnose(profileId, accountId));
		} catch (e) {
			setErr(String((e as { message?: string }).message ?? e));
		} finally {
			setBusy(false);
		}
	}, [profileId, accountId]);
	useEffect(() => {
		void run();
	}, [run]);

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
			<div
				className="sheet wide dg-sheet"
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						onClose();
					}
				}}
			>
				<h3>
					<Stethoscope size={15} /> 접속 진단 · {title}
				</h3>
				{busy && (
					<p className="dg-busy">
						<Loader2 size={14} className="spin" /> 경로마다 단계별로 살펴보는 중… (막힌 경로는 몇 초 걸립니다)
					</p>
				)}
				{err && <p className="err">{err}</p>}
				{rep && (
					<>
						{(rep.net.gateways.length > 0 || rep.net.dnsSuffixes.length > 0 || rep.net.wifi.length > 0) && (
							<p className="dg-net">
								이 PC 의 망 —{rep.net.gateways.length ? ` 게이트웨이 ${rep.net.gateways.join(", ")}` : ""}
								{rep.net.dnsSuffixes.length ? ` · DNS 접미사 ${rep.net.dnsSuffixes.join(", ")}` : ""}
								{rep.net.wifi.length ? ` · Wi-Fi ${rep.net.wifi.join(", ")}` : ""}
							</p>
						)}
						{rep.routes.map((r, i) => (
							<section key={r.routeId ?? i} className={`dg-route${r.ok ? " ok" : ""}`}>
								<header>
									{r.ok ? <CheckCircle2 size={15} className="dg-ic ok" /> : <XCircle size={15} className="dg-ic fail" />}
									<b>{r.label}</b>
									<small>{r.summary}</small>
								</header>
								<ol className="dg-steps">
									{r.steps.map((s, j) => (
										<li key={`${s.name}-${j}`} className={`dg-step ${s.status}`}>
											{ICON[s.status]}
											<span className="dg-name">{s.name}</span>
											<span className="dg-ms">{s.ms != null ? `${s.ms}ms` : ""}</span>
											<span className="dg-detail">{s.detail}</span>
											{s.hint && <span className="dg-hint">{s.hint}</span>}
										</li>
									))}
									{!r.ok && r.steps.length > 0 && r.steps[r.steps.length - 1].status === "ok" && (
										<li className="dg-step skip">
											<CircleDashed size={14} className="dg-ic skip" />
											<span className="dg-name">다음 단계</span>
											<span className="dg-ms" />
											<span className="dg-detail">여기서 멈췄습니다</span>
										</li>
									)}
								</ol>
							</section>
						))}
					</>
				)}
				<div className="sheet-actions">
					<button
						type="button"
						className="btn"
						disabled={!rep}
						onClick={() => {
							if (!rep) return;
							void navigator.clipboard.writeText(diagText(rep)).then(() => {
								setCopied(true);
								window.setTimeout(() => setCopied(false), 1500);
							});
						}}
						title="결과를 글로 복사(관리자에게 보내기 등) — 암호는 들어 있지 않습니다"
					>
						<ClipboardCopy size={14} /> {copied ? "복사했습니다" : "결과 복사"}
					</button>
					<span style={{ flex: 1 }} />
					<button type="button" className="btn" disabled={busy} onClick={() => void run()}>
						<RefreshCw size={14} /> 다시 진단
					</button>
					<button type="button" className="btn primary" onClick={onClose}>
						닫기
					</button>
				</div>
			</div>
		</div>
	);
}
