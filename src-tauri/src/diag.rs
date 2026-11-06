//! 접속 진단 — 서버의 경로마다 단계별로 어디서 막혔는지 본다.
//! 망 조건 → (프록시) → 이름 풀이 → TCP 연결(3회 평균, 핑 대신) → (점프 단계) → SSH 인사 → 키 교환·호스트 키 → 인증.
//! 호스트 키가 고정한 키와 같을 때만 인증까지 간다(처음 보는 서버에 비밀을 보내지 않는다). 저장한 비밀만 쓰고 묻지 않는다.
//! 진단은 저장한 비밀을 지우거나 키를 고정하지 않는다.

#![allow(clippy::result_large_err)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, Handle};
use russh::Disconnect;
use serde::Serialize;
use tauri::State;

use crate::route::{self, first_leg, BoxIo, CondState, NetInfo, ProxyAuth};
use crate::ssh::{self, Client};
use crate::store::{Account, Profile, Route, Store};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub name: String,
    /// ok · fail · warn · skip · info
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<f64>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

fn step(name: impl Into<String>, status: &'static str, ms: Option<f64>, detail: impl Into<String>, hint: Option<String>) -> Step {
    Step { name: name.into(), status, ms, detail: detail.into(), hint }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RouteDiag {
    pub route_id: Option<i64>,
    pub label: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cond: Option<String>,
    pub cond_state: CondState,
    pub steps: Vec<Step>,
    /// 인증까지 됐는지
    pub ok: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiagReport {
    pub profile: String,
    pub account: String,
    pub net: NetInfo,
    pub routes: Vec<RouteDiag>,
    pub at: i64,
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 10_000.0).round() / 10.0
}

fn avg_line(v: &[f64]) -> (f64, String) {
    let a = v.iter().sum::<f64>() / v.len().max(1) as f64;
    let a = (a * 10.0).round() / 10.0;
    (a, format!("평균 {a}ms ({})", v.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(" · ")))
}

/// 서버 진단 — 경로 전부(망 조건이 안 맞는 경로도 결과를 보인다)
#[tauri::command]
pub async fn ssh_diagnose(store: State<'_, Store>, profile_id: i64, account_id: Option<i64>) -> Result<DiagReport, String> {
    diagnose(&store, profile_id, account_id).await
}

pub(crate) async fn diagnose(store: &Store, profile_id: i64, account_id: Option<i64>) -> Result<DiagReport, String> {
    let p = store.profile(profile_id)?;
    if p.kind != "ssh" {
        return Err("SSH 서버만 진단할 수 있습니다".into());
    }
    let a = match account_id.and_then(|id| store.account(id).ok()).filter(|a| a.profile_id == profile_id) {
        Some(a) => a,
        None => store.default_account(profile_id)?,
    };
    let mut routes = store.routes(profile_id)?;
    if routes.is_empty() {
        routes.push(route::adhoc(profile_id, &p.host, p.port, p.jump_id));
    }
    let net = route::net_info().await;
    let also: Vec<String> = routes.iter().filter_map(|r| store.host_key(&r.host, r.port)).map(|k| k.fingerprint).collect();
    let limit = ssh::route_timeout(store).max(Duration::from_secs(4));
    let mut out = Vec::new();
    for r in &routes {
        let one = diag_route(store, &p, &a, r, &net, &also, limit);
        let d = match tokio::time::timeout(Duration::from_secs(60), one).await {
            Ok(d) => d,
            Err(_) => RouteDiag {
                route_id: r.id,
                label: route::route_name(r),
                summary: summary(store, r),
                cond: route::cond_text(r),
                cond_state: CondState::Unknown,
                steps: vec![step("진단", "fail", None, "60초 안에 끝나지 않아 멈췄습니다", None)],
                ok: false,
            },
        };
        out.push(d);
    }
    Ok(DiagReport { profile: p.name.clone(), account: a.username.clone(), net, routes: out, at: crate::store::now() })
}

fn summary(store: &Store, r: &Route) -> String {
    route::route_summary(r, |h| store.profile(h.profile_id).map(|p| p.name).unwrap_or_else(|_| "(지워진 서버)".into()))
}

/// 대상(또는 첫 점프)까지 새 전송로 하나
async fn fresh(r: &Route, hops: &[Handle<Client>], host: &str, port: u16, user: &str, auth: &ProxyAuth, limit: Duration) -> Result<BoxIo, (String, Option<String>)> {
    match hops.last() {
        Some(h) => {
            let ch = tokio::time::timeout(limit, h.channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1", 0))
                .await
                .map_err(|_| ("점프 서버에서 길이 제때 열리지 않았습니다".to_string(), None))?
                .map_err(|e| {
                    (
                        format!("점프 서버에서 {host}:{port} 로 가는 길을 열지 못했습니다: {e}"),
                        Some("점프 서버에서 그 주소·포트가 닿는지, 점프 서버 sshd 가 포워딩(AllowTcpForwarding)을 허용하는지 확인하세요.".into()),
                    )
                })?;
            Ok(Box::new(ch.into_stream()))
        }
        None => first_leg(r, host, port, user, auth, limit).await.map_err(|e| (e.message, e.hint)),
    }
}

fn banner_hint(e: &str) -> String {
    if e.contains("SSH 가 아닌") {
        "SSH 가 아닌 프로그램(웹 서버 등)이 답했습니다 — 포트 번호를 확인하세요.".into()
    } else if e.contains("끊겼") {
        "서버가 인사 전에 끊었습니다 — 접속 허용 목록(AllowUsers·hosts.allow), 동시 접속 제한(MaxStartups), fail2ban 차단일 수 있습니다.".into()
    } else {
        "연결은 됐지만 SSH 인사가 오지 않습니다 — 중간 장비(방화벽·IPS)가 막았거나 서버가 매우 바쁩니다.".into()
    }
}

async fn diag_route(store: &Store, p: &Profile, a: &Account, r: &Route, net: &NetInfo, also: &[String], limit: Duration) -> RouteDiag {
    let mut steps: Vec<Step> = Vec::new();
    let (cs, why) = route::cond_state(r, net).await;
    let cond = route::cond_text(r);
    if let Some(c) = cond.as_deref() {
        let (st, d) = match cs {
            CondState::Match => ("ok", format!("맞음 — {c} · {why}")),
            CondState::NoMatch => ("warn", format!("안 맞음 — {c} · {why}. 접속할 때는 이 경로를 건너뜁니다")),
            _ => ("warn", format!("알 수 없음 — {why}. 접속할 때는 조건 없는 경로 뒤에 시도합니다")),
        };
        steps.push(step("망 조건", st, None, d, None));
    }
    let mut d = RouteDiag { route_id: r.id, label: route::route_name(r), summary: summary(store, r), cond, cond_state: cs, steps: Vec::new(), ok: false };
    let auth = ProxyAuth {
        user: r.proxy_user.clone(),
        pass: r.id.filter(|_| r.proxy_secret_saved).and_then(|id| crate::secrets::get(&crate::store::route_proxy_key(id))),
    };
    if r.proxy_user.is_some() && auth.pass.is_none() && matches!(r.proxy_kind.as_deref(), Some("http" | "socks5")) {
        steps.push(step("프록시 계정", "warn", None, "프록시 암호가 저장돼 있지 않습니다(빈 암호로 시도)", None));
    }

    // 첫 구간의 목적지 — 점프가 있으면 첫 점프 서버
    let hop_profiles: Vec<Option<Profile>> = r.jumps.iter().map(|h| store.profile(h.profile_id).ok()).collect();
    if let Some(i) = hop_profiles.iter().position(|x| x.is_none()) {
        steps.push(step(format!("점프 {}", i + 1), "fail", None, "점프 단계의 서버가 지워졌습니다", Some("경로 설정에서 점프 단계를 고치세요.".into())));
        d.steps = steps;
        return d;
    }
    let hop_profiles: Vec<Profile> = hop_profiles.into_iter().flatten().collect();
    let (h0, p0, name0) = match hop_profiles.first() {
        Some(hp) => (hp.host.clone(), hp.port, format!("점프 서버 {}", hp.name)),
        None => (r.host.clone(), r.port, "대상".to_string()),
    };
    let first_user = match r.jumps.first() {
        Some(h) => h.account_id.and_then(|id| store.account(id).ok()).or_else(|| store.default_account(h.profile_id).ok()).map(|a| a.username).unwrap_or_default(),
        None => a.username.clone(),
    };

    // 이름 풀이·TCP — 프록시면 프록시 주소를, 명령이면 건너뛴다
    let (dns_host, dns_port, what) = match r.proxy_kind.as_deref() {
        Some("http" | "socks5") => (r.proxy_host.clone().unwrap_or_default(), r.proxy_port.unwrap_or(0), "프록시".to_string()),
        Some("command") => (String::new(), 0, String::new()),
        _ => (h0.clone(), p0, name0.clone()),
    };
    if dns_host.is_empty() {
        steps.push(step("프록시 명령", "info", None, "명령의 표준 입출력으로 이어 붙입니다 — 이름 풀이·TCP 는 명령이 맡습니다", None));
    } else {
        match route::resolve(&dns_host, dns_port, Duration::from_secs(3)).await {
            Err(e) => {
                steps.push(step(format!("이름 풀이 · {what}"), "fail", None, e.message, e.hint));
                d.steps = steps;
                return d;
            }
            Ok((addrs, took)) => {
                let ips: Vec<String> = addrs.iter().map(|x| x.ip().to_string()).fold(Vec::new(), |mut v, x| {
                    if !v.contains(&x) {
                        v.push(x);
                    }
                    v
                });
                if dns_host.parse::<std::net::IpAddr>().is_ok() {
                    steps.push(step(format!("이름 풀이 · {what}"), "info", None, "IP 주소라 풀이할 이름이 없습니다", None));
                } else {
                    steps.push(step(format!("이름 풀이 · {what}"), "ok", Some(ms(took)), format!("{dns_host} → {}", ips.join(", ")), None));
                }
                // TCP 3회 — 핑 대신 연결 시간
                let target = addrs[0];
                let mut times = Vec::new();
                let mut fail = None;
                for _ in 0..3 {
                    let t = Instant::now();
                    match tokio::time::timeout(limit, tokio::net::TcpStream::connect(target)).await {
                        Ok(Ok(_s)) => times.push(ms(t.elapsed())),
                        Ok(Err(e)) => {
                            fail = Some((format!("{target} 연결 실패: {e}"), route::tcp_hint(Some(&e), Some(&target.ip()))));
                            break;
                        }
                        Err(_) => {
                            fail = Some((format!("{target} 이(가) {}초 안에 답하지 않았습니다", limit.as_secs()), route::tcp_hint(None, Some(&target.ip()))));
                            break;
                        }
                    }
                }
                if let Some((m, h)) = fail {
                    steps.push(step(format!("TCP 연결 · {what}"), "fail", None, m, Some(h)));
                    d.steps = steps;
                    return d;
                }
                let (avg, line) = avg_line(&times);
                steps.push(step(format!("TCP 연결 · {what}"), "ok", Some(avg), format!("{target} {line}"), None));
            }
        }
    }
    if let Some(k @ ("http" | "socks5")) = r.proxy_kind.as_deref() {
        let t = Instant::now();
        match first_leg(r, &h0, p0, &first_user, &auth, limit).await {
            Ok(_) => steps.push(step(
                format!("프록시 통과 · {}", if k == "http" { "HTTP CONNECT" } else { "SOCKS5" }),
                "ok",
                Some(ms(t.elapsed())),
                format!("프록시가 {h0}:{p0} 로 길을 열었습니다"),
                None,
            )),
            Err(e) => {
                steps.push(step("프록시 통과", "fail", None, e.message, e.hint));
                d.steps = steps;
                return d;
            }
        }
    }

    // 점프 단계
    let mut hops: Vec<Handle<Client>> = Vec::new();
    for (i, (hop, hp)) in r.jumps.iter().zip(hop_profiles.iter()).enumerate() {
        let name = format!("점프 {} · {}", i + 1, hp.name);
        let ha = hop.account_id.and_then(|id| store.account(id).ok()).filter(|x| x.profile_id == hop.profile_id).or_else(|| store.default_account(hop.profile_id).ok());
        let Some(ha) = ha else {
            steps.push(step(name, "fail", None, "그 서버에 계정이 없습니다", None));
            break;
        };
        let t = Instant::now();
        let io = match fresh(r, &hops, &hp.host, hp.port, &ha.username, &auth, limit).await {
            Ok(io) => io,
            Err((m, h)) => {
                steps.push(step(name, "fail", None, m, h));
                break;
            }
        };
        match ssh::hop_session(store, hp, &ha, io, limit).await {
            Ok(h) => {
                steps.push(step(name, "ok", Some(ms(t.elapsed())), format!("{}:{} · 계정 {} 인증까지", hp.host, hp.port, ha.username), None));
                hops.push(h);
            }
            Err(e) => {
                let (code, m, ..) = e.parts();
                let hint = match code {
                    "AUTH_FAILED" => Some("점프 서버 계정의 암호·키를 확인하세요.".to_string()),
                    "NETWORK" => Some("그 점프 서버에 닿지 않습니다 — 그 서버 자체를 진단해 보세요.".to_string()),
                    _ => None,
                };
                steps.push(step(name, "fail", None, m.to_string(), hint));
                break;
            }
        }
    }
    if hops.len() < r.jumps.len() {
        d.steps = steps;
        return d;
    }
    if !hops.is_empty() {
        let mut times = Vec::new();
        for _ in 0..3 {
            let t = Instant::now();
            match fresh(r, &hops, &r.host, r.port, &a.username, &auth, limit).await {
                Ok(_io) => times.push(ms(t.elapsed())),
                Err((m, h)) => {
                    steps.push(step("점프 서버 → 대상", "fail", None, m, h));
                    d.steps = steps;
                    return d;
                }
            }
        }
        let (avg, line) = avg_line(&times);
        steps.push(step("점프 서버 → 대상", "ok", Some(avg), format!("{}:{} 길 열기 {line}", r.host, r.port), None));
    }

    // SSH 인사
    let t = Instant::now();
    let banner = match fresh(r, &hops, &r.host, r.port, &a.username, &auth, limit).await {
        Ok(mut io) => route::read_banner(&mut io, limit).await,
        Err((m, _)) => Err(m),
    };
    match banner {
        Ok(b) => steps.push(step("SSH 인사", "ok", Some(ms(t.elapsed())), b, None)),
        Err(e) => {
            let h = banner_hint(&e);
            steps.push(step("SSH 인사", "fail", None, e, Some(h)));
            d.steps = steps;
            return d;
        }
    }

    // 키 교환·호스트 키
    let pinned = store.host_key(&r.host, r.port);
    let seen = Arc::new(Mutex::new(None));
    let handler = Client::probe(pinned.clone(), if pinned.is_none() { also.to_vec() } else { Vec::new() }, seen.clone());
    let t = Instant::now();
    let io = match fresh(r, &hops, &r.host, r.port, &a.username, &auth, limit).await {
        Ok(io) => io,
        Err((m, h)) => {
            steps.push(step("키 교환·호스트 키", "fail", None, m, h));
            d.steps = steps;
            return d;
        }
    };
    let conn = tokio::time::timeout(limit, client::connect_stream(ssh::ssh_config(&p.legacy), io, handler)).await;
    let mut handle = match conn {
        Err(_) => {
            steps.push(step("키 교환·호스트 키", "fail", None, "키 교환이 제때 끝나지 않았습니다", Some("서버가 매우 느리거나 중간에서 막혔습니다.".into())));
            d.steps = steps;
            return d;
        }
        Ok(Ok(h)) => {
            let s = seen.lock().unwrap().clone();
            let how = if pinned.is_some() { "고정한 키와 같습니다" } else { "같은 서버의 다른 경로에서 고정한 키와 같습니다" };
            steps.push(step(
                "키 교환·호스트 키",
                "ok",
                Some(ms(t.elapsed())),
                format!("{how} · {}", s.map(|k| format!("{} {}", k.algorithm, k.fingerprint)).unwrap_or_default()),
                None,
            ));
            h
        }
        Ok(Err(e)) => {
            match seen.lock().unwrap().clone() {
                Some(k) if pinned.as_ref().is_some_and(|pk| pk.fingerprint != k.fingerprint) => steps.push(step(
                    "키 교환·호스트 키",
                    "fail",
                    Some(ms(t.elapsed())),
                    format!("서버 키가 고정한 키와 다릅니다 · 받은 키 {} {}", k.algorithm, k.fingerprint),
                    Some("서버를 다시 설치했거나 다른 서버로 연결되고 있습니다 — 관리자에게 지문을 확인하세요.".into()),
                )),
                Some(k) => steps.push(step(
                    "키 교환·호스트 키",
                    "warn",
                    Some(ms(t.elapsed())),
                    format!("처음 보는 키입니다 · {} {}", k.algorithm, k.fingerprint),
                    Some("접속할 때 지문을 확인하면 고정됩니다. 확인 전에는 인증을 시험하지 않습니다.".into()),
                )),
                None => {
                    let x = ssh::map_russh(e);
                    let (code, m, ..) = x.parts();
                    let hint = x.hint.clone().or_else(|| (code == "CLOSED").then(|| "서버가 키 교환 중에 끊었습니다 — 구형 호환 단계를 올려 보세요.".into()));
                    steps.push(step("키 교환·호스트 키", "fail", None, m.to_string(), hint));
                }
            }
            steps.push(step("인증", "skip", None, "호스트 키를 먼저 확인해야 합니다", None));
            d.steps = steps;
            return d;
        }
    };

    // 인증 — 저장한 비밀만
    let secret = a.id.and_then(|id| crate::secrets::get(&crate::secrets::account_key(id)));
    let t = Instant::now();
    match ssh::authenticate(&mut handle, &a.auth, &a.username, a.key_path.as_deref(), secret.as_deref()).await {
        Ok(true) => {
            steps.push(step("인증", "ok", Some(ms(t.elapsed())), format!("계정 {} · {}", a.username, auth_name(&a.auth)), None));
            d.ok = true;
        }
        Ok(false) => steps.push(step(
            "인증",
            "fail",
            Some(ms(t.elapsed())),
            format!("계정 {} 인증에 실패했습니다", a.username),
            Some(match a.auth.as_str() {
                "key" => "서버의 authorized_keys 에 이 키의 공개키가 있는지, 사용자명이 맞는지 확인하세요.".into(),
                "agent" => "에이전트에 든 키가 서버에 등록돼 있지 않습니다.".into(),
                _ => "계정 또는 암호가 맞지 않습니다(저장한 암호가 바뀌었을 수 있습니다). 서버가 암호 로그인을 막았을 수도 있습니다.".into(),
            }),
        )),
        Err(e) => {
            let (code, m, ..) = e.parts();
            if code == "NEED_SECRET" {
                steps.push(step("인증", "skip", None, format!("{} — 저장된 비밀이 없어 건너뜁니다(접속할 때 입력)", m), None));
            } else {
                steps.push(step("인증", "fail", None, m.to_string(), None));
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(3), handle.disconnect(Disconnect::ByApplication, "", "ko")).await;
    drop(hops);
    d.steps = steps;
    d
}

fn auth_name(a: &str) -> &'static str {
    match a {
        "key" => "개인키",
        "agent" => "SSH 에이전트",
        _ => "암호",
    }
}

#[cfg(test)]
mod live {
    use super::*;
    use crate::ssh::{ConnectReq, SshConns};
    use crate::store::Hop;

    /// 로컬 Docker 로 — rbshell-route-a(127.0.0.1:22131 공개)·-b·-t(내부망만)·-px(HTTP 22141·SOCKS5 22142).
    /// RB_ROUTE_TEST=1 과 RB_SSH_TEST_PW 를 줄 때만(cargo test -- --ignored live_routes)
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_routes_jumps_proxies_diag() {
        std::env::var("RB_ROUTE_TEST").expect("RB_ROUTE_TEST=1");
        let pw = std::env::var("RB_SSH_TEST_PW").expect("RB_SSH_TEST_PW");
        let dir = std::env::temp_dir().join(format!("rbshell-route-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(dir.clone(), false).unwrap();
        let mk = |name: &str, host: &str, port: u16| {
            let mut p = store.profile(crate::store::profile_save_core(&store, host, port, "rbtest")).unwrap();
            p.name = name.into();
            store.profile_save(&p).unwrap()
        };
        let a = mk("A", "127.0.0.1", 22131);
        let b = mk("B", "rbshell-route-b", 22);
        let t = mk("T", "192.0.2.1", 22);
        let accs: Vec<i64> = [a, b, t].iter().map(|p| store.default_account(*p).unwrap().id.unwrap()).collect();
        for x in &accs {
            crate::secrets::set(&crate::secrets::account_key(*x), &pw).unwrap();
        }
        let req = |pid: i64, route: Option<i64>, trust: Option<String>| -> ConnectReq {
            let mut r = ssh::tunnel_req(&store, pid, None, None, trust, false).unwrap();
            r.route_id = route;
            r
        };
        // A 직접, B 는 A 를 거쳐(한 단계) — 처음엔 지문 확인
        let mut r0 = store.routes(b).unwrap().remove(0);
        r0.jumps = vec![Hop { profile_id: a, account_id: None }];
        store.route_save(&r0).unwrap();
        for pid in [a, b] {
            let e = ssh::open_authed(&store, &req(pid, None, None)).await.err().expect("처음엔 지문");
            let (code, _, fp, ..) = e.parts();
            assert_eq!(code, "HOSTKEY_UNKNOWN");
            let fp = fp.map(str::to_string);
            ssh::open_authed(&store, &req(pid, None, fp)).await.unwrap_or_else(|e| panic!("{:?}", e.parts()));
        }
        println!("A·B 지문 고정");

        // T: 경로 1 막힌 주소(시간 초과) · 2 닫힌 포트 · 3 점프 A→B · 4 SOCKS5 · 5 HTTP · 6 명령
        store.setting_put("ssh.routeTimeoutSec", "2");
        let mut r1 = store.routes(t).unwrap().remove(0);
        r1.label = Some("사내 직접".into());
        let r1id = store.route_save(&r1).unwrap();
        let base = |label: &str| Route { profile_id: t, label: Some(label.into()), host: "rbshell-route-t".into(), port: 22, ..Default::default() };
        let r2 = store.route_save(&Route { host: "127.0.0.1".into(), port: 1, ..base("닫힌 포트") }).unwrap();
        let r3 = store
            .route_save(&Route { jumps: vec![Hop { profile_id: a, account_id: None }, Hop { profile_id: b, account_id: None }], ..base("점프 2단") })
            .unwrap();
        let r4 = store
            .route_save(&Route {
                proxy_kind: Some("socks5".into()),
                proxy_host: Some("127.0.0.1".into()),
                proxy_port: Some(22142),
                proxy_user: Some("u".into()),
                ..base("SOCKS5")
            })
            .unwrap();
        store.route_proxy_secret_set(r4, "p").unwrap();
        let r5 = store.route_save(&Route { proxy_kind: Some("http".into()), proxy_host: Some("127.0.0.1".into()), proxy_port: Some(22141), ..base("HTTP") }).unwrap();
        let r6 = store
            .route_save(&Route { proxy_kind: Some("command".into()), proxy_command: Some("docker exec -i rbshell-route-px python3 /bridge.py %h %p".into()), ..base("명령") })
            .unwrap();
        // 순환은 저장 단계에서 막는다
        assert!(store.route_save(&Route { jumps: vec![Hop { profile_id: a, account_id: None }, Hop { profile_id: a, account_id: None }], ..base("x") }).is_err());
        assert!(store.route_save(&Route { jumps: vec![Hop { profile_id: t, account_id: None }], ..base("x") }).is_err());

        let t0 = Instant::now();
        let e = ssh::open_authed(&store, &req(t, None, None)).await.err().expect("대상 지문 확인");
        println!("경로 1·2 실패 → 경로 3 지문 확인 {}ms: {} / {:?}", t0.elapsed().as_millis(), e.parts().0, e.attempts);
        assert_eq!(e.parts().0, "HOSTKEY_UNKNOWN");
        assert_eq!(e.route_id, Some(r3));
        assert_eq!(e.attempts.as_ref().map(|v| v.len()), Some(2));
        let fp = e.parts().2.unwrap().to_string();
        let ok = ssh::open_authed(&store, &req(t, Some(r3), Some(fp))).await.unwrap_or_else(|e| panic!("{:?}", e.parts()));
        assert_eq!(ok.route.id, Some(r3));
        assert_eq!(ok.jump.len(), 2);
        drop(ok);

        // 다시: 지문이 고정돼 묻지 않고 경로 1·2 를 넘어 3 으로
        let t0 = Instant::now();
        let ok = ssh::open_authed(&store, &req(t, None, None)).await.unwrap_or_else(|e| panic!("{:?}", e.parts()));
        println!("자동 선택 {}ms → {} ({}) note={:?}", t0.elapsed().as_millis(), ok.route.label, ok.route.summary, ok.route.note);
        assert_eq!(ok.route.id, Some(r3));
        drop(ok);

        // 프록시 셋 — 같은 서버 키라 묻지 않는다
        for (rid, name) in [(r4, "SOCKS5"), (r5, "HTTP"), (r6, "명령")] {
            let t0 = Instant::now();
            let ok = ssh::open_authed(&store, &req(t, Some(rid), None)).await.unwrap_or_else(|e| panic!("{name}: {:?}", e.parts()));
            let mut ch = ok.handle.channel_open_session().await.unwrap();
            ch.exec(true, "hostname").await.unwrap();
            let mut out = Vec::new();
            while let Some(m) = ch.wait().await {
                if let russh::ChannelMsg::Data { data } = m {
                    out.extend_from_slice(&data);
                }
            }
            println!("{name} 경로 {}ms · hostname {}", t0.elapsed().as_millis(), String::from_utf8_lossy(&out).trim());
            assert!(!out.is_empty());
        }

        // 망 조건: 경로 1 을 "닿지 않는 곳이 닿을 때만" → 건너뜀
        let mut x = store.routes(t).unwrap().into_iter().find(|r| r.id == Some(r1id)).unwrap();
        x.cond_kind = Some("reach".into());
        x.cond_value = Some("127.0.0.1:1".into());
        store.route_save(&x).unwrap();
        let t0 = Instant::now();
        let ok = ssh::open_authed(&store, &req(t, None, None)).await.unwrap_or_else(|e| panic!("{:?}", e.parts()));
        println!("조건 건너뜀 {}ms note={:?}", t0.elapsed().as_millis(), ok.route.note);
        assert!(ok.route.note.clone().unwrap_or_default().contains("건너뜀"));
        drop(ok);

        // 작업대 연결(SFTP)과 DB 터널도 같은 경로 규칙
        let conns = SshConns::default();
        let ok = ssh::connect(&store, &conns, req(t, None, None)).await.unwrap_or_else(|e| panic!("{:?}", e.parts()));
        let v = serde_json::to_value(&ok).unwrap();
        println!("작업대 연결 경로 {} · home {}", v["route"]["label"], v["home"]);
        let spec = crate::tunnel::TunnelSpec { profile_id: t, ..Default::default() };
        let tun = crate::tunnel::open_db_tunnel(&store, &spec, "127.0.0.1", 22).await.unwrap_or_else(|e| panic!("{:?}", e.parts()));
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", tun.port)).await.unwrap();
        let banner = route::read_banner(&mut s, Duration::from_secs(5)).await.unwrap();
        println!("DB 터널(경로 따라감) → 대상 안 127.0.0.1:22 인사 {banner}");
        drop(s);
        drop(tun);

        // 진단
        let rep = diagnose(&store, t, None).await.unwrap();
        for r in &rep.routes {
            println!("── {} [{}] ok={}", r.label, r.summary, r.ok);
            for s in &r.steps {
                println!("   {} {} {:?} {} {}", s.status, s.name, s.ms, s.detail, s.hint.clone().unwrap_or_default());
            }
        }
        let by = |id: i64| rep.routes.iter().find(|r| r.route_id == Some(id)).unwrap();
        assert!(!by(r1id).ok && !by(r2).ok);
        assert!(by(r2).steps.iter().any(|s| s.status == "fail" && s.name.starts_with("TCP")));
        assert!(by(r3).ok && by(r4).ok && by(r5).ok && by(r6).ok);
        println!("망: {:?}", rep.net);

        for x in &accs {
            crate::secrets::forget(&crate::secrets::account_key(*x));
        }
        crate::secrets::forget(&crate::store::route_proxy_key(r4));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
