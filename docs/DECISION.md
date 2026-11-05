# 기술 스택 결정 (2026-11-05)

웹 콘솔에 있던 두 도구를 하나의 로컬 데스크톱 앱으로 다시 만든다. 하나는 SSH 작업대(3칸 터미널·SFTP·편집기·sudo·구형 SSH 호환·명령어 사전)이고, 다른 하나는 DB 작업대(DataGrip식 트리·SQL·결과 표 편집)다.
최우선 기준은 성능이다. 기동·메모리·설치 크기·화면 반응이 그 내용이다. 그다음이 쉬운 설치다.
후보 비교와 판정은 별도 어드바이저 검토를 거쳤다. 라이브러리 문서·소스로 확인한 사실은 [확인], 추정은 [추정]으로 적는다.

## 결정

**Tauri 2 + Rust 백엔드 + React 19 화면.** 차선은 .NET 9 + Avalonia다.

- 터미널(xterm.js WebGL)·코드 편집기(Monaco)·큰 표(TanStack Virtual)는 검증된 웹 부품을 쓴다. 네트워크·암호·DB·파일은 Rust 로 내린다.
- 네이티브 Rust GUI(egui·iced·GPUI)는 터미널·편집기를 직접 만들어야 해 일정이 크게 는다.
- Avalonia 는 성숙한 터미널 컨트롤이 없고, SSH.NET 에 ssh-dss 가 없다 [확인].
- Electron 은 메모리 300~450 MB, 설치 90~130 MB 로 기준 미달이다 [추정].

## 비교 (5=최상, 대부분 [추정] — 아래 스파이크로 실측)

| 축 | Tauri 2+Rust | 네이티브 Rust GUI | .NET+Avalonia | Electron |
|---|---|---|---|---|
| 기동 | 4 | 5 | 3(AOT 4) | 2 |
| 상주 메모리 | 3~4 | 5 | 3 | 1 |
| 설치 용량 | 4 | 5 | 3 | 1 |
| 터미널 | 4 | 2 | 1~2 | 4 |
| 큰 표 | 4 | 4 | 3 | 4 |
| SSH·SFTP | 5 | 5 | 3 | 2 |
| DB 드라이버 | 4 | 4 | 5 | 3 |
| 서명·업데이트 | 4 | 3 | 5 | 4 |
| 웹 부품 재사용 | 5 | 0 | 1 | 5 |
| AI 유지보수성 | 5 | 2 | 4 | 5 |

## 핵심 부품

| 영역 | 선택 |
|---|---|
| SSH | russh 0.65 — 구형 알고리즘(ssh-rsa SHA-1, dh-group1/14-sha1, gex-sha1, aes-cbc, 3des-cbc, ssh-dss)을 프로필마다 런타임 `Preferred` 로 켠다 [확인]. 단계는 OFF / RSA / SHA1 / WEAKEST |
| SFTP | russh-sftp, sudo 파일 작업은 셸 채널 + `sudo -S` |
| 터미널 데이터 | `tauri::ipc::Channel` 바이너리 → xterm `write(Uint8Array)`. JSON 이벤트는 쓰지 않는다 |
| 인코딩 | encoding_rs + chardetng(UTF-8·EUC-KR·UTF-16·BOM·CRLF 보존) |
| PostgreSQL | tokio-postgres(CancelToken·RowStream), 임의 타입은 텍스트 형식 결과 |
| MySQL·MariaDB | mysql_async(구판 인증 플러그인 포함 [확인]), 취소는 두 번째 연결 `KILL QUERY` |
| 후속 DB | MSSQL tiberius, Oracle·CUBRID 는 JDBC 사이드카(선택 설치) |
| 결과 표 | 행은 Rust 에 두고 화면은 보이는 구간만 받는다(`grid_rows(from,to)`). Canvas 표와 실측 비교 예정 |
| 앱 저장 | SQLite(rusqlite, WAL, FTS5) 파일 하나. Postgres 내장은 쓰지 않는다(별도 서버·포트·기동 지연) |
| 비밀 | OS 자격 증명 저장소(keyring — Windows Credential Manager·macOS Keychain). 앱 DB 에는 넣지 않는다 |
| 업데이트 | tauri-plugin-updater + GitHub Releases `latest.json`, minisign 서명 필수 |

## 디자인

- 사내 디자인 시스템을 따르지 않는다. Apple macOS·iOS 최신 풍(Liquid Glass 다음 세대)의 자체 디자인을 Windows·macOS 공통으로 쓴다. 창 단추만 각 OS 관례를 따른다.
- 창 바탕 흐림은 OS 가 그린다. Windows 11 은 Mica, macOS 는 vibrancy 다.
- CSS `backdrop-filter` 는 떠 있는 층(시트·팝오버·팔레트)에만 쓴다. 터미널·편집기·표 본문은 불투명이다.
- 글꼴: macOS 는 SF Pro·SF Mono 다. Windows 는 SF 를 번들할 수 없어(라이선스) Pretendard·Segoe UI Variable, 터미널은 Cascadia·D2Coding 계열을 쓴다.
- 웹 흔적을 지운다. 브라우저 우클릭 메뉴, 글자 끌어 선택, 손가락 커서, 스크롤 튕김이 없다.

## 리스크와 스파이크 (합격 기준)

| # | 리스크 | 합격 기준 | 상태 |
|---|---|---|---|
| 1 | 터미널 대량 출력 IPC | 24 MiB ≤ 3초, 처리 중 키 에코 p95 ≤ 50 ms | 0.1.0 에 "출력 벤치" 단추 — 측정 중 |
| 2 | russh 로 구형 서버(OpenSSH 5.3·CentOS 7) | 4단계 핸드셰이크, ssh-dss 포함, 1시간 유지·재연결 | 1단계 |
| 3 | PostgreSQL 임의 타입 표시 | 미지 타입 오류 0, 10만 행 첫 행 ≤ 300 ms, 취소 ≤ 500 ms | 1단계 |
| 4 | MariaDB 5.5·MySQL 5.7·8.0 인증·취소 | 3종 접속, KILL QUERY 취소 | 1단계 |
| 5 | 상주 메모리·기동 | 합계 ≤ 300 MB(목표 250), 콜드 기동 → 첫 입력 ≤ 1.2초(목표 0.8) | 0.1.0 측정 중 |

## 측정 결과

### 0.1.0 (2026-11-05, Windows 11, 노트북 1대)

| 항목 | 결과 | 목표 |
|---|---|---|
| 설치 파일(NSIS) | 2.66 MiB | ≤ 20 MB ✅ |
| 설치 폴더 | 6.1 MB | ≤ 60 MB ✅ |
| 무인 설치 시간 | 1.5초 | — |
| 실행 → 창 표시 | 167 ms | 콜드 ≤ 0.8초 ✅ (첫 입력까지는 다음에) |
| 메모리, 홈 화면(앱+WebView2 6개 전 프로세스 private 합) | 206 MB | ≤ 250 MB ✅ |
| 메모리, 터미널 1개 + 스크롤백 1만 줄 가득 | 269 MB | ≤ 250 MB ❌ (상한 300 안) — 줄일 곳: 스크롤백 상한·WebGL 아틀라스·WebView2 GPU 프로세스 |
| 터미널 24 MiB 출력(바이너리 채널 → xterm WebGL) | 0.81초 (≈30 MiB/s), 64 KiB 묶음 384개, Rust 보내기 61 ms | ≤ 3초 ✅ |
| 첫 화면 JS | 259 KB(gzip 81 KB) — 터미널·표·사전은 지연 로드 | — |

### 0.2.0 (2026-11-05, 같은 PC, Docker 시험 서버)

| 항목 | 결과 |
|---|---|
| SSH 접속(최신 OpenSSH, ED25519·암호 인증) | 126~151 ms |
| 구형 흉내 서버(SHA-1 KEX·ssh-rsa·CBC 만) | 기본 단계 협상 실패 → SHA1 단계 제안 → 접속 성공 |
| PostgreSQL 18 접속 / 20만 행 중 10만 행 상한 첫 행·전체 | 57 ms / 32 ms · 0.52초 |
| MariaDB 11 접속 / 같은 조회 | 4 ms / 89 ms · 0.93초 |
| 실행 중 취소(pg_sleep·SLEEP 10초) | 0.3초에 멈춤, 같은 연결로 다음 문장 바로 실행 |
| 읽기 전용 | DELETE 거절, CTE 안 DELETE 도 서버가 거절 |

## 벤치 계획

기준 PC 1대에서 수기로 측정하고 결과를 이 문서에 표로 고정한다. 릴리스마다 기동·메모리를 다시 잰다.

| 항목 | 목표 |
|---|---|
| 기동(콜드/웜, 5회 중앙값) | ≤ 0.8초 / ≤ 0.4초 |
| 메모리(창1·SSH1·터미널3·DB1·10만 행, 5분 뒤 전 프로세스 합) | ≤ 250 MB |
| 설치 크기 | exe ≤ 20 MB, 설치 폴더 ≤ 60 MB |
| 터미널 대량 출력 | 24 MiB ≤ 3초 |
| 10만 행 표 | 첫 행 ≤ 300 ms, 스크롤 프레임 p95 ≤ 16 ms |
| SFTP | 1 GB ≥ 80 MB/s(LAN), 작은 파일 ≥ 200개/초 |
