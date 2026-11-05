/** DB 엔진 — 기본 포트·데이터베이스 칸 이름·JDBC 브리지 여부·SQL 문법 */
export type EngineKey = "postgres" | "mariadb" | "mysql" | "mssql" | "oracle" | "cubrid" | "tibero" | "altibase";

export const ENGINES: { key: EngineKey; label: string; port: number; dbLabel: string; jdbc: boolean }[] = [
	{ key: "postgres", label: "PostgreSQL", port: 5432, dbLabel: "데이터베이스", jdbc: false },
	{ key: "mariadb", label: "MariaDB", port: 3306, dbLabel: "데이터베이스", jdbc: false },
	{ key: "mysql", label: "MySQL", port: 3306, dbLabel: "데이터베이스", jdbc: false },
	{ key: "mssql", label: "SQL Server", port: 1433, dbLabel: "데이터베이스", jdbc: false },
	{ key: "oracle", label: "Oracle", port: 1521, dbLabel: "서비스 이름(예: ORCLPDB1)", jdbc: true },
	{ key: "cubrid", label: "CUBRID", port: 33000, dbLabel: "데이터베이스", jdbc: true },
	{ key: "tibero", label: "Tibero", port: 8629, dbLabel: "데이터베이스(SID)", jdbc: true },
	{ key: "altibase", label: "Altibase", port: 20300, dbLabel: "데이터베이스", jdbc: true },
];

export const engineOf = (k?: string | null) => ENGINES.find((e) => e.key === k) ?? ENGINES[0];

export function quoteIdentFor(engine: string, name: string): string {
	if (engine === "mariadb" || engine === "mysql") return `\`${name.replaceAll("`", "``")}\``;
	if (engine === "mssql") return `[${name.replaceAll("]", "]]")}]`;
	return `"${name.replaceAll('"', '""')}"`;
}

/** 표 앞부분 보기 SQL — 엔진마다 행 제한 문법이 다르다 */
export function selectTop(engine: string, table: string, n: number): string {
	if (engine === "mssql") return `SELECT TOP ${n} * FROM ${table}`;
	if (engine === "oracle" || engine === "tibero") return `SELECT * FROM ${table} FETCH FIRST ${n} ROWS ONLY`;
	return `SELECT * FROM ${table} LIMIT ${n}`;
}
