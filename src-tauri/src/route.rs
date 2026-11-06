//! 서버 경로 — 한 서버에 닿는 길 여럿(사내 직접·외부 주소·점프 경유·프록시 경유)을 순서대로 시도한다.
//! - 망 판별: 지금 PC 의 기본 게이트웨이 IP·DNS 접미사·Wi-Fi 이름, 또는 특정 호스트:포트가 300ms 안에 닿는지.
//!   Windows 는 GetAdaptersAddresses·WLAN API, macOS 는 route·scutil·ipconfig, 그 밖은 ip·resolv.conf·nmcli.
//!   읽지 못하는 값은 "알 수 없음" — 그 조건의 경로는 조건 없는 경로 뒤로 미룬다.
//! - 첫 구간 전송로: TCP 바로 · HTTP CONNECT · SOCKS5(원격 이름 풀이) · ProxyCommand(자식 프로세스 표준 입출력, 창 숨김).
//!   점프 단계는 ssh.rs 가 이 전송로 위에 direct-tcpip 를 이어 붙인다.

use std::net::IpAddr;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;

use crate::store::{Hop, Route};

// ── 지금 망 ──────────────────────────

/// 지금 PC 의 망 값 — supports* 가 false 면 그 조건은 이 PC 에서 볼 수 없다(화면이 숨긴다)
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetInfo {
    pub gateways: Vec<String>,
    pub dns_suffixes: Vec<String>,
    pub wifi: Vec<String>,
    pub supports_gateway: bool,
    pub supports_dns: bool,
    pub supports_wifi: bool,
    /// Wi-Fi 이름을 못 읽은 까닭(위치 권한 등)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wifi_note: Option<String>,
}

static NET_CACHE: LazyLock<Mutex<Option<(Instant, NetInfo)>>> = LazyLock::new(Default::default);

/// 망 값(5초 동안은 같은 값을 쓴다 — 경로 여럿을 볼 때 한 번만 읽게)
pub(crate) async fn net_info() -> NetInfo {
    if let Some((t, n)) = NET_CACHE.lock().unwrap().as_ref() {
        if t.elapsed() < Duration::from_secs(5) {
            return n.clone();
        }
    }
    let n = tokio::task::spawn_blocking(read_net).await.unwrap_or_default();
    *NET_CACHE.lock().unwrap() = Some((Instant::now(), n.clone()));
    n
}

#[tauri::command]
pub async fn net_info_get() -> NetInfo {
    *NET_CACHE.lock().unwrap() = None;
    net_info().await
}

fn push_unique(v: &mut Vec<String>, s: &str) {
    let s = s.trim().trim_end_matches('.');
    if !s.is_empty() && !v.iter().any(|x| x.eq_ignore_ascii_case(s)) {
        v.push(s.to_string());
    }
}

#[cfg(windows)]
fn read_net() -> NetInfo {
    let mut n = NetInfo { supports_gateway: true, supports_dns: true, ..Default::default() };
    win::adapters(&mut n);
    win::wifi(&mut n);
    n
}

#[cfg(windows)]
mod win {
    use super::{push_unique, NetInfo};
    use std::net::{Ipv4Addr, Ipv6Addr};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6, SOCKET_ADDRESS};

    unsafe fn wide(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0;
        while *p.add(len) != 0 && len < 1024 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }

    unsafe fn sock_ip(a: &SOCKET_ADDRESS) -> Option<String> {
        if a.lpSockaddr.is_null() {
            return None;
        }
        match (*a.lpSockaddr).sa_family {
            AF_INET => {
                let s = &*(a.lpSockaddr as *const SOCKADDR_IN);
                Some(Ipv4Addr::from(u32::from_be(s.sin_addr.S_un.S_addr)).to_string())
            }
            AF_INET6 => {
                let s = &*(a.lpSockaddr as *const SOCKADDR_IN6);
                Some(Ipv6Addr::from(s.sin6_addr.u.Byte).to_string())
            }
            _ => None,
        }
    }

    /// 켜진 어댑터의 기본 게이트웨이·DNS 접미사
    pub(super) fn adapters(n: &mut NetInfo) {
        let mut size: u32 = 32 * 1024;
        for _ in 0..3 {
            // u64 로 잡아 구조체 정렬을 맞춘다
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            let p = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
            let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
            let r = unsafe { GetAdaptersAddresses(AF_UNSPEC as u32, flags, std::ptr::null(), p, &mut size) };
            if r == 111 {
                continue; // ERROR_BUFFER_OVERFLOW — size 가 바뀌었다
            }
            if r != 0 {
                n.supports_gateway = false;
                n.supports_dns = false;
                return;
            }
            let mut cur = p;
            unsafe {
                while !cur.is_null() {
                    let a = &*cur;
                    if a.OperStatus == IfOperStatusUp {
                        let mut g = a.FirstGatewayAddress;
                        let has_gw = !g.is_null();
                        while !g.is_null() {
                            if let Some(ip) = sock_ip(&(*g).Address) {
                                if ip != "0.0.0.0" && ip != "::" {
                                    push_unique(&mut n.gateways, &ip);
                                }
                            }
                            g = (*g).Next;
                        }
                        // 게이트웨이가 있는(밖으로 나가는) 어댑터의 접미사만 — 가상 어댑터 잡음을 줄인다
                        if has_gw {
                            push_unique(&mut n.dns_suffixes, &wide(a.DnsSuffix));
                            let mut s = a.FirstDnsSuffix;
                            while !s.is_null() {
                                push_unique(&mut n.dns_suffixes, &wide((*s).String.as_ptr()));
                                s = (*s).Next;
                            }
                        }
                    }
                    cur = a.Next;
                }
            }
            return;
        }
    }

    /// 연결된 Wi-Fi 이름 — Windows 11 24H2 부터는 위치 권한이 없으면 읽지 못한다
    pub(super) fn wifi(n: &mut NetInfo) {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::NetworkManagement::WiFi::{
            wlan_interface_state_connected, wlan_intf_opcode_current_connection, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle,
            WlanQueryInterface, WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST,
        };
        unsafe {
            let mut ver = 0u32;
            let mut h: HANDLE = std::ptr::null_mut();
            if WlanOpenHandle(2, std::ptr::null(), &mut ver, &mut h) != 0 {
                return; // 무선 서비스 없음(유선 전용 PC 등)
            }
            n.supports_wifi = true;
            let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
            if WlanEnumInterfaces(h, std::ptr::null(), &mut list) == 0 && !list.is_null() {
                let count = (*list).dwNumberOfItems as usize;
                let items = std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), count);
                for it in items {
                    if it.isState != wlan_interface_state_connected {
                        continue;
                    }
                    let mut size = 0u32;
                    let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
                    let r = WlanQueryInterface(h, &it.InterfaceGuid, wlan_intf_opcode_current_connection, std::ptr::null(), &mut size, &mut data, std::ptr::null_mut());
                    if r == 0 && !data.is_null() {
                        let c = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
                        let ssid = &c.wlanAssociationAttributes.dot11Ssid;
                        let len = (ssid.uSSIDLength as usize).min(32);
                        let name = String::from_utf8_lossy(&ssid.ucSSID[..len]).into_owned();
                        if name.is_empty() {
                            n.wifi_note = Some("Wi-Fi 이름이 비어 있습니다 — Windows 설정의 위치 권한을 켜야 읽힐 수 있습니다".into());
                        }
                        push_unique(&mut n.wifi, &name);
                        WlanFreeMemory(data);
                    } else if r == 5 {
                        n.wifi_note = Some("Wi-Fi 이름을 읽을 권한이 없습니다 — Windows 설정 > 개인 정보 > 위치에서 앱의 위치 접근을 켜세요".into());
                    }
                }
                WlanFreeMemory(list as *const _);
            }
            WlanCloseHandle(h, std::ptr::null());
        }
    }
}

/// 명령 결과(창 없이, 2초 상한은 호출하는 쪽 spawn_blocking 이 받는다)
#[cfg(not(windows))]
fn run_out(prog: &str, args: &[&str]) -> Option<String> {
    let o = std::process::Command::new(prog).args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn read_net() -> NetInfo {
    let mut n = NetInfo::default();
    if let Some(out) = run_out("/sbin/route", &["-n", "get", "default"]) {
        n.supports_gateway = true;
        for l in out.lines() {
            if let Some(v) = l.trim().strip_prefix("gateway:") {
                push_unique(&mut n.gateways, v);
            }
        }
    }
    if let Some(out) = run_out("/usr/sbin/scutil", &["--dns"]) {
        n.supports_dns = true;
        for l in out.lines() {
            let l = l.trim();
            if l.starts_with("search domain") || l.starts_with("domain ") {
                if let Some((_, v)) = l.split_once(':') {
                    push_unique(&mut n.dns_suffixes, v);
                }
            }
        }
    }
    // macOS 14 부터 SSID 는 위치 권한이 없으면 <redacted>
    for dev in ["en0", "en1"] {
        if let Some(out) = run_out("/usr/sbin/ipconfig", &["getsummary", dev]) {
            n.supports_wifi = true;
            for l in out.lines() {
                if let Some(v) = l.trim().strip_prefix("SSID : ") {
                    if v.contains("redacted") {
                        n.wifi_note = Some("Wi-Fi 이름이 가려져 있습니다 — 시스템 설정 > 개인정보 보호 > 위치 서비스에서 허용해야 읽힙니다".into());
                    } else {
                        push_unique(&mut n.wifi, v);
                    }
                }
            }
        }
    }
    n
}

#[cfg(all(unix, not(target_os = "macos")))]
fn read_net() -> NetInfo {
    let mut n = NetInfo::default();
    if let Some(out) = run_out("ip", &["route", "show", "default"]) {
        n.supports_gateway = true;
        for l in out.lines() {
            let w: Vec<&str> = l.split_whitespace().collect();
            if let Some(i) = w.iter().position(|x| *x == "via") {
                if let Some(g) = w.get(i + 1) {
                    push_unique(&mut n.gateways, g);
                }
            }
        }
    }
    if let Ok(t) = std::fs::read_to_string("/etc/resolv.conf") {
        n.supports_dns = true;
        for l in t.lines() {
            let mut w = l.split_whitespace();
            if matches!(w.next(), Some("search") | Some("domain")) {
                for d in w {
                    push_unique(&mut n.dns_suffixes, d);
                }
            }
        }
    }
    if let Some(out) = run_out("nmcli", &["-t", "-f", "active,ssid", "dev", "wifi"]) {
        n.supports_wifi = true;
        for l in out.lines() {
            if let Some(v) = l.strip_prefix("yes:") {
                push_unique(&mut n.wifi, v);
            }
        }
    } else if let Some(out) = run_out("iwgetid", &["-r"]) {
        n.supports_wifi = true;
        push_unique(&mut n.wifi, &out);
    }
    n
}

// ── 망 조건 ──────────────────────────

/// 경로의 망 조건 결과
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CondState {
    /// 조건 없음
    None,
    Match,
    NoMatch,
    /// 이 PC 에서 볼 수 없는 값
    Unknown,
}

pub(crate) const COND_NAME: [(&str, &str); 4] = [("gateway", "기본 게이트웨이"), ("dns", "DNS 접미사"), ("wifi", "Wi-Fi"), ("reach", "닿는 호스트")];

pub(crate) fn cond_text(r: &Route) -> Option<String> {
    let k = r.cond_kind.as_deref()?;
    let name = COND_NAME.iter().find(|(x, _)| *x == k).map(|(_, n)| *n).unwrap_or(k);
    Some(format!("{name} {}{}", r.cond_value.as_deref().unwrap_or(""), if r.cond_not { " 이(가) 아닐 때" } else { " 일 때" }))
}

/// 조건 판정 — (결과, 설명)
pub(crate) async fn cond_state(r: &Route, net: &NetInfo) -> (CondState, String) {
    let (Some(kind), Some(v)) = (r.cond_kind.as_deref(), r.cond_value.as_deref()) else {
        return (CondState::None, String::new());
    };
    let wants: Vec<&str> = v.split([',', ' ']).map(str::trim).filter(|x| !x.is_empty()).collect();
    let any = |have: &[String], suffix: bool| {
        wants.iter().any(|w| {
            let w = w.trim_start_matches('.');
            have.iter().any(|h| h.eq_ignore_ascii_case(w) || (suffix && h.to_lowercase().ends_with(&format!(".{}", w.to_lowercase()))))
        })
    };
    let (supported, hit, now) = match kind {
        "gateway" => (net.supports_gateway, any(&net.gateways, false), net.gateways.join(", ")),
        "dns" => (net.supports_dns, any(&net.dns_suffixes, true), net.dns_suffixes.join(", ")),
        "wifi" => (net.supports_wifi && net.wifi_note.is_none() || !net.wifi.is_empty(), any(&net.wifi, false), net.wifi.join(", ")),
        "reach" => {
            let mut hit = false;
            let mut seen = Vec::new();
            for w in &wants {
                if let Some((h, p)) = crate::store::split_host_port(w) {
                    let t = Instant::now();
                    let ok = matches!(tokio::time::timeout(Duration::from_millis(300), TcpStream::connect((h.as_str(), p))).await, Ok(Ok(_)));
                    seen.push(format!("{w} {}", if ok { format!("닿음 {}ms", t.elapsed().as_millis()) } else { "안 닿음".into() }));
                    hit |= ok;
                }
            }
            (true, hit, seen.join(", "))
        }
        _ => (false, false, String::new()),
    };
    if !supported {
        return (CondState::Unknown, "이 PC 에서 그 값을 읽지 못했습니다".into());
    }
    let now = if now.is_empty() { "없음".to_string() } else { now };
    let ok = hit != r.cond_not;
    (if ok { CondState::Match } else { CondState::NoMatch }, format!("지금: {now}"))
}

/// 시도할 순서 — 조건이 맞는 경로 → 조건 없는 경로 → 알 수 없는 경로. 안 맞는 경로는 건너뛴다(다 안 맞으면 모두 시도)
pub(crate) async fn plan(routes: Vec<Route>) -> (Vec<Route>, Vec<(Route, String)>) {
    let net = net_info().await;
    let mut tagged = Vec::new();
    for r in routes {
        let (s, why) = cond_state(&r, &net).await;
        tagged.push((r, s, why));
    }
    let rank = |s: CondState| match s {
        CondState::Match => 0,
        CondState::None => 1,
        CondState::Unknown => 2,
        CondState::NoMatch => 3,
    };
    tagged.sort_by_key(|(r, s, _)| (rank(*s), r.ord));
    if tagged.iter().all(|(_, s, _)| *s == CondState::NoMatch) {
        return (tagged.into_iter().map(|(r, ..)| r).collect(), Vec::new());
    }
    let mut go = Vec::new();
    let mut skipped = Vec::new();
    for (r, s, why) in tagged {
        if s == CondState::NoMatch {
            skipped.push((r, why));
        } else {
            go.push(r);
        }
    }
    (go, skipped)
}

/// 화면·오류에 쓰는 경로 이름 — 라벨, 없으면 "경로 n"
pub(crate) fn route_name(r: &Route) -> String {
    r.label.clone().unwrap_or_else(|| format!("경로 {}", r.ord + 1))
}

/// 경로 줄임 — "점프 a → b · SOCKS5 프록시 · host:22"
pub(crate) fn route_summary(r: &Route, hop_name: impl Fn(&Hop) -> String) -> String {
    let mut parts = Vec::new();
    match r.proxy_kind.as_deref() {
        Some("http") => parts.push(format!("HTTP 프록시 {}:{}", r.proxy_host.as_deref().unwrap_or(""), r.proxy_port.unwrap_or(0))),
        Some("socks5") => parts.push(format!("SOCKS5 프록시 {}:{}", r.proxy_host.as_deref().unwrap_or(""), r.proxy_port.unwrap_or(0))),
        Some("command") => parts.push("프록시 명령".into()),
        _ => {}
    }
    if !r.jumps.is_empty() {
        parts.push(format!("점프 {}", r.jumps.iter().map(hop_name).collect::<Vec<_>>().join(" → ")));
    }
    parts.push(format!("{}:{}", r.host, r.port));
    parts.join(" · ")
}

/// 저장한 경로가 없을 때(새 서버 시험·예전 자료) — 요청의 주소와 점프 하나로
pub(crate) fn adhoc(profile_id: i64, host: &str, port: u16, jump_id: Option<i64>) -> Route {
    Route {
        profile_id,
        host: host.to_string(),
        port,
        jumps: jump_id.map(|j| vec![Hop { profile_id: j, account_id: None }]).unwrap_or_default(),
        ..Default::default()
    }
}

// ── 전송로 ───────────────────────────

/// SSH 가 올라탈 바이트 흐름
pub(crate) trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub(crate) type BoxIo = Box<dyn Io>;

/// 전송로를 못 연 까닭(쉬운 설명 hint 포함)
#[derive(Debug, Clone)]
pub(crate) struct LegErr {
    pub(crate) message: String,
    pub(crate) hint: Option<String>,
}

fn leg(_stage: &'static str, message: impl Into<String>, hint: Option<String>) -> LegErr {
    LegErr { message: message.into(), hint }
}

/// 사설·링크 로컬 주소(같은 망·VPN 에서만 닿는 주소)
pub(crate) fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_link_local() || v.octets()[0] == 100 && (64..128).contains(&v.octets()[1]),
        IpAddr::V6(v) => (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// 이름 풀이 — (주소들, 걸린 시간)
pub(crate) async fn resolve(host: &str, port: u16, limit: Duration) -> Result<(Vec<std::net::SocketAddr>, Duration), LegErr> {
    let t = Instant::now();
    match tokio::time::timeout(limit, tokio::net::lookup_host((host, port))).await {
        Err(_) => Err(leg("dns", format!("{host} 이름 풀이가 {}초 안에 끝나지 않았습니다", limit.as_secs()), Some(dns_hint()))),
        Ok(Err(e)) => Err(leg("dns", format!("{host} 이름을 찾지 못했습니다 ({e})"), Some(dns_hint()))),
        Ok(Ok(it)) => {
            let v: Vec<_> = it.collect();
            if v.is_empty() {
                Err(leg("dns", format!("{host} 이름에 주소가 없습니다"), Some(dns_hint())))
            } else {
                Ok((v, t.elapsed()))
            }
        }
    }
}

fn dns_hint() -> String {
    "주소에 오타가 있거나, 사내 DNS 에서만 풀리는 이름일 수 있습니다(사내망·VPN 연결을 확인하세요)".into()
}

/// TCP 연결 실패의 쉬운 설명
pub(crate) fn tcp_hint(e: Option<&std::io::Error>, ip: Option<&IpAddr>) -> String {
    let private = ip.filter(|i| is_private(i)).map(|i| format!(" {i} 은(는) 사설 주소라 같은 망이나 VPN 에서만 닿습니다.")).unwrap_or_default();
    let base = match e.map(|e| e.kind()) {
        Some(std::io::ErrorKind::ConnectionRefused) => "포트가 닫혀 있습니다 — SSH 서버가 꺼져 있거나 포트 번호가 다를 수 있습니다.",
        Some(std::io::ErrorKind::NetworkUnreachable) | Some(std::io::ErrorKind::HostUnreachable) => {
            "이 PC 에서 그 망으로 가는 길이 없습니다 — 네트워크 연결·VPN 을 확인하세요."
        }
        Some(std::io::ErrorKind::PermissionDenied) => "이 PC 의 방화벽·보안 프로그램이 연결을 막았습니다.",
        _ => "응답이 없습니다 — 방화벽이 막았거나 사내망에서만 열린 주소일 수 있습니다.",
    };
    format!("{base}{private}")
}

/// TCP 연결(이름 풀이 포함) — 주소를 차례로, 남은 시간 안에서
pub(crate) async fn tcp(host: &str, port: u16, limit: Duration) -> Result<TcpStream, LegErr> {
    let start = Instant::now();
    let (addrs, _) = resolve(host, port, limit.min(Duration::from_secs(3))).await?;
    let mut last: Option<(std::io::Error, IpAddr)> = None;
    let mut timed_out = None;
    for a in &addrs {
        let left = limit.saturating_sub(start.elapsed());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(left, TcpStream::connect(a)).await {
            Ok(Ok(s)) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Ok(Err(e)) => last = Some((e, a.ip())),
            Err(_) => timed_out = Some(a.ip()),
        }
    }
    match (last, timed_out) {
        (Some((e, ip)), _) => Err(leg("tcp", format!("{host}:{port} 에 연결하지 못했습니다 ({e})"), Some(tcp_hint(Some(&e), Some(&ip))))),
        (None, ip) => Err(leg(
            "tcp",
            format!("{host}:{port} 이(가) {}초 안에 답하지 않았습니다", limit.as_secs_f32().round()),
            Some(tcp_hint(None, ip.as_ref().or(addrs.first().map(|a| a.ip()).as_ref()))),
        )),
    }
}

/// 프록시 계정
#[derive(Clone, Default)]
pub(crate) struct ProxyAuth {
    pub(crate) user: Option<String>,
    pub(crate) pass: Option<String>,
}

/// HTTP CONNECT — 프록시에 붙어 host:port 로 길을 연다
pub(crate) async fn http_connect<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S, host: &str, port: u16, auth: &ProxyAuth) -> Result<(), LegErr> {
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(u) = auth.user.as_deref() {
        use russh::keys::ssh_key::encoding::base64::{Base64, Encoding as _};
        let raw = format!("{u}:{}", auth.pass.as_deref().unwrap_or(""));
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", Base64::encode_string(raw.as_bytes())));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.map_err(|e| leg("proxy", format!("프록시에 요청을 보내지 못했습니다: {e}"), None))?;
    // 머리글 끝(빈 줄)까지 한 바이트씩 — 뒤따르는 SSH 바이트를 먹지 않게
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        let n = s.read(&mut b).await.map_err(|e| leg("proxy", format!("프록시 답을 읽지 못했습니다: {e}"), None))?;
        if n == 0 {
            return Err(leg("proxy", "프록시가 답 없이 연결을 끊었습니다", Some("HTTP 프록시가 맞는지, 포트가 맞는지 확인하세요.".into())));
        }
        head.push(b[0]);
        if head.len() > 16 * 1024 {
            return Err(leg("proxy", "프록시 답이 너무 깁니다", None));
        }
    }
    let text = String::from_utf8_lossy(&head);
    let status_line = text.lines().next().unwrap_or("").to_string();
    let code: u16 = status_line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    if (200..300).contains(&code) {
        return Ok(());
    }
    let hint = match code {
        407 => "프록시가 계정을 요구하거나 계정·암호가 틀렸습니다 — 경로의 프록시 계정·암호를 확인하세요.",
        403 => "프록시가 그 주소·포트로 가는 것을 막았습니다(SSH 포트를 허용하지 않는 프록시가 많습니다).",
        502..=504 => "프록시가 대상 서버에 닿지 못했습니다 — 대상 주소가 프록시 쪽에서 보이는지 확인하세요.",
        _ => "HTTP 프록시가 CONNECT 를 받아 주지 않았습니다.",
    };
    Err(leg("proxy", format!("프록시가 거절했습니다: {status_line}"), Some(hint.into())))
}

/// SOCKS5 — 이름은 프록시 쪽에서 풀게(ATYP 3)
pub(crate) async fn socks5_connect<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S, host: &str, port: u16, auth: &ProxyAuth) -> Result<(), LegErr> {
    let io = |e: std::io::Error| leg("proxy", format!("SOCKS 프록시와 주고받지 못했습니다: {e}"), None);
    let with_pw = auth.user.is_some();
    if with_pw {
        s.write_all(&[5, 2, 0, 2]).await.map_err(io)?;
    } else {
        s.write_all(&[5, 1, 0]).await.map_err(io)?;
    }
    let mut hello = [0u8; 2];
    s.read_exact(&mut hello).await.map_err(io)?;
    if hello[0] != 5 {
        return Err(leg("proxy", "SOCKS5 프록시가 아닙니다", Some("프록시 방식(HTTP·SOCKS5)과 포트를 확인하세요.".into())));
    }
    match hello[1] {
        0 => {}
        2 if with_pw => {
            let u = auth.user.as_deref().unwrap_or("").as_bytes();
            let p = auth.pass.as_deref().unwrap_or("").as_bytes();
            if u.len() > 255 || p.len() > 255 {
                return Err(leg("proxy", "프록시 계정·암호가 너무 깁니다", None));
            }
            let mut m = vec![1, u.len() as u8];
            m.extend_from_slice(u);
            m.push(p.len() as u8);
            m.extend_from_slice(p);
            s.write_all(&m).await.map_err(io)?;
            let mut r = [0u8; 2];
            s.read_exact(&mut r).await.map_err(io)?;
            if r[1] != 0 {
                return Err(leg("proxy", "SOCKS 프록시 인증에 실패했습니다", Some("경로의 프록시 계정·암호를 확인하세요.".into())));
            }
        }
        0xff => {
            return Err(leg(
                "proxy",
                "SOCKS 프록시가 인증 방식을 받아 주지 않았습니다",
                Some(if with_pw { "프록시가 계정 인증을 쓰지 않습니다 — 계정을 비워 보세요." } else { "프록시가 계정을 요구합니다 — 경로에 프록시 계정·암호를 넣으세요." }.into()),
            ))
        }
        m => return Err(leg("proxy", format!("SOCKS 프록시가 모르는 인증 방식({m})을 골랐습니다"), None)),
    }
    let hb = host.as_bytes();
    if hb.len() > 255 {
        return Err(leg("proxy", "주소가 너무 깁니다", None));
    }
    let mut q = vec![5, 1, 0];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v)) => {
            q.push(1);
            q.extend_from_slice(&v.octets());
        }
        Ok(IpAddr::V6(v)) => {
            q.push(4);
            q.extend_from_slice(&v.octets());
        }
        Err(_) => {
            q.push(3);
            q.push(hb.len() as u8);
            q.extend_from_slice(hb);
        }
    }
    q.extend_from_slice(&port.to_be_bytes());
    s.write_all(&q).await.map_err(io)?;
    let mut r = [0u8; 4];
    s.read_exact(&mut r).await.map_err(io)?;
    if r[1] != 0 {
        let why = match r[1] {
            2 => "프록시 규칙이 그 연결을 막았습니다",
            3 => "프록시에서 그 망으로 가는 길이 없습니다",
            4 => "프록시에서 그 호스트에 닿지 않습니다",
            5 => "대상이 연결을 거절했습니다(포트가 닫혀 있음)",
            6 => "대상까지 시간이 너무 걸렸습니다",
            7 => "프록시가 이 요청을 지원하지 않습니다",
            8 => "프록시가 이 주소 꼴을 지원하지 않습니다",
            _ => "프록시가 실패를 알렸습니다",
        };
        return Err(leg("proxy", format!("SOCKS 프록시: {why} (코드 {})", r[1]), Some("대상 주소가 프록시 쪽에서 보이는지 확인하세요.".into())));
    }
    // 묶인 주소 버리기
    let skip = match r[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await.map_err(io)?;
            l[0] as usize
        }
        _ => 0,
    } + 2;
    let mut sink = vec![0u8; skip];
    s.read_exact(&mut sink).await.map_err(io)?;
    Ok(())
}

/// ProxyCommand 자식 프로세스 — 표준 입출력을 하나로, 놓으면(연결이 끝나면) 프로세스도 끝낸다
pub(crate) struct ChildIo {
    out: tokio::process::ChildStdout,
    inp: tokio::process::ChildStdin,
    _child: tokio::process::Child,
}

impl AsyncRead for ChildIo {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.out).poll_read(cx, buf)
    }
}

impl AsyncWrite for ChildIo {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inp).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inp).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inp).poll_shutdown(cx)
    }
}

/// %h %p %r %% 바꾸기
pub(crate) fn expand_command(cmd: &str, host: &str, port: u16, user: &str) -> String {
    let mut out = String::new();
    let mut it = cmd.chars().peekable();
    while let Some(c) = it.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('h') => out.push_str(host),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(user),
            Some('n') => out.push_str(host),
            Some('%') => out.push('%'),
            Some(o) => {
                out.push('%');
                out.push(o);
            }
            None => out.push('%'),
        }
    }
    out
}

/// 프록시 명령 실행 — 창은 숨기고, 오류 출력은 실패 설명에 쓰게 모아 둔다
pub(crate) fn spawn_command(line: &str) -> Result<(ChildIo, Arc<Mutex<String>>), LegErr> {
    use std::process::Stdio;
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").raw_arg(line);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("/bin/sh");
        c.arg("-c").arg(line);
        c
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| leg("command", format!("프록시 명령을 실행하지 못했습니다: {e}"), Some("명령 이름·경로가 맞는지 확인하세요.".into())))?;
    let out = child.stdout.take().ok_or_else(|| leg("command", "프록시 명령의 출력을 잡지 못했습니다", None))?;
    let inp = child.stdin.take().ok_or_else(|| leg("command", "프록시 명령의 입력을 잡지 못했습니다", None))?;
    let errs = Arc::new(Mutex::new(String::new()));
    if let Some(mut e) = child.stderr.take() {
        let errs = errs.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = e.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut g = errs.lock().unwrap();
                if g.len() < 4096 {
                    g.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            }
        });
    }
    Ok((ChildIo { out, inp, _child: child }, errs))
}

/// 첫 구간 전송로 — 경로의 프록시 설정대로 host:port 까지
pub(crate) async fn first_leg(r: &Route, host: &str, port: u16, user: &str, auth: &ProxyAuth, limit: Duration) -> Result<BoxIo, LegErr> {
    match r.proxy_kind.as_deref() {
        Some(kind @ ("http" | "socks5")) => {
            let ph = r.proxy_host.as_deref().unwrap_or("");
            let pp = r.proxy_port.unwrap_or(0);
            let start = Instant::now();
            let mut s = tcp(ph, pp, limit).await.map_err(|mut e| {
                e.message = format!("프록시 {ph}:{pp}: {}", e.message);
                e
            })?;
            let left = limit.saturating_sub(start.elapsed()).max(Duration::from_millis(500));
            let hand = async {
                if kind == "http" {
                    http_connect(&mut s, host, port, auth).await
                } else {
                    socks5_connect(&mut s, host, port, auth).await
                }
            };
            tokio::time::timeout(left, hand).await.map_err(|_| leg("proxy", "프록시가 제때 답하지 않았습니다", None))??;
            Ok(Box::new(s))
        }
        Some("command") => {
            let line = expand_command(r.proxy_command.as_deref().unwrap_or(""), host, port, user);
            let (io, _errs) = spawn_command(&line)?;
            Ok(Box::new(io))
        }
        _ => Ok(Box::new(tcp(host, port, limit).await?)),
    }
}

/// 서버 인사(SSH-2.0-…) 한 줄 읽기 — 진단용. 앞에 오는 다른 줄은 넘긴다
pub(crate) async fn read_banner<S: AsyncRead + Unpin>(s: &mut S, limit: Duration) -> Result<String, String> {
    let run = async {
        let mut line = Vec::new();
        let mut b = [0u8; 1];
        loop {
            let n = s.read(&mut b).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("인사 전에 연결이 끊겼습니다".to_string());
            }
            if b[0] == b'\n' {
                let l = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
                if l.starts_with("SSH-") {
                    return Ok(l);
                }
                line.clear();
                continue;
            }
            line.push(b[0]);
            if line.len() > 512 {
                return Err(format!("SSH 가 아닌 답: {}", String::from_utf8_lossy(&line[..60.min(line.len())])));
            }
        }
    };
    tokio::time::timeout(limit, run).await.map_err(|_| "제때 인사가 오지 않았습니다".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_proxy_command() {
        assert_eq!(expand_command("nc -X 5 -x px:1080 %h %p", "srv", 2222, "u"), "nc -X 5 -x px:1080 srv 2222");
        assert_eq!(expand_command("ssh -W %h:%p %r@gw 100%%", "a", 22, "me"), "ssh -W a:22 me@gw 100%");
    }

    #[tokio::test]
    async fn conditions_and_order() {
        let net = NetInfo {
            gateways: vec!["192.0.2.1".into()],
            dns_suffixes: vec!["corp.example".into()],
            wifi: vec![],
            supports_gateway: true,
            supports_dns: true,
            supports_wifi: false,
            wifi_note: None,
        };
        let r = |k: &str, v: &str, not: bool| Route { cond_kind: Some(k.into()), cond_value: Some(v.into()), cond_not: not, ..Default::default() };
        assert_eq!(cond_state(&r("gateway", "192.0.2.1", false), &net).await.0, CondState::Match);
        assert_eq!(cond_state(&r("gateway", "192.0.2.1", true), &net).await.0, CondState::NoMatch);
        assert_eq!(cond_state(&r("dns", "example", false), &net).await.0, CondState::Match, "접미사 끝 맞춤");
        assert_eq!(cond_state(&r("dns", "other.example", false), &net).await.0, CondState::NoMatch);
        assert_eq!(cond_state(&r("wifi", "office", false), &net).await.0, CondState::Unknown);
        assert_eq!(cond_state(&Route::default(), &net).await.0, CondState::None);
        // 닫힌 포트는 안 닿음
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let open = l.local_addr().unwrap().port();
        assert_eq!(cond_state(&r("reach", &format!("127.0.0.1:{open}"), false), &net).await.0, CondState::Match);
    }

    #[test]
    fn private_ranges() {
        assert!(is_private(&"10.1.2.3".parse().unwrap()));
        assert!(is_private(&"192.168.0.1".parse().unwrap()));
        assert!(!is_private(&"8.8.8.8".parse().unwrap()));
    }

    /// 가짜 프록시 둘(HTTP CONNECT·SOCKS5)로 왕복 — 계정 포함
    #[tokio::test]
    async fn proxies_handshake() {
        use tokio::net::TcpListener;
        // 목적지: "hi" 를 보내는 서버
        let dst = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dport = dst.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = dst.accept().await {
                let _ = s.write_all(b"hi").await;
            }
        });
        // HTTP 프록시: CONNECT 를 읽고 200, 그다음 목적지로 이어 준다
        let hp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hport = hp.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = hp.accept().await.unwrap();
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                s.read_exact(&mut b).await.unwrap();
                head.push(b[0]);
            }
            let h = String::from_utf8(head).unwrap();
            assert!(h.starts_with(&format!("CONNECT 127.0.0.1:{dport} ")));
            assert!(h.contains("Proxy-Authorization: Basic dTpw")); // u:p
            s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
            let mut d = TcpStream::connect(("127.0.0.1", dport)).await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut s, &mut d).await;
        });
        let r = Route { proxy_kind: Some("http".into()), proxy_host: Some("127.0.0.1".into()), proxy_port: Some(hport), ..Default::default() };
        let auth = ProxyAuth { user: Some("u".into()), pass: Some("p".into()) };
        let mut io = first_leg(&r, "127.0.0.1", dport, "x", &auth, Duration::from_secs(3)).await.unwrap();
        let mut got = [0u8; 2];
        io.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hi");
    }
}
