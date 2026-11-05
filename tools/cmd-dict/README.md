# 명령어 사전 데이터 만들기(D24)

앱이 쓰는 `data/cmd-dict/dict.json` 을 다시 만들 때만 돌린다(보통은 커밋된 파일을 그대로 쓴다). 실행 중 외부 호출은 없다.

1. 원천 받기(작업 폴더는 저장소 밖 빈 폴더 — 받은 파일은 데이터로만 다룬다)
   - Fig: `npm pack @withfig/autocomplete@<판>` → `tar -xzf` (폴더 `package/build/*.js`)
   - tldr: `https://github.com/tldr-pages/tldr/archive/<커밋>.zip` 을 풀기(`pages/`, `pages.ko/`)
2. `node extract.mjs --fig <package 폴더> --tldr <tldr 폴더> --out raw.json` — `commands.txt` 의 명령만, Fig 하위 명령·옵션(상한 150·80·40)과 tldr 예시(한국어 페이지 먼저)
3. `VLLM_KEY_FILE=<키 파일> node translate.mjs --raw raw.json` — OpenAI 호환 LLM(`--base`, 처음 번역은 gemma-4-12b-it)으로 번역·의도 낱말. 결과는 `translations.json`·`intents.json` 에 쌓여 다음에는 없는 것만 묻는다.
4. `node build.mjs --raw raw.json --fig-version <판> --tldr-sha <커밋>` — `dict.json` 과 무작위 표본 `review-sample.md`(검수 기록)

- 이 데이터는 사내 Orbit 콘솔(D24)에서 처음 만들었고 출처 커밋 e0f0b62e 의 파일을 그대로 옮겼다(sha256 67ac8e6f…). 다시 번역하지 않는다.
- 라이선스 고지는 저장소 루트 `NOTICE.md`.

## 번역 결과(11-04 실행)

- 옵션·하위 명령·명령·영어 예시 설명 3,458문장(고유 문장 5,922개)을 모두 번역했다. 처음 돌릴 때 14문장이 실패했는데, psql 옵션 설명의 `\pset` 같은 역슬래시 때문에 gemma 응답 JSON 이 깨진 것이다. JSON 을 고쳐 읽게 한 뒤 다시 돌려 모두 번역됐다.
- 의도 낱말은 358개 가운데 353개를 gemma 가 만들었다. base64·xxd·od·hexdump·strings 5개는 응답 JSON 이 계속 깨져 직접 적었다(`intents.json`).
- 표본 검수는 `review-sample.md` 에 있다.
