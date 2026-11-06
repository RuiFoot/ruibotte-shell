import { CirclePlay, CircleStop, FileText, Layers, RefreshCw, RotateCw, Search, SquareTerminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { Select } from "../Select";
import { confirmAction, errText, LogView, type SudoCtx, sq, srvRun, srvStream, sudoAllowed, usePoll, useLines } from "./common";

/**
 * Docker 칸 — 컨테이너 목록(이름·이미지·상태·포트·만든 지·CPU/메모리), compose 프로젝트 묶음, 실행 중/전체,
 * 로그 실시간(docker logs -f --tail), 컨테이너 안 셸, 시작·중지·재시작·삭제(확인), 이미지 목록·용량.
 * docker 소켓 권한이 없으면 계정 sudo 설정을 따라 sudo 로, podman 만 있으면 podman 으로.
 */
export type DockerPanelProps = {
	conn: number;
	sudo?: SudoCtx;
	visible?: boolean;
	/** 터미널 새 탭에서 명령 돌리기 — 컨테이너 셸 */
	onOpenTerminal?: (cmd: string, title: string) => void;
};

export type Container = { id: string; name: string; image: string; state: string; status: string; ports: string; created: string; project: string; service: string };
type Img = { repo: string; tag: string; id: string; size: string; created: string };
type Stat = { cpu: string; mem: string; memPct: string };
type Env = { state: "loading" | "none" | "denied" | "down" | "ok"; bin: string; sudo: boolean; message?: string };

/** {{.Labels}} — docker 는 "a=b,c=d", podman 은 "map[a:b c:d]" */
export function parseLabels(s: string): Record<string, string> {
	const o: Record<string, string> = {};
	const t = s.trim();
	if (t.startsWith("map[")) {
		for (const kv of t.slice(4, -1).split(" ")) {
			const i = kv.indexOf(":");
			if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
		}
	} else {
		for (const kv of t.split(",")) {
			const i = kv.indexOf("=");
			if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
		}
	}
	return o;
}

export function parseContainers(out: string): Container[] {
	return out
		.split("\n")
		.filter((l) => l.includes("\t"))
		.map((l) => {
			const [id, name, image, state, status, ports, created, labels = ""] = l.split("\t");
			const lb = parseLabels(labels);
			return {
				id,
				name: name.replace(/^\//, ""),
				image,
				state: state.toLowerCase(),
				status,
				ports,
				created,
				project: lb["com.docker.compose.project"] ?? lb["io.podman.compose.project"] ?? "",
				service: lb["com.docker.compose.service"] ?? "",
			};
		});
}

const PS_FMT = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.RunningFor}}\t{{.Labels}}";

/** 포트 줄을 짧게 — "0.0.0.0:8080->80/tcp, :::8080->80/tcp" → "8080→80" */
const shortPorts = (p: string) =>
	[
		...new Set(
			p
				.split(/,\s*/)
				.map((x) => x.trim())
				.filter(Boolean)
				.map((x) => {
					const m = x.match(/:(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(\w+)/);
					if (m) return `${m[1]}→${m[2]}${m[3] === "tcp" ? "" : `/${m[3]}`}`;
					return x.replace(/\/tcp$/, "");
				}),
		),
	].join(", ");

export function DockerPanel({ conn, sudo, visible = true, onOpenTerminal }: DockerPanelProps) {
	const [env, setEnv] = useState<Env>({ state: "loading", bin: "docker", sudo: false });
	const [tab, setTab] = useState<"ps" | "images">("ps");
	const [list, setList] = useState<Container[]>([]);
	const [stats, setStats] = useState<Map<string, Stat>>(new Map());
	const [images, setImages] = useState<Img[]>([]);
	const [df, setDf] = useState("");
	const [all, setAll] = useState(false);
	const [group, setGroup] = useState(true);
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null);
	const [sel, setSel] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; c: Container } | null>(null);
	const canSudo = sudoAllowed(sudo);

	/** 어느 명령으로·sudo 가 필요한지 */
	const detect = useCallback(async () => {
		try {
			const r = await srvRun(conn, "for b in docker podman; do if command -v $b >/dev/null 2>&1; then echo bin=$b; break; fi; done; echo uid=$(id -u)");
			const bin = r.stdout.match(/bin=(\w+)/)?.[1];
			if (!bin) return setEnv({ state: "none", bin: "docker", sudo: false });
			const root = /uid=0\b/.test(r.stdout);
			const p = await srvRun(conn, `${bin} ps -q 2>&1 >/dev/null`, { timeoutMs: 20000 });
			const msg = (p.stdout + p.stderr).trim();
			if (p.code === 0) return setEnv({ state: "ok", bin, sudo: false });
			if (/permission denied/i.test(msg) && !root) {
				if (!canSudo) return setEnv({ state: "denied", bin, sudo: false, message: msg });
				const s = await srvRun(conn, `${bin} ps -q 2>&1 >/dev/null`, { sudo: true, timeoutMs: 20000 });
				if (s.code === 0) return setEnv({ state: "ok", bin, sudo: true });
				return setEnv({ state: "down", bin, sudo: true, message: (s.stdout + s.stderr).trim() });
			}
			setEnv({ state: "down", bin, sudo: false, message: msg });
		} catch (e) {
			setEnv({ state: "down", bin: "docker", sudo: false, message: errText(e) });
		}
	}, [conn, canSudo]);

	useEffect(() => {
		void detect();
	}, [detect]);

	const D = env.bin;
	const run = useCallback((cmd: string, timeoutMs = 30000) => srvRun(conn, cmd, { sudo: env.sudo, timeoutMs }), [conn, env.sudo]);

	const loadStats = useCallback(async () => {
		let r = await run(`${D} stats --no-stream --no-trunc --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' 2>&1`, 40000);
		if (r.code !== 0 && /unknown flag|no-trunc/.test(r.stdout)) r = await run(`${D} stats --no-stream --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' 2>&1`, 40000);
		const m = new Map<string, Stat>();
		for (const l of r.stdout.split("\n")) {
			const [id, cpu, mem, memPct] = l.split("\t");
			if (id && cpu != null) m.set(id.trim(), { cpu: cpu.trim(), mem: (mem ?? "").trim(), memPct: (memPct ?? "").trim() });
		}
		setStats(m);
	}, [D, run]);

	const load = useCallback(async () => {
		if (env.state !== "ok") return;
		setBusy(true);
		try {
			const r = await run(`${D} ps -a --no-trunc --format '${PS_FMT}'`);
			if (r.code !== 0) throw new Error(r.stderr.trim() || `실패(종료 코드 ${r.code})`);
			setList(parseContainers(r.stdout));
			void loadStats().catch(() => undefined);
		} catch (e) {
			setNote({ text: errText(e), err: true });
		} finally {
			setBusy(false);
		}
	}, [env.state, D, run, loadStats]);

	const loadImages = useCallback(async () => {
		if (env.state !== "ok") return;
		setBusy(true);
		try {
			const r = await run(`${D} images --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}'`);
			setImages(
				r.stdout
					.split("\n")
					.filter((l) => l.includes("\t"))
					.map((l) => {
						const [repo, tag, id, size, created] = l.split("\t");
						return { repo, tag, id, size, created };
					}),
			);
			const d = await run(`${D} system df 2>/dev/null`);
			setDf(d.code === 0 ? d.stdout.trim() : "");
		} catch (e) {
			setNote({ text: errText(e), err: true });
		} finally {
			setBusy(false);
		}
	}, [env.state, D, run]);

	useEffect(() => {
		if (tab === "ps") void load();
		else void loadImages();
	}, [tab, load, loadImages]);
	usePoll(() => (tab === "ps" ? load() : Promise.resolve()), 15, visible && env.state === "ok");

	const act = async (c: Container, verb: "start" | "stop" | "restart" | "rm") => {
		const running = c.state === "running";
		const label = { start: "시작", stop: "중지", restart: "재시작", rm: "삭제" }[verb];
		if (verb !== "start") {
			const ok = await confirmAction({
				title: `${c.name} ${label}`,
				message:
					verb === "rm"
						? `컨테이너를 지웁니다${running ? "(실행 중이라 강제로 멈추고 지움)" : ""}. 볼륨에 두지 않은 컨테이너 안 파일은 사라지고 되돌릴 수 없습니다.`
						: verb === "stop"
							? "컨테이너가 멈춥니다. 다시 시작할 수 있습니다."
							: "컨테이너를 껐다 켭니다. 잠깐 끊깁니다.",
				okLabel: label,
				danger: true,
			});
			if (!ok) return;
		}
		setNote({ text: `${c.name} ${label} 중…` });
		const cmd = verb === "rm" ? `${D} rm ${running ? "-f " : ""}${sq(c.id)}` : `${D} ${verb} ${sq(c.id)}`;
		try {
			const r = await run(`${cmd} 2>&1`, 120000);
			if (r.code !== 0) throw new Error(r.stdout.trim().split("\n").pop() || `실패(종료 코드 ${r.code})`);
			setNote({ text: `${c.name} ${label} 했습니다` });
			if (verb === "rm" && sel === c.id) setSel(null);
		} catch (e) {
			setNote({ text: errText(e), err: true });
		}
		void load();
	};

	const rmi = async (i: Img) => {
		const name = i.repo === "<none>" ? i.id : `${i.repo}:${i.tag}`;
		if (!(await confirmAction({ title: `이미지 ${name} 삭제`, message: "이 이미지를 쓰는 컨테이너가 있으면 지우지 못합니다.", okLabel: "삭제", danger: true }))) return;
		try {
			const r = await run(`${D} rmi ${sq(i.repo === "<none>" ? i.id : name)} 2>&1`, 120000);
			setNote(r.code === 0 ? { text: `${name} 을(를) 지웠습니다` } : { text: r.stdout.trim().split("\n").pop() ?? "실패", err: true });
		} catch (e) {
			setNote({ text: errText(e), err: true });
		}
		void loadImages();
	};

	const shell = (c: Container) => {
		if (!onOpenTerminal) return;
		onOpenTerminal(`${env.sudo ? "sudo " : ""}${D} exec -it ${sq(c.id)} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`, `셸 · ${c.name}`);
	};

	const shown = useMemo(() => {
		const f = filter.trim().toLowerCase();
		return list
			.filter((c) => (all || c.state === "running") && (!f || c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || c.project.toLowerCase().includes(f)))
			.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
	}, [list, all, filter]);

	const groups = useMemo(() => {
		if (!group) return [{ key: "", items: shown }];
		const m = new Map<string, Container[]>();
		for (const c of shown) m.set(c.project, [...(m.get(c.project) ?? []), c]);
		return [...m.entries()].sort((a, b) => (a[0] === "") === (b[0] === "") ? a[0].localeCompare(b[0]) : a[0] === "" ? 1 : -1).map(([key, items]) => ({ key, items }));
	}, [shown, group]);

	if (env.state === "loading") return <div className="sp-panel sp-center">Docker 를 찾는 중…</div>;
	if (env.state === "none")
		return (
			<div className="sp-panel sp-center">
				<p>이 서버에는 docker·podman 명령이 없습니다.</p>
			</div>
		);
	if (env.state === "denied" || env.state === "down")
		return (
			<div className="sp-panel sp-center">
				<p>{env.state === "denied" ? `${env.bin} 를 쓸 권한이 없습니다.` : `${env.bin} 에 붙지 못했습니다.`}</p>
				{env.message && <pre className="sp-pre">{env.message}</pre>}
				<p className="sp-dim">
					{env.state === "denied" ? "계정을 docker 묶음에 넣거나(sudo usermod -aG docker 사용자 → 다시 접속), 계정 설정에서 sudo 를 켜세요." : "데몬이 꺼져 있을 수 있습니다(systemctl status docker)."}
				</p>
				<button type="button" className="btn" onClick={() => void detect()}>
					다시 확인
				</button>
			</div>
		);

	const cur = list.find((c) => c.id === sel);
	const statOf = (c: Container) => [...stats.entries()].find(([k]) => k && c.id.startsWith(k))?.[1];
	const items = (c: Container): MenuItem[] => [
		{ label: "로그 보기", run: () => setSel(c.id) },
		...(onOpenTerminal ? [{ label: "셸 열기", run: () => shell(c), disabled: c.state !== "running" }] : []),
		{ sep: true },
		{ label: "시작", run: () => void act(c, "start"), disabled: c.state === "running" },
		{ label: "중지", run: () => void act(c, "stop"), danger: true, disabled: c.state !== "running" },
		{ label: "재시작", run: () => void act(c, "restart"), danger: true },
		{ sep: true },
		{ label: "삭제", run: () => void act(c, "rm"), danger: true },
		{ label: "ID 복사", run: () => void navigator.clipboard.writeText(c.id) },
	];

	return (
		<div className="sp-panel sp-docker">
			<div className="sp-bar">
				<div className="seg sp-seg" role="group">
					<button type="button" aria-pressed={tab === "ps"} onClick={() => setTab("ps")}>
						컨테이너
					</button>
					<button type="button" aria-pressed={tab === "images"} onClick={() => setTab("images")}>
						이미지
					</button>
				</div>
				{tab === "ps" && (
					<>
						<label className="sp-find">
							<Search size={13} />
							<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="이름·이미지·프로젝트" spellCheck={false} />
						</label>
						<button type="button" className={`btn ghost tiny${all ? " on" : ""}`} aria-pressed={all} onClick={() => setAll((x) => !x)} title="멈춘 것까지 모두 보기">
							{all ? "전체" : "실행 중"}
						</button>
						<button type="button" className={`btn ghost tiny${group ? " on" : ""}`} aria-pressed={group} onClick={() => setGroup((x) => !x)} title="compose 프로젝트로 묶기">
							<Layers size={13} />
						</button>
					</>
				)}
				<span className="sp-grow" />
				<small className="sp-dim">
					{env.bin}
					{env.sudo ? " · sudo" : ""}
				</small>
				<button type="button" className="btn ghost tiny" onClick={() => void (tab === "ps" ? load() : loadImages())} disabled={busy} title="새로 고침">
					<RefreshCw size={13} className={busy ? "sp-spin" : undefined} />
				</button>
			</div>
			{note && <p className={`sp-pad ${note.err ? "err" : "sp-note"}`}>{note.text}</p>}
			{tab === "images" ? (
				<div className="sp-scroll">
					<table className="sp-table">
						<thead>
							<tr>
								<th>저장소</th>
								<th>태그</th>
								<th>ID</th>
								<th className="num">크기</th>
								<th>만든 지</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{images.map((i) => (
								<tr key={`${i.id}:${i.repo}:${i.tag}`}>
									<td className="sp-mono">{i.repo}</td>
									<td>{i.tag}</td>
									<td className="sp-mono sp-dim">{i.id.replace(/^sha256:/, "").slice(0, 12)}</td>
									<td className="num">{i.size}</td>
									<td className="sp-dim">{i.created}</td>
									<td>
										<button type="button" className="btn ghost tiny danger" title="이미지 삭제" onClick={() => void rmi(i)}>
											<Trash2 size={12} />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{images.length === 0 && <div className="sp-empty">이미지가 없습니다</div>}
					{df && (
						<details className="sp-status sp-pad">
							<summary>디스크 사용(system df)</summary>
							<pre className="selectable">{df}</pre>
						</details>
					)}
				</div>
			) : (
				<div className={`sp-dsplit${cur ? " with-log" : ""}`}>
					<div className="sp-scroll">
						<table className="sp-table">
							<thead>
								<tr>
									<th>이름</th>
									<th>이미지</th>
									<th>상태</th>
									<th>포트</th>
									<th className="num">CPU</th>
									<th className="num">메모리</th>
									<th>만든 지</th>
									<th />
								</tr>
							</thead>
							{groups.map((g) => (
								<tbody key={g.key || "_"}>
									{group && (g.key || groups.length > 1) && (
										<tr className="sp-grow-row">
											<td colSpan={8}>
												<Layers size={12} /> {g.key || "묶이지 않음"} <small className="sp-dim">{g.items.length}개</small>
											</td>
										</tr>
									)}
									{g.items.map((c) => {
										const st = statOf(c);
										return (
											<tr
												key={c.id}
												className={`click${sel === c.id ? " sel" : ""}`}
												onClick={() => setSel(c.id)}
												onContextMenu={(e) => {
													e.preventDefault();
													setMenu({ x: e.clientX, y: e.clientY, c });
												}}
											>
												<td className="sp-mono" title={c.id}>
													<span className={`sp-dot st-${c.state === "running" ? "active" : c.state === "exited" || c.state === "dead" ? (/\(0\)/.test(c.status) ? "inactive" : "failed") : "activating"}`} />
													{c.service && group ? c.service : c.name}
												</td>
												<td className="sp-dim sp-clip" title={c.image}>
													{c.image}
												</td>
												<td className="sp-clip" title={c.status}>
													{c.status}
												</td>
												<td className="sp-mono sp-clip" title={c.ports}>
													{shortPorts(c.ports)}
												</td>
												<td className="num">{st?.cpu ?? (c.state === "running" ? "…" : "")}</td>
												<td className="num" title={st?.mem}>
													{st ? `${st.mem.split("/")[0].trim()}${st.memPct ? ` · ${st.memPct}` : ""}` : ""}
												</td>
												<td className="sp-dim">{c.created}</td>
												<td className="acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
													{c.state === "running" ? (
														<button type="button" className="btn ghost tiny danger" title="중지" onClick={() => void act(c, "stop")}>
															<CircleStop size={12} />
														</button>
													) : (
														<button type="button" className="btn ghost tiny" title="시작" onClick={() => void act(c, "start")}>
															<CirclePlay size={12} />
														</button>
													)}
													<button type="button" className="btn ghost tiny" title="재시작" onClick={() => void act(c, "restart")}>
														<RotateCw size={12} />
													</button>
													{onOpenTerminal && (
														<button type="button" className="btn ghost tiny" title="셸 열기" disabled={c.state !== "running"} onClick={() => shell(c)}>
															<SquareTerminal size={12} />
														</button>
													)}
													<button type="button" className="btn ghost tiny" title="로그" onClick={() => setSel(c.id)}>
														<FileText size={12} />
													</button>
													<button type="button" className="btn ghost tiny danger" title="삭제" onClick={() => void act(c, "rm")}>
														<Trash2 size={12} />
													</button>
												</td>
											</tr>
										);
									})}
								</tbody>
							))}
						</table>
						{shown.length === 0 && <div className="sp-empty">{all ? "컨테이너가 없습니다" : "실행 중인 컨테이너가 없습니다 — [실행 중]을 눌러 전체를 보세요"}</div>}
					</div>
					{cur && <ContainerLogs key={cur.id} conn={conn} bin={D} sudo={env.sudo} c={cur} onClose={() => setSel(null)} />}
				</div>
			)}
			{menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.c)} onClose={() => setMenu(null)} />}
		</div>
	);
}

function ContainerLogs({ conn, bin, sudo, c, onClose }: { conn: number; bin: string; sudo: boolean; c: Container; onClose: () => void }) {
	const stream = useLines(20000);
	const [tail, setTail] = useState(200);
	const [ts, setTs] = useState(false);
	const [state, setState] = useState<{ text: string; err?: boolean }>({ text: "여는 중…" });
	const { push, end, clear } = stream;
	useEffect(() => {
		let close: (() => void) | null = null;
		let gone = false;
		clear();
		setState({ text: "여는 중…" });
		srvStream(conn, `${bin} logs -f --tail ${tail}${ts ? " --timestamps" : ""} ${sq(c.id)} 2>&1`, {
			sudo,
			onText: push,
			onEnd: (e) => {
				end();
				if (!gone) setState(e.cancelled ? { text: "멈춤" } : { text: `끝남 — 컨테이너가 멈췄습니다(종료 코드 ${e.code ?? "?"})` });
			},
		})
			.then((x) => {
				if (gone) x();
				else {
					close = x;
					setState({ text: `${c.name} 실시간` });
				}
			})
			.catch((e) => !gone && setState({ text: errText(e), err: true }));
		return () => {
			gone = true;
			close?.();
		};
	}, [conn, bin, sudo, c.id, c.name, tail, ts, push, end, clear]);
	return (
		<div className="sp-dlog">
			<LogView
				stream={stream}
				left={
					<>
						<b className="sp-mono sp-clip">{c.name}</b>
						<Select size="sm" value={tail} onChange={setTail} title="처음 보일 줄 수" options={[50, 200, 1000, 5000].map((n) => ({ value: n, label: `${n}줄` }))} />
						<button type="button" className={`btn ghost tiny${ts ? " on" : ""}`} aria-pressed={ts} onClick={() => setTs((x) => !x)} title="줄마다 시각">
							시각
						</button>
						<button type="button" className="btn ghost tiny" onClick={onClose} title="로그 닫기">
							닫기
						</button>
					</>
				}
				status={<span className={state.err ? "err" : "sp-dim"}>{state.text}</span>}
			/>
		</div>
	);
}
