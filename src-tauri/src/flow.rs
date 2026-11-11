//! 터미널 출력 흐름 제어 — 화면(xterm)에 보냈지만 아직 그리지 않은 양을 창(WINDOW) 안으로 묶는다.
//! 대량 출력(cat 큰 파일·yes)에도 화면 큐가 수십 MB 로 쌓이지 않아 Ctrl+C·키 입력이 바로 먹는다.
//! 화면은 그린 뒤 그린 바이트 수를 ack 로 알려 온다(Terminal.tsx).

use std::sync::atomic::{AtomicUsize, Ordering};

/// 화면에 떠 있을 수 있는 최대 양(보냈지만 그리지 않은 바이트)
pub(crate) const WINDOW: usize = 512 * 1024;
/// 한 번에 보내는 묶음 상한
pub(crate) const SEND_CHUNK: usize = 256 * 1024;
/// SSH: 화면이 못 따라올 때 앱 안에 모아 둘 상한 — 넘으면 채널 읽기를 쉰다
pub(crate) const MAX_BUF: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct Flow {
    unacked: AtomicUsize,
    /// SSH(비동기) 쪽 깨우기
    notify: tokio::sync::Notify,
    /// PTY(스레드) 쪽 깨우기
    lock: std::sync::Mutex<()>,
    cv: std::sync::Condvar,
}

impl Flow {
    pub(crate) fn can_send(&self) -> bool {
        self.unacked.load(Ordering::Acquire) < WINDOW
    }
    pub(crate) fn sent(&self, n: usize) {
        self.unacked.fetch_add(n, Ordering::AcqRel);
    }
    pub(crate) fn ack(&self, n: usize) {
        let _ = self.unacked.fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| Some(v.saturating_sub(n)));
        self.wake();
    }
    /// 화면이 사라졌거나 오래 답이 없을 때 — 막힌 것을 푼다
    pub(crate) fn reset(&self) {
        self.unacked.store(0, Ordering::Release);
        self.wake();
    }
    fn wake(&self) {
        self.notify.notify_one();
        let _g = self.lock.lock().unwrap();
        self.cv.notify_all();
    }
    /// SSH: ack 가 올 때까지
    pub(crate) async fn acked(&self) {
        self.notify.notified().await;
    }
    /// PTY 리더 스레드: 창이 찰 동안 기다린다(3초 넘게 답이 없으면 풀고 계속)
    pub(crate) fn wait_room_blocking(&self) {
        let mut g = self.lock.lock().unwrap();
        let start = std::time::Instant::now();
        while !self.can_send() {
            let (ng, _) = self.cv.wait_timeout(g, std::time::Duration::from_millis(200)).unwrap();
            g = ng;
            if start.elapsed() > std::time::Duration::from_secs(3) {
                self.unacked.store(0, Ordering::Release);
                break;
            }
        }
    }
}
