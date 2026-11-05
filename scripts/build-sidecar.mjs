// JDBC 브리지(sidecar/RbJdbc.java)를 Java 11 대상으로 컴파일해 src-tauri/resources/rb-jdbc.jar 로 묶는다.
// 필요: JDK 11+ (JAVA_HOME 또는 PATH 의 javac·jar). 사용: node scripts/build-sidecar.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = (n) => (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", n) : n);
const out = mkdtempSync(join(tmpdir(), "rbjdbc-"));
try {
	execFileSync(bin("javac"), ["--release", "11", "-encoding", "UTF-8", "-d", out, "sidecar/RbJdbc.java"], { stdio: "inherit" });
	mkdirSync("src-tauri/resources", { recursive: true });
	execFileSync(bin("jar"), ["--create", "--file", "src-tauri/resources/rb-jdbc.jar", "--main-class", "RbJdbc", "-C", out, "."], { stdio: "inherit" });
	console.log("src-tauri/resources/rb-jdbc.jar 만듦");
} finally {
	rmSync(out, { recursive: true, force: true });
}
