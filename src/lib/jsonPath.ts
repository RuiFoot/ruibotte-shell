/** 커서 위치의 JSON 경로($.a.b[2]) — 문자열·괄호만 따라가는 가벼운 훑기(깨진 JSON 에서도 대략) */
export function jsonPathAt(text: string, offset: number): string {
	const stack: { kind: "obj" | "arr"; key: string | number }[] = [];
	let i = 0;
	while (i < offset && i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			let s = "";
			while (j < text.length && text[j] !== '"') {
				if (text[j] === "\\") j++;
				s += text[j] ?? "";
				j++;
			}
			// 바로 뒤가 ':' 면 키
			let k = j + 1;
			while (k < text.length && /\s/.test(text[k] ?? "")) k++;
			const top = stack.at(-1);
			if (text[k] === ":" && top?.kind === "obj") top.key = s;
			i = j + 1;
			continue;
		}
		if (ch === "{") stack.push({ kind: "obj", key: "" });
		else if (ch === "[") stack.push({ kind: "arr", key: 0 });
		else if (ch === "}" || ch === "]") stack.pop();
		else if (ch === ",") {
			const top = stack.at(-1);
			if (top?.kind === "arr") top.key = (top.key as number) + 1;
		}
		i++;
	}
	return `$${stack
		.map((s) => (s.kind === "arr" ? `[${s.key}]` : s.key === "" ? "" : /^[A-Za-z_$][\w$]*$/.test(String(s.key)) ? `.${s.key}` : `["${s.key}"]`))
		.join("")}`;
}
