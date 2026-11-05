# 번역 표본 검수(D24)

무작위 40개(씨앗 20261104) — 사내 gemma(google/gemma-4-12b-it) 번역. 판정은 아래 "검수"에.

| # | 영어 | 한국어 |
|---|---|---|
| 1 | Read from tar archive file, instead of STDIN | STDIN 대신 tar 아카이브 파일에서 읽기 |
| 2 | Reopen stdin as /dev/tty (useful for running interactive applications) | stdin을 /dev/tty로 다시 열기 (대화형 애플리케이션 실행에 유용) |
| 3 | Enable/Disable bold text | 굵은 텍스트 활성화/비활성화 |
| 4 | Fix only the specified bench target | 지정된 bench target만 수정 |
| 5 | Indicate that this key may repeat | 이 키의 반복 가능 여부 표시 |
| 6 | Causes less to prompt even more verbosely than more | more보다 훨씬 더 자세하게 프롬프트 표시 |
| 7 | Execute a command without create a new window | 새 창 생성 없이 명령 실행 |
| 8 | Initialize, update or inspect submodules | submodules 초기화, 업데이트 또는 검사 |
| 9 | Set the Module's Versions field to a list of all known versions of that module | Module's Versions 필드를 해당 module의 모든 알려진 버전 목록으로 설정 |
| 10 | Like get, but returns all values for a multi-valued key | get와 유사하지만 multi-valued key의 모든 값 반환 |
| 11 | Start at end of file, if line number is specified, start at that line | 파일 끝에서 시작, line 번호 지정 시 해당 줄에서 시작 |
| 12 | Interpreted object-oriented scripting language | 해석형 객체 지향 스크립팅 언어 |
| 13 | Use string to terminate sequence of numbers | 숫자 시퀀스를 종료할 문자열 사용 |
| 14 | Dependency types to omit from the installation tree on disk | 디스크의 설치 트리에서 제외할 Dependency 유형 |
| 15 | Reserve the x13 register (AArch64/RISC-V only) | register x13 예약 (AArch64/RISC-V 전용) |
| 16 | Tells npm to not create symlinks (or .cmd shims on Windows) for package executables | 패키지 실행 파일에 대한 symlinks(또는 Windows의 .cmd shims) 생성 안 함 |
| 17 | Prepend the node executable dir to the PATH in scripts | scripts 내 PATH에 node 실행 파일 dir 추가 |
| 18 | Change the default settings of the named environment variables to the given values | 이름이 지정된 환경 변수의 기본 설정을 주어진 값으로 변경 |
| 19 | List all entries except for . and ... Always set for the super-user | . 및 ... 제외한 모든 항목 목록 표시, super-user에 항상 설정 |
| 20 | Remove a package from the registry | registry에서 package 제거 |
| 21 | Alias to '-o X-mount.mkdir | -o X-mount.mkdir 별칭 |
| 22 | Name of compiler to use, as in runtime.Compiler (gccgo or gc) | runtime과 동일하게 사용할 컴파일러 이름 (gccgo 또는 gc) |
| 23 | Shorten the output of uptime | uptime 출력 단축 |
| 24 | Search for sources only in the specified directory | 지정된 폴더 내 sources만 검색 |
| 25 | Shows number of added and deleted lines in decimal notation | 추가 및 삭제된 줄 수를 10진수로 표시 |
| 26 | Kill one or more running containers with a specific signal | 특정 signal로 하나 이상의 실행 중인 container 종료 |
| 27 | Match exactly with the command name | 명령 이름과 정확히 일치 |
| 28 | Update to newer minor or patch releases when available | 가능한 경우 더 새로운 minor 또는 patch 릴리스로 업데이트 |
| 29 | Add additional groups to join | 참여할 추가 그룹 추가 |
| 30 | Print version and exit | version 출력 및 종료 |
| 31 | Fail if checksums do not match | checksum 일치하지 않을 경우 실패 |
| 32 | Print version info | 버전 정보 출력 |
| 33 | End lines with 0 byte, not newline | 줄 끝을 newline 대신 0 byte로 종료 |
| 34 | Forces nc to use IPv6 addresses only | nc가 IPv6 주소만 사용하도록 강제 |
| 35 | Syntax check script without executing | 실행 없이 script 구문 검사 |
| 36 | Number the non-blank output lines, starting at 1 | 비어 있지 않은 출력 줄에 1부터 번호 매기기 |
| 37 | Use DNS SRV lookup for host information | host 정보에 DNS SRV lookup 사용 |
| 38 | Enables X11 forwarding | X11 forwarding 활성화 |
| 39 | Set the maximum number of tasks to run simultaneously. For unlimited concurrency use Infinity | 동시에 실행할 최대 task 수 설정. 무제한 병렬 실행 시 Infinity 사용 |
| 40 | GPG-sign commits. The keyid argument is optional and defaults to the committe | GPG-sign commits. keyid 인자는 선택 사항이며 기본값은 committe |

## 검수

11-04, 표본 40개를 영어 원문과 한 줄씩 대조했다(SSH 작업대 세션).

- **뜻이 맞음 38/40.** 옵션 글자·명령 이름·기술 용어(STDIN, /dev/tty, IPv6, X11 forwarding)는 원문 그대로 남는다.
- **어색함 2/40.**
  - #4 "Fix … bench target": cargo 의 '고치기(fix)' 동작인데 "수정"으로 옮겨 뜻은 통하나 모호하다.
  - #9: 원문 구조를 그대로 따라 읽기 어렵다.
- **영어 낱말이 그대로 남는 경향**(package·registry·container·signal·task·script 등): 뜻은 통하고 터미널 사용자에게 익숙한 말이라 그대로 둔다.
- **원문이 잘린 것**(#40): 추출 단계에서 200자로 자른 영향이다. 짧은 설명이라 화면에서는 문제없다.
- 판정: 화면 설명으로 쓰기에 충분하다. 자주 쓰는 명령(ls·cp·grep·find·tar·du·sed·awk·xargs 등)은 손으로 적은 한국어(completion-specs.ts)가 먼저 보인다.
