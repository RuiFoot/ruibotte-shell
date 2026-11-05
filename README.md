# RuiBotte Shell

SSH 터미널·SFTP·편집기와 DataGrip식 DB 접근기를 하나로 합친 **가볍고 빠른 데스크톱 앱**(Windows·macOS).
웹 콘솔이 서버를 거쳐 중계하던 방식과 달리, 이 앱은 **내 PC 에서 서버·DB 에 바로 붙는다**.

- 백엔드 Rust(Tauri 2) — SSH·SFTP·DB·인코딩·파일·비밀 저장
- 화면 React 19 + TypeScript — 터미널 xterm.js(WebGL), 결과 표 가상화, Apple macOS·iOS 풍 자체 디자인
- 앱 자체 저장 SQLite 파일 하나, 암호는 원할 때만 OS 자격 증명 저장소(Windows 자격 증명 관리자·macOS 키체인)

## 할 수 있는 것 (0.5)

**SSH 서버**
- 접속: 암호·개인키·keyboard-interactive. 처음 보는 호스트 키는 지문을 확인하고 고정하며, 바뀌면 인증 전에 막는다
- 구형 서버: 서버마다 구형 호환 단계(RSA·SHA1·최후). 협상에 실패하면 서버 목록을 보여 주고 켤 단계를 제안한다
- 점프 호스트: 다른 SSH 프로필을 거쳐 접속한다
- IDE식 작업대: 파일 트리·편집기·터미널·내 PC 트리·전송·동기화 칸을 탭처럼 끌어 어디든 붙이고 합친다. 배치는 기억한다
- 편집기: 언어별 색, EUC-KR·UTF-16·BOM·CRLF 를 원래대로 저장한다. 연 뒤 서버에서 바뀌었으면 덮어쓰지 않는다. JSON·XML 정리, 자동 저장(선택)
- 미리보기: 이미지·PDF·마크다운·CSV/TSV 표·바이너리 헥스
- 실시간 보기(tail -F): 로그 색 그대로, 멈춤·찾기·EUC-KR
- 좌우 비교: 원격·내 PC 파일을 섞어 비교하고 덩어리를 옮긴다
- 주고받기: 트리끼리 끌어 놓기·우클릭. 동시 3개, 끊기면 이어받기, 끝나면 sha256 확인. 폴더째 tar.gz 로 받기, 서버 A → 서버 B 중계
- 동기화(rsync 모드): 미리보기(dry-run)·지우기·체크섬·제외 패턴, 같은 설정의 rsync 명령, 경로 매핑 자동 반영(충돌은 덮어쓰지 않음)
- 파일 조작: 새 파일·폴더·이름 바꾸기·지우기(내 PC 는 휴지통)
- sudo: 일반 계정으로 root 파일을 다룬다. "터미널도 같이"면 터미널도 root 셸이 된다
- 터미널: 여러 개, 명령마다 ✓/✗·걸린 시간, 트리가 지금 폴더를 따라감, 찾기·링크·글꼴 크기·여러 줄 붙여넣기 확인·스크롤백 저장, EUC-KR, 동시 입력, 오래 걸린 명령 끝 알림, root 표시, 끊기면 다시 연결
- 자동완성: 흐린 제안(→), Tab 목록(명령·하위 명령·옵션 한국어 설명·경로·지난 명령), 스니펫(Alt+P)
- 가져오기: `~/.ssh/config`·PuTTY 세션. 내보내기: ssh config·hosts·PuTTY·MobaXterm

**데이터베이스** — PostgreSQL·MariaDB·MySQL·SQL Server 는 앱에 들어 있고, Oracle·CUBRID·Tibero·Altibase 는 JDBC 브리지로
- 객체 트리, SQL 편집기(커서 문장·고른 글·전체 실행, 문장마다 결과 탭, `:이름` 파라미터, 초안 자동 저장), 실행 전 확인(DDL·WHERE 없는 UPDATE/DELETE)
- 결과 표: 수십만 행 가상화, 행 상한, 실행 중 취소, CSV·TSV·JSON 내보내기, 우클릭 복사(CSV·TSV·JSON·Markdown·INSERT)·값으로 거르기
- 표 편집: 칸 안 편집·형식별 입력기(날짜·참거짓·enum·숫자·JSON·UUID)·NULL·행 추가/복제/삭제·SQL 보기·반영(한 트랜잭션, 1행 보장), 수동 트랜잭션
- 도구: DDL 보기·실행 계획·객체 찾기(Alt+O)·표 크기·세션(멈추기)·잠금·쿼리 기록·ERD·스키마 비교·즐겨찾는 SQL
- 읽기 전용 접속: 세션 READ ONLY + 조회 문장만(SQL Server·JDBC 엔진은 문장 판별만)
- JDBC 브리지: 처음 쓸 때만 Java 실행기(Temurin JRE 21)·드라이버를 받아 확인한다. 기본 설치 크기는 그대로다
- 가져오기: DataGrip·DBeaver 파일. 내보내기: DataGrip·DBeaver·JDBC CSV

**공통**: 내 PC 터미널(같은 작업대), 리눅스 명령어 사전 358개(한국어), 암호는 원할 때만 OS 자격 증명 저장소에, 설정 › 정보(업데이트·자동 실행), 자동 업데이트

다음 계획은 [로드맵](docs/ROADMAP.md).

## 설치

[Releases](../../releases) 에서 받는다.

| OS | 파일 | 비고 |
|---|---|---|
| Windows 10/11 | `RuiBotte.Shell_<버전>_x64-setup.exe` | 사용자별 설치(관리자 권한 불필요), `%LOCALAPPDATA%\Programs` 에 설치, 설정 › 앱에서 제거 |
| Windows 포터블 | `RuiBotteShell-Portable-<버전>.exe` | 설치 없이 실행. 자료는 exe 옆 `<exe 이름>-data/` |
| macOS 12+ | `RuiBotte.Shell_<버전>_universal.dmg` | Apple Silicon·Intel 공용. 아직 서명 전이라 처음 한 번 Finder 에서 우클릭 › 열기 |

- Windows 는 아직 코드 서명 전이라 SmartScreen 에서 "추가 정보 › 실행"을 한 번 눌러야 한다.
- WebView2 가 없는 PC(드묾)는 설치 프로그램이 자동으로 받아 설치한다.
- **업데이트:** 앱이 시작 1분 뒤와 6시간마다 새 판을 확인한다(설정 › 정보에서 끌 수 있음). 새 판이면 OS 알림을 한 번 띄우고 사이드바 아래에 "업데이트 설치"가 뜬다. 설정 › 정보의 "확인"으로 바로 다시 확인할 수 있다. 받은 파일은 서명을 확인한 뒤에만 설치한다. 포터블판은 릴리스 페이지에서 새 파일을 받는다.
- **설정 › 정보:** 로그인할 때 자동 실행, 데이터 폴더 열기, 문제 보고(GitHub 이슈), 릴리스 노트

## 자료 위치

| | Windows | macOS |
|---|---|---|
| 앱 DB(`app.db`) | `%APPDATA%\com.ruibotte.shell\` | `~/Library/Application Support/com.ruibotte.shell/` |

## 단축키

| | Windows | macOS |
|---|---|---|
| 새 터미널 | Ctrl+T | ⌘T |
| 탭 닫기 | Ctrl+W | ⌘W |
| 찾기(홈) | Ctrl+K | ⌘K |

## 개발

필요: Node 24 + pnpm 11, Rust stable(Windows 는 MSVC 빌드 도구), Windows 는 WebView2(Windows 11 기본).

```bash
pnpm install
pnpm app:dev      # 앱 창 + 화면 핫 리로드
pnpm app:build    # 설치 파일(src-tauri/target/release/bundle/)
```

- 브랜치: `develop` 에서 작업하고, 릴리스할 때 `main` 으로 합친 뒤 태그를 단다. 절차는 [docs/RELEASE.md](docs/RELEASE.md).
- 기술 선택 근거·벤치 계획: [docs/DECISION.md](docs/DECISION.md)
- 명령어 사전 데이터: [tools/cmd-dict/README.md](tools/cmd-dict/README.md), 고지 [NOTICE.md](NOTICE.md)

## 라이선스

MIT. 포함한 외부 데이터의 라이선스는 [NOTICE.md](NOTICE.md).
