import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { buildInsertMany, type Cell, type ColMeta, type EditStmt, qualified } from "../lib/edits";
import { Select } from "./Select";

type CsvData = { rows: string[][]; delimiter: string; encoding: string };
type DbError = { code: string; message: string };

const SKIP = -1;

/**
 * CSV 가져오기 — 파일 고르기 → 열 맞추기·미리보기 → INSERT 묶음을 한 트랜잭션으로 실행(하나라도 틀리면 모두 되돌림).
 * 수동 커밋 모드면 열린 트랜잭션 안 세이브포인트로 들어가 커밋해야 남는다.
 */
export function ImportCsvSheet({
	conn,
	engine,
	schema,
	table,
	onClose,
	onDone,
}: {
	conn: number;
	engine: string;
	schema: string | null;
	table: string;
	onClose: () => void;
	onDone: (msg: string) => void;
}) {
	const [metas, setMetas] = useState<ColMeta[] | null>(null);
	const [csv, setCsv] = useState<CsvData | null>(null);
	const [path, setPath] = useState("");
	const [header, setHeader] = useState(true);
	const [emptyNull, setEmptyNull] = useState(true);
	const [map, setMap] = useState<number[]>([]);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");

	useEffect(() => {
		void invoke<ColMeta[]>("db_table_meta", { conn, schema, table })
			.then(setMetas)
			.catch((e) => setErr((e as DbError).message ?? String(e)));
	}, [conn, schema, table]);

	const pick = async () => {
		const p = await openDialog({ multiple: false, filters: [{ name: "CSV·TSV", extensions: ["csv", "tsv", "txt"] }] });
		if (typeof p !== "string") return;
		setErr("");
		try {
			const d = await invoke<CsvData>("db_read_csv", { path: p });
			setPath(p);
			setCsv(d);
		} catch (e) {
			setErr((e as DbError).message ?? String(e));
		}
	};

	const heads = useMemo(() => {
		if (!csv?.rows.length) return [];
		const w = Math.max(...csv.rows.slice(0, 50).map((r) => r.length));
		return Array.from({ length: w }, (_, i) => (header ? (csv.rows[0][i] ?? `열 ${i + 1}`) : `열 ${i + 1}`));
	}, [csv, header]);
	const body = useMemo(() => (csv ? (header ? csv.rows.slice(1) : csv.rows) : []).filter((r) => !(r.length === 1 && r[0] === "")), [csv, header]);

	// 열 맞추기 — 이름이 같으면(대소문자 무시) 그 열, 머리가 없으면 순서대로
	useEffect(() => {
		if (!metas || !heads.length) return;
		setMap(
			metas.map((m, i) => {
				const j = heads.findIndex((h) => h.trim().toLowerCase() === m.name.toLowerCase());
				return j >= 0 ? j : header ? SKIP : i < heads.length ? i : SKIP;
			}),
		);
	}, [metas, heads, header]);

	const used = metas ? metas.map((m, i) => ({ m, j: map[i] ?? SKIP })).filter((x) => x.j !== SKIP) : [];
	const cellOf = (r: string[], j: number): Cell => {
		const v = r[j] ?? "";
		return emptyNull && v === "" ? null : v;
	};
	const preview = body.slice(0, 5).map((r) => used.map((u) => cellOf(r, u.j)));

	const run = async () => {
		if (!metas || !used.length) return;
		setBusy(true);
		setErr("");
		try {
			const t = qualified(engine, schema, table);
			const stmts: EditStmt[] = buildInsertMany(
				engine,
				t,
				metas,
				used.map((u) => u.m.name),
				body.map((r) => used.map((u) => cellOf(r, u.j))),
			);
			const r = await invoke<{ affected: number[]; inTx: boolean }>("db_apply", { conn, stmts });
			const n = r.affected.reduce((a, b) => a + b, 0);
			onDone(`${n.toLocaleString()}행을 넣었습니다${r.inTx ? "(트랜잭션 안 — 커밋해야 남습니다)" : ""}`);
		} catch (e) {
			setErr(`${(e as DbError).message ?? String(e)}\n— 모두 되돌렸습니다`);
		} finally {
			setBusy(false);
		}
	};

	const options = [{ value: SKIP, label: "(넣지 않음 — 기본값)" }, ...heads.map((h, j) => ({ value: j, label: h || `열 ${j + 1}` }))];

	return (
		<div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
			<div className="sheet db-import" onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
				<h3>CSV 가져오기 — {table}</h3>
				<div className="db-import-file">
					<button type="button" className="btn" onClick={() => void pick()} disabled={busy}>
						파일 고르기…
					</button>
					<span className="db-import-path" title={path}>
						{path ? `${path.split(/[\\/]/).pop()} · ${body.length.toLocaleString()}행 · ${csv?.encoding} · 구분자 ${csv?.delimiter === "\t" ? "탭" : csv?.delimiter}` : "CSV·TSV 파일을 고르세요"}
					</span>
				</div>
				{csv && (
					<>
						<div className="db-import-opts">
							<label className="check">
								<input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> 첫 줄은 열 이름
							</label>
							<label className="check">
								<input type="checkbox" checked={emptyNull} onChange={(e) => setEmptyNull(e.target.checked)} /> 빈 칸은 NULL
							</label>
						</div>
						<div className="db-import-map">
							{metas?.map((m, i) => (
								<div key={m.name} className="db-import-maprow">
									<code title={m.dataType}>
										{m.pk ? "🔑 " : ""}
										{m.name}
									</code>
									<small>{m.dataType}</small>
									<Select size="sm" value={map[i] ?? SKIP} onChange={(v) => setMap((x) => x.map((y, k) => (k === i ? v : y)))} options={options} />
								</div>
							))}
						</div>
						{used.length > 0 && (
							<div className="db-import-preview">
								<table>
									<thead>
										<tr>
											{used.map((u) => (
												<th key={u.m.name}>{u.m.name}</th>
											))}
										</tr>
									</thead>
									<tbody>
										{preview.map((r, i) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: 미리보기 순서
											<tr key={i}>
												{r.map((v, j) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: 열 순서
													<td key={j} className={v === null ? "null" : ""}>
														{v === null ? "NULL" : v}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</>
				)}
				{err && <pre className="db-import-err">{err}</pre>}
				<div className="sheet-actions">
					<button type="button" className="btn" onClick={onClose} disabled={busy}>
						닫기
					</button>
					<button type="button" className="btn primary" disabled={busy || !used.length || !body.length} onClick={() => void run()}>
						{busy ? "넣는 중…" : `${body.length.toLocaleString()}행 넣기`}
					</button>
				</div>
			</div>
		</div>
	);
}
