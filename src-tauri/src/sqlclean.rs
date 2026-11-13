//! 쿼리 다듬기 — 지저분한 레거시 문장 하나를 sqlparser 로 읽어 AST 를 고쳐 다시 찍는다.
//! 결과는 정리된 SQL 과 "바꾼 것 목록"(항목마다 id·안전 등급·원문 위치)이다. 화면이 항목을 끄면 그 id 를
//! `off` 로 넘겨 다시 만든다(id 는 원문 위치에서 나오므로 다시 만들어도 같다).
//!
//! - safe: 의미가 확실히 같은 것만(쉼표 조인 → INNER JOIN, 1=1 제거 …)
//! - check: 결과가 같은지 확인을 권하는 것(파생 표 펼치기, 상관 서브쿼리 → JOIN …)
//!
//! 지키는 것: ① 원문을 그대로 다시 찍어 다시 읽었을 때 같은 AST 가 아니면(다시 찍기가 뜻을 잃는 문법) 손대지 않는다
//! ② 정리본도 다시 읽어 바꾼 AST 와 같아야만 돌려준다 ③ 주석은 가까운 낱말 앞뒤로 옮겨 붙이고, 못 붙인 것은 맨 앞으로 모은 뒤 그 수를 알린다.
//! 서버에는 묻지 않는다 — 표 메타데이터(열·PK·UNIQUE)는 화면이 넘겨 준다(없으면 그것이 필요한 변환만 건너뛴다).
//!
//! `sql_compare_sql` 은 원문·정리본의 결과가 같은지 볼 SQL(행 수, EXCEPT 차이 행 수 또는 열별 집계)을 만들어 주기만 한다 —
//! 실행은 화면이 읽기 문장일 때만 시간 상한을 걸어 `db_query` 로 한다.

use serde::{Deserialize, Serialize};
use sqlparser::ast::comments::{Comment, CommentWithSpan};
use sqlparser::ast::{
    BinaryOperator, CastKind, Cte, Distinct, Expr, Function, GroupByExpr, Ident, InTarget, Join, JoinConstraint, JoinOperator, ObjectName, ObjectNamePart, OrderBy, Query, Select, SelectItem, SelectItemQualifiedWildcardKind, SetExpr, Spanned, Statement, TableAlias, TableFactor, TableWithJoins, UnaryOperator,
    Value, Visit, VisitMut, Visitor, VisitorMut,
};
use sqlparser::dialect::{Dialect, GenericDialect, MsSqlDialect, MySqlDialect, OracleDialect, PostgreSqlDialect};
use sqlparser::keywords::ALL_KEYWORDS;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Location, Span, Token, TokenWithSpan, Tokenizer};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::ControlFlow;

/// 이보다 긴 문장은 다듬지 않는다
const MAX_SQL: usize = 256 << 10;
/// 전용 스레드 스택(깊은 AND 사슬의 재귀 걷기·Drop)
const BIG_STACK: usize = 256 << 20;

/// [시작, 끝) — 원문 안의 UTF-16 위치(편집기 위치와 같은 단위)
type Pos = Option<[u32; 2]>;

// ───────────────────────── 주고받는 모양 ─────────────────────────

/// 화면이 넘겨 주는 표 메타데이터(있는 표만)
#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CleanMeta {
    #[serde(default)]
    pub tables: Vec<MetaTable>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaTable {
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    #[serde(default)]
    pub cols: Vec<MetaCol>,
    /// PK·UNIQUE 키(부분 인덱스 제외) — 열 이름 묶음
    #[serde(default)]
    pub unique: Vec<Vec<String>>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaCol {
    pub name: String,
    #[serde(default)]
    pub pk: bool,
}

/// 바꾼 것 하나
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// 다시 만들 때 끄는 열쇠 — 종류:원문 위치
    pub id: String,
    pub kind: &'static str,
    /// safe · check
    pub safety: &'static str,
    pub title: String,
    pub detail: String,
    pub pos: Pos,
    /// 이번 결과에 반영했는지(off 로 껐으면 false)
    pub on: bool,
}

#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommentNote {
    pub total: u32,
    /// 가까운 낱말 옆에 붙인 수
    pub kept: u32,
    /// 붙일 자리를 못 찾아 맨 앞으로 모은 수
    pub moved: u32,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TableName {
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    /// 읽고 다듬기를 마쳤는지(바꾼 것이 없어도 true)
    pub ok: bool,
    /// 읽지 못함·처리 못 하는 문법 — 이때 text 는 원문 그대로
    pub error: Option<String>,
    /// select · insert · update · delete · other
    pub kind: &'static str,
    pub dialect: &'static str,
    /// 정리본(바꾼 것이 없으면 원문)
    pub text: String,
    pub changed: bool,
    pub changes: Vec<Change>,
    pub comments: CommentNote,
    /// 문장이 읽는 표(메타데이터를 채워 다시 부를 때 쓴다 — CTE 이름은 뺀다)
    pub tables: Vec<TableName>,
    /// 건너뛴 이유 같은 짧은 알림
    pub notes: Vec<String>,
}

// ───────────────────────── 엔진·방언 ─────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Eng {
    Pg,
    My,
    Ms,
    Ora,
    Gen,
}

impl Eng {
    fn of(engine: &str) -> Eng {
        match engine {
            "postgres" => Eng::Pg,
            "mysql" | "mariadb" => Eng::My,
            "mssql" => Eng::Ms,
            "oracle" | "tibero" => Eng::Ora,
            _ => Eng::Gen,
        }
    }
    fn dialect(self) -> Box<dyn Dialect> {
        match self {
            Eng::Pg => Box::new(PostgreSqlDialect {}),
            Eng::My => Box::new(MySqlDialect {}),
            Eng::Ms => Box::new(MsSqlDialect {}),
            Eng::Ora => Box::new(OracleDialect {}),
            Eng::Gen => Box::new(GenericDialect {}),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Eng::Pg => "postgres",
            Eng::My => "mysql",
            Eng::Ms => "mssql",
            Eng::Ora => "oracle",
            Eng::Gen => "generic",
        }
    }
    /// 표 별칭 앞의 AS — Oracle 은 표 별칭에 AS 를 받지 않는다
    fn alias_as(self) -> bool {
        self != Eng::Ora
    }
}

fn parse_all(d: &dyn Dialect, sql: &str) -> Result<(Vec<Statement>, Vec<CommentWithSpan>), String> {
    let mut p = Parser::new(d).with_recursion_limit(96).try_with_sql(sql).map_err(|e| e.to_string())?;
    let v = p.parse_statements().map_err(|e| e.to_string())?;
    let c: Vec<CommentWithSpan> = p.into_comments().into();
    Ok((v, c))
}

fn parse_plain(d: &dyn Dialect, sql: &str) -> Option<Vec<Statement>> {
    Parser::new(d).with_recursion_limit(96).try_with_sql(sql).ok()?.parse_statements().ok()
}

fn print(st: &Statement, pretty: bool) -> String {
    if pretty {
        format!("{st:#}")
    } else {
        st.to_string()
    }
}

/// 찍은 글을 다시 읽어 같은 AST 인지(위치는 비교하지 않는다)
fn roundtrip(d: &dyn Dialect, st: &Statement, pretty: bool) -> bool {
    matches!(parse_plain(d, &print(st, pretty)), Some(v) if v.len() == 1 && v[0] == *st)
}

fn kind_of(st: &Statement) -> &'static str {
    match st {
        Statement::Query(_) => "select",
        Statement::Insert(_) => "insert",
        Statement::Update(_) => "update",
        Statement::Delete(_) => "delete",
        _ => "other",
    }
}

// ───────────────────────── 위치 ─────────────────────────

/// 줄·열(문자 단위, 1부터) → UTF-16 위치
struct PosMap {
    char_u16: Vec<u32>,
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
        line_char.push(char_u16.len() - 1);
        PosMap { char_u16, line_char, units: s.encode_utf16().collect() }
    }
    fn char_at(&self, l: Location) -> Option<usize> {
        if l.line == 0 || l.column == 0 {
            return None;
        }
        let line = l.line as usize - 1;
        let start = *self.line_char.get(line)?;
        let next = self.line_char.get(line + 1).copied().unwrap_or(start);
        let end = if line + 2 < self.line_char.len() { next.saturating_sub(1) } else { next };
        Some((start + l.column as usize - 1).min(end.max(start)))
    }
    fn at(&self, l: Location) -> Option<u32> {
        self.char_u16.get(self.char_at(l)?).copied()
    }
    fn span(&self, s: Span) -> Pos {
        let a = self.at(s.start)?;
        let b = self.at(s.end).unwrap_or(a).max(a);
        Some([a, self.balance(a, b)])
    }
    /// sqlparser 위치는 서브쿼리·함수 끝 ) 를 빼먹기도 한다 — 괄호 짝이 맞을 때까지 끝을 늘린다
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
        i as u32
    }
}

/// 줄·열 → 바이트 위치(주석 끼우기)
fn byte_at(text: &str, line_starts: &[usize], l: Location) -> Option<usize> {
    if l.line == 0 || l.column == 0 {
        return None;
    }
    let ls = *line_starts.get(l.line as usize - 1)?;
    let rest = &text[ls..];
    let col = l.column as usize - 1;
    match rest.char_indices().nth(col) {
        Some((b, _)) => Some(ls + b),
        None => Some(text.len()),
    }
}

fn line_starts(text: &str) -> Vec<usize> {
    let mut v = vec![0];
    for (i, c) in text.char_indices() {
        if c == '\n' {
            v.push(i + 1);
        }
    }
    v
}

// ───────────────────────── 식 도우미 ─────────────────────────

fn lc(s: &str) -> String {
    s.to_lowercase()
}

fn num(n: &str) -> Expr {
    Expr::Value(Value::Number(n.into(), false).with_empty_span())
}

fn bin(l: Expr, op: BinaryOperator, r: Expr) -> Expr {
    Expr::BinaryOp { left: Box::new(l), op, right: Box::new(r) }
}

/// AND 로 묶기(왼쪽 결합 — 다시 읽었을 때와 같은 모양)
fn and_all(v: Vec<Expr>) -> Option<Expr> {
    join_op(v, BinaryOperator::And)
}

fn join_op(v: Vec<Expr>, op: BinaryOperator) -> Option<Expr> {
    if v.len() == 1 {
        return v.into_iter().next();
    }
    let mut it = v.into_iter();
    let first = it.next()?;
    let wrap = |e: Expr, op: &BinaryOperator| -> Expr {
        // 같은 연산자(또는 OR 안의 OR, AND 안의 OR)가 괄호 없이 들어오면 다시 읽을 때 모양이 달라진다
        let bad = match &e {
            Expr::BinaryOp { op: o, .. } => matches!(o, BinaryOperator::Or | BinaryOperator::Xor) || (*o == BinaryOperator::And && *op == BinaryOperator::And),
            _ => false,
        };
        if bad {
            Expr::Nested(Box::new(e))
        } else {
            e
        }
    };
    let mut acc = match (&first, &op) {
        // 맨 앞은 왼쪽 결합 사슬의 일부라 같은 연산자면 그대로 둬도 된다
        (Expr::BinaryOp { op: o, .. }, _) if *o == op => first,
        _ => wrap(first, &op),
    };
    for e in it {
        acc = bin(acc, op.clone(), wrap(e, &op));
    }
    Some(acc)
}

/// AND 사슬을 낱개로(괄호로 묶인 AND 도 편다 — 의미는 같다)
fn conjuncts(e: Expr) -> Vec<Expr> {
    let mut out = vec![];
    fn go(e: Expr, out: &mut Vec<Expr>) {
        match e {
            Expr::BinaryOp { left, op: BinaryOperator::And, right } => {
                go(*left, out);
                go(*right, out);
            }
            Expr::Nested(inner) if matches!(*inner, Expr::BinaryOp { op: BinaryOperator::And, .. } | Expr::Nested(_)) => go(*inner, out),
            other => out.push(other),
        }
    }
    go(e, &mut out);
    out
}

fn peel(e: &Expr) -> &Expr {
    match e {
        Expr::Nested(i) => peel(i),
        _ => e,
    }
}

/// 열 참조(이름 부분들)
fn col_parts(e: &Expr) -> Option<&[Ident]> {
    match peel(e) {
        Expr::Identifier(i) => Some(std::slice::from_ref(i)),
        Expr::CompoundIdentifier(v) => Some(v.as_slice()),
        _ => None,
    }
}

fn last_name(n: &ObjectName) -> Option<&Ident> {
    n.0.last().and_then(ObjectNamePart::as_ident)
}

fn name_parts(n: &ObjectName) -> Vec<String> {
    n.0.iter().filter_map(|p| p.as_ident().map(|i| lc(&i.value))).collect()
}

fn fn_name(f: &Function) -> String {
    f.name.0.last().and_then(ObjectNamePart::as_ident).map(|i| lc(&i.value)).unwrap_or_default()
}

const AGGS: &[&str] = &[
    "count", "sum", "avg", "min", "max", "group_concat", "string_agg", "array_agg", "listagg", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp", "bit_and", "bit_or",
    "bit_xor", "bool_and", "bool_or", "every", "json_agg", "jsonb_agg", "json_arrayagg", "json_objectagg", "median", "percentile_cont", "percentile_disc", "mode", "any_value", "count_big",
    "checksum_agg", "grouping", "xmlagg", "collect", "approx_count_distinct",
];

/// 같은 입력이면 같은 값(중복 조건을 지워도 되는 함수)
const PURE_FNS: &[&str] = &[
    "upper", "lower", "trim", "ltrim", "rtrim", "substr", "substring", "coalesce", "nvl", "ifnull", "isnull", "concat", "length", "char_length", "len", "abs", "round", "floor", "ceil",
    "ceiling", "date", "year", "month", "day", "to_char", "to_date", "to_number", "replace", "nullif", "left", "right", "lpad", "rpad", "date_format", "str_to_date", "decode",
];

/// 이름은 같아도 열이 아닌 것(별칭을 붙이면 안 된다)
const PSEUDO: &[&str] = &[
    "sysdate", "systimestamp", "current_date", "current_time", "current_timestamp", "localtime", "localtimestamp", "user", "current_user", "session_user", "rownum", "level", "rowid", "null",
    "true", "false", "default",
];

#[derive(Debug, Clone)]
struct CRef {
    parts: Vec<Ident>,
    depth: usize,
    /// Oracle (+) 안
    marked: bool,
}

/// 식 하나를 훑어 열 참조·서브쿼리·집계·함수를 모은다
#[derive(Default)]
struct Scan {
    depth: usize,
    outer: usize,
    refs: Vec<CRef>,
    subq: bool,
    agg: bool,
    window: bool,
    impure: bool,
    outer_join: bool,
}

impl Visitor for Scan {
    type Break = ();
    fn pre_visit_query(&mut self, _q: &Query) -> ControlFlow<()> {
        self.depth += 1;
        self.subq = true;
        ControlFlow::Continue(())
    }
    fn post_visit_query(&mut self, _q: &Query) -> ControlFlow<()> {
        self.depth -= 1;
        ControlFlow::Continue(())
    }
    fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
        match e {
            Expr::Identifier(i) => self.refs.push(CRef { parts: vec![i.clone()], depth: self.depth, marked: self.outer > 0 }),
            Expr::CompoundIdentifier(v) => self.refs.push(CRef { parts: v.clone(), depth: self.depth, marked: self.outer > 0 }),
            Expr::OuterJoin(_) => {
                self.outer += 1;
                self.outer_join = true;
            }
            Expr::Function(f) if self.depth == 0 => {
                let n = fn_name(f);
                if f.over.is_some() {
                    self.window = true;
                } else if AGGS.contains(&n.as_str()) {
                    self.agg = true;
                }
                if !PURE_FNS.contains(&n.as_str()) {
                    self.impure = true;
                }
            }
            _ => {}
        }
        ControlFlow::Continue(())
    }
    fn post_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
        if let Expr::OuterJoin(_) = e {
            self.outer -= 1;
        }
        ControlFlow::Continue(())
    }
}

fn scan<V: Visit>(v: &V) -> Scan {
    let mut s = Scan::default();
    let _ = v.visit(&mut s);
    s
}

/// 깊이(서브쿼리 몇 겹 안인지)를 세며 모든 식에 f 를 부른다 — 식을 바꿔 끼워도 된다(바꾼 식의 안쪽도 이어서 걷는다)
struct ExprMut<F: FnMut(&mut Expr, usize)> {
    depth: usize,
    f: F,
}

impl<F: FnMut(&mut Expr, usize)> VisitorMut for ExprMut<F> {
    type Break = ();
    fn pre_visit_query(&mut self, _q: &mut Query) -> ControlFlow<()> {
        self.depth += 1;
        ControlFlow::Continue(())
    }
    fn post_visit_query(&mut self, _q: &mut Query) -> ControlFlow<()> {
        self.depth -= 1;
        ControlFlow::Continue(())
    }
    fn pre_visit_expr(&mut self, e: &mut Expr) -> ControlFlow<()> {
        (self.f)(e, self.depth);
        ControlFlow::Continue(())
    }
}

fn each_expr_mut<V: VisitMut, F: FnMut(&mut Expr, usize)>(v: &mut V, f: F) {
    let mut w = ExprMut { depth: 0, f };
    let _ = v.visit(&mut w);
}

/// 서브쿼리 안쪽(깊이 1 이상)에서 이 이름을 별칭·표 이름으로 드러내는 표가 있는지 — 이름 바꾸기 전에 가림을 막는다
struct Exposes<'a> {
    depth: usize,
    name: &'a str,
    hit: bool,
}

impl Visitor for Exposes<'_> {
    type Break = ();
    fn pre_visit_query(&mut self, _q: &Query) -> ControlFlow<()> {
        self.depth += 1;
        ControlFlow::Continue(())
    }
    fn post_visit_query(&mut self, _q: &Query) -> ControlFlow<()> {
        self.depth -= 1;
        ControlFlow::Continue(())
    }
    fn pre_visit_table_factor(&mut self, t: &TableFactor) -> ControlFlow<()> {
        if self.depth > 0 && factor_qual(t).as_deref() == Some(self.name) {
            self.hit = true;
        }
        ControlFlow::Continue(())
    }
}

fn nested_exposes<V: Visit>(v: &V, name: &str) -> bool {
    let mut e = Exposes { depth: 0, name, hit: false };
    let _ = v.visit(&mut e);
    e.hit
}

/// 표 자리가 드러내는 한정 이름(소문자)
fn factor_qual(t: &TableFactor) -> Option<String> {
    match t {
        TableFactor::Table { name, alias, .. } => alias.as_ref().map(|a| lc(&a.name.value)).or_else(|| last_name(name).map(|i| lc(&i.value))),
        TableFactor::Derived { alias, .. } | TableFactor::NestedJoin { alias, .. } | TableFactor::Function { alias, .. } | TableFactor::TableFunction { alias, .. } | TableFactor::UNNEST { alias, .. } => {
            alias.as_ref().map(|a| lc(&a.name.value))
        }
        _ => None,
    }
}

fn is_cmp(op: &BinaryOperator) -> bool {
    matches!(op, BinaryOperator::Eq | BinaryOperator::NotEq | BinaryOperator::Lt | BinaryOperator::Gt | BinaryOperator::LtEq | BinaryOperator::GtEq)
}

fn neg_cmp(op: &BinaryOperator) -> Option<BinaryOperator> {
    Some(match op {
        BinaryOperator::Eq => BinaryOperator::NotEq,
        BinaryOperator::NotEq => BinaryOperator::Eq,
        BinaryOperator::Lt => BinaryOperator::GtEq,
        BinaryOperator::GtEq => BinaryOperator::Lt,
        BinaryOperator::Gt => BinaryOperator::LtEq,
        BinaryOperator::LtEq => BinaryOperator::Gt,
        _ => return None,
    })
}

fn is_lit(e: &Expr) -> bool {
    matches!(e, Expr::Value(v) if !matches!(v.value, Value::Null))
}

/// 늘 참인 조건(1=1, 'a'='a', TRUE)
fn is_true(e: &Expr) -> bool {
    match e {
        Expr::Nested(i) => is_true(i),
        Expr::Value(v) => matches!(v.value, Value::Boolean(true)),
        Expr::BinaryOp { left, op: BinaryOperator::Eq, right } => match (peel(left), peel(right)) {
            (Expr::Value(a), Expr::Value(b)) => match (&a.value, &b.value) {
                (Value::Number(x, _), Value::Number(y, _)) => x == y,
                (Value::SingleQuotedString(x), Value::SingleQuotedString(y)) => x == y,
                _ => false,
            },
            _ => false,
        },
        _ => false,
    }
}

/// 괄호를 벗겨도 어디서나 같은 덩어리
fn is_atom(e: &Expr) -> bool {
    match e {
        Expr::Identifier(_) | Expr::CompoundIdentifier(_) | Expr::Value(_) | Expr::Function(_) | Expr::Nested(_) | Expr::Subquery(_) | Expr::Exists { .. } => true,
        Expr::Cast { kind, .. } => matches!(kind, CastKind::Cast | CastKind::TryCast | CastKind::SafeCast),
        _ => false,
    }
}

/// AND·OR 의 한 칸에 괄호 없이 두어도 되는 조건(비교·IS·IN·LIKE·BETWEEN·NOT)
fn is_predicate(e: &Expr) -> bool {
    match e {
        Expr::BinaryOp { op, .. } => is_cmp(op),
        Expr::IsNull(_) | Expr::IsNotNull(_) | Expr::IsTrue(_) | Expr::IsFalse(_) | Expr::IsNotTrue(_) | Expr::IsNotFalse(_) => true,
        Expr::In { .. } | Expr::Between { .. } | Expr::Like { .. } | Expr::ILike { .. } => true,
        Expr::UnaryOp { op: UnaryOperator::Not, .. } => true,
        e => is_atom(e),
    }
}

/// 중복을 지워도 되는 식(서브쿼리·비결정 함수 없음)
fn is_pure(e: &Expr) -> bool {
    let s = scan(e);
    !s.subq && !s.impure && !s.window
}

// ───────────────────────── 다듬기 일꾼 ─────────────────────────

/// 한 문장 범위의 표 정보
#[derive(Clone, Debug)]
struct Tab {
    /// 한정 이름(소문자) — 별칭이 있으면 별칭, 없으면 표 이름
    qual: String,
    /// 한정할 때 찍을 이름
    ident: Ident,
    name: Option<ObjectName>,
    aliased: bool,
    /// 열(소문자) — None: 모름
    cols: Option<Vec<String>>,
    uniq: Vec<Vec<String>>,
}

impl Tab {
    fn has(&self, c: &str) -> Option<bool> {
        self.cols.as_ref().map(|v| v.iter().any(|x| x == c))
    }
    /// 이 표를 가리키는 한정(q.col 의 q 부분)인지
    fn matches(&self, q: &[Ident]) -> bool {
        let Some(last) = q.last() else { return false };
        if lc(&last.value) != self.qual {
            return false;
        }
        if q.len() == 1 {
            return true;
        }
        if self.aliased {
            return false;
        }
        // schema.table.col — 앞 부분이 표 이름 앞 부분과 맞아야
        let Some(n) = &self.name else { return false };
        let parts = name_parts(n);
        let want: Vec<String> = q.iter().map(|i| lc(&i.value)).collect();
        parts.len() >= want.len() && parts[parts.len() - want.len()..] == want[..]
    }
}

struct Cx<'a> {
    d: Box<dyn Dialect>,
    eng: Eng,
    meta: Option<&'a CleanMeta>,
    off: HashSet<&'a str>,
    pm: PosMap,
    changes: Vec<Change>,
    notes: Vec<String>,
    ids: HashMap<String, u32>,
    /// 이 문장에서 쓰인 이름(소문자) — 새 별칭·CTE 이름이 겹치지 않게
    used: HashSet<String>,
    /// 지금 보이는 CTE 이름들(바깥부터)
    ctes: Vec<Vec<String>>,
}

impl<'a> Cx<'a> {
    fn new(eng: Eng, meta: Option<&'a CleanMeta>, off: &'a [String], sql: &str, st: &Statement) -> Self {
        struct Names(HashSet<String>);
        impl Visitor for Names {
            type Break = ();
            fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
                match e {
                    Expr::Identifier(i) => {
                        self.0.insert(lc(&i.value));
                    }
                    Expr::CompoundIdentifier(v) => {
                        for i in v {
                            self.0.insert(lc(&i.value));
                        }
                    }
                    _ => {}
                }
                ControlFlow::Continue(())
            }
            fn pre_visit_table_factor(&mut self, t: &TableFactor) -> ControlFlow<()> {
                if let Some(q) = factor_qual(t) {
                    self.0.insert(q);
                }
                if let TableFactor::Table { name, .. } = t {
                    for p in name_parts(name) {
                        self.0.insert(p);
                    }
                }
                ControlFlow::Continue(())
            }
            fn pre_visit_query(&mut self, q: &Query) -> ControlFlow<()> {
                if let Some(w) = &q.with {
                    for c in &w.cte_tables {
                        self.0.insert(lc(&c.alias.name.value));
                    }
                }
                ControlFlow::Continue(())
            }
        }
        let mut n = Names(HashSet::new());
        let _ = st.visit(&mut n);
        Cx {
            d: eng.dialect(),
            eng,
            meta,
            off: off.iter().map(String::as_str).collect(),
            pm: PosMap::new(sql),
            changes: vec![],
            notes: vec![],
            ids: HashMap::new(),
            used: n.0,
            ctes: vec![],
        }
    }

    /// 바꿀 거리 하나를 목록에 올리고, 켜져 있으면 true
    fn propose(&mut self, kind: &'static str, safe: bool, title: String, detail: String, span: Span) -> bool {
        let pos = if span == Span::empty() { None } else { self.pm.span(span) };
        let base = match pos {
            Some([a, _]) => format!("{kind}:{a}"),
            None => format!("{kind}#"),
        };
        let n = self.ids.entry(base.clone()).or_insert(0);
        *n += 1;
        let id = if *n == 1 && pos.is_some() { base } else { format!("{base}{n}") };
        let on = !self.off.contains(id.as_str());
        self.changes.push(Change { id, kind, safety: if safe { "safe" } else { "check" }, title, detail, pos, on });
        on
    }

    fn fresh(&mut self, base: &str) -> Ident {
        let base = if base.is_empty() { "t" } else { base };
        let mut n = 1;
        loop {
            let cand = if n == 1 { base.to_string() } else { format!("{base}{n}") };
            if !self.used.contains(&cand) && !ALL_KEYWORDS.contains(&cand.to_uppercase().as_str()) {
                self.used.insert(cand.clone());
                return Ident::new(cand);
            }
            n += 1;
        }
    }

    fn parse_query(&self, sql: &str) -> Option<Box<Query>> {
        let mut p = Parser::new(&*self.d).try_with_sql(sql).ok()?;
        let q = p.parse_query().ok()?;
        Some(q)
    }

    fn parse_expr(&self, sql: &str) -> Option<Expr> {
        Parser::new(&*self.d).try_with_sql(sql).ok()?.parse_expr().ok()
    }

    fn alias(&self, name: Ident) -> TableAlias {
        TableAlias { explicit: self.eng.alias_as(), name, columns: vec![], at: None }
    }

    fn is_cte(&self, n: &ObjectName) -> bool {
        n.0.len() == 1 && last_name(n).is_some_and(|i| self.ctes.iter().any(|s| s.contains(&lc(&i.value))))
    }

    fn meta_of(&self, n: &ObjectName) -> Option<&'a MetaTable> {
        if self.is_cte(n) {
            return None;
        }
        let parts = name_parts(n);
        let name = parts.last()?;
        let schema = if parts.len() >= 2 { Some(&parts[parts.len() - 2]) } else { None };
        let m = self.meta?;
        let mut hit = m.tables.iter().filter(|t| lc(&t.name) == *name);
        let all: Vec<&MetaTable> = hit.by_ref().collect();
        match schema {
            Some(s) => all.iter().copied().find(|t| t.schema.as_deref().map(lc).as_deref() == Some(s.as_str())).or_else(|| if all.len() == 1 { Some(all[0]) } else { None }),
            None => {
                if all.len() == 1 {
                    Some(all[0])
                } else {
                    None
                }
            }
        }
    }

    fn tab_of(&self, t: &TableFactor) -> Option<Tab> {
        let qual = factor_qual(t)?;
        Some(match t {
            TableFactor::Table { name, alias, .. } => {
                let m = self.meta_of(name);
                let ident = alias.as_ref().map(|a| a.name.clone()).or_else(|| last_name(name).cloned())?;
                Tab {
                    qual,
                    ident,
                    name: Some(name.clone()),
                    aliased: alias.is_some(),
                    cols: m.filter(|m| !m.cols.is_empty()).map(|m| m.cols.iter().map(|c| lc(&c.name)).collect()),
                    uniq: m.map(|m| {
                        let mut u: Vec<Vec<String>> = m.unique.iter().map(|k| k.iter().map(|c| lc(c)).collect()).collect();
                        let pk: Vec<String> = m.cols.iter().filter(|c| c.pk).map(|c| lc(&c.name)).collect();
                        if !pk.is_empty() {
                            u.push(pk);
                        }
                        u
                    }).unwrap_or_default(),
                }
            }
            TableFactor::Derived { subquery, alias: Some(a), .. } => Tab {
                qual,
                ident: a.name.clone(),
                name: None,
                aliased: true,
                cols: if a.columns.is_empty() { output_names(subquery) } else { Some(a.columns.iter().map(|c| lc(&c.name.value)).collect()) },
                uniq: vec![],
            },
            other => Tab { qual, ident: Ident::new(factor_qual(other)?), name: None, aliased: true, cols: None, uniq: vec![] },
        })
    }

    /// 이 SELECT 의 FROM 이 드러내는 표들(나온 순서)
    fn scope_tabs(&self, s: &Select) -> Vec<Tab> {
        let mut out = vec![];
        fn go(cx: &Cx, t: &TableFactor, out: &mut Vec<Tab>) {
            if let TableFactor::NestedJoin { table_with_joins, alias: None } = t {
                go(cx, &table_with_joins.relation, out);
                for j in &table_with_joins.joins {
                    go(cx, &j.relation, out);
                }
                return;
            }
            if let Some(x) = cx.tab_of(t) {
                out.push(x);
            }
        }
        for twj in &s.from {
            go(self, &twj.relation, &mut out);
            for j in &twj.joins {
                go(self, &j.relation, &mut out);
            }
        }
        out
    }

    // ───────────── 문장 ─────────────

    fn statement(&mut self, st: &mut Statement) -> Result<(), String> {
        match st {
            Statement::Query(q) => {
                self.query(q);
                self.repeated_to_cte(q);
            }
            Statement::Insert(ins) => {
                if let Some(q) = ins.source.as_mut() {
                    self.query(q);
                }
            }
            Statement::Update(u) => {
                if let Some(e) = u.selection.as_mut() {
                    self.children(e);
                }
                self.clause(&mut u.selection, "WHERE", false);
            }
            Statement::Delete(d) => {
                if let Some(e) = d.selection.as_mut() {
                    self.children(e);
                }
                self.clause(&mut d.selection, "WHERE", false);
            }
            _ => return Err("SELECT · INSERT … SELECT · UPDATE · DELETE 문장만 다듬습니다".into()),
        }
        Ok(())
    }

    /// 이 노드 바로 아래의 서브쿼리들(더 깊은 것은 그 서브쿼리가 스스로) 다듬기
    fn children<V: VisitMut>(&mut self, v: &mut V) {
        struct W<'c, 'a> {
            cx: &'c mut Cx<'a>,
            depth: usize,
        }
        impl VisitorMut for W<'_, '_> {
            type Break = ();
            fn pre_visit_query(&mut self, q: &mut Query) -> ControlFlow<()> {
                if self.depth == 0 {
                    self.cx.query(q);
                }
                self.depth += 1;
                ControlFlow::Continue(())
            }
            fn post_visit_query(&mut self, _q: &mut Query) -> ControlFlow<()> {
                self.depth -= 1;
                ControlFlow::Continue(())
            }
        }
        let mut w = W { cx: self, depth: 0 };
        let _ = v.visit(&mut w);
    }

    fn query(&mut self, q: &mut Query) {
        let names: Vec<String> = q.with.as_ref().map(|w| w.cte_tables.iter().map(|c| lc(&c.alias.name.value)).collect()).unwrap_or_default();
        self.ctes.push(names);
        if let Some(w) = q.with.as_mut() {
            for c in w.cte_tables.iter_mut() {
                self.query(&mut c.query);
            }
        }
        if let Some(ob) = q.order_by.as_mut() {
            self.children(ob);
        }
        let Query { body, order_by, .. } = q;
        match body.as_mut() {
            SetExpr::Select(s) => self.select(s, order_by.as_mut()),
            other => self.set_expr(other),
        }
        self.ctes.pop();
        self.unused_cte(q);
    }

    fn set_expr(&mut self, e: &mut SetExpr) {
        match e {
            SetExpr::Select(s) => self.select(s, None),
            SetExpr::Query(q) => self.query(q),
            SetExpr::SetOperation { left, right, .. } => {
                self.set_expr(left);
                self.set_expr(right);
            }
            _ => {}
        }
    }

    fn select(&mut self, s: &mut Select, mut ob: Option<&mut OrderBy>) {
        self.children(s);
        self.flatten_derived(s, ob.as_deref_mut());
        self.qualify(s);
        self.rejoin(s);
        self.short_alias(s, ob.as_deref_mut());
        self.clause(&mut s.selection, "WHERE", false);
        for twj in s.from.iter_mut() {
            for j in twj.joins.iter_mut() {
                if let Some(c) = on_of(&mut j.join_operator) {
                    let mut tmp = Some(std::mem::replace(c, Expr::Value(Value::Null.with_empty_span())));
                    self.clause(&mut tmp, "ON", true);
                    if let Some(e) = tmp {
                        *c = e;
                    }
                }
            }
        }
        self.clause(&mut s.having, "HAVING", false);
        self.not_in(s);
        self.having_to_where(s);
        self.distinct_group(s);
        self.scalar_to_join(s);
        self.drop_left_join(s, ob.as_deref());
    }

    // ───────────── 조건 다듬기(safe) ─────────────

    fn clause(&mut self, e: &mut Option<Expr>, label: &str, is_on: bool) {
        let Some(orig) = e.as_ref() else { return };
        let span = orig.span();
        let mut c = Counts::default();
        let dry = simp(orig.clone(), Ctx::Root, Kinds::all(), &mut c);
        if is_true(&dry) && !is_on {
            c.taut += 1;
        }
        let mut k = Kinds::default();
        if c.taut > 0 {
            let t = if is_true(&dry) && !is_on { format!("{label} 1=1 지우기") } else { format!("{label} 의 1=1·TRUE 조건 지우기") };
            k.taut = self.propose("trueCond", true, t, format!("늘 참인 조건 {}개", c.taut), span);
        }
        if c.parens > 0 {
            k.parens = self.propose("parens", true, format!("{label} 의 불필요한 괄호 벗기기"), format!("{}곳", c.parens), span);
        }
        if c.dup > 0 {
            k.dup = self.propose("dupCond", true, format!("{label} 의 중복 조건 지우기"), format!("같은 조건 {}개", c.dup), span);
        }
        if c.inone > 0 {
            k.inone = self.propose("inOne", true, format!("{label} 의 IN (값 하나) → ="), format!("{}곳", c.inone), span);
        }
        if c.not > 0 {
            k.not = self.propose("notCmp", true, format!("{label} 의 NOT (a = b) → a <> b"), format!("{}곳", c.not), span);
        }
        if c.orin > 0 {
            k.orin = self.propose("orToIn", true, format!("{label} 의 같은 열 OR 사슬 → IN (…)"), format!("{}묶음", c.orin), span);
        }
        if !(k.taut || k.parens || k.dup || k.inone || k.not || k.orin) {
            return;
        }
        let mut c2 = Counts::default();
        let out = simp(orig.clone(), Ctx::Root, k, &mut c2);
        if k.taut && is_true(&out) && !is_on {
            *e = None;
        } else {
            *e = Some(out);
        }
    }

    // ───────────── 한정 안 된 열에 별칭(safe, 메타 필요) ─────────────

    fn qualify(&mut self, s: &mut Select) {
        if self.meta.is_none() {
            return;
        }
        let tabs = self.scope_tabs(s);
        if tabs.len() < 2 || tabs.iter().any(|t| t.cols.is_none()) {
            return;
        }
        let aliases = proj_aliases(s);
        let mut plan: HashMap<String, Ident> = HashMap::new();
        let mut miss = HashSet::new();
        let mut look = |e: &Expr, plan: &mut HashMap<String, Ident>, alias_ok: bool| {
            let sc = scan(e);
            for r in sc.refs.iter().filter(|r| r.depth == 0 && r.parts.len() == 1) {
                let n = lc(&r.parts[0].value);
                if PSEUDO.contains(&n.as_str()) || (!alias_ok && aliases.contains(&n)) {
                    continue;
                }
                let hits: Vec<&Tab> = tabs.iter().filter(|t| t.has(&n) == Some(true)).collect();
                if hits.len() == 1 {
                    plan.insert(n, hits[0].ident.clone());
                } else {
                    miss.insert(n);
                }
            }
        };
        for it in &s.projection {
            if let SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } = it {
                look(e, &mut plan, true);
            }
        }
        if let Some(e) = &s.selection {
            look(e, &mut plan, true);
        }
        for twj in &s.from {
            for j in &twj.joins {
                if let Some(e) = on_ref(&j.join_operator) {
                    look(e, &mut plan, true);
                }
            }
        }
        if let GroupByExpr::Expressions(v, _) = &s.group_by {
            for e in v {
                look(e, &mut plan, false);
            }
        }
        if let Some(e) = &s.having {
            look(e, &mut plan, false);
        }
        for m in &miss {
            plan.remove(m);
        }
        if plan.is_empty() {
            return;
        }
        let mut names: Vec<String> = plan.iter().map(|(k, v)| format!("{k} → {}.{k}", v.value)).collect();
        names.sort();
        if !self.propose("qualify", true, format!("한정 안 된 열에 표 별칭 붙이기 ({}개)", plan.len()), names.join(", "), s.span()) {
            return;
        }
        let fix = |e: &mut Expr, d: usize, skip_alias: bool| {
            if d != 0 {
                return;
            }
            if let Expr::Identifier(i) = e {
                let n = lc(&i.value);
                if skip_alias && aliases.contains(&n) {
                    return;
                }
                if let Some(q) = plan.get(&n) {
                    *e = Expr::CompoundIdentifier(vec![q.clone(), i.clone()]);
                }
            }
        };
        for it in s.projection.iter_mut() {
            if let SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } = it {
                each_expr_mut(e, |e, d| fix(e, d, false));
            }
        }
        if let Some(e) = s.selection.as_mut() {
            each_expr_mut(e, |e, d| fix(e, d, false));
        }
        for twj in s.from.iter_mut() {
            for j in twj.joins.iter_mut() {
                if let Some(e) = on_of(&mut j.join_operator) {
                    each_expr_mut(e, |e, d| fix(e, d, false));
                }
            }
        }
        if let GroupByExpr::Expressions(v, _) = &mut s.group_by {
            for e in v.iter_mut() {
                each_expr_mut(e, |e, d| fix(e, d, true));
            }
        }
        if let Some(e) = s.having.as_mut() {
            each_expr_mut(e, |e, d| fix(e, d, true));
        }
    }

    // ───────────── 쉼표 조인 → INNER JOIN, Oracle (+) → LEFT JOIN ─────────────

    fn rejoin(&mut self, s: &mut Select) {
        if s.from.len() < 2 {
            return;
        }
        let plus = s.selection.as_ref().is_some_and(|e| scan(e).outer_join);
        // (+) 가 WHERE 밖에 있으면 손대지 않는다
        let elsewhere = s.projection.iter().any(|p| scan(p).outer_join) || s.from.iter().any(|t| scan(t).outer_join) || s.having.as_ref().is_some_and(|h| scan(h).outer_join);
        if elsewhere {
            return;
        }
        // 단위(쉼표로 나뉜 것)마다 표
        let mut units: Vec<Vec<Tab>> = vec![];
        for twj in &s.from {
            if !matches!(twj.relation, TableFactor::Table { .. } | TableFactor::Derived { lateral: false, .. }) {
                return;
            }
            for j in &twj.joins {
                let ok = match &j.join_operator {
                    JoinOperator::Join(c) | JoinOperator::Inner(c) | JoinOperator::Left(c) | JoinOperator::LeftOuter(c) => matches!(c, JoinConstraint::On(_)),
                    JoinOperator::CrossJoin(JoinConstraint::None) => true,
                    _ => false,
                };
                if !ok || !matches!(j.relation, TableFactor::Table { .. } | TableFactor::Derived { lateral: false, .. }) {
                    return;
                }
            }
            let mut v = vec![];
            for t in std::iter::once(&twj.relation).chain(twj.joins.iter().map(|j| &j.relation)) {
                match self.tab_of(t) {
                    Some(x) => v.push(x),
                    None => return,
                }
            }
            units.push(v);
        }
        // 한정 이름이 겹치면(같은 표를 별칭 없이 두 번) 손대지 않는다
        let mut seen = HashSet::new();
        for t in units.iter().flatten() {
            if !seen.insert(t.qual.clone()) {
                return;
            }
        }
        let find = |parts: &[Ident]| -> Option<(usize, usize)> {
            if parts.len() < 2 {
                return None;
            }
            let q = &parts[..parts.len() - 1];
            for (u, ts) in units.iter().enumerate() {
                for (k, t) in ts.iter().enumerate() {
                    if t.matches(q) {
                        return Some((u, k));
                    }
                }
            }
            None
        };
        struct Cj {
            e: Expr,
            units: BTreeSet<usize>,
            /// 단위 안의 조인 표(첫 표가 아닌 것)를 가리키는지
            inner_join_ref: BTreeSet<usize>,
            known: bool,
            subq: bool,
            marked: Option<usize>,
            simple: bool,
            col_eq: bool,
            has_or: bool,
        }
        let list = s.selection.clone().map(conjuncts).unwrap_or_default();
        let mut cjs = vec![];
        for e in list {
            let sc = scan(&e);
            let mut units_ref = BTreeSet::new();
            let mut deep = BTreeSet::new();
            let mut known = true;
            let mut marked: Option<usize> = None;
            let mut unmarked_units = BTreeSet::new();
            for r in sc.refs.iter().filter(|r| r.depth == 0) {
                match find(&r.parts) {
                    Some((u, k)) => {
                        units_ref.insert(u);
                        if k > 0 {
                            deep.insert(u);
                        }
                        if r.marked {
                            if marked.is_some_and(|m| m != u) {
                                return; // 두 표에 (+) — Oracle 도 거부
                            }
                            marked = Some(u);
                        } else {
                            unmarked_units.insert(u);
                        }
                    }
                    None => {
                        if !PSEUDO.contains(&lc(&r.parts[r.parts.len() - 1].value).as_str()) {
                            known = false;
                        }
                    }
                }
            }
            if let Some(m) = marked {
                // 같은 표의 열이 (+) 있는 것·없는 것이 섞이면 손대지 않는다
                if unmarked_units.contains(&m) || sc.subq || !known {
                    return;
                }
            }
            let has_or = {
                let mut f = false;
                let _ = e.visit(&mut OrFinder(&mut f));
                f
            };
            if marked.is_some() && has_or {
                return;
            }
            let unplus = |x: &Expr| -> Expr {
                match peel(x) {
                    Expr::OuterJoin(i) => peel(i).clone(),
                    o => o.clone(),
                }
            };
            let simple = match peel(&e) {
                Expr::BinaryOp { left, op, right } => {
                    let (l, r) = (unplus(left), unplus(right));
                    is_cmp(op) && (col_parts(&l).is_some() || is_lit(&l)) && (col_parts(&r).is_some() || is_lit(&r))
                }
                _ => false,
            };
            let col_eq = match peel(&e) {
                Expr::BinaryOp { left, op: BinaryOperator::Eq, right } => col_parts(left).is_some_and(|p| p.len() >= 2) && col_parts(right).is_some_and(|p| p.len() >= 2),
                _ => false,
            };
            cjs.push(Cj { e, units: units_ref, inner_join_ref: deep, known, subq: sc.subq, marked, simple, col_eq, has_or });
        }
        if plus != cjs.iter().any(|c| c.marked.is_some()) {
            return;
        }
        // 바깥 조인될(선택) 단위와 그 단위가 기대는 단위
        let n = units.len();
        let mut optional = vec![false; n];
        let mut deps: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n];
        for c in &cjs {
            if let Some(m) = c.marked {
                optional[m] = true;
                for &u in &c.units {
                    if u != m {
                        deps[m].insert(u);
                    }
                }
            }
        }
        for u in 0..n {
            if optional[u] && (units[u].len() > 1 || deps[u].is_empty()) {
                return;
            }
        }
        // 순서 정하기 — 선택 단위는 기대는 단위가 다 붙은 뒤에
        let mut order = vec![];
        let mut joined = vec![false; n];
        let mut left: Vec<usize> = (0..n).collect();
        while !left.is_empty() {
            let pick = left.iter().position(|&u| if optional[u] { deps[u].iter().all(|&d| joined[d]) && !order.is_empty() } else { true });
            let Some(i) = pick else { return };
            let u = left.remove(i);
            joined[u] = true;
            order.push(u);
        }
        let reordered = order.iter().enumerate().any(|(i, &u)| i != u);
        if reordered && s.projection.iter().any(|p| matches!(p, SelectItem::Wildcard(_))) {
            return; // SELECT * 의 열 순서가 바뀐다
        }
        // 조건 나누기
        let mut used = vec![false; cjs.len()];
        let mut on_of_unit: Vec<Vec<Expr>> = vec![vec![]; n];
        let mut in_set = vec![false; n];
        for (step, &u) in order.iter().enumerate() {
            in_set[u] = true;
            if step == 0 {
                continue;
            }
            for (i, c) in cjs.iter().enumerate() {
                if used[i] {
                    continue;
                }
                let fits = c.units.contains(&u) && c.units.iter().all(|&x| in_set[x]) && c.units.len() >= 2;
                if optional[u] {
                    if c.marked == Some(u) {
                        used[i] = true;
                        on_of_unit[u].push(strip_plus(c.e.clone()));
                    }
                } else if fits && c.marked.is_none() && c.col_eq && c.known && !c.subq && !c.has_or && !c.inner_join_ref.contains(&u) {
                    used[i] = true;
                    on_of_unit[u].push(c.e.clone());
                }
            }
        }
        // (+) 조건이 하나라도 남으면 손대지 않는다
        if cjs.iter().enumerate().any(|(i, c)| c.marked.is_some() && !used[i]) {
            return;
        }
        let moved = used.iter().filter(|&&x| x).count();
        let crosses = order.iter().skip(1).filter(|&&u| on_of_unit[u].is_empty()).count();
        let span = s.from.iter().fold(Span::empty(), |a, t| a.union(&t.span()));
        let on = if plus {
            let simple = !reordered && (0..n).all(|u| !optional[u] || deps[u].len() == 1) && cjs.iter().all(|c| c.marked.is_none() || c.simple);
            let outs = (0..n).filter(|&u| optional[u]).count();
            let mut why = format!("(+) 표 {outs}개를 LEFT JOIN 으로, 조건 {moved}개를 ON 으로 옮김");
            if reordered {
                why.push_str(" · 표 순서를 바꿈");
            }
            if !simple {
                why.push_str(" · 조건이 단순하지 않아 확인 권장");
            }
            self.propose("outerJoin", simple, "Oracle (+) 바깥 조인 → LEFT JOIN".into(), why, span)
        } else {
            let mut why = format!("표 {n}개, 등호 조건 {moved}개를 ON 으로 옮김");
            if crosses > 0 {
                why.push_str(&format!(" · 조건 없는 표 {crosses}개는 CROSS JOIN(데카르트 곱)"));
            }
            self.propose("commaJoin", true, "쉼표 조인 → INNER JOIN … ON".into(), why, span)
        };
        if !on {
            return;
        }
        let mut items: Vec<Option<TableWithJoins>> = std::mem::take(&mut s.from).into_iter().map(Some).collect();
        let first = items[order[0]].take().expect("단위");
        let mut out = first;
        for &u in order.iter().skip(1) {
            let t = items[u].take().expect("단위");
            let conds = std::mem::take(&mut on_of_unit[u]);
            let op = if optional[u] {
                JoinOperator::Left(JoinConstraint::On(and_all(conds).expect("조건")))
            } else if conds.is_empty() {
                JoinOperator::CrossJoin(JoinConstraint::None)
            } else {
                JoinOperator::Inner(JoinConstraint::On(and_all(conds).expect("조건")))
            };
            out.joins.push(Join { relation: t.relation, global: false, join_operator: op });
            out.joins.extend(t.joins);
        }
        s.from = vec![out];
        let rest: Vec<Expr> = cjs.into_iter().enumerate().filter(|(i, _)| !used[*i]).map(|(_, c)| c.e).collect();
        s.selection = and_all(rest);
    }

    // ───────────── 짧은 별칭(safe) ─────────────

    fn short_alias(&mut self, s: &mut Select, ob: Option<&mut OrderBy>) {
        let tabs = self.scope_tabs(s);
        if tabs.len() < 2 {
            return;
        }
        let mut seen = HashSet::new();
        for t in &tabs {
            if !seen.insert(t.qual.clone()) {
                return;
            }
        }
        let mut plan: Vec<(Tab, Ident)> = vec![];
        for t in tabs.iter().filter(|t| !t.aliased && t.name.is_some()) {
            if nested_exposes(&*s, &t.qual) {
                continue;
            }
            let base = short_name(&t.ident.value);
            if base.len() >= t.ident.value.len() {
                continue; // 이미 짧다
            }
            let a = self.fresh(&base);
            plan.push((t.clone(), a));
        }
        if plan.is_empty() {
            return;
        }
        let detail = plan.iter().map(|(t, a)| format!("{} → {}", t.ident.value, a.value)).collect::<Vec<_>>().join(", ");
        if !self.propose("alias", true, format!("짧은 별칭 붙이기 ({}개 표)", plan.len()), detail, s.span()) {
            for (_, a) in &plan {
                self.used.remove(&lc(&a.value));
            }
            return;
        }
        let eng_as = self.eng.alias_as();
        for (t, a) in &plan {
            // 표 자리에 별칭 달기
            for twj in s.from.iter_mut() {
                for f in std::iter::once(&mut twj.relation).chain(twj.joins.iter_mut().map(|j| &mut j.relation)) {
                    if let TableFactor::Table { name, alias, .. } = f {
                        if alias.is_none() && last_name(name).is_some_and(|i| lc(&i.value) == t.qual) {
                            *alias = Some(TableAlias { explicit: eng_as, name: a.clone(), columns: vec![], at: None });
                        }
                    }
                }
            }
            rename_qual(s, t, a);
        }
        if let Some(o) = ob {
            for (t, a) in &plan {
                each_expr_mut(o, |e, _| rename_ref(e, t, a));
            }
        }
    }

    // ───────────── NOT IN (서브쿼리) → NOT EXISTS (check) ─────────────

    fn not_in(&mut self, s: &mut Select) {
        let Some(sel) = s.selection.as_mut() else { return };
        let tabs = self.scope_tabs_from(&s.from);
        let mut todo: Vec<(Span, Expr)> = vec![];
        {
            let mut found = vec![];
            let _ = Visit::visit(&*sel, &mut NotInFinder { depth: 0, out: &mut found });
            for (span, e) in found {
                if let Some(rep) = self.not_in_rewrite(&e, &tabs) {
                    todo.push((span, rep));
                }
            }
        }
        if todo.is_empty() {
            return;
        }
        let mut applied: Vec<(Span, Expr)> = vec![];
        for (span, rep) in todo {
            if self.propose("notInExists", false, "NOT IN (서브쿼리) → NOT EXISTS".into(), "서브쿼리 열에 NULL 이 있으면 NOT IN 은 빈 결과지만 NOT EXISTS 는 행을 돌려줍니다 — 결과를 확인하세요".into(), span) {
                applied.push((span, rep));
            }
        }
        each_expr_mut(sel, |e, d| {
            if d != 0 {
                return;
            }
            if let Expr::In { negated: true, target: InTarget::Subquery(_), .. } = e {
                let sp = e.span();
                if let Some((_, rep)) = applied.iter().find(|(x, _)| *x == sp) {
                    *e = rep.clone();
                }
            }
        });
    }

    fn scope_tabs_from(&self, from: &[TableWithJoins]) -> Vec<Tab> {
        let mut out = vec![];
        for twj in from {
            for t in std::iter::once(&twj.relation).chain(twj.joins.iter().map(|j| &j.relation)) {
                if let Some(x) = self.tab_of(t) {
                    out.push(x);
                }
            }
        }
        out
    }

    fn not_in_rewrite(&self, e: &Expr, outer: &[Tab]) -> Option<Expr> {
        let Expr::In { expr, target: InTarget::Subquery(q), negated: true, .. } = e else { return None };
        if matches!(peel(expr), Expr::Tuple(_)) {
            return None;
        }
        if q.with.is_some() || q.order_by.is_some() || q.limit_clause.is_some() || q.fetch.is_some() {
            return None;
        }
        let SetExpr::Select(inner) = q.body.as_ref() else { return None };
        if inner.having.is_some() || inner.top.is_some() || !matches!(&inner.group_by, GroupByExpr::Expressions(v, m) if v.is_empty() && m.is_empty()) || inner.projection.len() != 1 || inner.into.is_some() {
            return None;
        }
        let y = match &inner.projection[0] {
            SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => e.clone(),
            _ => return None,
        };
        let ys = scan(&y);
        if ys.agg || ys.window || ys.subq {
            return None;
        }
        // 바깥 열 x — 서브쿼리 안의 표에 잡히지 않게 한정한다
        let inner_tabs = self.scope_tabs_from(&inner.from);
        let xs = scan(expr.as_ref());
        if xs.subq {
            return None;
        }
        let mut x = expr.as_ref().clone();
        for r in &xs.refs {
            if r.parts.len() == 1 {
                if outer.len() != 1 {
                    return None;
                }
            } else {
                let q = &r.parts[..r.parts.len() - 1];
                if inner_tabs.iter().any(|t| t.matches(q)) {
                    return None;
                }
            }
        }
        if xs.refs.iter().any(|r| r.parts.len() == 1) {
            let o = &outer[0];
            if inner_tabs.iter().any(|t| t.qual == o.qual) {
                return None;
            }
            let q = o.ident.clone();
            each_expr_mut(&mut x, |e, d| {
                if d == 0 {
                    if let Expr::Identifier(i) = e {
                        if !PSEUDO.contains(&lc(&i.value).as_str()) {
                            *e = Expr::CompoundIdentifier(vec![q.clone(), i.clone()]);
                        }
                    }
                }
            });
        }
        let mut nq = q.as_ref().clone();
        let SetExpr::Select(ns) = nq.body.as_mut() else { return None };
        ns.projection = vec![SelectItem::UnnamedExpr(num("1"))];
        ns.distinct = None;
        let cond = bin(y, BinaryOperator::Eq, x);
        let mut parts = ns.selection.take().map(conjuncts).unwrap_or_default();
        parts.push(cond);
        ns.selection = and_all(parts);
        Some(Expr::Exists { subquery: Box::new(nq), negated: true })
    }

    // ───────────── HAVING 의 비집계 조건 → WHERE (check) ─────────────

    fn having_to_where(&mut self, s: &mut Select) {
        let Some(h) = s.having.clone() else { return };
        let GroupByExpr::Expressions(g, mods) = &s.group_by else { return };
        if g.is_empty() || !mods.is_empty() || g.iter().any(|e| matches!(e, Expr::Rollup(_) | Expr::Cube(_) | Expr::GroupingSets(_))) {
            return;
        }
        let aliases = proj_alias_map(s);
        let parts = conjuncts(h);
        let mut keep = vec![];
        let mut moved = vec![];
        for p in parts {
            let sc = scan(&p);
            let ok = !sc.agg && !sc.window && !sc.subq && !sc.refs.is_empty() && sc.refs.iter().all(|r| {
                let e = if r.parts.len() == 1 { Expr::Identifier(r.parts[0].clone()) } else { Expr::CompoundIdentifier(r.parts.clone()) };
                let alias_clash = r.parts.len() == 1 && aliases.get(&lc(&r.parts[0].value)).is_some_and(|x| *x != e);
                !alias_clash && g.iter().any(|ge| *peel(ge) == e)
            });
            if ok {
                moved.push(p);
            } else {
                keep.push(p);
            }
        }
        if moved.is_empty() {
            return;
        }
        let span = s.having.as_ref().map(|h| h.span()).unwrap_or(Span::empty());
        if !self.propose("havingToWhere", false, format!("HAVING 의 비집계 조건 {}개 → WHERE", moved.len()), "묶기 전에 걸러 같은 결과를 더 적은 행으로 — GROUP BY 열만 보는 조건이라 결과는 같아야 합니다".into(), span) {
            return;
        }
        let mut w = s.selection.take().map(conjuncts).unwrap_or_default();
        w.extend(moved);
        s.selection = and_all(w);
        s.having = and_all(keep);
    }

    // ───────────── GROUP BY 아래 DISTINCT(safe) ─────────────

    fn distinct_group(&mut self, s: &mut Select) {
        if !matches!(s.distinct, Some(Distinct::Distinct)) {
            return;
        }
        let GroupByExpr::Expressions(g, mods) = &s.group_by else { return };
        if g.is_empty() || !mods.is_empty() {
            return;
        }
        if s.projection.iter().any(|p| matches!(p, SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(..))) {
            return;
        }
        let aliases = proj_aliases(s);
        let exprs: Vec<&Expr> = s
            .projection
            .iter()
            .filter_map(|p| match p {
                SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => Some(e),
                _ => None,
            })
            .collect();
        let covered = g.iter().all(|ge| match peel(ge) {
            Expr::Value(v) => matches!(&v.value, Value::Number(n, _) if n.parse::<usize>().is_ok_and(|k| k >= 1 && k <= s.projection.len())),
            Expr::Identifier(i) if aliases.contains(&lc(&i.value)) => true,
            e => exprs.iter().any(|x| peel(x) == e),
        });
        if !covered {
            return;
        }
        let span = s.select_token.0.span;
        if self.propose("distinctGroup", true, "GROUP BY 아래 군더더기 DISTINCT 지우기".into(), "묶음 열이 모두 결과에 있어 행이 이미 서로 다릅니다".into(), span) {
            s.distinct = None;
        }
    }

    // ───────────── 상관 스칼라 서브쿼리 → LEFT JOIN (… GROUP BY) (check) ─────────────

    fn scalar_to_join(&mut self, s: &mut Select) {
        if !matches!(&s.group_by, GroupByExpr::Expressions(v, m) if v.is_empty() && m.is_empty()) || s.having.is_some() {
            return;
        }
        if s.projection.iter().any(|p| matches!(p, SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } if scan(e).agg)) {
            return;
        }
        let outer = self.scope_tabs(s);
        for idx in 0..s.projection.len() {
            let (e, alias) = match &s.projection[idx] {
                SelectItem::UnnamedExpr(e) => (e.clone(), None),
                SelectItem::ExprWithAlias { expr, alias } => (expr.clone(), Some(alias.clone())),
                _ => continue,
            };
            let Expr::Subquery(q) = peel(&e) else { continue };
            let Some(plan) = self.scalar_plan(q, &outer) else { continue };
            // 바깥 표들이 같은 FROM 항목 안에 있어야 ON 이 그것을 본다
            let mut item = None;
            for (i, twj) in s.from.iter().enumerate() {
                let here: Vec<Tab> = self.scope_tabs_from(std::slice::from_ref(twj));
                if plan.outer_quals.iter().all(|q| here.iter().any(|t| t.qual == *q)) {
                    item = Some(i);
                }
            }
            let Some(item) = item else { continue };
            let span = e.span();
            let agg = plan.agg_name.to_uppercase();
            if !self.propose("scalarToJoin", false, format!("상관 스칼라 서브쿼리({agg}) → LEFT JOIN (… GROUP BY)"), "행마다 다시 돌던 서브쿼리를 한 번 묶어 붙입니다 — 결과를 확인하세요".into(), span) {
                continue;
            }
            let a = self.fresh("s");
            let keys: Vec<String> = (1..=plan.keys.len()).map(|i| format!("k{i}")).collect();
            let sel_keys = plan.keys.iter().zip(&keys).map(|((ik, _), k)| format!("{ik} AS {k}")).collect::<Vec<_>>().join(", ");
            let grp = plan.keys.iter().map(|(ik, _)| ik.to_string()).collect::<Vec<_>>().join(", ");
            let wh = plan.rest.as_ref().map(|w| format!(" WHERE {w}")).unwrap_or_default();
            let sql = format!("SELECT {sel_keys}, {} AS v FROM {}{wh} GROUP BY {grp}", plan.agg, plan.from);
            let Some(dq) = self.parse_query(&sql) else { continue };
            let on: Vec<Expr> = plan.keys.iter().zip(&keys).map(|((_, ok), k)| bin(Expr::CompoundIdentifier(vec![a.clone(), Ident::new(k.clone())]), BinaryOperator::Eq, ok.clone())).collect();
            s.from[item].joins.push(Join {
                relation: TableFactor::Derived { lateral: false, subquery: dq, alias: Some(self.alias(a.clone())), sample: None },
                global: false,
                join_operator: JoinOperator::Left(JoinConstraint::On(and_all(on).expect("키"))),
            });
            let v = Expr::CompoundIdentifier(vec![a.clone(), Ident::new("v")]);
            let val = if plan.count {
                let Some(c) = self.parse_expr(&format!("COALESCE({}.v, 0)", a)) else { continue };
                c
            } else {
                v
            };
            // 이름 없던 열은 원래 서브쿼리 글 대신 이 이름이 된다 — 별칭이 있으면 그대로
            s.projection[idx] = match alias {
                Some(al) => SelectItem::ExprWithAlias { expr: val, alias: al },
                None => SelectItem::UnnamedExpr(val),
            };
        }
    }

    fn scalar_plan(&self, q: &Query, outer: &[Tab]) -> Option<ScalarPlan> {
        if q.with.is_some() || q.order_by.is_some() || q.limit_clause.is_some() || q.fetch.is_some() {
            return None;
        }
        let SetExpr::Select(inner) = q.body.as_ref() else { return None };
        if inner.from.len() != 1 || !inner.from[0].joins.is_empty() || inner.distinct.is_some() || inner.top.is_some() || inner.having.is_some() || inner.projection.len() != 1 {
            return None;
        }
        if !matches!(&inner.group_by, GroupByExpr::Expressions(v, m) if v.is_empty() && m.is_empty()) {
            return None;
        }
        if !matches!(inner.from[0].relation, TableFactor::Table { .. }) {
            return None;
        }
        let it = self.tab_of(&inner.from[0].relation)?;
        let agg = match &inner.projection[0] {
            SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => e.clone(),
            _ => return None,
        };
        let Expr::Function(f) = peel(&agg) else { return None };
        let name = fn_name(f);
        if !["count", "sum", "min", "max", "avg"].contains(&name.as_str()) || f.over.is_some() {
            return None;
        }
        // 열 참조 판정 — 안쪽 표인지(true)·바깥 표인지(false)·모름(None)
        let side = |p: &[Ident]| -> Option<bool> {
            if p.len() == 1 {
                return match it.has(&lc(&p[0].value)) {
                    Some(true) => Some(true),
                    _ => None,
                };
            }
            let qq = &p[..p.len() - 1];
            if it.matches(qq) {
                Some(true)
            } else if outer.iter().any(|t| t.matches(qq)) {
                Some(false)
            } else {
                None
            }
        };
        let fs = scan(&agg);
        if fs.subq || fs.refs.iter().any(|r| side(&r.parts) != Some(true)) {
            return None;
        }
        let mut keys = vec![];
        let mut rest = vec![];
        let mut outer_quals = BTreeSet::new();
        for c in inner.selection.clone().map(conjuncts).unwrap_or_default() {
            let sc = scan(&c);
            if sc.subq {
                return None;
            }
            if let Expr::BinaryOp { left, op: BinaryOperator::Eq, right } = peel(&c) {
                if let (Some(l), Some(r)) = (col_parts(left), col_parts(right)) {
                    match (side(l), side(r)) {
                        (Some(true), Some(false)) => {
                            outer_quals.insert(lc(&r[r.len() - 2].value));
                            keys.push((left.as_ref().clone(), right.as_ref().clone()));
                            continue;
                        }
                        (Some(false), Some(true)) => {
                            outer_quals.insert(lc(&l[l.len() - 2].value));
                            keys.push((right.as_ref().clone(), left.as_ref().clone()));
                            continue;
                        }
                        _ => {}
                    }
                }
            }
            if sc.refs.iter().any(|r| side(&r.parts) != Some(true)) {
                return None;
            }
            rest.push(c);
        }
        if keys.is_empty() {
            return None;
        }
        Some(ScalarPlan {
            agg: agg.to_string(),
            agg_name: name.clone(),
            count: name == "count",
            from: inner.from[0].relation.to_string(),
            keys,
            rest: and_all(rest).map(|e| e.to_string()),
            outer_quals: outer_quals.into_iter().collect(),
        })
    }

    // ───────────── 안 쓰는 LEFT JOIN 지우기(check, 메타 필요) ─────────────

    fn drop_left_join(&mut self, s: &mut Select, ob: Option<&OrderBy>) {
        if self.meta.is_none() || s.projection.iter().any(|p| matches!(p, SelectItem::Wildcard(_))) {
            return;
        }
        let mut ti = 0;
        while ti < s.from.len() {
            let mut ji = 0;
            while ji < s.from[ti].joins.len() {
                if self.try_drop(s, ob, ti, ji) {
                    continue;
                }
                ji += 1;
            }
            ti += 1;
        }
    }

    fn try_drop(&mut self, s: &mut Select, ob: Option<&OrderBy>, ti: usize, ji: usize) -> bool {
        let j = &s.from[ti].joins[ji];
        let on = match &j.join_operator {
            JoinOperator::Left(JoinConstraint::On(e)) | JoinOperator::LeftOuter(JoinConstraint::On(e)) => e.clone(),
            _ => return false,
        };
        let TableFactor::Table { name, .. } = &j.relation else { return false };
        if self.is_cte(name) {
            return false;
        }
        let Some(t) = self.tab_of(&j.relation) else { return false };
        if t.uniq.is_empty() || t.cols.is_none() {
            return false;
        }
        // ON 의 x.k = (x 를 안 보는 식) 으로 유일 키를 모두 덮는지
        let mut eq_cols = HashSet::new();
        for c in conjuncts(on.clone()) {
            if let Expr::BinaryOp { left, op: BinaryOperator::Eq, right } = peel(&c) {
                for (a, b) in [(left, right), (right, left)] {
                    if let Some(p) = col_parts(a) {
                        if p.len() >= 2 && t.matches(&p[..p.len() - 1]) {
                            let other = scan(b.as_ref());
                            if !other.refs.iter().any(|r| r.parts.len() >= 2 && t.matches(&r.parts[..r.parts.len() - 1])) && !other.refs.iter().any(|r| r.parts.len() == 1 && t.has(&lc(&r.parts[0].value)) == Some(true)) {
                                eq_cols.insert(lc(&p[p.len() - 1].value));
                            }
                        }
                    }
                }
            }
        }
        if !t.uniq.iter().any(|k| !k.is_empty() && k.iter().all(|c| eq_cols.contains(c))) {
            return false;
        }
        // 이 조인의 ON 밖에서 x 를 보는 곳이 없어야
        let mut probe = s.clone();
        probe.from[ti].joins.remove(ji);
        let mut refs = scan(&probe).refs;
        if let Some(o) = ob {
            refs.extend(scan(o).refs);
        }
        let used = refs.iter().any(|r| (r.parts.len() >= 2 && t.matches(&r.parts[..r.parts.len() - 1])) || (r.parts.len() == 1 && t.has(&lc(&r.parts[0].value)) == Some(true)));
        let qw = probe.projection.iter().any(|p| match p {
            SelectItem::QualifiedWildcard(SelectItemQualifiedWildcardKind::ObjectName(n), _) => t.matches(&n.0.iter().filter_map(|x| x.as_ident().cloned()).collect::<Vec<_>>()),
            _ => false,
        });
        if used || qw {
            return false;
        }
        let span = s.from[ti].joins[ji].span();
        if !self.propose("dropLeftJoin", false, format!("결과에 안 쓰는 LEFT JOIN {} 지우기", t.ident.value), "유일 키로 붙어 행 수를 바꾸지 않고 어느 열도 쓰지 않습니다 — 결과를 확인하세요".into(), span) {
            return false;
        }
        s.from[ti].joins.remove(ji);
        true
    }

    // ───────────── 중첩 파생 표 펼치기(check) ─────────────

    fn flatten_derived(&mut self, s: &mut Select, ob: Option<&mut OrderBy>) {
        // 바깥이 표 하나뿐일 때만(가장 흔한 레거시 겹 SELECT) — 여러 표와 섞이면 열 이름 가림을 다 따지기 어렵다
        if s.from.len() != 1 || !s.from[0].joins.is_empty() {
            return;
        }
        let TableFactor::Derived { lateral: false, subquery, alias: Some(alias), .. } = &s.from[0].relation else { return };
        if !alias.columns.is_empty() {
            return;
        }
        let q = subquery.as_ref();
        // 안쪽 ORDER BY 는 바깥 ROWNUM·LIMIT(상위 N개)과 함께 뜻이 있다 — 펼치면 정렬이 사라져 다른 행이 나온다
        if q.with.is_some() || q.order_by.is_some() || q.limit_clause.is_some() || q.fetch.is_some() || !q.locks.is_empty() || q.for_clause.is_some() || q.settings.is_some() || q.format_clause.is_some() || !q.pipe_operators.is_empty() {
            return;
        }
        let SetExpr::Select(inner) = q.body.as_ref() else { return };
        if inner.from.len() != 1 || !inner.from[0].joins.is_empty() || inner.distinct.is_some() || inner.top.is_some() || inner.having.is_some() || inner.into.is_some() {
            return;
        }
        // 안쪽의 ROWNUM(Oracle 행 번호·상위 N개)은 바깥 조건과 섞이면 세는 행이 바뀐다
        let rownum = |r: &CRef| r.parts.len() == 1 && lc(&r.parts[0].value) == "rownum";
        if inner.selection.as_ref().is_some_and(|w| scan(w).refs.iter().any(rownum)) || inner.projection.iter().any(|p| scan(p).refs.iter().any(rownum)) {
            return;
        }
        if !matches!(&inner.group_by, GroupByExpr::Expressions(v, m) if v.is_empty() && m.is_empty()) || !inner.named_window.is_empty() || inner.qualify.is_some() || !inner.lateral_views.is_empty() || inner.prewhere.is_some() || !inner.connect_by.is_empty() {
            return;
        }
        let TableFactor::Table { .. } = &inner.from[0].relation else { return };
        if inner.selection.as_ref().is_some_and(|w| scan(w).subq) {
            return;
        }
        let Some(it) = self.tab_of(&inner.from[0].relation) else { return };
        let x = alias.name.clone();
        let xq = lc(&x.value);
        // 안쪽 열 목록: 별칭 이름 → 안쪽 식(x. 로 한정)
        let star = inner.projection.len() == 1 && matches!(inner.projection[0], SelectItem::Wildcard(_));
        let mut map: Vec<(String, Expr)> = vec![];
        let requal = |e: &Expr| -> Option<Expr> {
            let p = col_parts(e)?;
            if p.len() >= 2 && !it.matches(&p[..p.len() - 1]) {
                return None;
            }
            Some(Expr::CompoundIdentifier(vec![x.clone(), p[p.len() - 1].clone()]))
        };
        if !star {
            for p in &inner.projection {
                let (e, out) = match p {
                    SelectItem::UnnamedExpr(e) => (e, col_parts(e).map(|v| lc(&v[v.len() - 1].value))),
                    SelectItem::ExprWithAlias { expr, alias } => (expr, Some(lc(&alias.value))),
                    _ => return,
                };
                let (Some(out), Some(ne)) = (out, requal(e)) else { return };
                if map.iter().any(|(n, _)| *n == out) {
                    return;
                }
                map.push((out, ne));
            }
        }
        // 바깥이 x 를 가리지 않는지, 안쪽 이름이 겹치지 않는지
        if nested_exposes(&*s, &xq) {
            return;
        }
        let outer_scan = scan(&*s);
        // 안쪽 열 목록이 따로 있으면 바깥의 한정 안 된 열·서브쿼리 안 참조는 이름 바꾸기가 어긋날 수 있다
        if !star {
            for r in &outer_scan.refs {
                if r.parts.len() == 1 {
                    let n = lc(&r.parts[0].value);
                    if let Some((_, e)) = map.iter().find(|(k, _)| *k == n) {
                        let same = col_parts(e).is_some_and(|p| lc(&p[p.len() - 1].value) == n);
                        if !same && r.depth > 0 {
                            return;
                        }
                    }
                } else if r.parts.len() >= 2 && lc(&r.parts[r.parts.len() - 2].value) == xq && !map.iter().any(|(k, _)| *k == lc(&r.parts[r.parts.len() - 1].value)) {
                    return; // 없는 열
                }
            }
        }
        let span = s.from[0].relation.span();
        if !self.propose("flattenDerived", false, format!("파생 표 {} 펼치기", x.value), "겹 SELECT 를 한 겹으로 — 바깥 조건과 안쪽 조건을 합칩니다. 결과를 확인하세요".into(), span) {
            return;
        }
        // 바꾸기
        let TableFactor::Derived { subquery, .. } = std::mem::replace(&mut s.from[0].relation, TableFactor::Table {
            name: ObjectName(vec![]),
            alias: None,
            args: None,
            with_hints: vec![],
            version: None,
            with_ordinality: false,
            partitions: vec![],
            json_path: None,
            sample: None,
            index_directives: vec![],
            inheritance: None,
        }) else {
            return;
        };
        let SetExpr::Select(inner) = *subquery.body else { return };
        let mut inner = *inner;
        let mut rel = inner.from.remove(0).relation;
        if let TableFactor::Table { alias: a, .. } = &mut rel {
            *a = Some(self.alias(x.clone()));
        }
        // 안쪽 WHERE 를 x. 로
        let mut iw = inner.selection.take();
        if let Some(w) = iw.as_mut() {
            let itq = it.clone();
            let xx = x.clone();
            each_expr_mut(w, |e, d| {
                if d != 0 {
                    return;
                }
                match e {
                    // 한정 안 된 열은 그대로(바깥도 표 하나라 같은 표로 읽힌다 — DATEADD(day, …) 같은 낱말을 건드리지 않게)
                    Expr::CompoundIdentifier(v) if v.len() >= 2 && itq.matches(&v[..v.len() - 1]) => {
                        let last = v[v.len() - 1].clone();
                        *e = Expr::CompoundIdentifier(vec![xx.clone(), last]);
                    }
                    _ => {}
                }
            });
        }
        s.from[0].relation = rel;
        // 바깥 참조를 안쪽 식으로
        if !star {
            let single = true;
            let mapc = map.clone();
            let fix = |e: &mut Expr, _d: usize| match e {
                Expr::CompoundIdentifier(v) if v.len() == 2 && lc(&v[0].value) == xq => {
                    if let Some((_, ne)) = mapc.iter().find(|(k, _)| *k == lc(&v[1].value)) {
                        *e = ne.clone();
                    }
                }
                Expr::Identifier(i) if single => {
                    if let Some((_, ne)) = mapc.iter().find(|(k, _)| *k == lc(&i.value)) {
                        let same = col_parts(ne).is_some_and(|p| lc(&p[p.len() - 1].value) == lc(&i.value));
                        if !same {
                            *e = ne.clone();
                        }
                    }
                }
                _ => {}
            };
            let mut proj = std::mem::take(&mut s.projection);
            let mut np = vec![];
            for p in proj.drain(..) {
                match p {
                    SelectItem::Wildcard(_) => {
                        for (k, e) in &map {
                            np.push(SelectItem::ExprWithAlias { expr: e.clone(), alias: Ident::new(k.clone()) });
                        }
                    }
                    SelectItem::QualifiedWildcard(SelectItemQualifiedWildcardKind::ObjectName(n), _) if n.0.len() == 1 && last_name(&n).is_some_and(|i| lc(&i.value) == xq) => {
                        for (k, e) in &map {
                            np.push(SelectItem::ExprWithAlias { expr: e.clone(), alias: Ident::new(k.clone()) });
                        }
                    }
                    SelectItem::UnnamedExpr(mut e) => {
                        // 이름이 바뀌는 열은 원래 이름을 별칭으로 남긴다
                        let keep = col_parts(&e).map(|p| p[p.len() - 1].clone());
                        each_expr_mut(&mut e, fix);
                        match keep {
                            Some(k) if col_parts(&e).is_some_and(|p| lc(&p[p.len() - 1].value) != lc(&k.value)) => np.push(SelectItem::ExprWithAlias { expr: e, alias: k }),
                            _ => np.push(SelectItem::UnnamedExpr(e)),
                        }
                    }
                    SelectItem::ExprWithAlias { mut expr, alias } => {
                        each_expr_mut(&mut expr, fix);
                        np.push(SelectItem::ExprWithAlias { expr, alias });
                    }
                    other => np.push(other),
                }
            }
            s.projection = np;
            if let Some(e) = s.selection.as_mut() {
                each_expr_mut(e, fix);
            }
            if let GroupByExpr::Expressions(v, _) = &mut s.group_by {
                for e in v.iter_mut() {
                    each_expr_mut(e, fix);
                }
            }
            if let Some(e) = s.having.as_mut() {
                each_expr_mut(e, fix);
            }
            if let Some(o) = ob {
                // ORDER BY 는 결과 열 이름(별칭)을 볼 수 있다 — x. 로 한정된 것만
                each_expr_mut(o, |e, _| {
                    if let Expr::CompoundIdentifier(v) = e {
                        if v.len() == 2 && lc(&v[0].value) == xq {
                            if let Some((_, ne)) = map.iter().find(|(k, _)| *k == lc(&v[1].value)) {
                                *e = ne.clone();
                            }
                        }
                    }
                });
            }
        }
        let mut w = iw.map(conjuncts).unwrap_or_default();
        w.extend(s.selection.take().map(conjuncts).unwrap_or_default());
        s.selection = and_all(w);
    }

    // ───────────── 안 쓰는 CTE(safe) ─────────────

    fn unused_cte(&mut self, q: &mut Query) {
        let Some(w) = q.with.as_ref() else { return };
        if w.cte_tables.is_empty() {
            return;
        }
        let mut kept: HashSet<String> = HashSet::new();
        loop {
            let Some(w) = q.with.as_ref() else { return };
            let mut pick = None;
            for (i, c) in w.cte_tables.iter().enumerate() {
                let name = lc(&c.alias.name.value);
                if kept.contains(&name) || has_dml(&c.query) {
                    continue;
                }
                let mut probe = q.clone();
                if let Some(pw) = probe.with.as_mut() {
                    pw.cte_tables.remove(i);
                }
                if count_rel(&probe, &name) == 0 {
                    pick = Some((i, name, c.alias.name.span));
                    break;
                }
            }
            let Some((i, name, span)) = pick else { break };
            let shown = q.with.as_ref().map(|w| w.cte_tables[i].alias.name.value.clone()).unwrap_or_default();
            if self.propose("unusedCte", true, format!("안 쓰는 CTE {shown} 지우기"), "어디서도 읽지 않는 WITH 항목입니다".into(), span) {
                if let Some(w) = q.with.as_mut() {
                    w.cte_tables.remove(i);
                }
            } else {
                kept.insert(name);
            }
        }
        if q.with.as_ref().is_some_and(|w| w.cte_tables.is_empty()) {
            q.with = None;
        }
    }

    // ───────────── 반복되는 같은 서브쿼리 → CTE (check) ─────────────

    fn repeated_to_cte(&mut self, q: &mut Query) {
        let existing: Vec<String> = q.with.as_ref().map(|w| w.cte_tables.iter().map(|c| lc(&c.alias.name.value)).collect()).unwrap_or_default();
        let mut rounds = 0;
        let mut skipped: Vec<Query> = vec![];
        while rounds < 8 {
            rounds += 1;
            let mut found: Vec<(Query, Span)> = vec![];
            // CTE 본문 안은 빼고(새 CTE 를 앞에 두니 정의 순서가 꼬이지 않게) 본문·ORDER BY 만
            let _ = q.body.visit(&mut SubqFinder { out: &mut found });
            if let Some(o) = &q.order_by {
                let _ = o.visit(&mut SubqFinder { out: &mut found });
            }
            // 같은 것끼리 세기(큰 것부터)
            let mut groups: Vec<(Query, usize, Span)> = vec![];
            for (sq, sp) in found {
                if let Some(g) = groups.iter_mut().find(|g| g.0 == sq) {
                    g.1 += 1;
                } else {
                    groups.push((sq, 1, sp));
                }
            }
            groups.retain(|g| g.1 >= 2 && !skipped.contains(&g.0));
            groups.sort_by_key(|g| std::cmp::Reverse(g.0.to_string().len()));
            let Some((cand, count, span)) = groups.into_iter().find(|g| self.uncorrelated(&g.0) && count_rel_any(&g.0, &existing) == 0 && g.0.to_string().len() >= 24) else {
                break;
            };
            if !self.propose("repeatToCte", false, format!("같은 서브쿼리 {count}번 → CTE 로 빼기"), "한 번만 정의해 여러 곳이 읽습니다 — 엔진이 CTE 를 지원해야 합니다(MySQL 8 · MariaDB 10.2 이상). 결과를 확인하세요".into(), span) {
                skipped.push(cand);
                continue;
            }
            let name = self.fresh("sq");
            let Some(star) = self.parse_query(&format!("SELECT * FROM {name}")) else { break };
            let mut rep = Replacer { cand: &cand, star: &star, name: &name, alias_as: self.eng.alias_as() };
            let _ = VisitMut::visit(q.body.as_mut(), &mut rep);
            if let Some(o) = q.order_by.as_mut() {
                let _ = VisitMut::visit(o, &mut rep);
            }
            let cte = Cte {
                alias: TableAlias { explicit: false, name: name.clone(), columns: vec![], at: None },
                query: Box::new(cand.clone()),
                from: None,
                materialized: None,
                closing_paren_token: sqlparser::ast::helpers::attached_token::AttachedToken::empty(),
            };
            match q.with.as_mut() {
                Some(w) => w.cte_tables.insert(0, cte),
                None => {
                    q.with = Some(sqlparser::ast::With { with_token: sqlparser::ast::helpers::attached_token::AttachedToken::empty(), recursive: false, cte_tables: vec![cte] });
                }
            }
        }
    }

    /// 바깥을 보지 않는 서브쿼리인지(모든 열 참조가 안쪽 표에 잡힌다)
    fn uncorrelated(&self, q: &Query) -> bool {
        struct Free<'c, 'a> {
            cx: &'c Cx<'a>,
            stack: Vec<Vec<Tab>>,
            bad: bool,
        }
        impl Visitor for Free<'_, '_> {
            type Break = ();
            fn pre_visit_select(&mut self, s: &Select) -> ControlFlow<()> {
                let t = self.cx.scope_tabs(s);
                self.stack.push(t);
                ControlFlow::Continue(())
            }
            fn post_visit_select(&mut self, _s: &Select) -> ControlFlow<()> {
                self.stack.pop();
                ControlFlow::Continue(())
            }
            fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
                let parts: &[Ident] = match e {
                    Expr::Identifier(i) => std::slice::from_ref(i),
                    Expr::CompoundIdentifier(v) => v,
                    _ => return ControlFlow::Continue(()),
                };
                if parts.len() == 1 {
                    let n = lc(&parts[0].value);
                    if PSEUDO.contains(&n.as_str()) {
                        return ControlFlow::Continue(());
                    }
                    // 한정 안 된 열은 메타데이터로 안쪽 표의 열임을 확인할 수 있을 때만(아니면 바깥 열일 수 있다)
                    let ok = self.stack.iter().rev().any(|ts| ts.iter().any(|t| t.has(&n) == Some(true)));
                    if !ok {
                        self.bad = true;
                    }
                } else {
                    let q = &parts[..parts.len() - 1];
                    if !self.stack.iter().any(|ts| ts.iter().any(|t| t.matches(q))) {
                        self.bad = true;
                    }
                }
                ControlFlow::Continue(())
            }
        }
        let mut f = Free { cx: self, stack: vec![], bad: false };
        let _ = q.visit(&mut f);
        !f.bad && !has_dml(q)
    }
}

struct ScalarPlan {
    agg: String,
    agg_name: String,
    count: bool,
    from: String,
    /// (안쪽 열, 바깥 식)
    keys: Vec<(Expr, Expr)>,
    rest: Option<String>,
    outer_quals: Vec<String>,
}

struct OrFinder<'a>(&'a mut bool);
impl Visitor for OrFinder<'_> {
    type Break = ();
    fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
        if matches!(e, Expr::BinaryOp { op: BinaryOperator::Or, .. } | Expr::In { .. }) {
            *self.0 = true;
        }
        ControlFlow::Continue(())
    }
}

struct NotInFinder<'a> {
    depth: usize,
    out: &'a mut Vec<(Span, Expr)>,
}
impl Visitor for NotInFinder<'_> {
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
            if let Expr::In { negated: true, target: InTarget::Subquery(_), .. } = e {
                self.out.push((e.span(), e.clone()));
            }
        }
        ControlFlow::Continue(())
    }
}

/// 식·FROM 자리의 서브쿼리 모으기
struct SubqFinder<'a> {
    out: &'a mut Vec<(Query, Span)>,
}
impl Visitor for SubqFinder<'_> {
    type Break = ();
    fn pre_visit_expr(&mut self, e: &Expr) -> ControlFlow<()> {
        if let Expr::Subquery(q) | Expr::In { target: InTarget::Subquery(q), .. } = e {
            self.out.push((q.as_ref().clone(), q.span()));
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_table_factor(&mut self, t: &TableFactor) -> ControlFlow<()> {
        if let TableFactor::Derived { lateral: false, subquery, alias, .. } = t {
            if alias.as_ref().is_none_or(|a| a.columns.is_empty()) {
                self.out.push((subquery.as_ref().clone(), subquery.span()));
            }
        }
        ControlFlow::Continue(())
    }
}

struct Replacer<'a> {
    cand: &'a Query,
    star: &'a Query,
    name: &'a Ident,
    alias_as: bool,
}
impl VisitorMut for Replacer<'_> {
    type Break = ();
    fn pre_visit_expr(&mut self, e: &mut Expr) -> ControlFlow<()> {
        match e {
            Expr::Subquery(q) | Expr::In { target: InTarget::Subquery(q), .. } if q.as_ref() == self.cand => {
                **q = self.star.clone();
            }
            _ => {}
        }
        ControlFlow::Continue(())
    }
    fn pre_visit_table_factor(&mut self, t: &mut TableFactor) -> ControlFlow<()> {
        if let TableFactor::Derived { lateral: false, subquery, alias, .. } = t {
            if subquery.as_ref() == self.cand {
                let alias = alias.clone().map(|mut a| {
                    a.explicit = self.alias_as;
                    a
                });
                *t = TableFactor::Table {
                    name: ObjectName(vec![ObjectNamePart::Identifier(self.name.clone())]),
                    alias,
                    args: None,
                    with_hints: vec![],
                    version: None,
                    with_ordinality: false,
                    partitions: vec![],
                    json_path: None,
                    sample: None,
                    index_directives: vec![],
                    inheritance: None,
                };
            }
        }
        ControlFlow::Continue(())
    }
}

fn has_dml(q: &Query) -> bool {
    struct D(bool);
    impl Visitor for D {
        type Break = ();
        fn pre_visit_query(&mut self, q: &Query) -> ControlFlow<()> {
            if matches!(q.body.as_ref(), SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Delete(_) | SetExpr::Merge(_)) || !q.locks.is_empty() {
                self.0 = true;
            }
            ControlFlow::Continue(())
        }
        fn pre_visit_select(&mut self, s: &Select) -> ControlFlow<()> {
            if s.into.is_some() {
                self.0 = true;
            }
            ControlFlow::Continue(())
        }
    }
    let mut d = D(false);
    let _ = q.visit(&mut d);
    d.0
}

fn count_rel<V: Visit>(v: &V, name: &str) -> usize {
    count_rel_any(v, &[name.to_string()])
}

fn count_rel_any<V: Visit>(v: &V, names: &[String]) -> usize {
    let mut n = 0;
    let _ = sqlparser::ast::visit_relations(v, |r: &ObjectName| {
        if r.0.len() == 1 && last_name(r).is_some_and(|i| names.contains(&lc(&i.value))) {
            n += 1;
        }
        ControlFlow::<()>::Continue(())
    });
    n
}

fn on_of(op: &mut JoinOperator) -> Option<&mut Expr> {
    match op {
        JoinOperator::Join(JoinConstraint::On(e))
        | JoinOperator::Inner(JoinConstraint::On(e))
        | JoinOperator::Left(JoinConstraint::On(e))
        | JoinOperator::LeftOuter(JoinConstraint::On(e))
        | JoinOperator::Right(JoinConstraint::On(e))
        | JoinOperator::RightOuter(JoinConstraint::On(e))
        | JoinOperator::FullOuter(JoinConstraint::On(e))
        | JoinOperator::StraightJoin(JoinConstraint::On(e)) => Some(e),
        _ => None,
    }
}

fn on_ref(op: &JoinOperator) -> Option<&Expr> {
    match op {
        JoinOperator::Join(JoinConstraint::On(e))
        | JoinOperator::Inner(JoinConstraint::On(e))
        | JoinOperator::Left(JoinConstraint::On(e))
        | JoinOperator::LeftOuter(JoinConstraint::On(e))
        | JoinOperator::Right(JoinConstraint::On(e))
        | JoinOperator::RightOuter(JoinConstraint::On(e))
        | JoinOperator::FullOuter(JoinConstraint::On(e))
        | JoinOperator::StraightJoin(JoinConstraint::On(e)) => Some(e),
        _ => None,
    }
}

fn strip_plus(mut e: Expr) -> Expr {
    each_expr_mut(&mut e, |x, _| {
        if let Expr::OuterJoin(inner) = x {
            *x = std::mem::replace(inner.as_mut(), Expr::Value(Value::Null.with_empty_span()));
        }
    });
    e
}

fn proj_aliases(s: &Select) -> HashSet<String> {
    s.projection
        .iter()
        .filter_map(|p| match p {
            SelectItem::ExprWithAlias { alias, .. } => Some(lc(&alias.value)),
            _ => None,
        })
        .collect()
}

fn proj_alias_map(s: &Select) -> HashMap<String, Expr> {
    s.projection
        .iter()
        .filter_map(|p| match p {
            SelectItem::ExprWithAlias { alias, expr } => Some((lc(&alias.value), expr.clone())),
            _ => None,
        })
        .collect()
}

/// 서브쿼리의 결과 열 이름(소문자) — 모두 이름이 있을 때만
fn output_names(q: &Query) -> Option<Vec<String>> {
    let mut b = q.body.as_ref();
    loop {
        match b {
            SetExpr::Select(s) => {
                let mut v = vec![];
                for p in &s.projection {
                    match p {
                        SelectItem::ExprWithAlias { alias, .. } => v.push(lc(&alias.value)),
                        SelectItem::UnnamedExpr(e) => v.push(lc(&col_parts(e)?.last()?.value)),
                        _ => return None,
                    }
                }
                return Some(v);
            }
            SetExpr::Query(q) => b = q.body.as_ref(),
            SetExpr::SetOperation { left, .. } => b = left.as_ref(),
            _ => return None,
        }
    }
}

/// TB_POST_FILE → pf, order_item → oi, OrderLine → ol
fn short_name(name: &str) -> String {
    let mut parts: Vec<String> = vec![];
    let mut cur = String::new();
    let mut prev_lower = false;
    for ch in name.chars() {
        if ch == '_' || ch == '-' || ch == ' ' || ch == '$' {
            if !cur.is_empty() {
                parts.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if ch.is_ascii_uppercase() && prev_lower && !cur.is_empty() {
            parts.push(std::mem::take(&mut cur));
        }
        prev_lower = ch.is_ascii_lowercase();
        cur.push(ch);
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    if parts.len() > 1 && ["tb", "tbl", "t", "tm", "tn", "tbm"].contains(&lc(&parts[0]).as_str()) {
        parts.remove(0);
    }
    let s: String = parts.iter().filter_map(|p| p.chars().next()).filter(|c| c.is_ascii_alphabetic()).map(|c| c.to_ascii_lowercase()).take(4).collect();
    if s.is_empty() {
        "t".into()
    } else {
        s
    }
}

/// q.col 한정을 바꾸기(이 SELECT 와 그 안 서브쿼리 모두 — 가림은 미리 막았다)
fn rename_qual(s: &mut Select, t: &Tab, to: &Ident) {
    each_expr_mut(s, |e, _| rename_ref(e, t, to));
    for p in s.projection.iter_mut() {
        if let SelectItem::QualifiedWildcard(SelectItemQualifiedWildcardKind::ObjectName(n), _) = p {
            let parts: Vec<Ident> = n.0.iter().filter_map(|x| x.as_ident().cloned()).collect();
            if t.matches(&parts) {
                *n = ObjectName(vec![ObjectNamePart::Identifier(to.clone())]);
            }
        }
    }
}

fn rename_ref(e: &mut Expr, t: &Tab, to: &Ident) {
    match e {
        Expr::CompoundIdentifier(v) if v.len() >= 2 && t.matches(&v[..v.len() - 1]) => {
            let last = v[v.len() - 1].clone();
            *v = vec![to.clone(), last];
        }
        Expr::QualifiedWildcard(n, _) => {
            let parts: Vec<Ident> = n.0.iter().filter_map(|x| x.as_ident().cloned()).collect();
            if t.matches(&parts) {
                *n = ObjectName(vec![ObjectNamePart::Identifier(to.clone())]);
            }
        }
        _ => {}
    }
}

// ───────────────────────── 조건식 다듬기 ─────────────────────────

#[derive(Default, Clone, Copy)]
struct Kinds {
    taut: bool,
    parens: bool,
    dup: bool,
    inone: bool,
    not: bool,
    orin: bool,
}

impl Kinds {
    fn all() -> Self {
        Kinds { taut: true, parens: true, dup: true, inone: true, not: true, orin: true }
    }
}

#[derive(Default)]
struct Counts {
    taut: u32,
    parens: u32,
    dup: u32,
    inone: u32,
    not: u32,
    orin: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    /// WHERE·ON·HAVING 맨 위 또는 괄호 안
    Root,
    And,
    Or,
    /// 비교 연산의 한쪽 등 — 덩어리만 괄호를 벗긴다
    Other,
}

fn can_unwrap(inner: &Expr, ctx: Ctx) -> bool {
    match ctx {
        Ctx::Root => true,
        Ctx::And | Ctx::Or => is_predicate(inner),
        Ctx::Other => is_atom(inner),
    }
}

fn flat(e: Expr, op: &BinaryOperator, k: Kinds, c: &mut Counts, out: &mut Vec<Expr>) {
    match e {
        Expr::BinaryOp { left, op: o, right } if o == *op => {
            flat(*left, op, k, c, out);
            flat(*right, op, k, c, out);
        }
        Expr::Nested(inner) if k.parens && matches!(peel(&inner), Expr::BinaryOp { op: o, .. } if o == op) => {
            c.parens += 1;
            let mut x = *inner;
            while let Expr::Nested(i) = x {
                c.parens += 1;
                x = *i;
            }
            flat(x, op, k, c, out);
        }
        other => out.push(other),
    }
}

fn simp(e: Expr, ctx: Ctx, k: Kinds, c: &mut Counts) -> Expr {
    match e {
        Expr::BinaryOp { op: BinaryOperator::And, .. } => {
            let mut parts = vec![];
            flat(e, &BinaryOperator::And, k, c, &mut parts);
            let mut out: Vec<Expr> = vec![];
            let mut first_true = None;
            for p in parts {
                let p = simp(p, Ctx::And, k, c);
                if k.taut && is_true(&p) {
                    c.taut += 1;
                    if first_true.is_none() {
                        first_true = Some(p);
                    }
                    continue;
                }
                if k.dup && is_pure(&p) && out.contains(&p) {
                    c.dup += 1;
                    continue;
                }
                out.push(p);
            }
            if out.is_empty() {
                // 다 참이었다 — 하나는 남긴다(맨 위면 부르는 쪽이 절을 지운다)
                c.taut -= 1;
                out.push(first_true.expect("참 조건"));
            }
            join_op(out, BinaryOperator::And).expect("조건")
        }
        Expr::BinaryOp { op: BinaryOperator::Or, .. } => {
            let mut parts = vec![];
            flat(e, &BinaryOperator::Or, k, c, &mut parts);
            let mut out: Vec<Expr> = vec![];
            for p in parts {
                let p = simp(p, Ctx::Or, k, c);
                if k.dup && is_pure(&p) && out.contains(&p) {
                    c.dup += 1;
                    continue;
                }
                out.push(p);
            }
            if k.orin {
                out = or_to_in(out, c);
            }
            if out.len() == 1 {
                return out.pop().expect("하나");
            }
            join_op(out, BinaryOperator::Or).expect("조건")
        }
        Expr::Nested(inner) => {
            let inner = simp(*inner, Ctx::Root, k, c);
            let and_in_and = ctx == Ctx::And && matches!(inner, Expr::BinaryOp { op: BinaryOperator::And, .. });
            let or_in_or = ctx == Ctx::Or && matches!(inner, Expr::BinaryOp { op: BinaryOperator::Or, .. });
            if k.parens && !and_in_and && !or_in_or && can_unwrap(&inner, ctx) {
                c.parens += 1;
                inner
            } else {
                Expr::Nested(Box::new(inner))
            }
        }
        Expr::UnaryOp { op: UnaryOperator::Not, expr } => {
            if k.not {
                if let Some(n) = negate(peel(&expr)) {
                    c.not += 1;
                    return simp(n, ctx, k, c);
                }
            }
            Expr::UnaryOp { op: UnaryOperator::Not, expr: Box::new(simp(*expr, Ctx::Other, k, c)) }
        }
        Expr::BinaryOp { left, op, right } if is_cmp(&op) => Expr::BinaryOp { left: Box::new(simp(*left, Ctx::Other, k, c)), op, right: Box::new(simp(*right, Ctx::Other, k, c)) },
        Expr::In { expr, target: InTarget::List(list), negated, global } => {
            if k.inone && list.len() == 1 && !matches!(peel(&list[0]), Expr::Subquery(_) | Expr::Tuple(_)) && !matches!(peel(&expr), Expr::Tuple(_)) {
                c.inone += 1;
                let v = list.into_iter().next().expect("값");
                let op = if negated { BinaryOperator::NotEq } else { BinaryOperator::Eq };
                return simp(bin(*expr, op, v), ctx, k, c);
            }
            Expr::In { expr: Box::new(simp(*expr, Ctx::Other, k, c)), target: InTarget::List(list.into_iter().map(|x| simp(x, Ctx::Other, k, c)).collect()), negated, global }
        }
        Expr::IsNull(x) => Expr::IsNull(Box::new(simp(*x, Ctx::Other, k, c))),
        Expr::IsNotNull(x) => Expr::IsNotNull(Box::new(simp(*x, Ctx::Other, k, c))),
        Expr::Between { expr, negated, low, high } => Expr::Between { expr: Box::new(simp(*expr, Ctx::Other, k, c)), negated, low: Box::new(simp(*low, Ctx::Other, k, c)), high: Box::new(simp(*high, Ctx::Other, k, c)) },
        other => other,
    }
}

/// NOT 을 안으로 — 3값 논리에서도 같은 것만
fn negate(e: &Expr) -> Option<Expr> {
    Some(match e {
        Expr::BinaryOp { left, op, right } => Expr::BinaryOp { left: left.clone(), op: neg_cmp(op)?, right: right.clone() },
        Expr::IsNull(x) => Expr::IsNotNull(x.clone()),
        Expr::IsNotNull(x) => Expr::IsNull(x.clone()),
        Expr::In { expr, target, negated, global } => Expr::In { expr: expr.clone(), target: target.clone(), negated: !negated, global: *global },
        Expr::Between { expr, negated, low, high } => Expr::Between { expr: expr.clone(), negated: !negated, low: low.clone(), high: high.clone() },
        Expr::Like { negated, any: false, expr, pattern, escape_char } => Expr::Like { negated: !negated, any: false, expr: expr.clone(), pattern: pattern.clone(), escape_char: escape_char.clone() },
        Expr::ILike { negated, any: false, expr, pattern, escape_char } => Expr::ILike { negated: !negated, any: false, expr: expr.clone(), pattern: pattern.clone(), escape_char: escape_char.clone() },
        Expr::Exists { subquery, negated } => Expr::Exists { subquery: subquery.clone(), negated: !negated },
        _ => return None,
    })
}

/// a = 1 OR a = 2 OR a IN (3) → a IN (1, 2, 3) — 같은 열끼리 첫 자리에 모은다
fn or_to_in(parts: Vec<Expr>, c: &mut Counts) -> Vec<Expr> {
    let key = |e: &Expr| -> Option<(Expr, Vec<Expr>)> {
        match e {
            Expr::BinaryOp { left, op: BinaryOperator::Eq, right } => {
                if col_parts(left).is_some() && is_lit(peel(right)) {
                    Some((peel(left).clone(), vec![peel(right).clone()]))
                } else if col_parts(right).is_some() && is_lit(peel(left)) {
                    Some((peel(right).clone(), vec![peel(left).clone()]))
                } else {
                    None
                }
            }
            Expr::In { expr, target: InTarget::List(list), negated: false, .. } if col_parts(expr).is_some() && list.iter().all(|x| is_lit(peel(x))) => Some((peel(expr).clone(), list.iter().map(|x| peel(x).clone()).collect())),
            _ => None,
        }
    };
    let keys: Vec<Option<(Expr, Vec<Expr>)>> = parts.iter().map(key).collect();
    let mut out: Vec<Expr> = vec![];
    let mut done = vec![false; parts.len()];
    for i in 0..parts.len() {
        if done[i] {
            continue;
        }
        let Some((col, vals)) = &keys[i] else {
            out.push(parts[i].clone());
            continue;
        };
        let same: Vec<usize> = (i + 1..parts.len()).filter(|&j| !done[j] && keys[j].as_ref().is_some_and(|(c2, _)| c2 == col)).collect();
        if same.is_empty() {
            out.push(parts[i].clone());
            continue;
        }
        let mut all = vals.clone();
        for &j in &same {
            done[j] = true;
            for v in &keys[j].as_ref().expect("열").1 {
                if !all.contains(v) {
                    all.push(v.clone());
                }
            }
        }
        c.orin += 1;
        out.push(Expr::In { expr: Box::new(col.clone()), target: InTarget::List(all), negated: false, global: false });
    }
    out
}

// ───────────────────────── 주석 ─────────────────────────

fn tok_key(t: &Token) -> Option<String> {
    match t {
        Token::Word(w) => Some(lc(&w.value)),
        Token::Number(n, _) => Some(n.clone()),
        Token::SingleQuotedString(s) => Some(format!("'{s}")),
        _ => None,
    }
}

fn significant(d: &dyn Dialect, text: &str) -> Option<Vec<TokenWithSpan>> {
    let v = Tokenizer::new(d, text).tokenize_with_location().ok()?;
    Some(v.into_iter().filter(|t| !matches!(t.token, Token::Whitespace(_) | Token::EOF)).collect())
}

fn render_comment(c: &Comment) -> (String, bool) {
    match c {
        Comment::SingleLine { content, .. } => (format!("--{}", content.trim_end_matches(['\n', '\r'])), true),
        Comment::MultiLine(s) => (format!("/*{s}*/"), false),
    }
}

/// 원문 주석을 정리본의 가까운 낱말 앞(또는 같은 줄 뒤)에 끼운다. 자리를 못 찾은 것은 맨 앞으로.
fn place_comments(d: &dyn Dialect, orig: &str, comments: &[CommentWithSpan], out: &str, expect: &Statement) -> (String, CommentNote) {
    let list: Vec<&CommentWithSpan> = comments.iter().filter(|c| !(matches!(&c.comment, Comment::MultiLine(s) if s.starts_with('+')) && d.supports_comment_optimizer_hint())).collect();
    let mut note = CommentNote { total: list.len() as u32, ..Default::default() };
    if list.is_empty() {
        return (out.to_string(), note);
    }
    let (Some(otoks), Some(ntoks)) = (significant(d, orig), significant(d, out)) else {
        return (block_top(&list, out), CommentNote { moved: note.total, ..note });
    };
    let nls = line_starts(out);
    // 원문 낱말의 (열쇠, 같은 열쇠 중 몇 번째)
    let okeys: Vec<Option<(String, usize)>> = {
        let mut cnt: HashMap<String, usize> = HashMap::new();
        otoks
            .iter()
            .map(|t| {
                tok_key(&t.token).map(|k| {
                    let n = cnt.entry(k.clone()).or_insert(0);
                    *n += 1;
                    (k, *n)
                })
            })
            .collect()
    };
    let find_new = |k: &(String, usize)| -> Option<&TokenWithSpan> {
        let mut n = 0;
        for t in &ntoks {
            if tok_key(&t.token).as_ref() == Some(&k.0) {
                n += 1;
                if n == k.1 {
                    return Some(t);
                }
            }
        }
        None
    };
    let mut head: Vec<String> = vec![];
    let mut tail: Vec<String> = vec![];
    // (바이트 위치, 끼울 글)
    let mut ins: Vec<(usize, String)> = vec![];
    for c in &list {
        let (text, line) = render_comment(&c.comment);
        let Some(next) = c.next_token_start else {
            tail.push(text);
            note.kept += 1;
            continue;
        };
        let Some(prev) = c.prev_token_end else {
            head.push(text);
            note.kept += 1;
            continue;
        };
        let trailing = prev.line == c.span.start.line;
        let mut placed = false;
        if trailing {
            // 바로 앞 낱말(뒤로 걸으며 열쇠 있는 것)
            if let Some(i) = otoks.iter().rposition(|t| t.span.end <= prev) {
                if let Some(k) = (0..=i).rev().find_map(|j| okeys[j].clone()) {
                    if let Some(t) = find_new(&k) {
                        if let Some(b) = byte_at(out, &nls, t.span.end) {
                            ins.push((b, if line { format!(" {text}\n") } else { format!(" {text}") }));
                            placed = true;
                        }
                    }
                }
            }
        }
        if !placed {
            if let Some(i) = otoks.iter().position(|t| t.span.start >= next) {
                if let Some(k) = (i..otoks.len()).find_map(|j| okeys[j].clone()) {
                    if let Some(t) = find_new(&k) {
                        if let Some(b) = byte_at(out, &nls, t.span.start) {
                            ins.push((b, if line { format!("{text}\n") } else { format!("{text} ") }));
                            placed = true;
                        }
                    }
                }
            }
        }
        if placed {
            note.kept += 1;
        } else {
            head.push(text);
            note.moved += 1;
        }
    }
    ins.sort_by_key(|x| std::cmp::Reverse(x.0));
    let mut s = out.to_string();
    for (b, t) in ins {
        s.insert_str(b, &t);
    }
    let mut full = String::new();
    for h in &head {
        full.push_str(h);
        full.push('\n');
    }
    full.push_str(&s);
    for t in &tail {
        full.push('\n');
        full.push_str(t);
    }
    // 끼운 뒤에도 같은 문장인지 — 아니면 모두 맨 앞으로
    match parse_plain(d, &full) {
        Some(v) if v.len() == 1 && v[0] == *expect => (full, note),
        _ => (block_top(&list, out), CommentNote { total: note.total, kept: 0, moved: note.total }),
    }
}

fn block_top(list: &[&CommentWithSpan], out: &str) -> String {
    let mut s = String::new();
    for c in list {
        let (t, _) = render_comment(&c.comment);
        s.push_str(&t);
        s.push('\n');
    }
    s.push_str(out);
    s
}

// ───────────────────────── 진입점 ─────────────────────────

fn tables_of(st: &Statement) -> Vec<TableName> {
    let mut ctes = HashSet::new();
    struct C<'a>(&'a mut HashSet<String>);
    impl Visitor for C<'_> {
        type Break = ();
        fn pre_visit_query(&mut self, q: &Query) -> ControlFlow<()> {
            if let Some(w) = &q.with {
                for c in &w.cte_tables {
                    self.0.insert(lc(&c.alias.name.value));
                }
            }
            ControlFlow::Continue(())
        }
    }
    let _ = st.visit(&mut C(&mut ctes));
    let mut out: Vec<TableName> = vec![];
    let _ = sqlparser::ast::visit_relations(st, |r: &ObjectName| {
        let parts: Vec<String> = r.0.iter().filter_map(|p| p.as_ident().map(|i| i.value.clone())).collect();
        if let Some(name) = parts.last() {
            if !(parts.len() == 1 && ctes.contains(&lc(name))) {
                let t = TableName { schema: if parts.len() >= 2 { Some(parts[parts.len() - 2].clone()) } else { None }, name: name.clone() };
                if !out.contains(&t) {
                    out.push(t);
                }
            }
        }
        ControlFlow::<()>::Continue(())
    });
    out
}

/// 다듬기(테스트에서 바로 부른다)
pub fn cleanup(sql: &str, engine: &str, meta: Option<&CleanMeta>, off: &[String]) -> CleanResult {
    let mut r = CleanResult { text: sql.to_string(), kind: "other", ..Default::default() };
    let eng = Eng::of(engine);
    r.dialect = eng.name();
    if sql.len() > MAX_SQL {
        r.error = Some("문장이 너무 커서 다듬지 않습니다".into());
        return r;
    }
    let d = eng.dialect();
    let (stmts, comments) = match parse_all(&*d, sql) {
        Ok(x) => x,
        Err(e) => {
            r.error = Some(format!("이 엔진 문법으로 읽지 못해 손대지 않습니다 — {e}"));
            return r;
        }
    };
    let st = match stmts.len() {
        0 => {
            r.error = Some("다듬을 문장이 없습니다".into());
            return r;
        }
        1 => stmts.into_iter().next().expect("문장"),
        _ => {
            r.error = Some("문장이 둘 이상입니다 — 하나씩 다듬습니다".into());
            return r;
        }
    };
    r.kind = kind_of(&st);
    r.tables = tables_of(&st);
    let pretty = roundtrip(&*d, &st, true);
    if !pretty && !roundtrip(&*d, &st, false) {
        r.error = Some("이 문장에는 다시 찍으면 뜻이 달라질 수 있는 문법이 있어 손대지 않습니다".into());
        return r;
    }
    let mut cx = Cx::new(eng, meta, off, sql, &st);
    let mut st2 = st.clone();
    if let Err(e) = cx.statement(&mut st2) {
        r.error = Some(e);
        return r;
    }
    r.changes = cx.changes;
    r.notes = cx.notes;
    if meta.is_none() {
        r.notes.push("표 메타데이터 없이 다듬었습니다 — 열 한정·안 쓰는 LEFT JOIN 지우기는 메타데이터가 있어야 합니다".into());
    }
    r.ok = true;
    if st2 == st {
        return r;
    }
    let text = print(&st2, pretty);
    match parse_plain(&*d, &text) {
        Some(v) if v.len() == 1 && v[0] == st2 => {}
        _ => {
            r.ok = false;
            r.error = Some("정리본을 다시 읽어 같은 문장인지 확인하지 못해 원문을 그대로 둡니다".into());
            return r;
        }
    }
    let (with_comments, note) = place_comments(&*d, sql, &comments, &text, &st2);
    r.text = with_comments;
    r.comments = note;
    r.changed = true;
    r
}

/// 쿼리 다듬기 — 문장 하나. off: 끌 항목 id, meta: 화면이 캐시한 표 메타데이터
#[tauri::command(async)]
pub fn sql_cleanup(sql: String, engine: String, meta: Option<CleanMeta>, off: Option<Vec<String>>) -> CleanResult {
    let keep = sql.clone();
    let run = std::thread::Builder::new().name("sql-clean".into()).stack_size(BIG_STACK).spawn(move || cleanup(&sql, &engine, meta.as_ref(), &off.unwrap_or_default()));
    match run.map(|h| h.join()) {
        Ok(Ok(r)) => r,
        _ => CleanResult { error: Some("이 문장은 다듬지 못했습니다".into()), kind: "other", text: keep, ..Default::default() },
    }
}

// ───────────────────────── 결과 같음 확인 SQL ─────────────────────────

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompareStep {
    /// countA · countB · aMinusB · bMinusA · sumA · sumB
    pub key: &'static str,
    pub label: String,
    pub sql: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompareSql {
    pub ok: bool,
    pub reason: Option<String>,
    /// except: 행 수 + 서로 뺀 차이 행 수 · hash: 행 수 + 열별 집계 · count: 행 수만
    pub mode: &'static str,
    pub cols: u32,
    pub steps: Vec<CompareStep>,
}

/// 비교용으로 다듬기 — 바깥 ORDER BY(자르지 않을 때) 빼기, 결과 열에 c1… 이름 붙이기. 열 수(모르면 None)
fn prep_compare(q: &mut Query) -> Option<usize> {
    if q.limit_clause.is_none() && q.fetch.is_none() {
        let top = matches!(q.body.as_ref(), SetExpr::Select(s) if s.top.is_some());
        if !top {
            q.order_by = None;
        }
    }
    let mut b = q.body.as_mut();
    loop {
        match b {
            SetExpr::Select(s) => {
                if s.projection.iter().any(|p| matches!(p, SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(..))) {
                    return None;
                }
                let n = s.projection.len();
                for (i, p) in s.projection.iter_mut().enumerate() {
                    let e = match std::mem::replace(p, SelectItem::Wildcard(Default::default())) {
                        SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => e,
                        other => {
                            *p = other;
                            return None;
                        }
                    };
                    *p = SelectItem::ExprWithAlias { expr: e, alias: Ident::new(format!("c{}", i + 1)) };
                }
                return Some(n);
            }
            SetExpr::Query(q2) => {
                b = q2.body.as_mut();
            }
            SetExpr::SetOperation { left, .. } => b = left.as_mut(),
            _ => return None,
        }
    }
}

fn read_only_query(d: &dyn Dialect, sql: &str) -> Result<Query, String> {
    let v = parse_plain(d, sql).ok_or("읽지 못하는 문장입니다")?;
    if v.len() != 1 {
        return Err("문장이 하나여야 합니다".into());
    }
    match v.into_iter().next() {
        Some(Statement::Query(q)) => {
            if has_dml(&q) || q.for_clause.is_some() {
                return Err("읽기만 하는 SELECT 만 비교합니다(잠금·INTO·쓰기 CTE 제외)".into());
            }
            Ok(*q)
        }
        _ => Err("SELECT 문장만 결과를 비교합니다 — 쓰기 문장(DML)은 비교하지 않습니다".into()),
    }
}

fn ver_at_least(v: &str, want: &[u32]) -> bool {
    let nums: Vec<u32> = v.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).take(want.len()).filter_map(|s| s.parse().ok()).collect();
    if nums.len() < want.len().min(2) {
        return false;
    }
    for (i, w) in want.iter().enumerate() {
        let n = nums.get(i).copied().unwrap_or(0);
        if n != *w {
            return n > *w;
        }
    }
    true
}

/// 원문(a)·정리본(b)의 결과가 같은지 볼 SQL 을 만든다(실행하지 않음)
pub fn compare_sql(a: &str, b: &str, engine: &str, version: Option<&str>) -> CompareSql {
    let eng = Eng::of(engine);
    let d = eng.dialect();
    let mut qa = match read_only_query(&*d, a) {
        Ok(q) => q,
        Err(e) => return CompareSql { reason: Some(format!("원문: {e}")), ..Default::default() },
    };
    let mut qb = match read_only_query(&*d, b) {
        Ok(q) => q,
        Err(e) => return CompareSql { reason: Some(format!("정리본: {e}")), ..Default::default() },
    };
    let na = prep_compare(&mut qa);
    let nb = prep_compare(&mut qb);
    let cols = match (na, nb) {
        (Some(x), Some(y)) if x == y => Some(x),
        (Some(_), Some(_)) => return CompareSql { reason: Some("두 문장의 결과 열 수가 다릅니다".into()), ..Default::default() },
        _ => None,
    };
    let al = |n: &str| if eng.alias_as() { format!(" AS {n}") } else { format!(" {n}") };
    let (sa, sb) = (qa.to_string(), qb.to_string());
    let lower_engine = engine.to_lowercase();
    // MariaDB 는 MySQL 규약상 "5.5.5-10.4.16-MariaDB" 처럼 앞에 5.5.5- 를 붙이기도 한다
    let ver = version.unwrap_or("").to_lowercase();
    let ver = ver.strip_prefix("5.5.5-").unwrap_or(&ver).to_string();
    let except_kw = match eng {
        Eng::Pg | Eng::Ms => Some("EXCEPT"),
        Eng::Ora => Some("MINUS"),
        Eng::My => {
            let maria = lower_engine == "mariadb" || ver.contains("mariadb");
            let ok = if maria { ver_at_least(&ver, &[10, 3]) } else { ver_at_least(&ver, &[8, 0, 31]) };
            if ok {
                Some("EXCEPT")
            } else {
                None
            }
        }
        Eng::Gen => None,
    };
    let count = |s: &str, k: &'static str, label: &str| CompareStep { key: k, label: label.into(), sql: format!("SELECT COUNT(*) AS n FROM ({s}){}", al("q")) };
    let mut steps = vec![count(&sa, "countA", "원문 행 수"), count(&sb, "countB", "정리본 행 수")];
    let mode;
    if let Some(kw) = except_kw {
        // MSSQL·MySQL 은 파생 표의 열 이름이 겹치면 안 된다 — 열 이름은 c1… 로 맞췄다(와일드카드면 원래 이름)
        let diff = |x: &str, y: &str, k: &'static str, label: &str| CompareStep {
            key: k,
            label: label.into(),
            sql: format!("SELECT COUNT(*) AS n FROM (SELECT * FROM ({x}){} {kw} SELECT * FROM ({y}){}){}", al("q1"), al("q2"), al("q")),
        };
        steps.push(diff(&sa, &sb, "aMinusB", "원문에만 있는 행"));
        steps.push(diff(&sb, &sa, "bMinusA", "정리본에만 있는 행"));
        mode = "except";
    } else if let Some(n) = cols {
        let agg = |s: &str, k: &'static str, label: &str| {
            let mut parts = vec!["COUNT(*) AS n".to_string()];
            for i in 1..=n {
                if eng == Eng::My {
                    parts.push(format!("SUM(CRC32(COALESCE(CAST(c{i} AS CHAR), '#null#'))) AS h{i}"));
                } else {
                    parts.push(format!("COUNT(c{i}) AS n{i}, MIN(c{i}) AS lo{i}, MAX(c{i}) AS hi{i}"));
                }
            }
            CompareStep { key: k, label: label.into(), sql: format!("SELECT {} FROM ({s}){}", parts.join(", "), al("q")) }
        };
        steps = vec![agg(&sa, "sumA", "원문 행 수·열별 집계"), agg(&sb, "sumB", "정리본 행 수·열별 집계")];
        mode = "hash";
    } else {
        mode = "count";
    }
    CompareSql { ok: true, reason: None, mode, cols: cols.unwrap_or(0) as u32, steps }
}

/// 결과 같음 확인 SQL 만들기 — 화면이 읽기 문장일 때만 시간 상한을 걸어 db_query 로 돌린다
#[tauri::command(async)]
pub fn sql_compare_sql(a: String, b: String, engine: String, version: Option<String>) -> CompareSql {
    let run = std::thread::Builder::new().name("sql-compare".into()).stack_size(BIG_STACK).spawn(move || compare_sql(&a, &b, &engine, version.as_deref()));
    match run.map(|h| h.join()) {
        Ok(Ok(r)) => r,
        _ => CompareSql { reason: Some("비교 SQL 을 만들지 못했습니다".into()), ..Default::default() },
    }
}

#[cfg(test)]
#[path = "sqlclean_tests.rs"]
mod tests;
