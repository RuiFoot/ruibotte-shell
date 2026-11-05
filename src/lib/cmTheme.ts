import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * 코드 색 — 편집기·SQL·비교가 함께 쓴다. 색은 CSS 변수(--syn-*)라 라이트·다크가 OS 를 따라 저절로 바뀐다.
 * (CodeMirror 기본 색은 밝은 바탕 전용이라 다크에서 남색 글자가 묻혔다)
 */
const style = HighlightStyle.define([
	{ tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
	{ tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--syn-string)" },
	{ tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--syn-number)" },
	{ tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
	{ tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--syn-prop)" },
	{ tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-func)" },
	{ tag: [t.definition(t.variableName), t.variableName, t.self], color: "var(--syn-var)" },
	{ tag: [t.operator, t.punctuation, t.separator, t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace], color: "var(--syn-punct)" },
	{ tag: [t.meta, t.processingInstruction, t.annotation], color: "var(--syn-meta)" },
	{ tag: t.heading, color: "var(--syn-keyword)", fontWeight: "700" },
	{ tag: t.link, color: "var(--accent)", textDecoration: "underline" },
	{ tag: t.emphasis, fontStyle: "italic" },
	{ tag: t.strong, fontWeight: "700" },
	{ tag: t.invalid, color: "var(--danger)" },
	{ tag: [t.inserted], color: "var(--ok)" },
	{ tag: [t.deleted], color: "var(--danger)" },
]);

export const codeHighlight = syntaxHighlighting(style);
