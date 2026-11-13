//! 다듬기 시험 — 레거시 패턴마다 ① 정리본이 다시 읽히는지 ② safe 변환은 기대 SQL 과 같은 AST 인지 본다.
//! 표 이름은 일반 이름(공개 저장소).

use super::*;

fn run(sql: &str, engine: &str) -> CleanResult {
    cleanup(sql, engine, None, &[])
}

fn run_meta(sql: &str, engine: &str, meta: &CleanMeta) -> CleanResult {
    cleanup(sql, engine, Some(meta), &[])
}

fn stmt(sql: &str, engine: &str) -> Statement {
    let d = Eng::of(engine).dialect();
    let v = parse_plain(&*d, sql).unwrap_or_else(|| panic!("읽지 못함: {sql}"));
    assert_eq!(v.len(), 1, "문장 하나: {sql}");
    v.into_iter().next().unwrap()
}

/// 정리본이 다시 읽히고 기대 문장과 같은 AST 인지
fn same(r: &CleanResult, engine: &str, want: &str) {
    assert!(r.ok, "다듬기 실패: {:?}", r.error);
    let got = stmt(&r.text, engine);
    let exp = stmt(want, engine);
    assert_eq!(got, exp, "\n정리본: {}\n기대값: {}\n바꾼 것: {:?}", r.text, want, r.changes.iter().map(|c| (c.kind, c.on)).collect::<Vec<_>>());
}

fn reparses(r: &CleanResult, engine: &str) {
    assert!(r.ok, "다듬기 실패: {:?}", r.error);
    let _ = stmt(&r.text, engine);
}

fn kinds(r: &CleanResult) -> Vec<&'static str> {
    r.changes.iter().filter(|c| c.on).map(|c| c.kind).collect()
}

fn has(r: &CleanResult, kind: &str) -> bool {
    r.changes.iter().any(|c| c.kind == kind && c.on)
}

fn safety(r: &CleanResult, kind: &str) -> &'static str {
    r.changes.iter().find(|c| c.kind == kind).map(|c| c.safety).unwrap_or("-")
}

fn meta(tables: &[(&str, &[&str], &[&str])]) -> CleanMeta {
    CleanMeta {
        tables: tables
            .iter()
            .map(|(n, cols, pk)| MetaTable {
                schema: None,
                name: n.to_string(),
                cols: cols.iter().map(|c| MetaCol { name: c.to_string(), pk: pk.contains(c) }).collect(),
                unique: vec![],
            })
            .collect(),
    }
}

// ───────────── 쉼표 조인 ─────────────

#[test]
fn comma_join_three_tables() {
    let r = run("SELECT a.id, b.title, c.name FROM article a, board b, users c WHERE a.board_id = b.id AND a.writer_id = c.id AND a.hit > 10", "mysql");
    same(&r, "mysql", "SELECT a.id, b.title, c.name FROM article a INNER JOIN board b ON a.board_id = b.id INNER JOIN users c ON a.writer_id = c.id WHERE a.hit > 10");
    assert_eq!(safety(&r, "commaJoin"), "safe");
}

#[test]
fn comma_join_five_tables_full_names_get_short_aliases() {
    let sql = "SELECT tb_post.post_id, tb_board.board_nm, tb_file.file_nm, tb_user.user_nm, tb_dept.dept_nm \
               FROM tb_post, tb_board, tb_file, tb_user, tb_dept \
               WHERE tb_post.board_id = tb_board.board_id AND tb_file.post_id = tb_post.post_id \
               AND tb_user.user_id = tb_post.writer_id AND tb_dept.dept_id = tb_user.dept_id AND tb_post.use_yn = 'Y'";
    let r = run(sql, "mysql");
    same(
        &r,
        "mysql",
        "SELECT p.post_id, b.board_nm, f.file_nm, u.user_nm, d.dept_nm FROM tb_post AS p \
         INNER JOIN tb_board AS b ON p.board_id = b.board_id \
         INNER JOIN tb_file AS f ON f.post_id = p.post_id \
         INNER JOIN tb_user AS u ON u.user_id = p.writer_id \
         INNER JOIN tb_dept AS d ON d.dept_id = u.dept_id WHERE p.use_yn = 'Y'",
    );
    assert!(has(&r, "commaJoin") && has(&r, "alias"), "{:?}", kinds(&r));
}

#[test]
fn comma_join_without_condition_is_cross_join() {
    let r = run("SELECT d.id, t.title FROM doc d, venue t WHERE d.ext = 'pdf'", "mysql");
    same(&r, "mysql", "SELECT d.id, t.title FROM doc d CROSS JOIN venue t WHERE d.ext = 'pdf'");
    assert!(r.changes[0].detail.contains("CROSS JOIN"));
}

#[test]
fn comma_join_keeps_explicit_left_join_unit() {
    let r = run("SELECT a.id, c.name FROM a, b LEFT JOIN c ON c.id = b.cid WHERE a.id = b.aid AND a.x = 1", "postgres");
    same(&r, "postgres", "SELECT a.id, c.name FROM a INNER JOIN b ON a.id = b.aid LEFT JOIN c ON c.id = b.cid WHERE a.x = 1");
}

#[test]
fn comma_join_leaves_unqualified_conditions_in_where() {
    // 한정 안 된 열은 어느 표 것인지 모르니 WHERE 에 남긴다(메타데이터가 없을 때)
    let r = run("SELECT a.id FROM a, b WHERE a.id = b.aid AND flag = 'Y'", "postgres");
    same(&r, "postgres", "SELECT a.id FROM a INNER JOIN b ON a.id = b.aid WHERE flag = 'Y'");
}

// ───────────── Oracle (+) ─────────────

#[test]
fn oracle_plus_simple_left_join() {
    let r = run("SELECT e.name, d.dname FROM emp e, dept d WHERE e.deptno = d.deptno(+) AND e.sal > 1000", "oracle");
    same(&r, "oracle", "SELECT e.name, d.dname FROM emp e LEFT JOIN dept d ON e.deptno = d.deptno WHERE e.sal > 1000");
    assert_eq!(safety(&r, "outerJoin"), "safe");
}

#[test]
fn oracle_plus_chain_and_filter_on_optional_side() {
    let r = run("SELECT a.id, b.x, c.y FROM a, b, c WHERE a.id = b.aid(+) AND b.cid = c.id(+) AND b.flag(+) = 'Y' AND a.kind = 'K'", "oracle");
    same(&r, "oracle", "SELECT a.id, b.x, c.y FROM a LEFT JOIN b ON a.id = b.aid AND b.flag = 'Y' LEFT JOIN c ON b.cid = c.id WHERE a.kind = 'K'");
}

#[test]
fn oracle_plus_reorder_is_check() {
    let r = run("SELECT e.name, d.dname FROM dept d, emp e WHERE d.deptno(+) = e.deptno", "oracle");
    same(&r, "oracle", "SELECT e.name, d.dname FROM emp e LEFT JOIN dept d ON d.deptno = e.deptno");
    assert_eq!(safety(&r, "outerJoin"), "check");
}

#[test]
fn oracle_plus_reorder_with_star_is_left_alone() {
    let sql = "SELECT * FROM dept d, emp e WHERE d.deptno(+) = e.deptno";
    let r = run(sql, "oracle");
    assert!(!has(&r, "outerJoin"));
    assert!(!r.text.contains("JOIN"), "{}", r.text);
}

// ───────────── 조건 다듬기 ─────────────

#[test]
fn where_one_equals_one_chain() {
    let r = run("SELECT * FROM orders WHERE 1=1 AND status = 'A' AND 1 = 1 AND TRUE", "mysql");
    same(&r, "mysql", "SELECT * FROM orders WHERE status = 'A'");
}

#[test]
fn where_only_one_equals_one_is_dropped() {
    let r = run("SELECT id FROM orders WHERE 1=1", "postgres");
    same(&r, "postgres", "SELECT id FROM orders");
}

#[test]
fn duplicate_conditions() {
    let r = run("SELECT id FROM t WHERE a = 1 AND b = 2 AND a = 1 AND UPPER(c) = 'X' AND UPPER(c) = 'X'", "postgres");
    same(&r, "postgres", "SELECT id FROM t WHERE a = 1 AND b = 2 AND UPPER(c) = 'X'");
}

#[test]
fn random_duplicates_are_kept() {
    let r = run("SELECT id FROM t WHERE RAND() > 0.5 AND RAND() > 0.5", "mysql");
    assert!(!has(&r, "dupCond"));
}

#[test]
fn redundant_parens() {
    let r = run("SELECT id FROM t WHERE ((a = 1)) AND (b = 2 AND (c = 3)) AND (d = 1 OR e = 2)", "postgres");
    same(&r, "postgres", "SELECT id FROM t WHERE a = 1 AND b = 2 AND c = 3 AND (d = 1 OR e = 2)");
}

#[test]
fn in_single_and_not_rewrites() {
    let r = run("SELECT id FROM t WHERE status IN ('A') AND NOT (kind = 'X') AND NOT (x IS NULL) AND code NOT IN (3) AND NOT y > 2", "postgres");
    same(&r, "postgres", "SELECT id FROM t WHERE status = 'A' AND kind <> 'X' AND x IS NOT NULL AND code <> 3 AND y <= 2");
}

#[test]
fn or_chain_to_in() {
    let r = run("SELECT id FROM t WHERE (type = 'A' OR type = 'B' OR 'C' = type OR type IN ('D')) AND flag = 'Y'", "mysql");
    same(&r, "mysql", "SELECT id FROM t WHERE type IN ('A', 'B', 'C', 'D') AND flag = 'Y'");
}

#[test]
fn on_keeps_last_true_condition() {
    // ON 이 비면 PG 는 JOIN 을 못 읽는다 — 마지막 하나는 둔다
    let r = run("SELECT a.id FROM a JOIN b ON 1=1 AND a.id = b.aid", "postgres");
    same(&r, "postgres", "SELECT a.id FROM a JOIN b ON a.id = b.aid");
    let r = run("SELECT a.id FROM a JOIN b ON 1=1", "postgres");
    assert!(!r.changed, "{}", r.text);
}

#[test]
fn distinct_under_group_by() {
    let r = run("SELECT DISTINCT dept, COUNT(*) FROM emp GROUP BY dept", "postgres");
    same(&r, "postgres", "SELECT dept, COUNT(*) FROM emp GROUP BY dept");
    // 묶음 열이 결과에 없으면 DISTINCT 가 뜻이 있다
    let r = run("SELECT DISTINCT COUNT(*) FROM emp GROUP BY dept", "postgres");
    assert!(!has(&r, "distinctGroup"));
}

#[test]
fn unused_ctes() {
    let r = run("WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT y FROM b", "postgres");
    same(&r, "postgres", "WITH b AS (SELECT 2 AS y) SELECT y FROM b");
    let r = run("WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT 1", "postgres");
    same(&r, "postgres", "SELECT 1");
    // 쓰기 CTE 는 읽지 않아도 실행된다 — 두기
    let r = run("WITH d AS (DELETE FROM t WHERE id = 1 RETURNING id) SELECT 1", "postgres");
    assert!(!has(&r, "unusedCte"));
}

// ───────────── check 변환 ─────────────

#[test]
fn nested_derived_three_levels() {
    let sql = "SELECT x.id, x.title FROM (SELECT y.id, y.title FROM (SELECT z.id, z.title FROM (SELECT id, title FROM board WHERE use_yn = 'Y') z WHERE z.id > 10) y) x WHERE x.title LIKE 'A%'";
    let r = run(sql, "mysql");
    same(&r, "mysql", "SELECT x.id, x.title FROM board AS x WHERE use_yn = 'Y' AND x.id > 10 AND x.title LIKE 'A%'");
    assert_eq!(r.changes.iter().filter(|c| c.kind == "flattenDerived").count(), 3);
    assert_eq!(safety(&r, "flattenDerived"), "check");
}

#[test]
fn derived_with_renamed_columns_and_star() {
    let r = run("SELECT * FROM (SELECT b.post_no AS id, b.subject AS title FROM board b WHERE b.del = 'N') t WHERE t.id > 5", "postgres");
    same(&r, "postgres", "SELECT t.post_no AS id, t.subject AS title FROM board AS t WHERE t.del = 'N' AND t.post_no > 5");
}

#[test]
fn derived_with_group_by_is_kept() {
    let r = run("SELECT t.n FROM (SELECT dept, COUNT(*) AS n FROM emp GROUP BY dept) t", "postgres");
    assert!(!has(&r, "flattenDerived"));
}

#[test]
fn derived_with_order_by_and_rownum_is_kept() {
    // Oracle 상위 N개 — 안쪽 ORDER BY 를 버리면 다른 10행이 나온다
    let r = run("SELECT * FROM (SELECT id, title FROM board ORDER BY reg_dt DESC) v WHERE ROWNUM <= 10", "oracle");
    assert!(!has(&r, "flattenDerived"), "{:?}", kinds(&r));
    reparses(&r, "oracle");
    // 안쪽 WHERE 의 ROWNUM 도 바깥 조건과 섞으면 세는 행이 바뀐다
    let r = run("SELECT v.id FROM (SELECT id FROM board WHERE ROWNUM <= 5) v WHERE v.id > 3", "oracle");
    assert!(!has(&r, "flattenDerived"), "{:?}", kinds(&r));
}

#[test]
fn derived_with_order_by_limit_is_kept() {
    let r = run("SELECT * FROM (SELECT id, title FROM board ORDER BY hit DESC LIMIT 5) d", "mysql");
    assert!(!has(&r, "flattenDerived"), "{:?}", kinds(&r));
    reparses(&r, "mysql");
    let r = run("SELECT d.id FROM (SELECT id FROM board ORDER BY hit) d", "mysql");
    assert!(!has(&r, "flattenDerived"), "{:?}", kinds(&r));
}

#[test]
fn repeated_subquery_to_cte() {
    let sql = "SELECT o.id FROM orders o WHERE o.cust_id IN (SELECT c.id FROM customer c WHERE c.grade = 'VIP') OR o.ref_id IN (SELECT c.id FROM customer c WHERE c.grade = 'VIP')";
    let r = run(sql, "postgres");
    same(
        &r,
        "postgres",
        "WITH sq AS (SELECT c.id FROM customer c WHERE c.grade = 'VIP') SELECT o.id FROM orders o WHERE o.cust_id IN (SELECT * FROM sq) OR o.ref_id IN (SELECT * FROM sq)",
    );
    assert_eq!(safety(&r, "repeatToCte"), "check");
}

#[test]
fn correlated_repeated_subquery_is_not_extracted() {
    // 바깥 열(o.id)을 보는 서브쿼리는 CTE 로 뺄 수 없다
    let sql = "SELECT o.id FROM orders o WHERE o.total > (SELECT AVG(i.qty) FROM item i WHERE i.oid = o.id) AND o.cnt < (SELECT AVG(i.qty) FROM item i WHERE i.oid = o.id)";
    let r = run(sql, "postgres");
    assert!(!has(&r, "repeatToCte"));
    assert!(!r.changed, "{}", r.text);
    // 결과 열의 상관 서브쿼리는 먼저 LEFT JOIN 묶음이 되고, 같은 묶음 둘은 다시 CTE 하나로 모인다
    let sql = "SELECT o.id, (SELECT MAX(i.qty) FROM item i WHERE i.oid = o.id) AS a, (SELECT MAX(i.qty) FROM item i WHERE i.oid = o.id) AS b FROM orders o";
    let r = run(sql, "postgres");
    same(
        &r,
        "postgres",
        "WITH sq AS (SELECT i.oid AS k1, MAX(i.qty) AS v FROM item i GROUP BY i.oid) SELECT o.id, s.v AS a, s2.v AS b FROM orders o LEFT JOIN sq AS s ON s.k1 = o.id LEFT JOIN sq AS s2 ON s2.k1 = o.id",
    );
}

#[test]
fn correlated_scalar_count_to_left_join() {
    let sql = "SELECT bd.post_no, bd.subject, (SELECT COUNT(*) FROM board_file f WHERE f.post_no = bd.post_no AND f.del = 'N') AS files FROM board bd";
    let r = run(sql, "mysql");
    same(
        &r,
        "mysql",
        "SELECT bd.post_no, bd.subject, COALESCE(s.v, 0) AS files FROM board bd LEFT JOIN (SELECT f.post_no AS k1, COUNT(*) AS v FROM board_file f WHERE f.del = 'N' GROUP BY f.post_no) AS s ON s.k1 = bd.post_no",
    );
    assert_eq!(safety(&r, "scalarToJoin"), "check");
}

#[test]
fn not_in_to_not_exists() {
    let r = run("SELECT bd.post_no FROM board bd WHERE bd.post_no NOT IN (SELECT f.post_no FROM board_file f WHERE f.del = 'N')", "mysql");
    same(&r, "mysql", "SELECT bd.post_no FROM board bd WHERE NOT EXISTS (SELECT 1 FROM board_file f WHERE f.del = 'N' AND f.post_no = bd.post_no)");
    // 바깥 열이 한정 안 됐어도 바깥 표가 하나면 한정해서 옮긴다
    let r = run("SELECT post_no FROM board WHERE post_no NOT IN (SELECT f.post_no FROM board_file f)", "mysql");
    same(&r, "mysql", "SELECT post_no FROM board WHERE NOT EXISTS (SELECT 1 FROM board_file f WHERE f.post_no = board.post_no)");
}

#[test]
fn having_non_aggregate_to_where() {
    let r = run("SELECT dept, COUNT(*) FROM emp GROUP BY dept HAVING dept <> 'X' AND COUNT(*) > 1", "postgres");
    same(&r, "postgres", "SELECT dept, COUNT(*) FROM emp WHERE dept <> 'X' GROUP BY dept HAVING COUNT(*) > 1");
    assert_eq!(safety(&r, "havingToWhere"), "check");
    // ROLLUP 이면 소계가 달라진다 — 두기
    let r = run("SELECT dept, COUNT(*) FROM emp GROUP BY ROLLUP(dept) HAVING dept <> 'X'", "postgres");
    assert!(!has(&r, "havingToWhere"));
}

#[test]
fn unused_left_join_removed_with_meta() {
    let m = meta(&[("orders", &["id", "cust_id", "total"], &["id"]), ("customer", &["id", "name"], &["id"])]);
    let r = run_meta("SELECT o.id, o.total FROM orders o LEFT JOIN customer c ON c.id = o.cust_id WHERE o.total > 0", "postgres", &m);
    same(&r, "postgres", "SELECT o.id, o.total FROM orders o WHERE o.total > 0");
    assert_eq!(safety(&r, "dropLeftJoin"), "check");
    // 열을 쓰면 두기
    let r = run_meta("SELECT o.id, c.name FROM orders o LEFT JOIN customer c ON c.id = o.cust_id", "postgres", &m);
    assert!(!has(&r, "dropLeftJoin"));
    // 메타데이터 없으면 두기
    let r = run("SELECT o.id FROM orders o LEFT JOIN customer c ON c.id = o.cust_id", "postgres");
    assert!(!has(&r, "dropLeftJoin"));
}

#[test]
fn qualify_columns_with_meta() {
    let m = meta(&[("article", &["id", "title", "writer_id", "hit"], &["id"]), ("users", &["id", "name"], &["id"])]);
    let r = run_meta("SELECT title, name FROM article a JOIN users u ON a.writer_id = u.id WHERE hit > 10 ORDER BY title", "postgres", &m);
    same(&r, "postgres", "SELECT a.title, u.name FROM article a JOIN users u ON a.writer_id = u.id WHERE a.hit > 10 ORDER BY title");
    // 두 표에 다 있는 열(id)은 건드리지 않는다
    let r = run_meta("SELECT id, title FROM article a JOIN users u ON a.writer_id = u.id", "postgres", &m);
    same(&r, "postgres", "SELECT id, a.title FROM article a JOIN users u ON a.writer_id = u.id");
}

#[test]
fn qualify_leaves_date_unit_words() {
    // 단위 낱말(day·MONTH)과 같은 이름의 열이 있어도 단위 자리는 한정하지 않는다
    let m = meta(&[("orders", &["id", "day", "reg_dt", "cust_id"], &["id"]), ("customer", &["id", "name", "joined"], &["id"])]);
    let r = run_meta("SELECT name, DATEADD(day, 1, reg_dt) AS due FROM orders o JOIN customer c ON o.cust_id = c.id", "mssql", &m);
    same(&r, "mssql", "SELECT c.name, DATEADD(day, 1, o.reg_dt) AS due FROM orders o JOIN customer c ON o.cust_id = c.id");
    let m = meta(&[("orders", &["id", "month", "reg_dt", "cust_id"], &["id"]), ("customer", &["id", "name", "joined"], &["id"])]);
    let r = run_meta("SELECT name, TIMESTAMPDIFF(MONTH, joined, reg_dt) AS m FROM orders o JOIN customer c ON o.cust_id = c.id", "mysql", &m);
    same(&r, "mysql", "SELECT c.name, TIMESTAMPDIFF(MONTH, c.joined, o.reg_dt) AS m FROM orders o JOIN customer c ON o.cust_id = c.id");
    let r = run_meta(
        "SELECT name, EXTRACT(YEAR FROM joined) AS y FROM orders o JOIN customer c ON o.cust_id = c.id WHERE reg_dt > joined + INTERVAL 1 DAY",
        "mysql",
        &m,
    );
    same(&r, "mysql", "SELECT c.name, EXTRACT(YEAR FROM c.joined) AS y FROM orders o JOIN customer c ON o.cust_id = c.id WHERE o.reg_dt > c.joined + INTERVAL 1 DAY");
}

#[test]
fn qualify_then_comma_join_moves_more() {
    let m = meta(&[("article", &["post_id", "board_id", "title"], &["post_id"]), ("board_master", &["board_id", "board_nm"], &["board_id"])]);
    let r = run_meta("SELECT title, board_nm FROM article a, board_master m WHERE a.board_id = m.board_id AND title LIKE '%공지%'", "mysql", &m);
    same(&r, "mysql", "SELECT a.title, m.board_nm FROM article a INNER JOIN board_master m ON a.board_id = m.board_id WHERE a.title LIKE '%공지%'");
}

// ───────────── 따옴표·대소문자·주석 ─────────────

#[test]
fn mysql_backticks_kept() {
    let r = run("SELECT `a`.`id` FROM `article` `a`, `board` `b` WHERE `a`.`board_id` = `b`.`id`", "mysql");
    same(&r, "mysql", "SELECT `a`.`id` FROM `article` `a` INNER JOIN `board` `b` ON `a`.`board_id` = `b`.`id`");
    assert!(r.text.contains("`board`"));
}

#[test]
fn postgres_double_quotes_kept() {
    let r = run(r#"SELECT "A"."Id" FROM "Article" "A", "Board" "B" WHERE "A"."BoardId" = "B"."Id" AND 1=1"#, "postgres");
    same(&r, "postgres", r#"SELECT "A"."Id" FROM "Article" "A" INNER JOIN "Board" "B" ON "A"."BoardId" = "B"."Id""#);
    assert!(r.text.contains(r#""Article""#));
}

#[test]
fn mssql_brackets_kept() {
    let r = run("SELECT [a].[id] FROM [dbo].[article] [a], [dbo].[board] [b] WHERE [a].[board_id] = [b].[id] AND 1=1", "mssql");
    same(&r, "mssql", "SELECT [a].[id] FROM [dbo].[article] [a] INNER JOIN [dbo].[board] [b] ON [a].[board_id] = [b].[id]");
    assert!(r.text.contains("[dbo].[article]"));
}

#[test]
fn mixed_case_keywords_and_comments_kept() {
    let sql = "-- 게시글 목록\nselect A.ID, b.Title -- 제목\n  from Article A, Board b /* 게시판 */\n where A.board_id = b.ID and 1=1 -- 늘 참\n";
    let r = run(sql, "mysql");
    same(&r, "mysql", "SELECT A.ID, b.Title FROM Article A INNER JOIN Board b ON A.board_id = b.ID");
    assert_eq!(r.comments.total, 4, "{:?}", r.comments);
    assert_eq!(r.comments.kept + r.comments.moved, 4);
    for c in ["-- 게시글 목록", "-- 제목", "/* 게시판 */", "-- 늘 참"] {
        assert!(r.text.contains(c), "주석 {c} 이 없다: {}", r.text);
    }
    assert!(r.text.starts_with("-- 게시글 목록"), "{}", r.text);
}

#[test]
fn hint_comment_is_not_duplicated() {
    let r = run("SELECT /*+ INDEX(a idx_a) */ a.id FROM a, b WHERE a.id = b.aid", "mysql");
    reparses(&r, "mysql");
    assert_eq!(r.text.matches("INDEX(a idx_a)").count(), 1, "{}", r.text);
}

// ───────────── 거절·끄기·위치 ─────────────

#[test]
fn unsupported_and_parse_errors_leave_text() {
    let sql = "CREATE TABLE x (id int)";
    let r = run(sql, "postgres");
    assert!(r.error.is_some() && !r.ok && r.text == sql);
    let sql = "SELEC id FRM t";
    let r = run(sql, "postgres");
    assert!(r.error.is_some() && r.text == sql);
    let r = run("SELECT 1; SELECT 2", "postgres");
    assert!(r.error.is_some());
}

#[test]
fn nothing_to_do_keeps_original_text() {
    let sql = "SELECT a.id\n  FROM a\n  JOIN b ON b.aid = a.id\n WHERE a.x = 1";
    let r = run(sql, "postgres");
    assert!(r.ok && !r.changed);
    assert_eq!(r.text, sql);
}

#[test]
fn off_ids_are_stable_and_rebuild() {
    let sql = "SELECT a.id FROM a, b WHERE a.id = b.aid AND 1=1";
    let r = run(sql, "postgres");
    let id = r.changes.iter().find(|c| c.kind == "commaJoin").unwrap().id.clone();
    let r2 = cleanup(sql, "postgres", None, std::slice::from_ref(&id));
    let c = r2.changes.iter().find(|c| c.id == id).expect("같은 id");
    assert!(!c.on);
    assert!(!r2.text.contains("JOIN"), "{}", r2.text);
    same(&r2, "postgres", "SELECT a.id FROM a, b WHERE a.id = b.aid");
    // 같은 입력이면 같은 id 목록
    let r3 = run(sql, "postgres");
    assert_eq!(r.changes.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), r3.changes.iter().map(|c| c.id.clone()).collect::<Vec<_>>());
}

#[test]
fn positions_are_utf16() {
    let sql = "-- 한글 주석\nSELECT 가.id FROM 사용자 가, 부서 나 WHERE 가.dept = 나.id";
    let r = run(sql, "postgres");
    let c = r.changes.iter().find(|c| c.kind == "commaJoin").expect("쉼표 조인");
    let [a, b] = c.pos.unwrap();
    let u: Vec<u16> = sql.encode_utf16().collect();
    let s = String::from_utf16(&u[a as usize..b as usize]).unwrap();
    assert!(s.starts_with("사용자") && s.ends_with("나"), "{s}");
}

#[test]
fn update_and_delete_where_are_cleaned() {
    let r = run("UPDATE t SET a = 1 WHERE 1=1 AND id IN (5)", "mysql");
    same(&r, "mysql", "UPDATE t SET a = 1 WHERE id = 5");
    let r = run("DELETE FROM t WHERE 1=1 AND (k = 'A' OR k = 'B')", "postgres");
    same(&r, "postgres", "DELETE FROM t WHERE k IN ('A', 'B')");
}

#[test]
fn legacy_mess_all_together() {
    // 레거시 화면에서 흔한 모양 — 쉼표 조인·1=1·IN 하나·중복·상관 COUNT·괄호
    let sql = "select TB_POST.POST_ID, TB_POST.TITLE, TB_BOARD.BOARD_NM,\n\
               (select count(*) from TB_FILE where TB_FILE.POST_ID = TB_POST.POST_ID) as FILE_CNT\n\
               from TB_POST, TB_BOARD\n\
               where 1=1\n  and TB_POST.BOARD_ID = TB_BOARD.BOARD_ID\n  and ((TB_POST.USE_YN in ('Y')))\n  and TB_POST.USE_YN in ('Y')\n\
               order by TB_POST.REG_DT desc";
    let r = run(sql, "mysql");
    reparses(&r, "mysql");
    for k in ["commaJoin", "alias", "trueCond", "parens", "dupCond", "inOne", "scalarToJoin"] {
        assert!(has(&r, k), "{k} 없음: {:?}\n{}", kinds(&r), r.text);
    }
    same(
        &r,
        "mysql",
        "SELECT p.POST_ID, p.TITLE, b.BOARD_NM, COALESCE(s.v, 0) AS FILE_CNT FROM TB_POST AS p \
         INNER JOIN TB_BOARD AS b ON p.BOARD_ID = b.BOARD_ID \
         LEFT JOIN (SELECT TB_FILE.POST_ID AS k1, count(*) AS v FROM TB_FILE GROUP BY TB_FILE.POST_ID) AS s ON s.k1 = p.POST_ID \
         WHERE p.USE_YN = 'Y' ORDER BY p.REG_DT DESC",
    );
}

#[test]
fn fixture_queries_all_reparse() {
    // 시험 묶음(일반 이름)의 18문장 — 무엇을 바꾸든 다시 읽혀야 한다
    let list = [
        "SELECT a.post_id, a.title FROM post a WHERE a.board_id = 'B1' ORDER BY a.reg_dt DESC LIMIT 50",
        "SELECT a.post_id, b.hit AS pk_hit FROM post a JOIN post_bak b ON b.post_id = a.post_id WHERE a.hit > 100",
        "SELECT bd.post_no, f.file_nm FROM board bd LEFT JOIN board_file f ON f.post_no = bd.post_no WHERE bd.create_date >= '2025-01-01'",
        "SELECT p.menu_nm AS parent_nm, c.menu_nm AS child_nm FROM menu c JOIN menu p ON p.menu_id = c.parent_id WHERE c.use_yn = 'Y' ORDER BY p.sort_ordn, c.sort_ordn",
        "SELECT bf.file_id, b.subject FROM board_file bf JOIN movie bm ON b.file_id = bf.file_id LEFT JOIN form_file mf ON mf.file_id = bf.file_id AND mf.file_sn = bf.file_sn",
        "SELECT fm.idx, COUNT(mf.file_sn) AS files FROM form fm LEFT JOIN form_file mf ON mf.idx = fm.idx GROUP BY fm.idx HAVING COUNT(mf.file_sn) > 1",
        "WITH recent AS (SELECT post_id, board_id, ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY reg_dt DESC) AS rn FROM post) SELECT r.board_id FROM recent r WHERE r.rn <= 3",
        "SELECT d.doc_id FROM docs d WHERE d.doc_id IN (SELECT l.doc_id FROM lang l WHERE l.lang = 'ko') AND EXISTS (SELECT 1 FROM field tf WHERE tf.doc_id = d.doc_id)",
        "SELECT post_no AS id, 'board' AS src FROM board UNION ALL SELECT post_no, 'qna' FROM qna",
        "SELECT d.doc_id, t.title FROM docs d, venue t WHERE d.file_ext = 'pdf'",
        "SELECT post_id FROM post WHERE DATE(reg_dt) = '2025-06-01'",
        "SELECT * FROM post WHERE title LIKE '%공지%'",
        "SELECT product_cd FROM product ORDER BY product_cd LIMIT 20 OFFSET 1500000",
        "SELECT bd.post_no FROM board bd WHERE bd.post_no NOT IN (SELECT f.post_no FROM board_file f)",
        "SELECT bd.post_no, (SELECT COUNT(*) FROM board_file f WHERE f.post_no = bd.post_no) AS files FROM board bd",
    ];
    for sql in list {
        let r = run(sql, "mariadb");
        reparses(&r, "mysql");
    }
}

// ───────────── 결과 같음 확인 SQL ─────────────

#[test]
fn compare_sql_modes() {
    let a = "SELECT a.id, b.id FROM a, b WHERE a.id = b.aid ORDER BY a.id";
    let b = "SELECT a.id, b.id FROM a INNER JOIN b ON a.id = b.aid ORDER BY a.id";
    let c = compare_sql(a, b, "postgres", None);
    assert!(c.ok, "{:?}", c.reason);
    assert_eq!(c.mode, "except");
    assert_eq!(c.steps.len(), 4);
    // ORDER BY 는 빠지고 열 이름은 c1, c2 로(겹치는 id 이름 피하기)
    assert!(!c.steps[0].sql.contains("ORDER BY") && c.steps[0].sql.contains("c2"), "{}", c.steps[0].sql);
    assert!(c.steps[2].sql.contains("EXCEPT"));
    for s in &c.steps {
        let _ = stmt(&s.sql, "postgres");
    }
    let c = compare_sql(a, b, "mysql", Some("5.7.44"));
    assert_eq!(c.mode, "hash");
    assert!(c.steps[0].sql.contains("CRC32"));
    for s in &c.steps {
        let _ = stmt(&s.sql, "mysql");
    }
    assert_eq!(compare_sql(a, b, "mysql", Some("8.0.36")).mode, "except");
    assert_eq!(compare_sql(a, b, "mariadb", Some("5.5.5-10.4.16-MariaDB")).mode, "except");
    assert_eq!(compare_sql(a, b, "mariadb", Some("10.1.48-MariaDB")).mode, "hash");
    let o = compare_sql("SELECT e.id FROM emp e, dept d WHERE e.d = d.id(+)", "SELECT e.id FROM emp e LEFT JOIN dept d ON e.d = d.id", "oracle", None);
    assert!(o.steps[2].sql.contains("MINUS") && !o.steps[0].sql.contains(" AS q"), "{}", o.steps[0].sql);
    // 쓰기 문장은 비교하지 않는다
    let w = compare_sql("UPDATE t SET a = 1", "UPDATE t SET a = 1", "postgres", None);
    assert!(!w.ok && w.reason.is_some());
    let w = compare_sql("SELECT * FROM t FOR UPDATE", "SELECT * FROM t", "postgres", None);
    assert!(!w.ok);
    // 와일드카드면 열 수를 모른다 — EXCEPT 없는 엔진은 행 수만
    assert_eq!(compare_sql("SELECT * FROM t", "SELECT * FROM t", "cubrid", None).mode, "count");
}

/// 목업 화면(src/dev/cleanupSample.json)이 쓰는 예시 결과 — 손으로 맞추지 않게 여기서 찍는다. RB_DUMP=경로 일 때만.
pub const PREVIEW_SQL: &str = "-- 게시판 글 목록(레거시 화면)
select TB_POST.POST_ID, TB_POST.TITLE, TB_BOARD.BOARD_NM,
       (select count(*) from TB_FILE where TB_FILE.POST_ID = TB_POST.POST_ID) as FILE_CNT -- 첨부 수
  from TB_POST, TB_BOARD, TB_USER
 where 1=1
   and TB_POST.BOARD_ID = TB_BOARD.BOARD_ID
   and TB_USER.USER_ID = TB_POST.WRITER_ID
   and ((TB_POST.USE_YN in ('Y')))
   and (TB_BOARD.BOARD_TYPE = 'NOTICE' or TB_BOARD.BOARD_TYPE = 'FAQ' or TB_BOARD.BOARD_TYPE = 'QNA')
   and TB_POST.USE_YN in ('Y')
   and not (TB_USER.STATUS = 'DEL')
 order by TB_POST.REG_DT desc";

#[test]
fn dump_preview_sample() {
    let r = run(PREVIEW_SQL, "mariadb");
    reparses(&r, "mysql");
    let Ok(path) = std::env::var("RB_DUMP") else { return };
    let mut variants = serde_json::Map::new();
    for c in &r.changes {
        let v = cleanup(PREVIEW_SQL, "mariadb", None, std::slice::from_ref(&c.id));
        variants.insert(c.id.clone(), serde_json::to_value(&v).unwrap());
    }
    let cmp = compare_sql(PREVIEW_SQL, &r.text, "mariadb", Some("10.4.16-MariaDB"));
    let out = serde_json::json!({ "sql": PREVIEW_SQL, "engine": "mariadb", "base": r, "variants": variants, "compare": cmp });
    std::fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
}
