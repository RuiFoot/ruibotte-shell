//! 쿼리 구조 지도 — 문장 하나를 sqlparser 로 읽어 표·별칭·조인·조건 열·CTE/서브쿼리 묶음과
//! 튜닝 도우미가 쓸 정적 사실(SELECT *, 앞이 % 인 LIKE, 함수로 감싼 조건 열 …)만 작은 JSON 으로 돌려준다.
//! 서버에는 묻지 않는다 — 메타데이터(형식·PK·FK·인덱스)와 맞추는 일은 화면 쪽이 캐시로 한다.

use serde::Serialize;
use sqlparser::ast::{
    AssignmentTarget, BinaryOperator, Expr, FromTable, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr, Ident, InTarget, Join, JoinConstraint, JoinOperator, LimitClause,
    ObjectName, ObjectNamePart, OrderByExpr, OrderByKind, Query, Select, SelectItem, SelectItemQualifiedWildcardKind, SetExpr, Spanned, Statement, TableFactor, TableObject,
    TableWithJoins, UpdateTableFromKind, Value, Visit, Visitor,
};
use sqlparser::dialect::{Dialect, GenericDialect, MsSqlDialect, MySqlDialect, OracleDialect, PostgreSqlDialect};
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Location, Span};
use std::ops::ControlFlow;

/// 이보다 긴 문장은 지도를 그리지 않는다(치는 동안 파싱 비용)
const MAX_SQL: usize = 256 << 10;

/// [시작, 끝) — 문장 안의 UTF-16 위치(편집기 위치와 같은 단위)
type Pos = Option<[u32; 2]>;

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueryMap {
    pub ok: bool,
    pub error: Option<String>,
    /// select · insert · update · delete · merge · other
    pub kind: &'static str,
    /// 실제로 읽은 방언(실패해서 일반 방언으로 다시 읽었으면 generic)
    pub dialect: &'static str,
    pub scopes: Vec<Scope>,
    pub tables: Vec<TableRef>,
    pub joins: Vec<JoinEdge>,
    pub cols: Vec<ColUse>,
    pub facts: Vec<Fact>,
    /// 묶음마다 절(FROM·WHERE·GROUP BY …)의 자리 — 단계 그래프와 편집기 강조용
    pub clauses: Vec<Clause>,
    /// 묶음마다 내놓는 열(SELECT 목록 한 항목씩)
    pub outs: Vec<OutCol>,
}

/// 단계의 입력 — 표 하나({"t":id}) 또는 앞 조인({"j":조인 번호})
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum In {
    T(u32),
    J(u32),
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub id: u32,
    /// main · cte · derived · subquery · union
    pub kind: &'static str,
    pub name: Option<String>,
    pub parent: Option<u32>,
    pub pos: Pos,
    /// 편집기에서 강조할 범위 — 서브쿼리는 괄호까지, CTE 는 `WITH 이름 AS (…)`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Pos,
    /// FROM 을 다 읽은 결과(마지막 조인 또는 표 하나)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<In>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Clause {
    pub scope: u32,
    /// select · distinct · from · where · group · having · window · order · limit · setop · target · set
    pub kind: &'static str,
    pub pos: Pos,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutCol {
    pub scope: u32,
    /// 별칭 또는 그냥 열의 이름(식이면 없음 — 화면이 원문으로 보여 준다)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 항목 전체(식 + 별칭)
    pub pos: Pos,
    /// 이 항목이 쓴 열 id [시작, 끝) — 그 안의 서브쿼리 열도 섞여 있으니 scope 로 거른다
    pub cols: [u32; 2],
    /// 이 항목 안의 스칼라 서브쿼리 묶음
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subs: Vec<u32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub agg: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub win: bool,
    /// * 이면 "", t.* 이면 "t"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub star: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub id: u32,
    pub scope: u32,
    pub schema: Option<String>,
    pub name: String,
    pub alias: Option<String>,
    /// 이 이름이 가리키는 CTE 묶음
    pub cte: Option<u32>,
    /// FROM (서브쿼리) — 그 묶음
    pub derived: Option<u32>,
    /// 표 함수 등 메타데이터로 맞출 수 없는 것
    pub virt: bool,
    /// UPDATE·DELETE·INSERT 의 대상 표
    pub target: bool,
    /// 열을 한정할 때 쓰는 원문 표기(별칭 또는 표 이름, 따옴표 그대로) — 바꿔 쓰기용
    pub qual_text: String,
    pub pos: Pos,
    /// 이름 + 별칭(FROM·JOIN 의 그 표 참조 전체)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Pos,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColPair {
    pub a: u32,
    pub b: u32,
    pub op: &'static str,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct JoinEdge {
    pub scope: u32,
    pub left: Option<u32>,
    pub right: Option<u32>,
    /// inner · left · right · full · cross · comma · semi · anti · apply · asof · where
    pub kind: &'static str,
    /// ON(또는 WHERE) 안의 열 = 열
    pub on: Vec<ColPair>,
    /// ON 이 있는지(열끼리 비교가 아니어도)
    pub has_on: bool,
    pub using: Vec<String>,
    pub natural: bool,
    pub pos: Pos,
    /// `LEFT JOIN 표 별칭 ON …` 전체
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clause: Pos,
    /// 조인의 두 입력(where 로 이은 것은 없음)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ia: Option<In>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ib: Option<In>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColUse {
    pub id: u32,
    pub scope: u32,
    /// 이 문장 안에서 알아낸 표(별칭·표 하나뿐인 묶음). 모르면 화면이 메타데이터로 고른다
    pub table: Option<u32>,
    pub qual: Option<String>,
    pub name: String,
    /// select · where · on · group · order · having · set · insert
    pub role: &'static str,
    /// 조건 안에서의 쓰임 — eq · range · in · like · prefix · null · other
    pub pred: Option<&'static str>,
    /// 함수·형변환·연산으로 감쌌으면 그 이름
    pub wrapped: Option<String>,
    pub pos: Pos,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    /// selectStar · fnOnCol · likeLeading · notInSubquery · cmp · offset · orderNoLimit · noWhere · correlated · cartesian · joinNoOn · crossJoin
    pub kind: &'static str,
    pub scope: u32,
    pub pos: Pos,
    pub col: Option<u32>,
    pub col2: Option<u32>,
    /// 다른 묶음(서브쿼리 등)
    pub sub: Option<u32>,
    pub table: Option<u32>,
    pub text: Option<String>,
    pub num: Option<f64>,
    /// cmp — 연산자 · 값 종류(str·num·bool·typed) · 값
    pub op: Option<&'static str>,
    pub lit: Option<&'static str>,
    pub value: Option<String>,
}

/// 엔진 → 방언
fn dialect_of(engine: &str) -> (Box<dyn Dialect>, &'static str) {
    match engine {
        "postgres" => (Box::new(PostgreSqlDialect {}), "postgres"),
        "mysql" | "mariadb" => (Box::new(MySqlDialect {}), "mysql"),
        "mssql" => (Box::new(MsSqlDialect {}), "mssql"),
        "oracle" | "tibero" => (Box::new(OracleDialect {}), "oracle"),
        _ => (Box::new(GenericDialect {}), "generic"),
    }
}

fn parse_one(d: &dyn Dialect, sql: &str) -> Result<Option<Statement>, String> {
    let mut p = Parser::new(d).with_recursion_limit(64).try_with_sql(sql).map_err(|e| e.to_string())?;
    let mut v = p.parse_statements().map_err(|e| e.to_string())?;
    Ok(if v.is_empty() { None } else { Some(v.swap_remove(0)) })
}

/// 쿼리 구조 지도 — 문장 하나(화면이 커서 문장만 보낸다)
#[tauri::command(async)]
pub fn sql_map(sql: String, engine: String) -> QueryMap {
    // 긴 AND/OR 사슬은 파서가 반복문으로 읽어 깊은 AST 가 된다 — 그 뒤의 위치 계산·걷기·Drop 이 재귀라
    // 큰 스택을 가진 전용 스레드에서 끝까지(AST 해제까지) 한다. 일꾼 스레드 기본 스택(2MB)은 수천 항에서 넘친다.
    let run = std::thread::Builder::new().name("sql-map".into()).stack_size(BIG_STACK).spawn(move || build(&sql, &engine));
    match run.map(|h| h.join()) {
        Ok(Ok(m)) => m,
        _ => QueryMap { error: Some("이 문장은 지도를 그리지 못했습니다".into()), kind: "other", ..Default::default() },
    }
}

/// 전용 스레드 스택(예약만 하고 쓰는 만큼만 잡힌다)
const BIG_STACK: usize = 256 << 20;
/// 이보다 많은 이항 연산(AND·OR·+·|| …)이 있으면 그리지 않는다 — 깊은 재귀 막기
const MAX_CHAIN: usize = 4000;
/// 결과가 이보다 크면 그리지 않는다(화면 쪽 계산·전송 크기)
const MAX_COLS: usize = 4000;

/// 이항 연산 수 대강 세기(따옴표 안 제외) — 파싱 전에 큰 사슬을 거른다
fn chain_len(sql: &str) -> usize {
    let mut n = 0;
    let mut quoted = false;
    let b = sql.as_bytes();
    let mut word = String::new();
    for (i, &c) in b.iter().enumerate() {
        if c == b'\'' {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        if c.is_ascii_alphabetic() {
            word.push(c.to_ascii_lowercase() as char);
            continue;
        }
        if word == "and" || word == "or" {
            n += 1;
        }
        word.clear();
        if matches!(c, b'+' | b'*' | b'/' | b'=' | b'<' | b'>') || (c == b'|' && b.get(i + 1) == Some(&b'|')) {
            n += 1;
        }
    }
    if word == "and" || word == "or" {
        n += 1;
    }
    n
}

pub fn build(sql: &str, engine: &str) -> QueryMap {
    if sql.len() > MAX_SQL {
        return QueryMap { error: Some("문장이 너무 커서 지도를 그리지 않습니다".into()), kind: "other", ..Default::default() };
    }
    if chain_len(sql) > MAX_CHAIN {
        return QueryMap { error: Some("조건·연산이 너무 많아 지도를 그리지 않습니다".into()), kind: "other", ..Default::default() };
    }
    let (d, name) = dialect_of(engine);
    let (st, used) = match parse_one(d.as_ref(), sql) {
        Ok(s) => (s, name),
        Err(first) => {
            // 그 엔진 방언이 못 읽으면 일반 방언으로 한 번 더(구조만 보면 되니 너그럽게)
            if name == "generic" {
                return QueryMap { error: Some(first), kind: "other", dialect: name, ..Default::default() };
            }
            match parse_one(&GenericDialect {}, sql) {
                Ok(s) => (s, "generic"),
                Err(_) => return QueryMap { error: Some(first), kind: "other", dialect: name, ..Default::default() },
            }
        }
    };
    let Some(st) = st else {
        return QueryMap { ok: true, kind: "other", dialect: used, ..Default::default() };
    };
    let mut b = Builder { pos: PosMap::new(sql), ..Default::default() };
    b.statement(&st);
    b.finish();
    if b.cols.len() > MAX_COLS {
        return QueryMap { error: Some("열이 너무 많아 지도를 그리지 않습니다".into()), kind: "other", dialect: used, ..Default::default() };
    }
    QueryMap { ok: true, error: None, kind: b.kind, dialect: used, scopes: b.scopes, tables: b.tables, joins: b.joins, cols: b.cols, facts: b.facts, clauses: b.clauses, outs: b.outs }
}

/// 두 범위를 덮는 범위
fn upos(a: Pos, b: Pos) -> Pos {
    match (a, b) {
        (Some([a0, a1]), Some([b0, b1])) => Some([a0.min(b0), a1.max(b1)]),
        (x, None) | (None, x) => x,
    }
}

const JOIN_WORDS: &[&str] = &["join", "inner", "left", "right", "full", "outer", "cross", "natural", "straight_join", "semi", "anti", "asof", "global", "lateral", "apply"];

fn is_ws(c: u16) -> bool {
    matches!(c, 9 | 10 | 13 | 32)
}
fn is_word(c: u16) -> bool {
    c < 128 && ((c as u8).is_ascii_alphanumeric() || c == u16::from(b'_'))
}

/// 줄·열(문자 단위, 1부터) → UTF-16 위치
#[derive(Default)]
struct PosMap {
    /// 문자 번호 → UTF-16 위치(끝에 하나 더) — 위치 하나를 O(1) 로
    char_u16: Vec<u32>,
    /// 줄마다 첫 문자 번호(끝에 전체 문자 수)
    line_char: Vec<usize>,
    units: Vec<u16>,
}

impl PosMap {
    fn new(s: &str) -> Self {
        let mut char_u16 = Vec::with_capacity(s.len() + 1);
        let mut line_char = vec![0usize];
        let mut u = 0u32;
        for (n, ch) in s.chars().enumerate() {
            char_u16.push(u);
            u += ch.len_utf16() as u32;
            if ch == '\n' {
                line_char.push(n + 1);
            }
        }
        char_u16.push(u);
        let total = char_u16.len() - 1;
        line_char.push(total);
        PosMap { char_u16, line_char, units: s.encode_utf16().collect() }
    }
    fn at(&self, l: Location) -> Option<u32> {
        if l.line == 0 || l.column == 0 {
            return None;
        }
        let line = l.line as usize - 1;
        let start = *self.line_char.get(line)?;
        // 줄 끝(다음 줄 첫 문자 앞의 \n 자리)을 넘지 않게
        let next = self.line_char.get(line + 1).copied().unwrap_or(start);
        let end = if line + 2 < self.line_char.len() { next.saturating_sub(1) } else { next };
        let idx = (start + l.column as usize - 1).min(end.max(start));
        self.char_u16.get(idx).copied()
    }
    fn span(&self, s: Span) -> Pos {
        let a = self.at(s.start)?;
        let b = self.at(s.end).unwrap_or(a).max(a);
        Some([a, self.balance(a, b)])
    }
    /// sqlparser 의 위치는 함수·서브쿼리 끝 ) 를 빼먹는다 — 괄호 짝이 맞을 때까지 끝을 늘린다(작은따옴표 안은 건너뜀)
    fn balance(&self, a: u32, b: u32) -> u32 {
        let u = &self.units;
        let b = (b as usize).min(u.len());
        let (mut depth, mut quoted) = (0i32, false);
        let mut step = |c: u16| {
            if c == u16::from(b'\'') {
                quoted = !quoted;
            } else if !quoted && c == u16::from(b'(') {
                depth += 1;
            } else if !quoted && c == u16::from(b')') {
                depth -= 1;
            }
            depth
        };
        let mut d = 0;
        for &c in &u[(a as usize).min(b)..b] {
            d = step(c);
        }
        let mut i = b;
        while d > 0 && i < u.len() {
            d = step(u[i]);
            i += 1;
        }
        if d > 0 {
            b as u32
        } else {
            i as u32
        }
    }

    // ── 절 범위 넓히기(키워드·괄호) — 모두 UTF-16 위치, ASCII 키워드만 본다 ──

    fn word(&self, a: usize, b: usize) -> String {
        self.units[a..b].iter().map(|&c| (c as u8 as char).to_ascii_lowercase()).collect()
    }
    /// 공백·주석(/* */, -- 줄) 건너뛰기(앞으로)
    fn skip_fwd(&self, mut i: usize) -> usize {
        let u = &self.units;
        let (slash, star, dash, nl) = (u16::from(b'/'), u16::from(b'*'), u16::from(b'-'), u16::from(b'\n'));
        loop {
            while i < u.len() && is_ws(u[i]) {
                i += 1;
            }
            if i + 1 < u.len() && u[i] == slash && u[i + 1] == star {
                let mut j = i + 2;
                while j + 1 < u.len() && !(u[j] == star && u[j + 1] == slash) {
                    j += 1;
                }
                i = (j + 2).min(u.len());
            } else if i + 1 < u.len() && u[i] == dash && u[i + 1] == dash {
                while i < u.len() && u[i] != nl {
                    i += 1;
                }
            } else {
                return i;
            }
        }
    }
    /// 공백·/* */ 주석 건너뛰기(뒤로)
    fn skip_back(&self, mut i: usize) -> usize {
        let u = &self.units;
        let (slash, star) = (u16::from(b'/'), u16::from(b'*'));
        loop {
            while i > 0 && is_ws(u[i - 1]) {
                i -= 1;
            }
            if i >= 2 && u[i - 1] == slash && u[i - 2] == star {
                let mut j = i - 2;
                while j >= 2 && !(u[j - 2] == slash && u[j - 1] == star) {
                    j -= 1;
                }
                i = j.saturating_sub(2);
            } else {
                return i;
            }
        }
    }
    /// a 앞의 키워드들(최대 max 개)까지 시작을 당긴다 — 사이의 여는 괄호는 건너뛴다(WHERE (a OR b))
    fn back_kw(&self, a: u32, words: &[&str], max: usize) -> u32 {
        let u = &self.units;
        let mut start = (a as usize).min(u.len());
        for _ in 0..max {
            let mut i = self.skip_back(start);
            while i > 0 && u[i - 1] == u16::from(b'(') {
                i = self.skip_back(i - 1);
            }
            let end = i;
            while i > 0 && is_word(u[i - 1]) {
                i -= 1;
            }
            if i == end || !words.contains(&self.word(i, end).as_str()) {
                break;
            }
            start = i;
        }
        start as u32
    }
    /// b 뒤의 키워드들까지 끝을 늘린다
    fn fwd_kw(&self, b: u32, words: &[&str], max: usize) -> u32 {
        let u = &self.units;
        let mut end = (b as usize).min(u.len());
        for _ in 0..max {
            let i = self.skip_fwd(end);
            let mut j = i;
            while j < u.len() && is_word(u[j]) {
                j += 1;
            }
            if i == j || !words.contains(&self.word(i, j).as_str()) {
                break;
            }
            end = j;
        }
        end as u32
    }
    /// i 의 ( 짝인 ) 뒤 — 작은따옴표 안은 건너뜀
    fn match_paren(&self, i: usize) -> Option<usize> {
        let u = &self.units;
        let (mut depth, mut quoted) = (0i32, false);
        for (k, &c) in u.iter().enumerate().skip(i) {
            if c == u16::from(b'\'') {
                quoted = !quoted;
            } else if !quoted && c == u16::from(b'(') {
                depth += 1;
            } else if !quoted && c == u16::from(b')') {
                depth -= 1;
                if depth == 0 {
                    return Some(k + 1);
                }
            }
        }
        None
    }
    /// b 뒤에 (…) 가 바로 오면 그 끝까지(함수 인자)
    fn call_end(&self, b: u32) -> u32 {
        let i = self.skip_fwd(b as usize);
        if self.units.get(i) == Some(&u16::from(b'(')) {
            if let Some(e) = self.match_paren(i) {
                return e as u32;
            }
        }
        b
    }
    /// 창 함수 끝 — b 뒤의 OVER (…) 또는 OVER 이름까지
    fn over_end(&self, b: u32) -> u32 {
        let u = &self.units;
        let i = self.skip_fwd(b as usize);
        let mut j = i;
        while j < u.len() && is_word(u[j]) {
            j += 1;
        }
        if self.word(i, j) != "over" {
            return b;
        }
        let k = self.skip_fwd(j);
        if u.get(k) == Some(&u16::from(b'(')) {
            return self.match_paren(k).map(|e| e as u32).unwrap_or(b);
        }
        let mut e = k;
        while e < u.len() && is_word(u[e]) {
            e += 1;
        }
        e as u32
    }
    /// 괄호로 바로 감싸였으면 괄호까지
    fn wrap_paren(&self, p: Pos) -> Pos {
        let [a, b] = p?;
        let u = &self.units;
        let i = self.skip_back(a as usize);
        if i == 0 || u[i - 1] != u16::from(b'(') {
            return p;
        }
        let j = self.skip_fwd(b as usize);
        if u.get(j) != Some(&u16::from(b')')) {
            return p;
        }
        Some([(i - 1) as u32, (j + 1) as u32])
    }
    /// 두 위치 사이를 공백·괄호를 뺀 범위로(UNION ALL 같은 연산자 글자)
    fn between(&self, a: u32, b: u32) -> Pos {
        let u = &self.units;
        let (mut i, mut j) = (a as usize, (b as usize).min(u.len()));
        let paren = |c: u16| c == u16::from(b'(') || c == u16::from(b')');
        while i < j && (is_ws(u[i]) || paren(u[i])) {
            i += 1;
        }
        while j > i && (is_ws(u[j - 1]) || paren(u[j - 1])) {
            j -= 1;
        }
        (i < j).then_some([i as u32, j as u32])
    }
    /// 식 범위를 앞 키워드까지 넓히고 괄호 짝을 맞춘다(WHERE …, GROUP BY …)
    fn kw(&self, s: Span, words: &[&str], max: usize) -> Pos {
        let [a, b] = self.span(s)?;
        let a = self.back_kw(a, words, max);
        Some([a, self.balance(a, b)])
    }
}

#[derive(Default)]
struct Builder {
    pos: PosMap,
    kind: &'static str,
    scopes: Vec<Scope>,
    tables: Vec<TableRef>,
    joins: Vec<JoinEdge>,
    cols: Vec<ColUse>,
    facts: Vec<Fact>,
    clauses: Vec<Clause>,
    outs: Vec<OutCol>,
    /// (소문자 이름, CTE 묶음, 그 이름이 보이는 묶음)
    ctes: Vec<(String, u32, u32)>,
    /// WHERE 의 열 = 열 (묶음, a, b) — 끝에 표를 알아낸 뒤 조인 선으로
    where_pairs: Vec<(u32, u32, u32)>,
    /// LIMIT·TOP·FETCH 가 있는 묶음
    limited: Vec<u32>,
    /// SELECT 별칭(묶음, 소문자) — ORDER BY·GROUP BY·HAVING 의 별칭은 열이 아니다
    aliases: Vec<(u32, String)>,
    /// WHERE 조건 하나에 함께 나온 열(묶음, 열 id 범위) — 두 표의 열이 섞이면 두 표는 이어졌다
    where_links: Vec<(u32, u32, u32)>,
    /// 쉼표 오른쪽에 와도 데카르트 곱이 아닌 표(LATERAL·표 함수)
    no_cartesian: Vec<u32>,
}

fn ident_name(i: &Ident) -> String {
    i.value.clone()
}

fn name_parts(n: &ObjectName) -> Vec<&Ident> {
    n.0.iter()
        .filter_map(|p| match p {
            ObjectNamePart::Identifier(i) => Some(i),
            _ => None,
        })
        .collect()
}

/// 조건 안의 비교 연산 → 쓰임
fn cmp_kind(op: &BinaryOperator) -> Option<&'static str> {
    match op {
        BinaryOperator::Eq | BinaryOperator::Spaceship => Some("eq"),
        BinaryOperator::Lt | BinaryOperator::LtEq | BinaryOperator::Gt | BinaryOperator::GtEq => Some("range"),
        BinaryOperator::NotEq => Some("other"),
        _ => None,
    }
}

fn op_text(op: &BinaryOperator) -> &'static str {
    match op {
        BinaryOperator::Eq => "=",
        BinaryOperator::Spaceship => "<=>",
        BinaryOperator::Lt => "<",
        BinaryOperator::LtEq => "<=",
        BinaryOperator::Gt => ">",
        BinaryOperator::GtEq => ">=",
        BinaryOperator::NotEq => "<>",
        _ => "?",
    }
}

/// 괄호·Oracle (+) 벗기기
fn strip(e: &Expr) -> &Expr {
    let mut e = e;
    loop {
        match e {
            Expr::Nested(x) | Expr::OuterJoin(x) => e = x,
            _ => return e,
        }
    }
}

/// @변수·@@시스템 변수(MSSQL·MySQL) — 열이 아니다
fn is_var(i: &Ident) -> bool {
    i.quote_style.is_none() && i.value.starts_with('@')
}

/// 그냥 열(감싸지 않은) — 이름 조각들
fn plain_col(e: &Expr) -> Option<Vec<&Ident>> {
    match strip(e) {
        Expr::Identifier(i) if is_var(i) => None,
        Expr::Identifier(i) => Some(vec![i]),
        Expr::CompoundIdentifier(v) if !v.is_empty() => Some(v.iter().collect()),
        _ => None,
    }
}

/// 열을 감싼 것의 이름(함수·CAST·연산) — 안에 서브쿼리가 없고 열이 하나뿐일 때만
fn wrapper_name(e: &Expr) -> Option<String> {
    match strip(e) {
        Expr::Function(f) => Some(f.name.to_string().to_uppercase()),
        Expr::Cast { .. } => Some("CAST".into()),
        Expr::Convert { .. } => Some("CONVERT".into()),
        Expr::Substring { .. } => Some("SUBSTRING".into()),
        Expr::Trim { .. } => Some("TRIM".into()),
        Expr::Extract { .. } => Some("EXTRACT".into()),
        Expr::Ceil { .. } => Some("CEIL".into()),
        Expr::Floor { .. } => Some("FLOOR".into()),
        Expr::AtTimeZone { .. } => Some("AT TIME ZONE".into()),
        Expr::Collate { .. } => Some("COLLATE".into()),
        Expr::BinaryOp { op: BinaryOperator::Plus | BinaryOperator::Minus | BinaryOperator::Multiply | BinaryOperator::Divide | BinaryOperator::Modulo | BinaryOperator::StringConcat, .. } => {
            Some("연산".into())
        }
        Expr::UnaryOp { .. } => Some("연산".into()),
        _ => None,
    }
}

/// 리터럴 종류 — 문자열 · 숫자 · 날짜형 문자열(DATE '…')
fn lit_kind(e: &Expr) -> Option<(&'static str, String)> {
    match strip(e) {
        Expr::Value(v) => match &v.value {
            Value::Number(n, _) => Some(("num", n.to_string())),
            Value::SingleQuotedString(s) | Value::NationalStringLiteral(s) | Value::EscapedStringLiteral(s) => Some(("str", s.clone())),
            Value::DoubleQuotedString(s) => Some(("str", s.clone())),
            Value::Boolean(b) => Some(("bool", b.to_string())),
            _ => None,
        },
        Expr::UnaryOp { expr, .. } => lit_kind(expr).filter(|(k, _)| *k == "num"),
        Expr::TypedString(t) => Some(("typed", t.data_type.to_string())),
        _ => None,
    }
}

/// 집계 함수(창 없이 쓰면 묶음 전체를 접는다)
fn is_agg(name: &str) -> bool {
    matches!(
        name,
        "count" | "sum" | "avg" | "min" | "max" | "group_concat" | "string_agg" | "array_agg" | "listagg" | "json_agg" | "jsonb_agg" | "json_arrayagg" | "json_objectagg" | "bool_and" | "bool_or" | "every"
            | "stddev" | "stddev_pop" | "stddev_samp" | "variance" | "var_pop" | "var_samp" | "bit_and" | "bit_or" | "bit_xor" | "median" | "percentile_cont" | "percentile_disc" | "approx_count_distinct"
            | "any_value" | "xmlagg" | "mode" | "count_big" | "checksum_agg"
    )
}

/// 식 안의 함수(바로 아래 서브쿼리 속은 빼고) — (소문자 이름, 이름 위치, OVER 가 있나)
#[derive(Default)]
struct Funcs {
    depth: usize,
    list: Vec<(String, Span, bool)>,
}

impl Visitor for Funcs {
    type Break = ();
    fn pre_visit_query(&mut self, _q: &Query) -> ControlFlow<()> {
        self.depth += 1;
        ControlFlow::Continue(())
    }
    fn post_visit_query(&mut self, _q: &Query) -> ControlFlow<()> {
        self.depth -= 1;
        ControlFlow::Continue(())
    }
    fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
        if self.depth == 0 {
            if let Expr::Function(f) = e {
                let name = name_parts(&f.name).last().map(|i| i.value.to_lowercase()).unwrap_or_default();
                self.list.push((name, f.name.span(), f.over.is_some()));
            }
        }
        ControlFlow::Continue(())
    }
}

/// 식 안의 열과 (바로 아래) 서브쿼리 — 서브쿼리 속 열은 그 묶음이 따로 모은다
#[derive(Default)]
struct Scan {
    depth: usize,
    cols: Vec<(Vec<Ident>, Span)>,
    subs: Vec<Query>,
}

impl Visitor for Scan {
    type Break = ();
    fn pre_visit_query(&mut self, q: &Query) -> ControlFlow<()> {
        if self.depth == 0 {
            self.subs.push(q.clone());
        }
        self.depth += 1;
        ControlFlow::Continue(())
    }
    fn post_visit_query(&mut self, _q: &Query) -> ControlFlow<()> {
        self.depth -= 1;
        ControlFlow::Continue(())
    }
    fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
        if self.depth > 0 {
            return ControlFlow::Continue(());
        }
        match e {
            Expr::Identifier(i) if is_var(i) => {}
            Expr::Identifier(i) => self.cols.push((vec![i.clone()], i.span)),
            Expr::CompoundIdentifier(v) if !v.is_empty() => self.cols.push((v.clone(), e.span())),
            _ => {}
        }
        ControlFlow::Continue(())
    }
}

impl Builder {
    fn scope(&mut self, kind: &'static str, name: Option<String>, parent: Option<u32>, pos: Pos) -> u32 {
        let id = self.scopes.len() as u32;
        self.scopes.push(Scope { id, kind, name, parent, pos, range: None, src: None });
        id
    }

    /// 괄호로 감싼 서브쿼리 묶음 — 강조 범위는 괄호까지
    fn sub_scope(&mut self, kind: &'static str, name: Option<String>, parent: u32, sp: Span) -> u32 {
        let pos = self.pos.span(sp);
        let id = self.scope(kind, name, Some(parent), pos);
        self.scopes[id as usize].range = self.pos.wrap_paren(pos);
        id
    }

    fn clause(&mut self, scope: u32, kind: &'static str, pos: Pos) {
        if pos.is_some() {
            self.clauses.push(Clause { scope, kind, pos });
        }
    }

    fn fact(&mut self, f: Fact) {
        self.facts.push(f);
    }

    fn ancestors(&self, s: u32) -> Vec<u32> {
        let mut v = vec![s];
        let mut c = self.scopes[s as usize].parent;
        while let Some(p) = c {
            v.push(p);
            c = self.scopes[p as usize].parent;
        }
        v
    }

    fn statement(&mut self, st: &Statement) {
        match st {
            Statement::Query(q) => {
                self.kind = "select";
                let s = self.scope("main", None, None, self.pos.span(q.span()));
                self.query(q, s, true);
            }
            Statement::Insert(ins) => {
                self.kind = "insert";
                let s = self.scope("main", None, None, None);
                if let TableObject::TableName(n) = &ins.table {
                    let t = self.table_ref(n, None, s, true);
                    let mut p = self.pos.kw(n.span(), &["into", "insert"], 2);
                    for c in &ins.columns {
                        if let Some(i) = name_parts(c).last() {
                            self.push_col(s, Some(t), None, ident_name(i), "insert", None, None, i.span);
                            p = upos(p, self.pos.span(c.span()));
                        }
                    }
                    // 열 목록의 닫는 괄호까지
                    let p = p.map(|[a, b]| [a, self.pos.balance(a, b)]);
                    self.clause(s, "target", p);
                }
                if let Some(src) = &ins.source {
                    let sub = self.sub_scope("subquery", Some("SELECT".into()), s, src.span());
                    self.query(src, sub, false);
                }
            }
            Statement::Update(u) => {
                self.kind = "update";
                let s = self.scope("main", None, None, None);
                let first = self.tables.len();
                let (_, h) = self.table_item(&u.table, s);
                self.scopes[s as usize].src = h;
                if let Some(t) = self.tables.get_mut(first) {
                    t.target = true;
                }
                let tp = self.pos.kw(u.table.span(), &["update"], 1);
                self.clause(s, "target", tp);
                if let Some(UpdateTableFromKind::BeforeSet(v) | UpdateTableFromKind::AfterSet(v)) = &u.from {
                    for x in v {
                        self.table_item(x, s);
                    }
                }
                if let (Some(a), Some(b)) = (u.assignments.first(), u.assignments.last()) {
                    let p = self.pos.kw(a.span().union(&b.span()), &["set"], 1);
                    self.clause(s, "set", p);
                }
                for a in &u.assignments {
                    let names: Vec<&ObjectName> = match &a.target {
                        AssignmentTarget::ColumnName(n) => vec![n],
                        AssignmentTarget::Tuple(v) => v.iter().collect(),
                    };
                    for n in names {
                        let parts = name_parts(n);
                        if let Some(last) = parts.last() {
                            let qual = (parts.len() > 1).then(|| ident_name(parts[parts.len() - 2]));
                            self.push_col(s, None, qual, ident_name(last), "set", None, None, last.span);
                        }
                    }
                    self.collect(&a.value, s, "set", None, None);
                }
                match &u.selection {
                    Some(w) => {
                        let p = self.pos.kw(w.span(), &["where"], 1);
                        self.clause(s, "where", p);
                        self.cond(w, s, "where", None)
                    }
                    None => self.fact(Fact { kind: "noWhere", scope: s, text: Some("UPDATE".into()), ..Default::default() }),
                }
            }
            Statement::Delete(d) => {
                self.kind = "delete";
                let s = self.scope("main", None, None, None);
                let list = match &d.from {
                    FromTable::WithFromKeyword(v) | FromTable::WithoutKeyword(v) => v,
                };
                let first = self.tables.len();
                for (i, x) in list.iter().enumerate() {
                    let (_, h) = self.table_item(x, s);
                    if i == 0 {
                        self.scopes[s as usize].src = h;
                        let p = self.pos.kw(x.span(), &["from", "delete"], 2);
                        self.clause(s, "target", p);
                    }
                }
                if let Some(t) = self.tables.get_mut(first) {
                    t.target = true;
                }
                if let Some(u) = &d.using {
                    for x in u {
                        self.table_item(x, s);
                    }
                }
                match &d.selection {
                    Some(w) => {
                        let p = self.pos.kw(w.span(), &["where"], 1);
                        self.clause(s, "where", p);
                        self.cond(w, s, "where", None)
                    }
                    None => self.fact(Fact { kind: "noWhere", scope: s, text: Some("DELETE".into()), ..Default::default() }),
                }
            }
            Statement::Merge(_) => self.kind = "merge",
            _ => self.kind = "other",
        }
    }

    fn query(&mut self, q: &Query, s: u32, top: bool) {
        if let Some(w) = &q.with {
            // WITH RECURSIVE 는 이름을 먼저 올린다(자기 참조). 아니면 본문을 읽은 뒤 올린다 —
            // WITH orders AS (SELECT … FROM orders) 의 안쪽 orders 는 실제 표다
            let mut ids = Vec::new();
            for c in &w.cte_tables {
                let p = self.pos.span(c.span());
                let id = self.scope("cte", Some(ident_name(&c.alias.name)), Some(s), p);
                // 첫 CTE 는 WITH [RECURSIVE] 부터
                self.scopes[id as usize].range = p.map(|[a, b]| [self.pos.back_kw(a, &["recursive", "with"], 2), b]);
                if w.recursive {
                    self.ctes.push((c.alias.name.value.to_lowercase(), id, s));
                }
                ids.push(id);
            }
            for (c, id) in w.cte_tables.iter().zip(ids) {
                self.query(&c.query, id, false);
                if !w.recursive {
                    self.ctes.push((c.alias.name.value.to_lowercase(), id, s));
                }
            }
        }
        self.set_expr(&q.body, s);
        let mut has_order = false;
        if let Some(ob) = &q.order_by {
            if let OrderByKind::Expressions(v) = &ob.kind {
                has_order = !v.is_empty();
                self.order_list(v, s);
                // 끝의 ASC·DESC·NULLS LAST 는 식 위치에 없다
                let p = self.pos.kw(ob.span(), &["by", "order"], 2).map(|[a, b]| [a, self.pos.fwd_kw(b, &["asc", "desc", "nulls", "first", "last"], 3)]);
                self.clause(s, "order", p);
            }
        }
        // LIMIT·OFFSET·FETCH — 키워드까지 한 범위로
        let lp = q.limit_clause.as_ref().and_then(|l| {
            let [a, b] = self.pos.span(l.span())?;
            let a = self.pos.back_kw(a, &["limit", "offset"], 1);
            Some([a, self.pos.fwd_kw(b, &["rows", "row"], 1)])
        });
        let fp = q.fetch.as_ref().and_then(|f| {
            let [a, b] = self.pos.span(f.span())?;
            Some([self.pos.back_kw(a, &["first", "next", "fetch"], 2), self.pos.fwd_kw(b, &["percent", "rows", "row", "only", "with", "ties"], 4)])
        });
        self.clause(s, "limit", upos(lp, fp));
        let mut limited = q.fetch.is_some();
        match &q.limit_clause {
            Some(LimitClause::LimitOffset { limit, offset, .. }) => {
                limited |= limit.is_some();
                if let Some(o) = offset {
                    self.offset_fact(&o.value, s);
                }
            }
            Some(LimitClause::OffsetCommaLimit { offset, .. }) => {
                limited = true;
                self.offset_fact(offset, s);
            }
            None => {}
        }
        if limited {
            self.limited.push(s);
        }
        if top && has_order && !limited && !self.limited.contains(&s) {
            let p = q.order_by.as_ref().and_then(|o| match &o.kind {
                OrderByKind::Expressions(v) => v.first().map(|x| x.span()),
                _ => None,
            });
            self.fact(Fact { kind: "orderNoLimit", scope: s, pos: p.and_then(|x| self.pos.span(x)), ..Default::default() });
        }
    }

    fn offset_fact(&mut self, e: &Expr, s: u32) {
        if let Some(("num", n)) = lit_kind(e) {
            if let Ok(v) = n.parse::<f64>() {
                self.fact(Fact { kind: "offset", scope: s, pos: self.pos.span(e.span()), num: Some(v), ..Default::default() });
            }
        }
    }

    fn order_list(&mut self, v: &[OrderByExpr], s: u32) {
        for o in v {
            // lower(name) 같은 식은 그 열의 인덱스로 정렬을 받지 못한다
            let w = if plain_col(&o.expr).is_some() { None } else { Some(wrapper_name(&o.expr).unwrap_or_else(|| "식".into())) };
            self.collect(&o.expr, s, "order", None, w);
        }
    }

    fn set_expr(&mut self, e: &SetExpr, s: u32) {
        match e {
            SetExpr::Select(sel) => self.select(sel, s),
            SetExpr::Query(q) => self.query(q, s, false),
            SetExpr::SetOperation { left, right, .. } => {
                // 연산자 글자(UNION ALL …) — 왼쪽 끝과 오른쪽 시작 사이
                if let (Some([_, le]), Some([rs, _])) = (self.pos.span(left.span()), self.pos.span(right.span())) {
                    let p = self.pos.between(le, rs);
                    self.clause(s, "setop", p);
                }
                for side in [left, right] {
                    if matches!(side.as_ref(), SetExpr::SetOperation { .. }) {
                        self.set_expr(side, s);
                    } else {
                        let u = self.sub_scope("union", None, s, side.span());
                        self.set_expr(side, u);
                    }
                }
            }
            _ => {}
        }
    }

    fn select(&mut self, sel: &Select, s: u32) {
        if sel.top.is_some() {
            self.limited.push(s);
        }
        for item in &sel.projection {
            if let SelectItem::ExprWithAlias { alias, .. } = item {
                self.aliases.push((s, alias.value.to_lowercase()));
            }
        }
        // FROM — 쉼표로 늘어놓은 덩이도 앞 결과와 잇는 단계(comma)로
        let mut acc: Option<In> = None;
        for (i, item) in sel.from.iter().enumerate() {
            let before = self.tables.iter().filter(|t| t.scope == s).map(|t| t.id).next_back();
            let (first, h) = self.table_item(item, s);
            if i > 0 {
                let idx = self.joins.len() as u32;
                self.joins.push(JoinEdge { scope: s, left: before, right: first, kind: "comma", pos: self.pos.span(item.relation.span()), ia: acc, ib: h, ..Default::default() });
                acc = Some(In::J(idx));
            } else {
                acc = h;
            }
        }
        if acc.is_some() {
            self.scopes[s as usize].src = acc;
        }
        if let (Some(a), Some(b)) = (sel.from.first(), sel.from.last()) {
            let p = self.pos.kw(a.span().union(&b.span()), &["from"], 1);
            self.clause(s, "from", p);
        }
        // SELECT 목록 — 항목마다 내놓는 열과 그 열이 쓴 열(계보)
        let mut list: Pos = self.pos.span(sel.select_token.0.span);
        for item in &sel.projection {
            let (c0, s0) = (self.cols.len() as u32, self.scopes.len() as u32);
            let mut pos = self.pos.span(item.span());
            let (mut agg, mut win) = (false, false);
            let (name, star) = match item {
                SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } | SelectItem::ExprWithAliases { expr: e, .. } => {
                    self.collect(e, s, "select", None, None);
                    let mut f = Funcs::default();
                    let _ = e.visit(&mut f);
                    for (fname, sp, over) in f.list {
                        if over {
                            win = true;
                            let wp = self.pos.span(sp).map(|[a, b]| [a, self.pos.over_end(self.pos.call_end(b))]);
                            self.clause(s, "window", wp);
                            pos = upos(pos, wp);
                        } else if is_agg(&fname) {
                            agg = true;
                        }
                    }
                    let name = match item {
                        SelectItem::ExprWithAlias { alias, .. } => Some(ident_name(alias)),
                        SelectItem::ExprWithAliases { aliases, .. } => aliases.first().map(ident_name),
                        _ => plain_col(e).and_then(|v| v.last().map(|i| ident_name(i))),
                    };
                    (name, None)
                }
                SelectItem::Wildcard(_) => {
                    self.fact(Fact { kind: "selectStar", scope: s, pos, ..Default::default() });
                    (None, Some(String::new()))
                }
                SelectItem::QualifiedWildcard(k, _) => {
                    let q = match k {
                        SelectItemQualifiedWildcardKind::ObjectName(n) => Some(n.to_string()),
                        _ => None,
                    };
                    let qual = match k {
                        SelectItemQualifiedWildcardKind::ObjectName(n) => name_parts(n).last().map(|i| ident_name(i)),
                        _ => None,
                    };
                    self.fact(Fact { kind: "selectStar", scope: s, pos, text: q, ..Default::default() });
                    (None, Some(qual.unwrap_or_default()))
                }
            };
            // 함수 끝 ) 를 빼먹은 위치 바로잡기
            pos = pos.map(|[a, b]| [a, self.pos.balance(a, b)]);
            list = upos(list, pos);
            let subs: Vec<u32> = (s0..self.scopes.len() as u32).filter(|&k| self.scopes[k as usize].parent == Some(s)).collect();
            self.outs.push(OutCol { scope: s, name, pos, cols: [c0, self.cols.len() as u32], subs, agg, win, star });
        }
        self.clause(s, "select", list);
        self.mods_clause(sel, s);
        if let Some(w) = &sel.selection {
            let p = self.pos.kw(w.span(), &["where"], 1);
            self.clause(s, "where", p);
            self.cond(w, s, "where", None);
        }
        if let GroupByExpr::Expressions(v, _) = &sel.group_by {
            for e in v {
                self.collect(e, s, "group", None, None);
            }
            if !v.is_empty() {
                let p = self.pos.kw(sel.group_by.span(), &["by", "group"], 2);
                self.clause(s, "group", p);
            }
        }
        if let Some(h) = &sel.having {
            let p = self.pos.kw(h.span(), &["having"], 1);
            self.clause(s, "having", p);
            self.cond(h, s, "having", None);
        }
        self.order_list(&sel.sort_by, s);
    }

    /// SELECT 바로 뒤의 DISTINCT · TOP — AST 에 위치가 없어 원문에서 찾는다
    fn mods_clause(&mut self, sel: &Select, s: u32) {
        if sel.distinct.is_none() && sel.top.is_none() {
            return;
        }
        let Some([_, mut i]) = self.pos.span(sel.select_token.0.span) else { return };
        let u = &self.pos.units;
        for _ in 0..4 {
            let a = self.pos.skip_fwd(i as usize);
            let mut b = a;
            while b < u.len() && is_word(u[b]) {
                b += 1;
            }
            if a == b {
                return;
            }
            let w = self.pos.word(a, b);
            match w.as_str() {
                "distinct" | "distinctrow" => {
                    // DISTINCT ON (…)
                    let on = self.pos.fwd_kw(b as u32, &["on"], 1);
                    let end = if on as usize > b { self.pos.call_end(on) } else { b as u32 };
                    self.clauses.push(Clause { scope: s, kind: "distinct", pos: Some([a as u32, end]) });
                    i = end;
                }
                "top" => {
                    let k = self.pos.skip_fwd(b);
                    let end_q = if u.get(k) == Some(&u16::from(b'(')) {
                        self.pos.match_paren(k).unwrap_or(b)
                    } else {
                        let mut e = k;
                        while e < u.len() && is_word(u[e]) {
                            e += 1;
                        }
                        e
                    };
                    let mut end = end_q as u32;
                    end = self.pos.fwd_kw(end, &["percent", "with", "ties"], 3);
                    self.clauses.push(Clause { scope: s, kind: "limit", pos: Some([a as u32, end]) });
                    i = end;
                }
                "all" | "sql_calc_found_rows" | "sql_no_cache" | "sql_cache" | "high_priority" | "straight_join" | "sql_small_result" | "sql_big_result" | "sql_buffer_result" => i = b as u32,
                _ => return,
            }
        }
    }

    /// FROM 한 덩이(표 + JOIN 들) — 첫 표 id 와 이 덩이의 결과(마지막 조인 또는 표)
    fn table_item(&mut self, twj: &TableWithJoins, s: u32) -> (Option<u32>, Option<In>) {
        let (first, mut h) = self.factor(&twj.relation, s);
        let mut prev = first;
        for j in &twj.joins {
            let (r, jh) = self.join(j, prev, h, s);
            prev = r.or(prev);
            h = jh;
        }
        (first, h)
    }

    fn join(&mut self, j: &Join, left: Option<u32>, lh: Option<In>, s: u32) -> (Option<u32>, Option<In>) {
        let (right, rh) = self.factor(&j.relation, s);
        let (kind, c) = match &j.join_operator {
            JoinOperator::Join(c) | JoinOperator::Inner(c) | JoinOperator::StraightJoin(c) => ("inner", Some(c)),
            JoinOperator::Left(c) | JoinOperator::LeftOuter(c) => ("left", Some(c)),
            JoinOperator::Right(c) | JoinOperator::RightOuter(c) => ("right", Some(c)),
            JoinOperator::FullOuter(c) => ("full", Some(c)),
            JoinOperator::CrossJoin(c) => ("cross", Some(c)),
            JoinOperator::Semi(c) | JoinOperator::LeftSemi(c) | JoinOperator::RightSemi(c) => ("semi", Some(c)),
            JoinOperator::Anti(c) | JoinOperator::LeftAnti(c) | JoinOperator::RightAnti(c) => ("anti", Some(c)),
            JoinOperator::CrossApply | JoinOperator::OuterApply => ("apply", None),
            JoinOperator::AsOf { constraint, .. } => ("asof", Some(constraint)),
            #[allow(unreachable_patterns)]
            _ => ("inner", None),
        };
        let idx = self.joins.len();
        let rel = self.pos.span(j.relation.span());
        // 강조 범위 — 앞의 LEFT OUTER JOIN 같은 키워드부터 ON 조건 끝까지
        let mut clause = rel.map(|[a, b]| [self.pos.back_kw(a, JOIN_WORDS, 5), b]);
        self.joins.push(JoinEdge { scope: s, left, right, kind, pos: rel, ia: lh, ib: rh, ..Default::default() });
        match c {
            Some(JoinConstraint::On(e)) => {
                self.joins[idx].has_on = true;
                if let Some(p) = self.pos.span(e.span()) {
                    self.joins[idx].pos = Some(p);
                    clause = upos(clause, Some(p));
                }
                self.cond(e, s, "on", Some(idx));
            }
            Some(JoinConstraint::Using(v)) | Some(JoinConstraint::UsingAlias(v, _)) => {
                self.joins[idx].using = v.iter().filter_map(|n| name_parts(n).last().map(|i| ident_name(i))).collect();
                self.joins[idx].has_on = true;
                for n in v {
                    clause = upos(clause, self.pos.span(n.span()));
                }
            }
            Some(JoinConstraint::Natural) => {
                self.joins[idx].natural = true;
                self.joins[idx].has_on = true;
            }
            _ => {
                if kind == "cross" {
                    self.fact(Fact { kind: "crossJoin", scope: s, pos: self.joins[idx].pos, table: right, ..Default::default() });
                } else if kind != "apply" {
                    self.fact(Fact { kind: "joinNoOn", scope: s, pos: self.joins[idx].pos, table: right, ..Default::default() });
                }
            }
        }
        self.joins[idx].clause = clause.map(|[a, b]| [a, self.pos.balance(a, b)]);
        (right, Some(In::J(idx as u32)))
    }

    fn table_ref(&mut self, n: &ObjectName, alias: Option<&Ident>, s: u32, target: bool) -> u32 {
        let parts = name_parts(n);
        let name = parts.last().map(|i| ident_name(i)).unwrap_or_else(|| n.to_string());
        let schema = (parts.len() > 1).then(|| ident_name(parts[parts.len() - 2]));
        let cte = if schema.is_none() {
            let low = name.to_lowercase();
            let anc = self.ancestors(s);
            // 가장 가까운 묶음의 CTE 부터
            anc.iter().find_map(|a| self.ctes.iter().find(|(n, _, owner)| *n == low && owner == a).map(|x| x.1))
        } else {
            None
        };
        let id = self.tables.len() as u32;
        let qual_text = alias.map(|a| a.to_string()).unwrap_or_else(|| n.to_string());
        self.tables.push(TableRef { id, scope: s, schema, name, alias: alias.map(ident_name), cte, derived: None, virt: false, target, qual_text, pos: self.pos.span(n.span()), span: None });
        id
    }

    /// FROM 의 한 요소 — 표 id 와 그 입력
    fn factor(&mut self, f: &TableFactor, s: u32) -> (Option<u32>, Option<In>) {
        match f {
            TableFactor::Table { name, alias, args, .. } => {
                let id = self.table_ref(name, alias.as_ref().map(|a| &a.name), s, false);
                let sp = self.pos.span(f.span());
                // 표 함수의 닫는 괄호까지
                self.tables[id as usize].span = sp.map(|[a, b]| [a, self.pos.balance(a, b)]);
                // jsonb_array_elements(o.items) 같은 표 함수 — 실표가 아니고, 앞 표의 열을 받으니 데카르트 곱도 아니다
                if args.is_some() {
                    self.tables[id as usize].virt = true;
                    self.tables[id as usize].cte = None;
                    self.no_cartesian.push(id);
                }
                (Some(id), Some(In::T(id)))
            }
            TableFactor::Derived { subquery, alias, lateral, .. } => {
                let nm = alias.as_ref().map(|a| ident_name(&a.name));
                let sub = self.sub_scope("derived", nm.clone(), s, subquery.span());
                // 괄호 + 별칭(+ 앞의 LATERAL)
                let fp = self.pos.span(f.span());
                let r = upos(self.scopes[sub as usize].range, fp).map(|[a, b]| [if *lateral { self.pos.back_kw(a, &["lateral"], 1) } else { a }, b]);
                self.scopes[sub as usize].range = r;
                let id = self.tables.len() as u32;
                self.tables.push(TableRef {
                    id,
                    scope: s,
                    schema: None,
                    name: nm.clone().unwrap_or_else(|| "(서브쿼리)".into()),
                    alias: nm,
                    cte: None,
                    derived: Some(sub),
                    virt: true,
                    target: false,
                    qual_text: alias.as_ref().map(|a| a.name.to_string()).unwrap_or_default(),
                    pos: fp,
                    span: r,
                });
                if *lateral {
                    self.no_cartesian.push(id);
                }
                self.query(subquery, sub, false);
                (Some(id), Some(In::T(id)))
            }
            TableFactor::NestedJoin { table_with_joins, .. } => self.table_item(table_with_joins, s),
            other => {
                let id = self.tables.len() as u32;
                let mut text = other.to_string();
                if text.chars().count() > 40 {
                    text = text.chars().take(40).collect::<String>() + "…";
                }
                let alias_id = match other {
                    TableFactor::TableFunction { alias, .. } | TableFactor::Function { alias, .. } | TableFactor::UNNEST { alias, .. } | TableFactor::JsonTable { alias, .. } => alias.as_ref().map(|a| &a.name),
                    _ => None,
                };
                let (alias, qual_text) = (alias_id.map(ident_name), alias_id.map(|a| a.to_string()).unwrap_or_default());
                let pos = self.pos.span(other.span());
                self.tables.push(TableRef { id, scope: s, schema: None, name: text, alias, cte: None, derived: None, virt: true, target: false, qual_text, pos, span: pos });
                self.no_cartesian.push(id);
                (Some(id), Some(In::T(id)))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn push_col(&mut self, s: u32, table: Option<u32>, qual: Option<String>, name: String, role: &'static str, pred: Option<&'static str>, wrapped: Option<String>, sp: Span) -> u32 {
        let id = self.cols.len() as u32;
        self.cols.push(ColUse { id, scope: s, table, qual, name, role, pred, wrapped, pos: self.pos.span(sp) });
        id
    }

    /// 식 속 열을 모두 올리고(쓰임 표시), 바로 아래 서브쿼리는 자기 묶음으로 — 처음 올린 열 id
    fn collect(&mut self, e: &Expr, s: u32, role: &'static str, pred: Option<&'static str>, wrapped: Option<String>) -> Option<u32> {
        let mut sc = Scan::default();
        let _ = e.visit(&mut sc);
        let mut first = None;
        for (parts, sp) in sc.cols {
            let name = parts.last().map(ident_name).unwrap_or_default();
            // 따옴표 없는 TRUE/FALSE/NULL 같은 것은 열이 아니다
            if parts.len() == 1 && parts[0].quote_style.is_none() && matches!(name.to_ascii_lowercase().as_str(), "true" | "false" | "null" | "current_date" | "current_timestamp" | "sysdate") {
                continue;
            }
            if parts.len() == 1 && matches!(role, "order" | "group" | "having") && self.is_alias(s, &name) {
                continue;
            }
            let qual = (parts.len() > 1).then(|| ident_name(&parts[parts.len() - 2]));
            let id = self.push_col(s, None, qual, name, role, pred, wrapped.clone(), sp);
            first.get_or_insert(id);
        }
        for q in sc.subs {
            let sub = self.sub_scope("subquery", None, s, q.span());
            self.query(&q, sub, false);
        }
        first
    }

    /// 이 묶음(또는 그 UNION 갈래)의 SELECT 별칭인가
    fn is_alias(&self, s: u32, name: &str) -> bool {
        let low = name.to_lowercase();
        self.aliases.iter().any(|(sc, n)| *n == low && (*sc == s || (self.scopes[*sc as usize].parent == Some(s) && self.scopes[*sc as usize].kind == "union")))
    }

    /// WHERE·ON·HAVING — AND 로 나눠 조건마다 쓰임을 가른다
    fn cond(&mut self, e: &Expr, s: u32, role: &'static str, join: Option<usize>) {
        let mut parts = Vec::new();
        split_and(e, &mut parts);
        for c in parts {
            let start = self.cols.len() as u32;
            self.conjunct(c, s, role, join);
            if role == "where" && join.is_none() {
                self.where_links.push((s, start, self.cols.len() as u32));
            }
        }
    }

    fn side(&mut self, e: &Expr, s: u32, role: &'static str, pred: &'static str) -> (Option<u32>, bool) {
        if plain_col(e).is_some() {
            return (self.collect(e, s, role, Some(pred), None), false);
        }
        // HAVING SUM(x) > 0 의 집계는 "열을 감싼 조건"이 아니다
        if role == "having" {
            return (self.collect(e, s, role, Some("other"), None), false);
        }
        if let Some(w) = wrapper_name(e) {
            let mut sc = Scan::default();
            let _ = e.visit(&mut sc);
            if sc.cols.len() == 1 && sc.subs.is_empty() {
                return (self.collect(e, s, role, Some(pred), Some(w)), true);
            }
        }
        (self.collect(e, s, role, Some("other"), None), false)
    }

    fn conjunct(&mut self, c: &Expr, s: u32, role: &'static str, join: Option<usize>) {
        match strip(c) {
            Expr::BinaryOp { left, op, right } if cmp_kind(op).is_some() => {
                let pred = cmp_kind(op).unwrap_or("other");
                let (a, aw) = self.side(left, s, role, pred);
                let (b, bw) = self.side(right, s, role, pred);
                let (ap, bp) = (plain_col(left).is_some(), plain_col(right).is_some());
                if let (Some(a), Some(b), true, true) = (a, b, ap, bp) {
                    if pred == "eq" {
                        match join {
                            Some(j) => self.joins[j].on.push(ColPair { a, b, op: op_text(op) }),
                            None if role == "where" => self.where_pairs.push((s, a, b)),
                            None => {}
                        }
                    }
                    self.fact(Fact { kind: "cmp", scope: s, col: Some(a), col2: Some(b), op: Some(op_text(op)), pos: self.pos.span(c.span()), ..Default::default() });
                } else {
                    // 열 대 값
                    let (col, lit) = if ap { (a, lit_kind(right)) } else if bp { (b, lit_kind(left)) } else { (None, None) };
                    // 감싼 열 대 값(YEAR(d) = 2024 같은 것)도 바꿔 쓰기에 값이 필요하다
                    let (col, lit) = match (col, lit) {
                        (Some(c), Some(l)) => (Some(c), Some(l)),
                        _ if aw => (a, lit_kind(right)),
                        _ if bw => (b, lit_kind(left)),
                        _ => (None, None),
                    };
                    if let (Some(col), Some((k, v))) = (col, lit) {
                        self.fact(Fact { kind: "cmp", scope: s, col: Some(col), op: Some(op_text(op)), lit: Some(k), value: Some(v), pos: self.pos.span(c.span()), ..Default::default() });
                    }
                }
                for (w, id, e) in [(aw, a, left), (bw, b, right)] {
                    if w {
                        let fname = wrapper_name(e);
                        self.fact(Fact { kind: "fnOnCol", scope: s, col: id, text: fname, pos: self.pos.span(e.span()), ..Default::default() });
                    }
                }
            }
            Expr::Like { negated, expr, pattern, .. } | Expr::ILike { negated, expr, pattern, .. } => {
                let ilike = matches!(strip(c), Expr::ILike { .. });
                let pat = match lit_kind(pattern) {
                    Some(("str", p)) => Some(p),
                    _ => None,
                };
                let leading = pat.as_deref().is_some_and(|p| p.starts_with('%') || p.starts_with('_'));
                let pred = if !leading && pat.is_some() && !negated && !ilike { "prefix" } else { "like" };
                let (a, aw) = self.side(expr, s, role, pred);
                self.collect(pattern, s, role, Some("other"), None);
                if leading && !negated {
                    self.fact(Fact { kind: "likeLeading", scope: s, col: a, text: pat, pos: self.pos.span(c.span()), ..Default::default() });
                }
                if aw {
                    self.fact(Fact { kind: "fnOnCol", scope: s, col: a, text: wrapper_name(expr), pos: self.pos.span(expr.span()), ..Default::default() });
                }
            }
            Expr::In { expr, target, negated, .. } => {
                let (a, aw) = self.side(expr, s, role, if *negated { "other" } else { "in" });
                match target {
                    InTarget::Subquery(q) => {
                        let sub = self.sub_scope("subquery", Some(if *negated { "NOT IN".into() } else { "IN".into() }), s, q.span());
                        self.query(q, sub, false);
                        if *negated {
                            self.fact(Fact { kind: "notInSubquery", scope: s, col: a, sub: Some(sub), pos: self.pos.span(c.span()), ..Default::default() });
                        }
                    }
                    InTarget::List(v) => {
                        for x in v {
                            self.collect(x, s, role, Some("other"), None);
                        }
                    }
                    #[allow(unreachable_patterns)]
                    _ => {}
                }
                if aw {
                    self.fact(Fact { kind: "fnOnCol", scope: s, col: a, text: wrapper_name(expr), pos: self.pos.span(expr.span()), ..Default::default() });
                }
            }
            Expr::Between { expr, low, high, negated } => {
                let (a, aw) = self.side(expr, s, role, if *negated { "other" } else { "range" });
                self.collect(low, s, role, Some("other"), None);
                self.collect(high, s, role, Some("other"), None);
                if aw {
                    self.fact(Fact { kind: "fnOnCol", scope: s, col: a, text: wrapper_name(expr), pos: self.pos.span(expr.span()), ..Default::default() });
                }
            }
            Expr::IsNull(x) | Expr::IsNotNull(x) => {
                self.side(x, s, role, "null");
            }
            Expr::Exists { subquery, negated } => {
                let sub = self.sub_scope("subquery", Some(if *negated { "NOT EXISTS".into() } else { "EXISTS".into() }), s, subquery.span());
                self.query(subquery, sub, false);
            }
            other => {
                self.collect(other, s, role, Some("other"), None);
            }
        }
    }

    /// 열이 가리키는 표 — 별칭·표 이름(가까운 묶음부터), 한정 없으면 그 묶음의 표가 하나일 때만
    fn resolve(&self, c: &ColUse) -> Option<u32> {
        let anc = self.ancestors(c.scope);
        match &c.qual {
            Some(q) => {
                let q = q.to_lowercase();
                for a in &anc {
                    let hit = self.tables.iter().filter(|t| t.scope == *a).find(|t| match &t.alias {
                        Some(al) => al.to_lowercase() == q,
                        None => t.name.to_lowercase() == q,
                    });
                    if let Some(t) = hit {
                        return Some(t.id);
                    }
                    // 별칭이 있어도 표 이름으로 쓴 경우(일부 엔진 허용)
                    if let Some(t) = self.tables.iter().filter(|t| t.scope == *a).find(|t| t.name.to_lowercase() == q) {
                        return Some(t.id);
                    }
                }
                None
            }
            None => {
                // IN·EXISTS·스칼라 서브쿼리는 바깥 표의 열도 한정 없이 쓸 수 있다 — 여기서 정하지 않는다
                if self.scopes[c.scope as usize].kind == "subquery" && anc.iter().skip(1).any(|a| self.tables.iter().any(|t| t.scope == *a)) {
                    return None;
                }
                let own: Vec<&TableRef> = self.tables.iter().filter(|t| t.scope == c.scope).collect();
                if own.len() == 1 {
                    Some(own[0].id)
                } else {
                    None
                }
            }
        }
    }

    fn finish(&mut self) {
        // 열 → 표
        for i in 0..self.cols.len() {
            if self.cols[i].table.is_none() {
                self.cols[i].table = self.resolve(&self.cols[i]);
            }
        }
        // ON 의 왼쪽 표를 실제 조건으로 바로잡기(앞 표가 아니라 조건이 가리키는 표)
        for j in 0..self.joins.len() {
            let Some(r) = self.joins[j].right else { continue };
            let other = self.joins[j].on.iter().find_map(|p| {
                let (ta, tb) = (self.cols[p.a as usize].table, self.cols[p.b as usize].table);
                match (ta, tb) {
                    (Some(a), Some(b)) if b == r && a != r => Some(a),
                    (Some(a), Some(b)) if a == r && b != r => Some(b),
                    _ => None,
                }
            });
            if let Some(o) = other {
                self.joins[j].left = Some(o);
            }
        }
        // WHERE 의 열 = 열 → 조인 선(옛 쉼표 조인)
        let pairs = std::mem::take(&mut self.where_pairs);
        let mut unresolved_scopes = Vec::new();
        for (s, a, b) in pairs {
            let (ta, tb) = (self.cols[a as usize].table, self.cols[b as usize].table);
            match (ta, tb) {
                (Some(x), Some(y)) if x != y => {
                    // 같은 묶음 안의 두 표일 때만(바깥 표와 맞추면 상관 서브쿼리)
                    let same = self.tables[x as usize].scope == s && self.tables[y as usize].scope == s;
                    if !same {
                        continue;
                    }
                    let ex = self.joins.iter().position(|e| e.kind == "where" && e.scope == s && ((e.left == Some(x) && e.right == Some(y)) || (e.left == Some(y) && e.right == Some(x))));
                    match ex {
                        Some(k) => self.joins[k].on.push(ColPair { a, b, op: "=" }),
                        None => {
                            let pos = self.cols[a as usize].pos;
                            self.joins.push(JoinEdge { scope: s, left: Some(x), right: Some(y), kind: "where", on: vec![ColPair { a, b, op: "=" }], has_on: true, pos, ..Default::default() });
                        }
                    }
                }
                (Some(_), Some(_)) => {}
                _ => {
                    unresolved_scopes.push(s);
                    self.joins.push(JoinEdge { scope: s, left: ta, right: tb, kind: "where", on: vec![ColPair { a, b, op: "=" }], has_on: true, pos: self.cols[a as usize].pos, ..Default::default() });
                }
            }
        }
        // 상관 서브쿼리 — 서브쿼리 안 열이 바깥 묶음의 표를 가리킨다
        for sc in 0..self.scopes.len() {
            let kind = self.scopes[sc].kind;
            if kind != "subquery" {
                continue;
            }
            let own_tree = |t: u32, me: &Builder| me.ancestors(me.tables[t as usize].scope).contains(&(sc as u32));
            let hit = self.cols.iter().find(|c| c.scope == sc as u32 && c.table.is_some_and(|t| !own_tree(t, self)));
            if let Some(c) = hit {
                let (cid, pos, tbl) = (c.id, self.scopes[sc].pos, c.table);
                let parent = self.scopes[sc].parent.unwrap_or(0);
                let name = self.scopes[sc].name.clone();
                self.fact(Fact { kind: "correlated", scope: parent, sub: Some(sc as u32), col: Some(cid), table: tbl, pos, text: name, ..Default::default() });
            }
        }
        // 데카르트 곱 — 쉼표로 늘어놓은 표가 조건으로 이어지지 않으면
        for sc in 0..self.scopes.len() as u32 {
            if unresolved_scopes.contains(&sc) {
                continue; // 한정 없는 열 = 열이 이을 수도 있다 — 화면이 메타데이터로 다시 본다
            }
            let commas: Vec<usize> = (0..self.joins.len()).filter(|&j| self.joins[j].scope == sc && self.joins[j].kind == "comma").collect();
            if commas.is_empty() {
                continue;
            }
            let ids: Vec<u32> = self.tables.iter().filter(|t| t.scope == sc).map(|t| t.id).collect();
            let mut root: Vec<u32> = (0..self.tables.len() as u32).collect();
            fn find(r: &mut [u32], x: u32) -> u32 {
                let mut x = x;
                while r[x as usize] != x {
                    r[x as usize] = r[r[x as usize] as usize];
                    x = r[x as usize];
                }
                x
            }
            for e in self.joins.iter().filter(|e| e.scope == sc && e.kind != "comma" && e.kind != "cross" && (e.has_on || e.kind == "apply")) {
                if let (Some(a), Some(b)) = (e.left, e.right) {
                    let (ra, rb) = (find(&mut root, a), find(&mut root, b));
                    root[ra as usize] = rb;
                }
                // ON 이 이름만 다른 표를 가리켜도(열 = 열 이 다른 표를 잇는 경우)
                for p in &e.on {
                    if let (Some(a), Some(b)) = (self.cols[p.a as usize].table, self.cols[p.b as usize].table) {
                        let (ra, rb) = (find(&mut root, a), find(&mut root, b));
                        root[ra as usize] = rb;
                    }
                }
            }
            for &(ls, a, b) in &self.where_links {
                if ls != sc {
                    continue;
                }
                let ts: Vec<u32> = (a..b).filter_map(|i| self.cols[i as usize].table).filter(|t| self.tables[*t as usize].scope == sc).collect();
                for w in ts.windows(2) {
                    let (ra, rb) = (find(&mut root, w[0]), find(&mut root, w[1]));
                    root[ra as usize] = rb;
                }
            }
            for j in commas {
                let Some(r) = self.joins[j].right else { continue };
                if self.no_cartesian.contains(&r) {
                    continue;
                }
                let rr = find(&mut root, r);
                // 이 쉼표 덩이 앞의 표들과 이어졌는가
                let joined = ids.iter().filter(|&&t| t < r).any(|&t| find(&mut root, t) == rr);
                if !joined {
                    let pos = self.joins[j].pos;
                    self.fact(Fact { kind: "cartesian", scope: sc, pos, table: Some(r), ..Default::default() });
                }
            }
        }
    }
}

fn split_and<'a>(e: &'a Expr, out: &mut Vec<&'a Expr>) {
    match strip(e) {
        Expr::BinaryOp { left, op: BinaryOperator::And, right } => {
            split_and(left, out);
            split_and(right, out);
        }
        x => out.push(x),
    }
}

// FunctionArg·FunctionArguments·FunctionArgExpr 는 Visitor 가 대신 걷는다 — 쓰지 않는 가져오기 경고 막기
#[allow(dead_code)]
fn _types(_: &FunctionArg, _: &FunctionArguments, _: &FunctionArgExpr) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn tbl<'a>(m: &'a QueryMap, name: &str) -> &'a TableRef {
        m.tables.iter().find(|t| t.name.eq_ignore_ascii_case(name)).unwrap_or_else(|| panic!("표 {name} 없음: {:?}", m.tables))
    }
    fn facts<'a>(m: &'a QueryMap, k: &str) -> Vec<&'a Fact> {
        m.facts.iter().filter(|f| f.kind == k).collect()
    }

    #[test]
    fn join_kinds_and_aliases() {
        let sql = "SELECT a.id, b.name FROM orders a INNER JOIN users b ON a.user_id = b.id LEFT JOIN items i ON i.order_id = a.id RIGHT JOIN x ON x.k = b.k FULL OUTER JOIN y ON y.k = x.k CROSS JOIN z";
        let m = build(sql, "postgres");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(m.kind, "select");
        let kinds: Vec<&str> = m.joins.iter().map(|j| j.kind).collect();
        assert_eq!(kinds, vec!["inner", "left", "right", "full", "cross"]);
        assert_eq!(tbl(&m, "orders").alias.as_deref(), Some("a"));
        assert_eq!(tbl(&m, "orders").qual_text, "a");
        // LEFT JOIN items 의 왼쪽은 조건이 가리키는 orders
        let left = &m.joins[1];
        assert_eq!(left.left, Some(tbl(&m, "orders").id));
        assert_eq!(left.right, Some(tbl(&m, "items").id));
        assert_eq!(left.on.len(), 1);
        let a = &m.cols[left.on[0].a as usize];
        assert_eq!((a.qual.as_deref(), a.name.as_str(), a.table), (Some("i"), "order_id", Some(tbl(&m, "items").id)));
        assert_eq!(facts(&m, "crossJoin").len(), 1);
        assert!(facts(&m, "cartesian").is_empty());
    }

    #[test]
    fn positions_are_utf16() {
        let sql = "-- 한글 주석\nSELECT * FROM 사용자 u";
        let m = build(sql, "postgres");
        assert!(m.ok, "{:?}", m.error);
        let t = tbl(&m, "사용자");
        let [a, b] = t.pos.unwrap();
        let u: Vec<u16> = sql.encode_utf16().collect();
        assert_eq!(String::from_utf16(&u[a as usize..b as usize]).unwrap(), "사용자");
        let star = facts(&m, "selectStar")[0].pos.unwrap();
        assert_eq!(String::from_utf16(&u[star[0] as usize..star[1] as usize]).unwrap(), "*");
    }

    #[test]
    fn cte_and_subquery_scopes() {
        let sql = "WITH recent AS (SELECT id, user_id FROM orders WHERE created_at > now() - interval '7 days')
            SELECT u.name, r.id FROM users u JOIN recent r ON r.user_id = u.id
            WHERE u.id IN (SELECT user_id FROM bans) AND EXISTS (SELECT 1 FROM logins l WHERE l.user_id = u.id)";
        let m = build(sql, "postgres");
        assert!(m.ok, "{:?}", m.error);
        let kinds: Vec<&str> = m.scopes.iter().map(|s| s.kind).collect();
        assert!(kinds.contains(&"cte") && kinds.iter().filter(|k| **k == "subquery").count() == 2, "{kinds:?}");
        let recent = m.tables.iter().find(|t| t.name == "recent").unwrap();
        assert!(recent.cte.is_some());
        // EXISTS 안의 l.user_id = u.id → 상관 서브쿼리
        let c = facts(&m, "correlated");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].text.as_deref(), Some("EXISTS"));
        // created_at 은 now() 와 비교(감싸지 않음) — fnOnCol 없음
        assert!(facts(&m, "fnOnCol").is_empty());
    }

    #[test]
    fn derived_table() {
        let m = build("SELECT t.c FROM (SELECT count(*) c FROM a GROUP BY k) t", "mysql");
        assert!(m.ok, "{:?}", m.error);
        let t = tbl(&m, "t");
        assert!(t.derived.is_some());
        assert_eq!(m.scopes[t.derived.unwrap() as usize].kind, "derived");
        assert!(m.cols.iter().any(|c| c.role == "group" && c.name == "k"));
    }

    #[test]
    fn parse_failure_keeps_error() {
        let m = build("SELECT a FROM WHERE", "postgres");
        assert!(!m.ok);
        assert!(m.error.is_some());
        let m = build("SELECT a, FROM t JOIN", "mysql");
        assert!(!m.ok);
    }

    #[test]
    fn lint_facts() {
        let m = build(
            "SELECT * FROM orders o, users u WHERE upper(u.email) = 'A' AND o.note LIKE '%x' AND o.id NOT IN (SELECT order_id FROM refunds) ORDER BY o.created_at LIMIT 20 OFFSET 50000",
            "postgres",
        );
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(facts(&m, "selectStar").len(), 1);
        let f = facts(&m, "fnOnCol");
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].text.as_deref(), Some("UPPER"));
        assert_eq!(m.cols[f[0].col.unwrap() as usize].name, "email");
        assert_eq!(facts(&m, "likeLeading").len(), 1);
        assert_eq!(facts(&m, "notInSubquery").len(), 1);
        assert_eq!(facts(&m, "offset")[0].num, Some(50000.0));
        assert!(facts(&m, "orderNoLimit").is_empty());
        // orders, users 를 잇는 조건이 없다
        assert_eq!(facts(&m, "cartesian").len(), 1);
    }

    #[test]
    fn comma_join_with_where_is_not_cartesian() {
        let m = build("SELECT o.id FROM orders o, users u WHERE o.user_id = u.id ORDER BY o.id", "oracle");
        assert!(m.ok, "{:?}", m.error);
        assert!(facts(&m, "cartesian").is_empty());
        assert!(m.joins.iter().any(|j| j.kind == "where" && j.on.len() == 1));
        assert_eq!(facts(&m, "orderNoLimit").len(), 1);
    }

    #[test]
    fn join_without_on() {
        let m = build("SELECT 1 FROM a JOIN b", "mysql");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(facts(&m, "joinNoOn").len(), 1);
    }

    #[test]
    fn update_delete_without_where() {
        let m = build("UPDATE users SET name = 'x'", "postgres");
        assert_eq!(m.kind, "update");
        assert_eq!(facts(&m, "noWhere").len(), 1);
        assert!(tbl(&m, "users").target);
        let m = build("DELETE FROM users WHERE id = 3", "mysql");
        assert_eq!(m.kind, "delete");
        assert!(facts(&m, "noWhere").is_empty());
        assert!(m.cols.iter().any(|c| c.name == "id" && c.pred == Some("eq") && c.table.is_some()));
    }

    #[test]
    fn dialects() {
        // SQL Server — TOP·대괄호 이름
        let m = build("SELECT TOP 10 [o].[id] FROM [dbo].[orders] AS [o] ORDER BY [o].[id]", "mssql");
        assert!(m.ok, "{:?}", m.error);
        let t = tbl(&m, "orders");
        assert_eq!(t.schema.as_deref(), Some("dbo"));
        assert_eq!(t.qual_text, "[o]");
        assert!(facts(&m, "orderNoLimit").is_empty());
        // MySQL — 백틱 · LIMIT a,b
        let m = build("SELECT `u`.`id` FROM `users` `u` LIMIT 100000, 20", "mysql");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(facts(&m, "offset")[0].num, Some(100000.0));
        // CUBRID 등은 일반 방언
        let m = build("SELECT a.x FROM t1 a LEFT OUTER JOIN t2 b ON a.k = b.k", "cubrid");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(m.dialect, "generic");
        assert_eq!(m.joins[0].kind, "left");
    }

    #[test]
    fn compare_facts_for_types() {
        let m = build("SELECT 1 FROM users u WHERE u.phone = 1012345678 AND u.age > '30'", "postgres");
        let c = facts(&m, "cmp");
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].lit, c[0].value.as_deref(), c[0].op), (Some("num"), Some("1012345678"), Some("=")));
        assert_eq!(c[1].lit, Some("str"));
        assert!(m.cols.iter().any(|x| x.name == "age" && x.pred == Some("range")));
    }

    fn text(sql: &str, p: Pos) -> String {
        let [a, b] = p.expect("위치 없음");
        let u: Vec<u16> = sql.encode_utf16().collect();
        String::from_utf16(&u[a as usize..b as usize]).unwrap()
    }

    #[test]
    fn spans_for_rewrites() {
        let sql = "SELECT o.id FROM orders o WHERE YEAR(o.created_at) = 2024 AND o.id NOT IN (SELECT r.order_id FROM refunds r WHERE r.ok = 1)";
        let m = build(sql, "mysql");
        assert!(m.ok, "{:?}", m.error);
        let f = facts(&m, "fnOnCol");
        assert_eq!(text(sql, f[0].pos), "YEAR(o.created_at)");
        let c = facts(&m, "cmp").into_iter().find(|x| x.col == f[0].col).expect("YEAR 비교");
        assert_eq!((c.op, c.lit, c.value.as_deref()), (Some("="), Some("num"), Some("2024")));
        assert_eq!(text(sql, c.pos), "YEAR(o.created_at) = 2024");
        let ni = facts(&m, "notInSubquery");
        assert_eq!(text(sql, ni[0].pos), "o.id NOT IN (SELECT r.order_id FROM refunds r WHERE r.ok = 1)");
        let sub = ni[0].sub.unwrap() as usize;
        assert!(text(sql, m.scopes[sub].pos).starts_with("SELECT r.order_id FROM refunds r"));
        assert!(m.cols.iter().any(|x| x.scope == sub as u32 && x.role == "select" && x.name == "order_id"));
    }

    #[test]
    fn union_insert_and_scalar_subquery() {
        let m = build("SELECT a FROM t1 UNION ALL SELECT b FROM t2", "postgres");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(m.scopes.iter().filter(|s| s.kind == "union").count(), 2);
        let m = build("INSERT INTO archive (id, name) SELECT id, name FROM users WHERE active = false", "postgres");
        assert_eq!(m.kind, "insert");
        assert!(tbl(&m, "archive").target);
        assert!(m.cols.iter().any(|c| c.role == "insert" && c.name == "id"));
        assert!(m.scopes.iter().any(|s| s.kind == "subquery"));
        // SELECT 목록의 상관 서브쿼리
        let m = build("SELECT u.id, (SELECT count(*) FROM orders o WHERE o.user_id = u.id) AS n FROM users u", "postgres");
        let c = facts(&m, "correlated");
        assert_eq!(c.len(), 1);
        assert!(c[0].text.is_none());
        // 같은 이름 별칭이 안쪽에 있으면 안쪽 표
        let m = build("SELECT 1 FROM users u WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = 1)", "postgres");
        assert!(facts(&m, "correlated").is_empty());
    }

    #[test]
    fn mssql_apply_and_oracle_fallback() {
        let m = build("SELECT c.id, x.n FROM customers c CROSS APPLY (SELECT TOP 1 o.id n FROM orders o WHERE o.cid = c.id ORDER BY o.id DESC) x", "mssql");
        assert!(m.ok, "{:?}", m.error);
        assert!(m.joins.iter().any(|j| j.kind == "apply"));
        assert!(facts(&m, "joinNoOn").is_empty());
        assert!(facts(&m, "cartesian").is_empty());
        // Oracle 방언이 못 읽는 것은 일반 방언으로
        let m = build("SELECT e.ename FROM emp e, dept d WHERE e.deptno = d.deptno(+)", "oracle");
        assert!(m.ok || m.error.is_some());
    }

    #[test]
    fn deep_chains_do_not_crash() {
        // 큰 스택 스레드에서 — 일꾼 스레드 기본 스택이면 수천 항에서 넘친다
        let terms: Vec<String> = (0..1900).map(|i| format!("a = {i}")).collect();
        let m = sql_map(format!("SELECT 1 FROM t WHERE {}", terms.join(" OR ")), "postgres".into());
        assert!(m.ok, "{:?}", m.error);
        let terms: Vec<String> = (0..2100).map(|i| format!("a = {i}")).collect();
        let m = sql_map(format!("SELECT 1 FROM t WHERE {}", terms.join(" OR ")), "postgres".into());
        assert!(!m.ok);
        // 따옴표 안의 and·or 는 세지 않는다
        assert_eq!(chain_len("SELECT 'a and b or c' FROM t WHERE x = 1 AND y = 2"), 3);
    }

    #[test]
    fn fable_review_cases() {
        // Oracle (+) — 데카르트 곱이 아니다
        let m = build("SELECT e.ename FROM emp e, dept d WHERE e.deptno = d.deptno(+)", "oracle");
        assert!(m.ok, "{:?}", m.error);
        assert!(facts(&m, "cartesian").is_empty(), "{:?}", m.facts);
        // 표 함수 — 실표·데카르트 곱이 아니다
        let m = build("SELECT o.id, item FROM orders o, jsonb_array_elements(o.items) item", "postgres");
        assert!(m.ok, "{:?}", m.error);
        assert!(facts(&m, "cartesian").is_empty());
        assert!(m.tables.iter().any(|t| t.name.contains("jsonb_array_elements") && t.virt));
        // ORDER BY 별칭은 열이 아니다
        let m = build("SELECT user_id, count(*) AS n FROM orders GROUP BY user_id ORDER BY n DESC", "postgres");
        assert!(!m.cols.iter().any(|c| c.name == "n"));
        // HAVING 집계는 감싼 조건이 아니다
        let m = build("SELECT user_id FROM orders GROUP BY user_id HAVING SUM(amount) > 1000", "postgres");
        assert!(facts(&m, "fnOnCol").is_empty());
        // @변수는 열이 아니다
        let m = build("SELECT name FROM users WHERE id = @id AND @@ROWCOUNT > 0", "mssql");
        assert!(m.ok, "{:?}", m.error);
        assert!(!m.cols.iter().any(|c| c.name.starts_with('@')));
        // 비재귀 CTE 안의 같은 이름은 실제 표
        let m = build("WITH orders AS (SELECT * FROM orders WHERE paid) SELECT id FROM orders", "postgres");
        let inner = m.tables.iter().find(|t| t.scope == 1).unwrap();
        assert!(inner.cte.is_none());
        assert!(m.tables.iter().find(|t| t.scope == 0).unwrap().cte.is_some());
        // 재귀 CTE 는 자기 참조
        let m = build("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT n FROM t", "postgres");
        assert!(m.tables.iter().all(|t| t.cte.is_some()), "{:?}", m.tables);
        // ILIKE 는 접두 검색이 아니다 · ORDER BY 식은 감싼 열
        let m = build("SELECT 1 FROM users u WHERE u.name ILIKE 'abc%' ORDER BY lower(u.name) LIMIT 5", "postgres");
        assert!(m.cols.iter().any(|c| c.pred == Some("like")));
        assert!(m.cols.iter().any(|c| c.role == "order" && c.wrapped.is_some()));
        // 서브쿼리의 한정 없는 열은 정하지 않는다(바깥 열일 수 있다)
        let m = build("SELECT 1 FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id AND email IS NOT NULL)", "postgres");
        assert!(m.cols.iter().find(|c| c.name == "email").unwrap().table.is_none());
        // 열 = 열 이 아니어도 두 표를 함께 쓰는 조건이면 이어졌다
        let m = build("SELECT 1 FROM a, b WHERE a.d BETWEEN b.s AND b.e", "postgres");
        assert!(facts(&m, "cartesian").is_empty());
    }

    // ── 단계 그래프(절 범위·출력 열·조인 입력) — 시험 SQL 묶음을 일반 이름으로 ──

    fn clause<'a>(m: &'a QueryMap, scope: u32, kind: &str) -> &'a Clause {
        m.clauses.iter().find(|c| c.scope == scope && c.kind == kind).unwrap_or_else(|| panic!("절 {kind} 없음: {:?}", m.clauses))
    }

    #[test]
    fn flow_inner_join_where() {
        let sql = "SELECT a.post_id, a.title, b.hit AS bak_hit\nFROM article a\nJOIN article_hit_bak b ON b.post_id = a.post_id\nWHERE a.hit > 100;";
        let m = build(sql, "mysql");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(text(sql, clause(&m, 0, "select").pos), "SELECT a.post_id, a.title, b.hit AS bak_hit");
        assert_eq!(text(sql, clause(&m, 0, "from").pos), "FROM article a\nJOIN article_hit_bak b ON b.post_id = a.post_id");
        assert_eq!(text(sql, clause(&m, 0, "where").pos), "WHERE a.hit > 100");
        let j = &m.joins[0];
        assert_eq!(text(sql, j.clause), "JOIN article_hit_bak b ON b.post_id = a.post_id");
        assert_eq!((j.ia, j.ib), (Some(In::T(0)), Some(In::T(1))));
        assert_eq!(m.scopes[0].src, Some(In::J(0)));
        assert_eq!(text(sql, tbl(&m, "article").span), "article a");
        let names: Vec<Option<&str>> = m.outs.iter().map(|o| o.name.as_deref()).collect();
        assert_eq!(names, vec![Some("post_id"), Some("title"), Some("bak_hit")]);
        // 계보 — bak_hit 은 b.hit 에서
        let o = &m.outs[2];
        let c: Vec<&ColUse> = (o.cols[0]..o.cols[1]).map(|i| &m.cols[i as usize]).collect();
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].name.as_str(), c[0].table), ("hit", Some(tbl(&m, "article_hit_bak").id)));
    }

    #[test]
    fn flow_join_chain_inputs() {
        let sql = "SELECT bf.file_id, bf.file_sn, bm.title AS movie_title, mf.c_name\nFROM board_file bf\nJOIN board_movie bm ON bm.file_id = bf.file_id\nLEFT JOIN form_file mf ON mf.file_id = bf.file_id AND mf.file_sn = bf.file_sn;";
        let m = build(sql, "mysql");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(m.joins.len(), 2);
        // 둘째 조인의 왼쪽 입력은 첫 조인 결과
        assert_eq!((m.joins[1].ia, m.joins[1].ib), (Some(In::J(0)), Some(In::T(2))));
        assert_eq!(text(sql, m.joins[1].clause), "LEFT JOIN form_file mf ON mf.file_id = bf.file_id AND mf.file_sn = bf.file_sn");
        assert_eq!(m.scopes[0].src, Some(In::J(1)));
        assert!(m.clauses.iter().all(|c| c.kind != "where"));
    }

    #[test]
    fn flow_cte_and_window() {
        let sql = "WITH recent AS (\n  SELECT post_id, board_id, title, created_at,\n         ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY created_at DESC) AS rn\n  FROM article\n)\nSELECT r.board_id, r.title, r.created_at\nFROM recent r\nWHERE r.rn <= 3;";
        let m = build(sql, "mysql");
        assert!(m.ok, "{:?}", m.error);
        let cte = m.scopes.iter().find(|s| s.kind == "cte").unwrap();
        let r = text(sql, cte.range);
        assert!(r.starts_with("WITH recent AS (") && r.ends_with(')'), "{r}");
        assert_eq!(text(sql, clause(&m, cte.id, "window").pos), "ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY created_at DESC)");
        let rn = m.outs.iter().find(|o| o.name.as_deref() == Some("rn")).unwrap();
        assert!(rn.win && !rn.agg && rn.scope == cte.id);
        assert!(text(sql, rn.pos).ends_with("DESC) AS rn"));
        assert!(text(sql, clause(&m, cte.id, "select").pos).ends_with("AS rn"));
        assert_eq!(text(sql, clause(&m, 0, "where").pos), "WHERE r.rn <= 3");
        assert_eq!(m.outs.iter().filter(|o| o.scope == 0).count(), 3);
    }

    #[test]
    fn flow_subquery_ranges() {
        let sql = "SELECT d.doc_id, d.file_name\nFROM docs d\nWHERE d.doc_id IN (SELECT l.doc_id FROM doc_lang l WHERE l.lang = 'ko')\n  AND EXISTS (SELECT 1 FROM doc_field tf WHERE tf.doc_id = d.doc_id);";
        let m = build(sql, "mysql");
        assert!(m.ok, "{:?}", m.error);
        let subs: Vec<String> = m.scopes.iter().filter(|s| s.kind == "subquery").map(|s| text(sql, s.range)).collect();
        assert_eq!(subs, vec!["(SELECT l.doc_id FROM doc_lang l WHERE l.lang = 'ko')", "(SELECT 1 FROM doc_field tf WHERE tf.doc_id = d.doc_id)"]);
        let w = text(sql, clause(&m, 0, "where").pos);
        assert!(w.starts_with("WHERE d.doc_id IN") && w.ends_with("d.doc_id)"), "{w}");
    }

    #[test]
    fn flow_union_branches() {
        let sql = "SELECT id AS id, title AS title, 'board' AS src FROM board\nUNION ALL\nSELECT id, title, 'qna' FROM qna;";
        let m = build(sql, "mysql");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(text(sql, clause(&m, 0, "setop").pos), "UNION ALL");
        let br: Vec<&Scope> = m.scopes.iter().filter(|s| s.kind == "union").collect();
        assert_eq!(br.len(), 2);
        assert_eq!(text(sql, br[1].range), "SELECT id, title, 'qna' FROM qna");
        assert_eq!(m.outs.iter().filter(|o| o.scope == br[0].id).count(), 3);
        assert_eq!(m.outs.iter().find(|o| o.scope == br[1].id).and_then(|o| o.name.as_deref()), Some("id"));
        // 셋째 열은 식(이름 없음)
        assert!(m.outs.iter().filter(|o| o.scope == br[1].id).nth(2).unwrap().name.is_none());
        assert_eq!(m.scopes[br[0].id as usize].src, Some(In::T(0)));
    }

    #[test]
    fn flow_comma_cartesian() {
        let sql = "SELECT d.doc_id, t.title\nFROM docs d, theater t\nWHERE d.file_ext = 'pdf';";
        let m = build(sql, "mysql");
        assert!(m.ok, "{:?}", m.error);
        let j = m.joins.iter().find(|j| j.kind == "comma").unwrap();
        assert_eq!((j.ia, j.ib), (Some(In::T(0)), Some(In::T(1))));
        assert_eq!(text(sql, j.pos), "theater t");
        assert_eq!(facts(&m, "cartesian").len(), 1);
    }

    #[test]
    fn flow_group_order_limit_distinct() {
        let sql = "SELECT DISTINCT fm.idx, fm.c_name, COUNT(mf.file_sn) AS files\nFROM form fm\nLEFT JOIN form_file mf ON mf.idx = fm.idx\nGROUP BY fm.idx, fm.c_name\nHAVING COUNT(mf.file_sn) > 1\nORDER BY files DESC\nLIMIT 20 OFFSET 40";
        let m = build(sql, "postgres");
        assert!(m.ok, "{:?}", m.error);
        assert_eq!(text(sql, clause(&m, 0, "distinct").pos), "DISTINCT");
        assert_eq!(text(sql, clause(&m, 0, "group").pos), "GROUP BY fm.idx, fm.c_name");
        assert_eq!(text(sql, clause(&m, 0, "having").pos), "HAVING COUNT(mf.file_sn) > 1");
        assert_eq!(text(sql, clause(&m, 0, "order").pos), "ORDER BY files DESC");
        assert_eq!(text(sql, clause(&m, 0, "limit").pos), "LIMIT 20 OFFSET 40");
        assert!(m.outs[2].agg && m.outs[2].name.as_deref() == Some("files"));
        // TOP · FETCH · DISTINCT ON
        let sql = "SELECT TOP (10) o.id FROM orders o ORDER BY o.id";
        let m = build(sql, "mssql");
        assert_eq!(text(sql, clause(&m, 0, "limit").pos), "TOP (10)");
        let sql = "SELECT o.id FROM orders o ORDER BY o.id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY";
        let m = build(sql, "mssql");
        assert_eq!(text(sql, clause(&m, 0, "limit").pos), "OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY");
        let sql = "SELECT DISTINCT ON (u.team) u.team, u.name FROM users u ORDER BY u.team, u.score DESC";
        let m = build(sql, "postgres");
        assert_eq!(text(sql, clause(&m, 0, "distinct").pos), "DISTINCT ON (u.team)");
    }

    #[test]
    fn flow_derived_and_dml() {
        let sql = "SELECT t.c FROM (SELECT count(*) c FROM a GROUP BY k) t WHERE (t.c > 1 OR t.c < 0)";
        let m = build(sql, "postgres");
        let d = m.scopes.iter().find(|s| s.kind == "derived").unwrap();
        assert_eq!(text(sql, d.range), "(SELECT count(*) c FROM a GROUP BY k) t");
        assert_eq!(text(sql, clause(&m, 0, "where").pos), "WHERE (t.c > 1 OR t.c < 0)");
        assert!(m.outs.iter().any(|o| o.scope == d.id && o.agg && o.name.as_deref() == Some("c")));
        // * 와 t.*
        let m = build("SELECT *, u.* FROM users u", "postgres");
        assert_eq!(m.outs.iter().map(|o| o.star.as_deref()).collect::<Vec<_>>(), vec![Some(""), Some("u")]);
        // UPDATE · DELETE · INSERT 의 대상·SET·WHERE
        let sql = "UPDATE users SET name = 'x', age = age + 1 WHERE id = 3";
        let m = build(sql, "postgres");
        assert_eq!(text(sql, clause(&m, 0, "target").pos), "UPDATE users");
        assert_eq!(text(sql, clause(&m, 0, "set").pos), "SET name = 'x', age = age + 1");
        assert_eq!(text(sql, clause(&m, 0, "where").pos), "WHERE id = 3");
        assert_eq!(m.scopes[0].src, Some(In::T(0)));
        let sql = "DELETE FROM users WHERE id = 3";
        let m = build(sql, "mysql");
        assert_eq!(text(sql, clause(&m, 0, "target").pos), "DELETE FROM users");
        let sql = "INSERT INTO archive (id, name) SELECT id, name FROM users";
        let m = build(sql, "postgres");
        assert_eq!(text(sql, clause(&m, 0, "target").pos), "INSERT INTO archive (id, name)");
        // 스칼라 서브쿼리는 그 출력 열에 붙는다
        let sql = "SELECT bd.id, (SELECT COUNT(*) FROM board_file f WHERE f.board_id = bd.id) AS files FROM board bd";
        let m = build(sql, "mysql");
        let o = m.outs.iter().find(|o| o.name.as_deref() == Some("files")).unwrap();
        assert_eq!(o.subs.len(), 1);
        assert_eq!(text(sql, m.scopes[o.subs[0] as usize].range), "(SELECT COUNT(*) FROM board_file f WHERE f.board_id = bd.id)");
        assert!(!o.agg, "서브쿼리 속 COUNT 는 바깥 집계가 아니다");
    }

    /// 목업(src/dev/mock.ts) 예시 만들기 — `cargo test --lib dump_mock_maps -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn dump_mock_maps() {
        let path = std::env::var("QM_DUMP").expect("QM_DUMP=예시 SQL 파일(문장마다 빈 줄 둘)");
        let all = std::fs::read_to_string(path).unwrap();
        for sql in all.split("\n\n\n").map(str::trim).filter(|s| !s.is_empty()) {
            let m = build(sql, "mariadb");
            println!("{}", serde_json::to_string(&serde_json::json!({ "sql": sql, "map": m })).unwrap());
        }
    }

    #[test]
    fn too_big() {
        let big = format!("SELECT '{}'", "x".repeat(MAX_SQL + 10));
        let m = build(&big, "postgres");
        assert!(!m.ok);
    }
}
