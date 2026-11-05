import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from "@codemirror/autocomplete";
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
export function editingExtensions(): Extension[] {
	return [
		autocompletion({ activateOnTyping: true, maxRenderedOptions: 80, icons: true }),
		EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
		closeBrackets(),
		EditorState.allowMultipleSelections.of(true),
		rectangularSelection({ eventFilter: (e) => e.altKey }),
		crosshairCursor({ key: "Alt" }),
		EditorView.clickAddsSelectionRange.of((e) => e.altKey),
		keymap.of([...closeBracketsKeymap, ...completionKeymap, { key: "Mod-g", run: gotoLine, preventDefault: true }]),
	];
}
