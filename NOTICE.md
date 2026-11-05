# NOTICE — RuiBotte Shell 에 포함한 외부 데이터

## 리눅스 명령어 사전·터미널 자동완성 데이터 (`data/cmd-dict/dict.json`)

빌드 때 한 번 아래 두 원천에서 자주 쓰는 리눅스 명령(약 360개, `tools/cmd-dict/commands.txt`)만 뽑아, 설명을 LLM(gemma-4-12b-it)으로 한국어로 옮겼다. 실행 중 외부 호출은 없다. 받는 절차는 `tools/cmd-dict/README.md`.

### Fig autocomplete — MIT License

- 출처: https://github.com/withfig/autocomplete (npm `@withfig/autocomplete`, 사용 판은 `dict.json` 의 `src.fig`)
- 쓴 것: 명령·하위 명령·옵션 구조와 설명(번역함)

```
MIT License

Copyright (c) 2021 Hercules Labs Inc. (Fig)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### tldr-pages — Creative Commons Attribution 4.0 International (CC BY 4.0)

- 출처: https://github.com/tldr-pages/tldr — © the tldr-pages team and contributors (사용 커밋은 `dict.json` 의 `src.tldr`)
- 라이선스: https://creativecommons.org/licenses/by/4.0/
- 쓴 것: 명령별 대표 사용 예시. 한국어 페이지(`pages.ko`)는 그대로, 한국어 페이지가 없는 명령은 영어 페이지의 설명을 LLM 으로 번역했다(변경함). 예시 명령의 자리표시자 표기(`{{…}}`)는 원본 그대로.

## 함께 쓰는 라이브러리(파일 보기·SQL)

| 라이브러리 | 라이선스 | 쓰는 곳 |
|---|---|---|
| SheetJS Community Edition `xlsx` 0.18.5 | Apache-2.0 | 엑셀(xlsx·xls·ods) 미리보기 |
| `mammoth` | BSD-2-Clause | 워드(docx) 미리보기 |
| `sql-formatter` | MIT | SQL 정렬 |
| CodeMirror 6(`@codemirror/*`, `@lezer/*`) | MIT | 편집기·자동완성·언어 |
