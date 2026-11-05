/**
 * 열린 DB 트랜잭션 기록 — DB 탭 닫기·앱 끄기 전에 묻기 위해(저장 안 한 편집기 기록과 같은 방식).
 * 키는 DB 연결 번호, 값은 그 트랜잭션 안에서 실행한 문장 수와 탭 이름.
 */
const open = new Map<number, { stmts: number; label: string }>();

export function setOpenTx(conn: number, state: { stmts: number; label: string } | null) {
	if (state) open.set(conn, state);
	else open.delete(conn);
}

/** 열린 트랜잭션이 있으면 묻는다 — 계속하면 true. conns 를 안 주면 모든 연결 */
export function confirmOpenTx(conns: number[] | null, what: string): boolean {
	const list = [...open.entries()].filter(([c]) => !conns || conns.includes(c)).map(([, v]) => v);
	if (!list.length) return true;
	const lines = list
		.slice(0, 8)
		.map((v) => `· ${v.label} — ${v.stmts}문장`)
		.join("\n");
	return confirm(`커밋하지 않은 트랜잭션이 ${list.length}개 있습니다.\n${lines}\n\n${what} 연결이 끊기며 고친 내용은 모두 되돌아갑니다. 계속할까요?`);
}
