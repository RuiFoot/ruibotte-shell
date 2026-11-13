import { autocompletion, type CompletionContext, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from "@codemirror/autocomplete";
import { gotoLine } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { crosshairCursor, EditorView, keymap, rectangularSelection } from "@codemirror/view";

/**
 * 편집기 공통 편의 — Monaco(Orbit) 가 기본으로 주던 것들.
 * - 자동완성: 언어가 주는 것(키워드·태그·속성 등) + 문서 안 낱말. 치는 대로 뜨고, Ctrl+Space 로 열기, Enter·Tab 으로 넣기
 * - 괄호·따옴표 자동 닫기
 * - 여러 커서: Alt+누르기로 커서 더하기, Alt+끌기로 사각 선택, Ctrl+D 로 같은 낱말 다음 것 더하기(search 키맵)
 * - 줄로 가기: Ctrl+G
 */
/** 문서 안 낱말 완성 — 직접 연 것(Ctrl+Space)이 아니면 두 글자 이상 쳤을 때만 */
const wordsFrom2 = (ctx: CompletionContext) => {
	if (!ctx.explicit) {
		const w = ctx.matchBefore(/\w+$/);
		if (!w || w.to - w.from < 2) return null;
	}
	return completeAnyWord(ctx);
};

/** autocompletion() 에 덧댈 것 — SQL 편집기는 자기 소스 하나(override)로 순서·거르기를 직접 정한다 */
export type CompletionOverride = Pick<NonNullable<Parameters<typeof autocompletion>[0]>, "override" | "icons" | "addToOptions" | "tooltipClass">;

/** completion 을 주면 그 설정으로(언어·문서 낱말 소스는 쓰지 않는다), 안 주면 지금까지처럼 */
export function editingExtensions(opts: { completion?: CompletionOverride } = {}): Extension[] {
	return [
		// 치는 동안 낱말마다 목록이 깜박이지 않게 — 잠깐 멈추면(200ms) 열고, 문서 안 낱말은 두 글자부터
		autocompletion({ activateOnTyping: true, activateOnTypingDelay: 200, maxRenderedOptions: 80, icons: true, ...opts.completion }),
		opts.completion ? [] : EditorState.languageData.of(() => [{ autocomplete: wordsFrom2 }]),
		closeBrackets(),
		EditorState.allowMultipleSelections.of(true),
		rectangularSelection({ eventFilter: (e) => e.altKey }),
		crosshairCursor({ key: "Alt" }),
		EditorView.clickAddsSelectionRange.of((e) => e.altKey),
		keymap.of([...closeBracketsKeymap, ...completionKeymap, { key: "Mod-g", run: gotoLine, preventDefault: true }]),
	];
}
