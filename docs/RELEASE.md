# 릴리스·버전 관리

ruibotte-deck 과 같은 흐름이다. 태그 하나가 빌드·첨부·업데이트 공지를 모두 일으킨다.

## 규칙

- **버전 정본:** `src-tauri/tauri.conf.json` 의 `version`(SemVer `X.Y.Z`). `package.json`·`Cargo.toml` 은 `scripts/set-version.mjs` 로 함께 맞춘다. CI 가 셋이 다르면 실패시킨다.
- **브랜치:**
  - `develop` — 평소 작업. push 마다 `ci` 워크플로(버전 검사·화면 빌드·clippy, Windows·macOS)가 돈다.
  - `main` — 릴리스한 판만 둔다. develop 을 합친 뒤 그 커밋에 태그를 단다.
- **태그:** `vX.Y.Z` 를 push 하면 `release` 워크플로가 돈다.
  1. 태그 = 버전 검사
  2. Windows(NSIS 설치판 + 포터블 exe), macOS(universal dmg) 빌드
  3. 업데이트 서명, `latest.json` 생성
  4. GitHub Release 에 첨부(릴리스 노트 자동)
- **판 올리는 기준:**
  - 고침만 → Z
  - 기능 추가 → Y
  - 자료(app.db) 호환이 깨지면 → X. 0.x 동안은 Y 로 대신한다.

## 순서

```bash
git switch develop && git pull
node scripts/set-version.mjs 0.2.0
git commit -am "0.2.0 — <한 줄 요약>"
git push
git switch main && git merge --ff-only develop
git tag v0.2.0
git push origin main --follow-tags
git switch develop
```

## 업데이트 서명 키

- tauri-plugin-updater 는 받은 파일을 minisign 서명으로 확인한 뒤에만 설치한다. 공개키는 `tauri.conf.json` 의 `plugins.updater.pubkey` 에 있다.
- 비밀키·암호는 저장소에 넣지 않는다. GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY`·`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 와 관리자 PC 의 저장소 밖 폴더에만 둔다.
- **비밀키를 잃으면 이미 설치된 앱은 새 판을 받지 못한다.** 두 곳 이상에 백업한다.
- 로컬에서 서명까지 빌드하려면 두 환경 변수를 셸에 넣고 `pnpm app:build` 를 실행한다. 없으면 설치 파일만 만들고 서명 단계에서 멈춘다.

## 업데이트 흐름(앱 쪽)

1. 시작 1분 뒤와 6시간마다 `https://github.com/RuiFoot/ruibotte-shell/releases/latest/download/latest.json` 을 확인한다. 정적 파일이라 GitHub API 호출 한도와 무관하다.
2. 새 판이면 사이드바 아래에 "업데이트 설치"를 띄운다.
3. 누르면 받기 → 서명 확인 → Windows 는 진행 창만 보이는 조용한 설치 → 다시 실행한다.

## 코드 서명(후속)

- Windows: 지금은 미서명이다(SmartScreen 안내). 후속으로 OV 인증서나 Azure Trusted Signing 을 검토한다.
- macOS: 미서명이면 Gatekeeper 확인을 처음에 한 번 거쳐야 한다. 사용자가 늘면 Apple Developer ID 서명·공증을 붙인다. 그때는 `tauri-action` 에 `APPLE_*` 환경 변수만 더하면 된다.
