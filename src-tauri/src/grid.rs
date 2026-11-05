//! 결과 표 시제품 — 행은 Rust 쪽에만 두고 화면은 보이는 구간만 받아 그린다(스파이크 5).
//! 실제 DB 결과도 같은 모양으로 들어온다: 열 정보 + 행 수 + `grid_rows(from, to)`.

use std::sync::RwLock;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

#[derive(Default)]
pub struct Grids {
    demo: RwLock<Option<Grid>>,
}

struct Grid {
    rows: Vec<Vec<String>>,
}

#[derive(Serialize, Clone)]
pub struct Column {
    name: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridInfo {
    columns: Vec<Column>,
    count: usize,
    build_ms: f64,
}

const CITIES: [&str; 8] = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "제주"];
const STATUS: [&str; 4] = ["active", "pending", "closed", "archived"];

#[tauri::command]
pub async fn grid_demo_open(grids: State<'_, Grids>, rows: usize) -> Result<GridInfo, String> {
    let started = Instant::now();
    let rows = rows.min(1_000_000);
    let col = |name: &str, kind| Column { name: name.into(), kind };
    let columns = vec![
        col("id", "int"),
        col("name", "text"),
        col("email", "text"),
        col("city", "text"),
        col("amount", "numeric"),
        col("created_at", "timestamp"),
        col("status", "text"),
        col("note", "text"),
    ];
    let mut data = Vec::with_capacity(rows);
    let mut seed: u64 = 0x2026_1105;
    for i in 0..rows {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let day = 1 + (seed % 28);
        let note = if seed % 11 == 0 { "NULL".to_string() } else { format!("메모 {}", seed % 9973) };
        data.push(vec![
            (i + 1).to_string(),
            format!("사용자 {:05}", i + 1),
            format!("user{}@example.com", i + 1),
            CITIES[(seed % 8) as usize].to_string(),
            format!("{}.{:02}", seed % 1_000_000, seed % 100),
            format!("2026-{:02}-{:02} {:02}:{:02}:00", 1 + seed % 12, day, seed % 24, seed % 60),
            STATUS[(seed % 4) as usize].to_string(),
            note,
        ]);
    }
    let count = data.len();
    *grids.demo.write().unwrap() = Some(Grid { rows: data });
    Ok(GridInfo { columns, count, build_ms: started.elapsed().as_secs_f64() * 1000.0 })
}

#[tauri::command]
pub fn grid_rows(grids: State<'_, Grids>, from: usize, to: usize) -> Result<Vec<Vec<String>>, String> {
    let g = grids.demo.read().unwrap();
    let g = g.as_ref().ok_or("열린 결과가 없습니다")?;
    let to = to.min(g.rows.len());
    let from = from.min(to);
    Ok(g.rows[from..to].to_vec())
}

#[tauri::command]
pub fn grid_close(grids: State<'_, Grids>) {
    *grids.demo.write().unwrap() = None;
}
