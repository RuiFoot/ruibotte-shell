//! 서버 자원 보기 — CPU·메모리·디스크·네트워크·프로세스.
//! 서버에 아무것도 깔지 않고 exec 채널 하나로 `/proc`·`df`·`ps` 를 읽는다(CentOS 6 의 coreutils·procps 로도 됨).
//! 비율(CPU %·전송 속도)은 두 번 잰 값의 차이라 화면이 앞 표본을 들고 계산한다. 여기서는 원값만 돌려준다.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::ssh::{err, Conn, SshConns, R};
use crate::sudo::{exec, q, sudo};

/// 한 번 재는 스크립트 — 구획마다 `@이름` 줄로 나눈다
const SCRIPT: &str = r#"export LC_ALL=C
echo @host; hostname 2>/dev/null; uname -sr 2>/dev/null; getconf PAGESIZE 2>/dev/null || echo 4096
echo @stat; grep -E '^(cpu|procs_)' /proc/stat
echo @mem; cat /proc/meminfo
echo @load; cat /proc/loadavg; cat /proc/uptime
echo @net; cat /proc/net/dev
echo @df; df -PkT 2>/dev/null || df -Pk
echo @io; cat /proc/diskstats 2>/dev/null
echo @ps; awk '{l=$0; o=index(l,"("); c=0; for(k=length(l);k>o;k--) if(substr(l,k,1)==")"){c=k;break}; n=substr(l,o+1,c-o-1); split(substr(l,c+2),f," "); print $1"\t"(f[12]+f[13])"\t"f[22]"\t"f[1]"\t"n}' /proc/[0-9]*/stat 2>/dev/null
echo @user; ps -eo pid=,user= 2>/dev/null || awk 'NR==FNR{split($0,a,":"); u[a[3]]=a[1]; next} /^Uid:/{split(FILENAME,p,"/"); print p[3], ($2 in u ? u[$2] : $2)}' /etc/passwd /proc/[0-9]*/status 2>/dev/null
"#;

#[derive(Serialize, Default, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct CpuTicks {
    busy: u64,
    iowait: u64,
    total: u64,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Mem {
    /// kB
    total: u64,
    /// MemAvailable(없는 옛 커널은 free+buffers+cached)
    available: u64,
    free: u64,
    buffers: u64,
    cached: u64,
    swap_total: u64,
    swap_free: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Net {
    name: String,
    rx: u64,
    tx: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    fs: String,
    kind: String,
    size_k: u64,
    used_k: u64,
    avail_k: u64,
    mount: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Io {
    name: String,
    /// 섹터(512B) 누적
    read: u64,
    write: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pid: u32,
    user: String,
    /// utime+stime 누적(tick)
    ticks: u64,
    rss_k: u64,
    state: String,
    name: String,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// 잰 시각(ms) — 차이 계산용
    at_ms: u64,
    host: String,
    kernel: String,
    ncpu: usize,
    uptime_s: f64,
    load: [f64; 3],
    running: u32,
    /// [0] 전체, 이후 코어별
    cpu: Vec<CpuTicks>,
    mem: Mem,
    net: Vec<Net>,
    disks: Vec<Disk>,
    io: Vec<Io>,
    procs: Vec<Proc>,
}

/// 실제 파일 시스템만(가상·메모리 파일 시스템은 뺀다)
fn real_fs(kind: &str, fs: &str) -> bool {
    const SKIP: &[&str] = &[
        "tmpfs", "devtmpfs", "devfs", "proc", "sysfs", "cgroup", "cgroup2", "squashfs", "overlay", "nsfs", "autofs", "mqueue", "debugfs",
        "tracefs", "securityfs", "pstore", "bpf", "configfs", "fusectl", "hugetlbfs", "rpc_pipefs", "binfmt_misc", "efivarfs", "ramfs", "iso9660",
    ];
    if !kind.is_empty() {
        return !SKIP.contains(&kind);
    }
    // -T 가 없는 df: 이름으로 짐작
    !(fs == "tmpfs" || fs == "devtmpfs" || fs == "none" || fs == "udev" || fs == "shm")
}

/// 파티션이 아닌 통째 디스크만(sda·vda·xvda·nvme0n1·dm-0·md0)
fn whole_disk(name: &str) -> bool {
    if name.starts_with("loop") || name.starts_with("ram") || name.starts_with("sr") || name.starts_with("fd") {
        return false;
    }
    if name.starts_with("nvme") || name.starts_with("mmcblk") {
        return !name.contains('p');
    }
    if name.starts_with("dm-") || name.starts_with("md") {
        return true;
    }
    !name.ends_with(|c: char| c.is_ascii_digit())
}

fn num(s: &str) -> u64 {
    s.parse().unwrap_or(0)
}

pub(crate) fn parse(text: &str) -> R<Stats> {
    let mut sec: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut cur = "";
    for line in text.lines() {
        if let Some(name) = line.strip_prefix('@') {
            cur = name.trim();
            sec.entry(cur).or_default();
        } else if !cur.is_empty() {
            sec.entry(cur).or_default().push(line);
        }
    }
    let get = |k: &str| sec.get(k).cloned().unwrap_or_default();
    let mut s = Stats::default();

    let host = get("host");
    s.host = host.first().map(|x| x.trim().to_string()).unwrap_or_default();
    s.kernel = host.get(1).map(|x| x.trim().to_string()).unwrap_or_default();
    let page_k = host.get(2).map(|x| num(x.trim())).filter(|&p| p > 0).unwrap_or(4096) / 1024;

    for l in get("stat") {
        let f: Vec<&str> = l.split_whitespace().collect();
        let Some(&head) = f.first() else { continue };
        if head.starts_with("cpu") {
            // user nice system idle iowait irq softirq steal (guest 는 user 에 이미 들어 있음)
            let v: Vec<u64> = f[1..].iter().take(8).map(|x| num(x)).collect();
            let idle = v.get(3).copied().unwrap_or(0);
            let iowait = v.get(4).copied().unwrap_or(0);
            let total: u64 = v.iter().sum();
            s.cpu.push(CpuTicks { busy: total - idle - iowait, iowait, total });
        } else if head == "procs_running" {
            s.running = f.get(1).map(|x| num(x) as u32).unwrap_or(0);
        }
    }
    if s.cpu.is_empty() {
        return Err(err("OTHER", "이 서버에서는 볼 수 없습니다 — 리눅스(/proc)만 지원합니다"));
    }
    s.ncpu = (s.cpu.len() - 1).max(1);

    let mut m: HashMap<&str, u64> = HashMap::new();
    for l in get("mem") {
        if let Some((k, v)) = l.split_once(':') {
            m.insert(k.trim(), num(v.split_whitespace().next().unwrap_or("0")));
        }
    }
    let g = |k: &str| m.get(k).copied().unwrap_or(0);
    s.mem = Mem {
        total: g("MemTotal"),
        free: g("MemFree"),
        buffers: g("Buffers"),
        cached: g("Cached") + g("SReclaimable"),
        available: m.get("MemAvailable").copied().unwrap_or_else(|| g("MemFree") + g("Buffers") + g("Cached")),
        swap_total: g("SwapTotal"),
        swap_free: g("SwapFree"),
    };

    let load = get("load");
    if let Some(l) = load.first() {
        let f: Vec<f64> = l.split_whitespace().take(3).map(|x| x.parse().unwrap_or(0.0)).collect();
        for (i, v) in f.into_iter().enumerate() {
            s.load[i] = v;
        }
    }
    s.uptime_s = load.get(1).and_then(|l| l.split_whitespace().next()).and_then(|x| x.parse().ok()).unwrap_or(0.0);

    for l in get("net") {
        let Some((name, rest)) = l.split_once(':') else { continue };
        let name = name.trim();
        if name == "lo" || name.contains('|') {
            continue;
        }
        let f: Vec<&str> = rest.split_whitespace().collect();
        if f.len() >= 9 {
            s.net.push(Net { name: name.into(), rx: num(f[0]), tx: num(f[8]) });
        }
    }

    let df = get("df");
    let typed = df.first().is_some_and(|h| h.contains("Type"));
    for l in df.iter().skip(1) {
        let f: Vec<&str> = l.split_whitespace().collect();
        let (fs, kind, rest) = if typed {
            if f.len() < 7 {
                continue;
            }
            (f[0], f[1], &f[2..])
        } else {
            if f.len() < 6 {
                continue;
            }
            (f[0], "", &f[1..])
        };
        let size_k = num(rest[0]);
        let mount = rest[4..].join(" ");
        // 컨테이너는 / 가 overlay 다 — 그 하나는 보인다
        let root_overlay = kind == "overlay" && mount == "/";
        // 컨테이너가 파일 하나씩 붙이는 /etc/hosts·resolv.conf 는 디스크가 아니다
        if size_k == 0 || mount.starts_with("/etc/") || !(real_fs(kind, fs) || root_overlay) {
            continue;
        }
        s.disks.push(Disk {
            fs: fs.into(),
            kind: kind.into(),
            size_k,
            used_k: num(rest[1]),
            avail_k: num(rest[2]),
            mount,
        });
    }

    // 같은 장치가 여러 곳에 붙은 것(bind mount·컨테이너의 /etc/hosts 등)은 가장 짧은 마운트 하나만
    s.disks.sort_by(|a, b| a.fs.cmp(&b.fs).then(a.mount.len().cmp(&b.mount.len())));
    s.disks.dedup_by(|b, a| a.fs == b.fs && a.fs.starts_with('/'));
    s.disks.sort_by(|a, b| a.mount.cmp(&b.mount));

    for l in get("io") {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() >= 10 && whole_disk(f[2]) {
            let (r, w) = (num(f[5]), num(f[9]));
            if r + w > 0 {
                s.io.push(Io { name: f[2].into(), read: r, write: w });
            }
        }
    }

    let users: HashMap<u32, &str> = get("user")
        .iter()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?))
        })
        .collect();
    for l in get("ps") {
        let f: Vec<&str> = l.splitn(5, '\t').collect();
        if f.len() < 5 {
            continue;
        }
        let Ok(pid) = f[0].parse::<u32>() else { continue };
        s.procs.push(Proc {
            pid,
            user: users.get(&pid).map(|u| u.to_string()).unwrap_or_default(),
            ticks: num(f[1]),
            rss_k: num(f[2]) * page_k,
            state: f[3].into(),
            name: f[4].into(),
        });
    }

    s.at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(s)
}

#[tauri::command]
pub async fn ssh_stats(conns: State<'_, SshConns>, conn: u32) -> R<Stats> {
    stats(&*conns.get(conn)?).await
}

pub(crate) async fn stats(c: &Conn) -> R<Stats> {
    let o = tokio::time::timeout(Duration::from_secs(15), exec(c, SCRIPT, None))
        .await
        .map_err(|_| err("NETWORK", "서버가 응답하지 않습니다"))??;
    parse(&String::from_utf8_lossy(&o.stdout))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DuEntry {
    /// "." 은 폴더 전체
    name: String,
    size_k: u64,
}

pub(crate) fn parse_du(text: &str) -> Vec<DuEntry> {
    let mut v: Vec<DuEntry> = text
        .lines()
        .filter_map(|l| {
            let (n, p) = l.split_once('\t')?;
            let name = p.strip_prefix("./").unwrap_or(p);
            Some(DuEntry { name: name.into(), size_k: n.trim().parse().ok()? })
        })
        .collect();
    v.sort_by_key(|e| std::cmp::Reverse(e.size_k));
    v
}

/// 폴더 안 크기(한 단계) — 같은 파일 시스템만(-x), 낮은 우선순위로. 읽을 수 없는 곳은 빠진다(sudo 면 다 본다)
#[tauri::command]
pub async fn ssh_du(conns: State<'_, SshConns>, conn: u32, path: String, as_root: bool) -> R<Vec<DuEntry>> {
    du(&*conns.get(conn)?, &path, as_root).await
}

pub(crate) async fn du(c: &Conn, path: &str, as_root: bool) -> R<Vec<DuEntry>> {
    let inner = format!("cd -- {} && {{ du -xk --max-depth=1 . 2>/dev/null || du -xk -d 1 . 2>/dev/null; }}; true", q(path));
    let run = async {
        if as_root {
            sudo(c, &format!("nice -n 19 sh -c {}", q(&inner)), None).await
        } else {
            exec(c, &format!("nice -n 19 sh -c {}", q(&inner)), None).await
        }
    };
    let o = tokio::time::timeout(Duration::from_secs(180), run).await.map_err(|_| err("NETWORK", "3분 안에 끝나지 않았습니다 — 더 안쪽 폴더에서 다시 보세요"))??;
    Ok(parse_du(&String::from_utf8_lossy(&o.stdout)))
}

/// 프로세스 멈추기 — TERM(정상 종료 요청) 또는 KILL(강제)
#[tauri::command]
pub async fn ssh_kill(conns: State<'_, SshConns>, conn: u32, pid: u32, force: bool, as_root: bool) -> R<()> {
    kill(&*conns.get(conn)?, pid, force, as_root).await
}

pub(crate) async fn kill(c: &Conn, pid: u32, force: bool, as_root: bool) -> R<()> {
    if pid <= 1 {
        return Err(err("OTHER", "이 프로세스는 멈출 수 없습니다"));
    }
    let cmd = format!("kill -s {} {pid}", if force { "KILL" } else { "TERM" });
    let o = if as_root { sudo(c, &cmd, None).await? } else { exec(c, &cmd, None).await? };
    if o.code != Some(0) {
        let m = o.stderr.trim();
        return Err(err(
            "OTHER",
            if m.contains("not permitted") { "권한이 없습니다 — sudo 를 켜고 다시 하세요".to_string() } else if m.is_empty() { "멈추지 못했습니다".into() } else { m.to_string() },
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../tests/monitor-sample.txt");

    #[test]
    fn parses_sample() {
        let s = parse(SAMPLE).unwrap();
        assert!(s.ncpu >= 1);
        assert_eq!(s.cpu.len(), s.ncpu + 1);
        assert!(s.mem.total > 0 && s.mem.available > 0);
        assert!(!s.disks.is_empty(), "df: {:?}", s.disks);
        assert!(s.procs.iter().any(|p| p.pid == 1));
        assert!(s.procs.iter().all(|p| !p.name.is_empty()));
        assert!(s.uptime_s > 0.0);
    }

    #[test]
    fn old_df_and_kernel() {
        // CentOS 6 식: MemAvailable 없음, df 에 Type 없음, 이름에 공백 있는 프로세스
        let t = "@host\nold\nLinux 2.6.32\n4096\n@stat\ncpu 10 0 10 70 10 0 0 0\ncpu0 10 0 10 70 10 0 0 0\nprocs_running 2\n@mem\nMemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n@load\n0.5 0.4 0.3 1/90 123\n1234.5 99.0\n@net\nInter-|   Receive\n face |bytes\n  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n    lo: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n@df\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 600 400 60% /data dir\ntmpfs 100 0 100 0% /dev/shm\n@io\n   8 0 sda 1 0 10 0 2 0 20 0 0 0 0\n   8 1 sda1 1 0 10 0 2 0 20 0 0 0 0\n@ps\n1\t5\t100\tS\tinit\n42\t7\t10\tR\tmy proc\n@user\n    1 root\n   42 app\n";
        let s = parse(t).unwrap();
        assert_eq!(s.mem.available, 400);
        assert_eq!(s.cpu[0].busy, 20);
        assert_eq!(s.cpu[0].total, 100);
        assert_eq!(s.disks.len(), 1);
        assert_eq!(s.disks[0].mount, "/data dir");
        assert_eq!(s.net.len(), 1);
        assert_eq!(s.net[0].tx, 200);
        assert_eq!(s.io.len(), 1);
        assert_eq!(s.procs[1].name, "my proc");
        assert_eq!(s.procs[1].user, "app");
        assert_eq!(s.procs[0].rss_k, 400);
    }

    #[test]
    fn rejects_non_linux() {
        assert!(parse("@host\nmac\nDarwin 24\n4096\n@stat\n").is_err());
    }

    #[test]
    fn du_sorted() {
        let v = parse_du("10\t./a\n300\t.\n200\t./b c\n");
        assert_eq!(v[0].name, ".");
        assert_eq!(v[1].name, "b c");
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// RB_SSH_TEST=127.0.0.1:22122 · RB_SSH_TEST_PW — 두 번 재기·du·kill(일반·sudo)
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_stats_du_kill() {
        let spec = std::env::var("RB_SSH_TEST").unwrap();
        let pw = std::env::var("RB_SSH_TEST_PW").unwrap();
        let mut it = spec.split(':');
        let host = it.next().unwrap().to_string();
        let port: u16 = it.next().unwrap().parse().unwrap();
        let dir = std::env::temp_dir().join(format!("rbshell-mon-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::store::Store::open(dir.join("db"), false).unwrap();
        let conns = SshConns::default();
        let cid = crate::ssh::test_connect(&store, &conns, &host, port, "rbtest", &pw).await;
        let c = conns.get(cid).unwrap();
        let t = std::time::Instant::now();
        let a = stats(&c).await.unwrap();
        let first = t.elapsed();
        let t = std::time::Instant::now();
        let b = stats(&c).await.unwrap();
        println!("stats {first:?} / {:?}  host={} kernel={} ncpu={} procs={} disks={:?} net={} io={}", t.elapsed(), b.host, b.kernel, b.ncpu, b.procs.len(), b.disks.iter().map(|d| &d.mount).collect::<Vec<_>>(), b.net.len(), b.io.len());
        assert!(b.cpu[0].total >= a.cpu[0].total);
        assert!(b.procs.iter().any(|p| p.name == "sshd" && p.user == "root"));
        assert!(!b.disks.is_empty());
        let d = du(&c, "/home/rbtest", false).await.unwrap();
        println!("du {:?}", d.iter().take(5).collect::<Vec<_>>());
        assert_eq!(d[0].name, ".");
        assert!(d.iter().any(|e| e.name == "app"));
        let d = du(&c, "/root", true).await.unwrap();
        assert!(d.iter().any(|e| e.name == "."), "sudo du {d:?}");
        // 내 프로세스 TERM, root 프로세스는 거절 → sudo 로 KILL
        let mut ch = c.handle_ref().channel_open_session().await.unwrap();
        ch.exec(true, "nohup sleep 300 >/dev/null 2>&1 & echo $!; sudo -n nohup sleep 301 >/dev/null 2>&1 & sleep 0.3; pgrep -u root -x sleep | head -1").await.unwrap();
        let mut out = Vec::new();
        while let Some(m) = ch.wait().await { if let russh::ChannelMsg::Data { data } = m { out.extend_from_slice(&data); } }
        let ids: Vec<u32> = String::from_utf8_lossy(&out).split_whitespace().filter_map(|x| x.parse().ok()).collect();
        println!("pids {ids:?}");
        kill(&c, ids[0], false, false).await.unwrap();
        let e = kill(&c, ids[1], false, false).await.unwrap_err();
        println!("거절: {e:?}");
        kill(&c, ids[1], true, true).await.unwrap();
        assert!(kill(&c, 1, true, true).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
