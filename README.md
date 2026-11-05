# RuiBotte Shell

SSH 터미널·SFTP·편집기와 DataGrip식 DB 접근기를 하나로 합친 **가볍고 빠른 데스크톱 앱**(Windows·macOS).
웹 콘솔이 서버를 거쳐 중계하던 방식과 달리, 이 앱은 **내 PC 에서 서버·DB 에 바로 붙는다**.

- 백엔드 Rust(Tauri 2) — SSH·SFTP·DB·인코딩·파일·비밀 저장
- 화면 React 19 + TypeScript — 터미널 xterm.js(WebGL), 결과 표 가상화, Apple macOS·iOS 풍 자체 디자인
- 앱 자체 저장 SQLite 파일 하나, 암호·키는 OS 자격 증명 저장소(다음 판)

> 지금 판(0.1.x)은 **시제품**이다. 앱 틀·디자인, 로컬 터미널, 10만 행 결과 표, 리눅스 명령어 사전, 접속 프로필 저장, 자동 업데이트까지 들어 있다.
> SSH·DB 실제 연결은 [로드맵](docs/ROADMAP.md) 1단계에서 붙는다.

## 설치

[Releases](../../releases) 에서 받는다.

| OS | 파일 | 비고 |
|---|---|---|
| Windows 10/11 | `RuiBotte.Shell_<버전>_x64-setup.exe` | 사용자별 설치(관리자 권한 불필요), `%LOCALAPPDATA%\Programs` 에 설치, 설정 › 앱에서 제거 |
| Windows 포터블 | `RuiBotteShell-Portable-<버전>.exe` | 설치 없이 실행. 자료는 exe 옆 `<exe 이름>-data/` |
| macOS 12+ | `RuiBotte.Shell_<버전>_universal.dmg` | Apple Silicon·Intel 공용. 아직 서명 전이라 처음 한 번 Finder 에서 우클릭 › 열기 |

- Windows 는 아직 코드 서명 전이라 SmartScreen 에서 "추가 정보 › 실행"을 한 번 눌러야 한다.
- WebView2 가 없는 PC(드묾)는 설치 프로그램이 자동으로 받아 설치한다.
- **업데이트:** 앱이 시작 1분 뒤와 6시간마다 새 판을 확인한다. 새 판이 있으면 사이드바 아래에 "업데이트 설치"가 뜬다. 받은 파일은 서명을 확인한 뒤에만 설치한다.

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
