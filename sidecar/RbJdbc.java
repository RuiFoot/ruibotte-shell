// RuiBotte Shell JDBC 브리지 — Rust 앱이 띄우는 별도 프로세스. Java 11+, 외부 라이브러리 없음.
// 표준입력으로 한 줄 JSON 요청을 받고, 표준출력으로 한 줄 JSON 응답을 보낸다(로그는 표준오류).
//   {"id":1,"op":"connect","url":"jdbc:…","user":"u","password":"p","driver":"oracle.jdbc.OracleDriver","readOnly":true}
//   {"id":2,"op":"query","sql":"select …","maxRows":10000}   → columns · rows(500행씩) · done | error
//   {"id":3,"op":"cancel"}                                      → 실행 중인 문장 Statement.cancel()
//   {"id":4,"op":"tree","path":["SCHEMA","TABLE"]}             → DatabaseMetaData 로 스키마·표·열
//   {"id":5,"op":"close"}
// 암호는 메모리에만 두고 출력하지 않는다.

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.ServiceLoader;

public final class RbJdbc {
    private static final PrintStream OUT = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    private static volatile Connection conn;
    private static volatile Statement running;
    private static final Object WRITE = new Object();

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        send(Map.of("type", "hello", "java", System.getProperty("java.version")));
        String line;
        Thread worker = null;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) continue;
            Map<String, Object> req;
            try {
                req = Json.parseObject(line);
            } catch (RuntimeException e) {
                send(Map.of("type", "error", "code", "OTHER", "message", "요청을 읽지 못했습니다"));
                continue;
            }
            Object id = req.get("id");
            String op = String.valueOf(req.get("op"));
            switch (op) {
                case "cancel": {
                    Statement s = running;
                    if (s != null) {
                        try {
                            s.cancel();
                        } catch (SQLException e) {
                            // 드라이버가 취소를 지원하지 않으면 끝날 때까지 기다린다
                        }
                    }
                    send(Map.of("id", id, "type", "ok"));
                    break;
                }
                case "close": {
                    if (conn != null) try { conn.close(); } catch (SQLException ignored) { }
                    send(Map.of("id", id, "type", "ok"));
                    return;
                }
                default: {
                    if (worker != null && worker.isAlive()) {
                        send(Map.of("id", id, "type", "error", "code", "BUSY", "message", "앞 문장이 아직 실행 중입니다"));
                        break;
                    }
                    worker = new Thread(() -> handle(id, op, req), "rb-jdbc-work");
                    worker.setDaemon(true);
                    worker.start();
                }
            }
        }
    }

    private static void handle(Object id, String op, Map<String, Object> req) {
        try {
            switch (op) {
                case "connect": connect(id, req); break;
                case "query": query(id, req); break;
                case "tree": tree(id, req); break;
                case "meta": meta(id, req); break;
                case "apply": apply(id, req); break;
                case "tx": tx(id, req); break;
                default: send(Map.of("id", id, "type", "error", "code", "OTHER", "message", "알 수 없는 요청"));
            }
        } catch (SQLException e) {
            send(sqlError(id, e));
        } catch (Throwable t) {
            send(Map.of("id", id, "type", "error", "code", "OTHER", "message", String.valueOf(t)));
        }
    }

    private static Map<String, Object> sqlError(Object id, SQLException e) {
        String state = e.getSQLState() == null ? "" : e.getSQLState();
        String code = "SQL";
        String msg = e.getMessage() == null ? e.toString() : e.getMessage();
        if (state.startsWith("28") || msg.contains("ORA-01017") || msg.toLowerCase().contains("login failed")) code = "AUTH_FAILED";
        else if (state.startsWith("08")) code = "NETWORK";
        else if (msg.contains("ORA-01013") || state.equals("HY008") || msg.toLowerCase().contains("cancel")) code = "CANCELLED";
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", "error");
        m.put("code", code);
        m.put("message", msg + (state.isEmpty() ? "" : " (" + state + ")"));
        return m;
    }

    private static void connect(Object id, Map<String, Object> req) throws Exception {
        String driver = (String) req.get("driver");
        if (driver != null && !driver.isEmpty()) {
            try {
                Driver d = (Driver) Class.forName(driver).getDeclaredConstructor().newInstance();
                DriverManager.registerDriver(new Shim(d));
            } catch (ClassNotFoundException e) {
                // ServiceLoader 로 등록되는 드라이버면 괜찮다
            }
        }
        for (Driver d : ServiceLoader.load(Driver.class)) {
            // 로드만 해 두면 DriverManager 가 찾는다
            d.getClass();
        }
        Properties p = new Properties();
        if (req.get("user") != null) p.setProperty("user", (String) req.get("user"));
        if (req.get("password") != null) p.setProperty("password", (String) req.get("password"));
        DriverManager.setLoginTimeout(12);
        long t0 = System.nanoTime();
        conn = DriverManager.getConnection((String) req.get("url"), p);
        if (Boolean.TRUE.equals(req.get("readOnly"))) {
            try { conn.setReadOnly(true); } catch (SQLException ignored) { }
        }
        DatabaseMetaData md = conn.getMetaData();
        Map<String, Object> ok = new LinkedHashMap<>();
        ok.put("id", id);
        ok.put("type", "ok");
        ok.put("version", md.getDatabaseProductName() + " " + md.getDatabaseProductVersion());
        ok.put("driver", md.getDriverName() + " " + md.getDriverVersion());
        ok.put("ms", (System.nanoTime() - t0) / 1_000_000);
        send(ok);
    }

    private static String kind(int t) {
        switch (t) {
            case Types.TINYINT: case Types.SMALLINT: case Types.INTEGER: case Types.BIGINT: return "int";
            case Types.DECIMAL: case Types.NUMERIC: case Types.FLOAT: case Types.REAL: case Types.DOUBLE: return "numeric";
            case Types.DATE: case Types.TIME: case Types.TIMESTAMP: case Types.TIME_WITH_TIMEZONE: case Types.TIMESTAMP_WITH_TIMEZONE: return "date";
            case Types.BIT: case Types.BOOLEAN: return "bool";
            case Types.BINARY: case Types.VARBINARY: case Types.LONGVARBINARY: case Types.BLOB: return "binary";
            default: return "text";
        }
    }

    private static void query(Object id, Map<String, Object> req) throws SQLException {
        Connection c = need();
        String sql = (String) req.get("sql");
        int max = req.get("maxRows") instanceof Number ? ((Number) req.get("maxRows")).intValue() : 10000;
        long t0 = System.nanoTime();
        try (Statement st = c.createStatement()) {
            running = st;
            st.setFetchSize(500);
            boolean isSet = st.execute(sql);
            Long firstRow = null;
            int count = 0;
            boolean truncated = false;
            long affected = -1;
            if (isSet) {
                try (ResultSet rs = st.getResultSet()) {
                    ResultSetMetaData md = rs.getMetaData();
                    int n = md.getColumnCount();
                    List<Object> cols = new ArrayList<>();
                    for (int i = 1; i <= n; i++) cols.add(Map.of("name", md.getColumnLabel(i), "kind", kind(md.getColumnType(i))));
                    send(Map.of("id", id, "type", "columns", "columns", cols));
                    List<Object> batch = new ArrayList<>();
                    while (rs.next()) {
                        if (firstRow == null) firstRow = (System.nanoTime() - t0) / 1_000_000;
                        if (count >= max) {
                            truncated = true;
                            try { st.cancel(); } catch (SQLException ignored) { }
                            break;
                        }
                        List<Object> row = new ArrayList<>(n);
                        for (int i = 1; i <= n; i++) {
                            int ty = md.getColumnType(i);
                            if (ty == Types.BLOB || ty == Types.BINARY || ty == Types.VARBINARY || ty == Types.LONGVARBINARY) {
                                byte[] b = rs.getBytes(i);
                                row.add(b == null ? null : hex(b));
                            } else {
                                row.add(rs.getString(i));
                            }
                        }
                        batch.add(row);
                        count++;
                        if (batch.size() >= 500) {
                            send(Map.of("id", id, "type", "rows", "rows", batch));
                            batch = new ArrayList<>();
                        }
                    }
                    if (!batch.isEmpty()) send(Map.of("id", id, "type", "rows", "rows", batch));
                }
            } else {
                affected = st.getUpdateCount();
            }
            Map<String, Object> done = new LinkedHashMap<>();
            done.put("id", id);
            done.put("type", "done");
            done.put("resultSet", isSet);
            done.put("rowCount", count);
            done.put("affected", affected < 0 ? null : affected);
            done.put("truncated", truncated);
            done.put("ms", (System.nanoTime() - t0) / 1_000_000);
            done.put("firstRowMs", firstRow);
            send(done);
        } finally {
            running = null;
        }
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder("0x");
        for (int i = 0; i < Math.min(b.length, 64); i++) s.append(String.format("%02X", b[i]));
        if (b.length > 64) s.append("…");
        return s.toString();
    }

    private static void tree(Object id, Map<String, Object> req) throws SQLException {
        Connection c = need();
        DatabaseMetaData md = c.getMetaData();
        @SuppressWarnings("unchecked")
        List<Object> path = req.get("path") instanceof List ? (List<Object>) req.get("path") : List.of();
        List<Object> nodes = new ArrayList<>();
        boolean useCatalogs = !md.supportsSchemasInTableDefinitions() && md.supportsCatalogsInTableDefinitions();
        if (path.isEmpty()) {
            try (ResultSet rs = useCatalogs ? md.getCatalogs() : md.getSchemas()) {
                while (rs.next()) nodes.add(node(rs.getString(1), "schema", null));
            }
            if (nodes.isEmpty()) nodes.add(node("(기본)", "schema", null));
        } else if (path.size() == 1) {
            String s = "(기본)".equals(path.get(0)) ? null : (String) path.get(0);
            try (ResultSet rs = useCatalogs ? md.getTables(s, null, "%", new String[] {"TABLE", "VIEW"}) : md.getTables(null, s, "%", new String[] {"TABLE", "VIEW"})) {
                while (rs.next()) nodes.add(node(rs.getString("TABLE_NAME"), "VIEW".equalsIgnoreCase(rs.getString("TABLE_TYPE")) ? "view" : "table", null));
            }
        } else {
            String s = "(기본)".equals(path.get(0)) ? null : (String) path.get(0);
            String t = (String) path.get(1);
            try (ResultSet rs = useCatalogs ? md.getColumns(s, null, t, "%") : md.getColumns(null, s, t, "%")) {
                while (rs.next()) {
                    String detail = rs.getString("TYPE_NAME") + ("NO".equals(rs.getString("IS_NULLABLE")) ? " · NOT NULL" : "");
                    nodes.add(node(rs.getString("COLUMN_NAME"), "column", detail));
                }
            }
        }
        send(Map.of("id", id, "type", "ok", "nodes", nodes));
    }

    /** 표 열 정보 — 형식·NULL·기본값·PK */
    private static void meta(Object id, Map<String, Object> req) throws SQLException {
        Connection c = need();
        DatabaseMetaData md = c.getMetaData();
        String s = req.get("schema") == null || "(기본)".equals(req.get("schema")) ? null : (String) req.get("schema");
        String t = (String) req.get("table");
        boolean useCatalogs = !md.supportsSchemasInTableDefinitions() && md.supportsCatalogsInTableDefinitions();
        java.util.Set<String> pks = new java.util.HashSet<>();
        try (ResultSet rs = useCatalogs ? md.getPrimaryKeys(s, null, t) : md.getPrimaryKeys(null, s, t)) {
            while (rs.next()) pks.add(rs.getString("COLUMN_NAME"));
        }
        List<Object> cols = new ArrayList<>();
        try (ResultSet rs = useCatalogs ? md.getColumns(s, null, t, "%") : md.getColumns(null, s, t, "%")) {
            while (rs.next()) {
                Map<String, Object> m = new LinkedHashMap<>();
                String name = rs.getString("COLUMN_NAME");
                m.put("name", name);
                m.put("dataType", rs.getString("TYPE_NAME"));
                m.put("nullable", rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
                m.put("default", rs.getString("COLUMN_DEF"));
                m.put("pk", pks.contains(name));
                cols.add(m);
            }
        }
        send(Map.of("id", id, "type", "ok", "columns", cols));
    }

    /** 표 편집 반영 — 한 트랜잭션(수동 트랜잭션 중이면 세이브포인트), UPDATE·DELETE 는 정확히 1행 */
    @SuppressWarnings("unchecked")
    private static void apply(Object id, Map<String, Object> req) throws SQLException {
        Connection c = need();
        boolean inTx = Boolean.TRUE.equals(req.get("inTx"));
        boolean auto = c.getAutoCommit();
        java.sql.Savepoint sp = null;
        if (inTx) sp = c.setSavepoint("rb_apply");
        else c.setAutoCommit(false);
        List<Object> affected = new ArrayList<>();
        try {
            int i = 0;
            for (Object o : (List<Object>) req.get("stmts")) {
                Map<String, Object> st = (Map<String, Object>) o;
                try (java.sql.PreparedStatement ps = c.prepareStatement((String) st.get("sql"))) {
                    int k = 1;
                    for (Object p : (List<Object>) st.get("params")) {
                        if (p == null) ps.setNull(k++, Types.VARCHAR);
                        else ps.setString(k++, (String) p);
                    }
                    int n = ps.executeUpdate();
                    affected.add(n);
                    i++;
                    if (Boolean.TRUE.equals(st.get("expectOne")) && n != 1) {
                        throw new SQLException(i + "번째 문장이 " + n + "행에 닿았습니다(1행이어야 함) — 모두 되돌렸습니다", "RB001");
                    }
                }
            }
            if (inTx) c.releaseSavepoint(sp);
            else c.commit();
        } catch (SQLException e) {
            if (inTx) c.rollback(sp);
            else c.rollback();
            throw e;
        } finally {
            if (!inTx) c.setAutoCommit(auto);
        }
        send(Map.of("id", id, "type", "ok", "affected", affected));
    }

    /** 수동 트랜잭션 */
    private static void tx(Object id, Map<String, Object> req) throws SQLException {
        Connection c = need();
        String a = String.valueOf(req.get("action"));
        if ("begin".equals(a)) c.setAutoCommit(false);
        else if ("commit".equals(a)) { c.commit(); c.setAutoCommit(true); }
        else if ("rollback".equals(a)) { c.rollback(); c.setAutoCommit(true); }
        send(Map.of("id", id, "type", "ok"));
    }

    private static Map<String, Object> node(String name, String kind, String detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("kind", kind);
        m.put("detail", detail);
        return m;
    }

    private static Connection need() throws SQLException {
        if (conn == null) throw new SQLException("연결 전입니다", "08003");
        return conn;
    }

    private static void send(Map<String, Object> m) {
        String s = Json.write(m);
        synchronized (WRITE) {
            OUT.println(s);
        }
    }

    /** 드라이버를 앱 클래스로더 밖에서 올렸을 때 DriverManager 가 받아 주도록 감싸는 껍질 */
    private static final class Shim implements Driver {
        private final Driver d;
        Shim(Driver d) { this.d = d; }
        public Connection connect(String u, Properties p) throws SQLException { return d.connect(u, p); }
        public boolean acceptsURL(String u) throws SQLException { return d.acceptsURL(u); }
        public java.sql.DriverPropertyInfo[] getPropertyInfo(String u, Properties p) throws SQLException { return d.getPropertyInfo(u, p); }
        public int getMajorVersion() { return d.getMajorVersion(); }
        public int getMinorVersion() { return d.getMinorVersion(); }
        public boolean jdbcCompliant() { return d.jdbcCompliant(); }
        public java.util.logging.Logger getParentLogger() throws java.sql.SQLFeatureNotSupportedException { return d.getParentLogger(); }
    }

    /** 아주 작은 JSON — 요청 읽기(객체·배열·문자열·숫자·참거짓·null)와 응답 쓰기만 */
    static final class Json {
        private final String s;
        private int i;
        private Json(String s) { this.s = s; }

        @SuppressWarnings("unchecked")
        static Map<String, Object> parseObject(String s) {
            Object v = new Json(s).value();
            if (!(v instanceof Map)) throw new IllegalArgumentException("object");
            return (Map<String, Object>) v;
        }

        private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

        private Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') {
                i++;
                Map<String, Object> m = new LinkedHashMap<>();
                ws();
                if (s.charAt(i) == '}') { i++; return m; }
                while (true) {
                    ws();
                    String k = string();
                    ws();
                    i++; // :
                    m.put(k, value());
                    ws();
                    if (s.charAt(i++) == '}') return m;
                }
            }
            if (c == '[') {
                i++;
                List<Object> l = new ArrayList<>();
                ws();
                if (s.charAt(i) == ']') { i++; return l; }
                while (true) {
                    l.add(value());
                    ws();
                    if (s.charAt(i++) == ']') return l;
                }
            }
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int st = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String num = s.substring(st, i);
            return num.contains(".") || num.contains("e") || num.contains("E") ? (Object) Double.parseDouble(num) : (Object) Long.parseLong(num);
        }

        private String string() {
            i++; // "
            StringBuilder b = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c == '\\') {
                    char e = s.charAt(i++);
                    switch (e) {
                        case 'n': b.append('\n'); break;
                        case 'r': b.append('\r'); break;
                        case 't': b.append('\t'); break;
                        case 'b': b.append('\b'); break;
                        case 'f': b.append('\f'); break;
                        case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                        default: b.append(e);
                    }
                } else b.append(c);
            }
        }

        static String write(Object o) {
            StringBuilder b = new StringBuilder();
            w(b, o);
            return b.toString();
        }

        @SuppressWarnings("unchecked")
        private static void w(StringBuilder b, Object o) {
            if (o == null) b.append("null");
            else if (o instanceof String) str(b, (String) o);
            else if (o instanceof Number || o instanceof Boolean) b.append(o);
            else if (o instanceof Map) {
                b.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                    if (!first) b.append(',');
                    first = false;
                    str(b, e.getKey());
                    b.append(':');
                    w(b, e.getValue());
                }
                b.append('}');
            } else if (o instanceof List) {
                b.append('[');
                boolean first = true;
                for (Object x : (List<Object>) o) {
                    if (!first) b.append(',');
                    first = false;
                    w(b, x);
                }
                b.append(']');
            } else str(b, o.toString());
        }

        private static void str(StringBuilder b, String s) {
            b.append('"');
            for (int k = 0; k < s.length(); k++) {
                char c = s.charAt(k);
                switch (c) {
                    case '"': b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    default:
                        if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                }
            }
            b.append('"');
        }
    }
}
