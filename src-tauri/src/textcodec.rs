//! 파일 글자 인코딩 — 읽을 때 판별하고, 저장할 때는 원래 인코딩·줄 끝·BOM 을 그대로 지킨다.
//! 판별 순서: BOM → UTF-8 으로 온전히 읽히는지 → chardetng(한국어면 EUC-KR=windows-949).

use encoding_rs::{Encoding, EUC_KR, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextMeta {
    /// "UTF-8" | "EUC-KR" | "UTF-16LE" | "UTF-16BE" | 그 밖 encoding_rs 이름
    pub encoding: String,
    pub bom: bool,
    /// "LF" | "CRLF" | "CR"
    pub eol: String,
    /// 판별이 불확실하면 true — 화면은 읽기 전용으로 열고 다른 인코딩으로 다시 열기를 권한다
    pub guessed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoded {
    pub text: Option<String>,
    pub meta: TextMeta,
    pub binary: bool,
}

fn detect_eol(s: &str) -> &'static str {
    if s.contains("\r\n") {
        "CRLF"
    } else if s.contains('\r') {
        "CR"
    } else {
        "LF"
    }
}

/// 바이너리 판정: 앞 8 KiB 에 NUL 이 있으면(UTF-16 BOM 이 없을 때)
fn looks_binary(b: &[u8]) -> bool {
    b.iter().take(8192).any(|&c| c == 0)
}

pub fn decode(bytes: &[u8], force: Option<&str>) -> Decoded {
    let (enc, bom_len, guessed): (&'static Encoding, usize, bool) = if let Some(name) = force {
        let e = Encoding::for_label(name.as_bytes()).unwrap_or(UTF_8);
        let bom = Encoding::for_bom(bytes).filter(|(be, _)| *be == e).map(|(_, n)| n).unwrap_or(0);
        (e, bom, false)
    } else if let Some((e, n)) = Encoding::for_bom(bytes) {
        (e, n, false)
    } else if looks_binary(bytes) {
        return Decoded {
            text: None,
            meta: TextMeta { encoding: "binary".into(), bom: false, eol: "LF".into(), guessed: false },
            binary: true,
        };
    } else if std::str::from_utf8(bytes).is_ok() {
        (UTF_8, 0, false)
    } else {
        let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
        det.feed(bytes, true);
        let e = det.guess(Some(b"kr"), chardetng::Utf8Detection::Allow);
        // 추측이라 화면은 읽기 전용으로 열고 다른 인코딩으로 다시 열기를 권한다(EUC-KR 이 아니면)
        (e, 0, e != EUC_KR)
    };
    let (text, had_errors) = enc.decode_without_bom_handling(&bytes[bom_len..]);
    let text = text.into_owned();
    let eol = detect_eol(&text).to_string();
    Decoded {
        meta: TextMeta {
            encoding: if enc == EUC_KR { "EUC-KR".into() } else { enc.name().into() },
            bom: bom_len > 0,
            eol,
            guessed: guessed || had_errors,
        },
        text: Some(text),
        binary: false,
    }
}

/// 화면 글(줄 끝은 LF 로 다룸)을 원래 인코딩·줄 끝·BOM 으로 되돌린다.
/// 원래 인코딩에 없는 글자가 있으면 저장하지 않는다(글자가 깨진 채 저장되는 것을 막음).
pub fn encode(text: &str, meta: &TextMeta) -> Result<Vec<u8>, String> {
    let normalized = text.replace("\r\n", "\n");
    let body = match meta.eol.as_str() {
        "CRLF" => normalized.replace('\n', "\r\n"),
        "CR" => normalized.replace('\n', "\r"),
        _ => normalized,
    };
    let enc = Encoding::for_label(meta.encoding.as_bytes()).unwrap_or(UTF_8);
    let mut out = Vec::with_capacity(body.len() + 3);
    if enc == UTF_16LE || enc == UTF_16BE {
        // encoding_rs 는 UTF-16 으로 인코딩하지 않는다 — 직접
        if meta.bom {
            out.extend_from_slice(if enc == UTF_16LE { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for u in body.encode_utf16() {
            out.extend_from_slice(&if enc == UTF_16LE { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        return Ok(out);
    }
    if meta.bom && enc == UTF_8 {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    let (bytes, _, unmappable) = enc.encode(&body);
    if unmappable {
        return Err(format!("{} 로 저장할 수 없는 글자가 있습니다. 다른 인코딩으로 저장하세요.", meta.encoding));
    }
    out.extend_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn euc_kr_crlf_round_trip() {
        let (src, _, _) = EUC_KR.encode("안녕하세요\r\n두 번째 줄\r\n");
        let d = decode(&src, None);
        assert_eq!(d.meta.encoding, "EUC-KR");
        assert_eq!(d.meta.eol, "CRLF");
        let text = d.text.unwrap().replace("\r\n", "\n") + "추가\n";
        let back = encode(&text, &d.meta).unwrap();
        let (again, _, _) = EUC_KR.decode(&back);
        assert_eq!(again, "안녕하세요\r\n두 번째 줄\r\n추가\r\n");
    }

    #[test]
    fn utf8_bom_kept() {
        let src = b"\xEF\xBB\xBFhello\n";
        let d = decode(src, None);
        assert!(d.meta.bom);
        assert_eq!(encode("hello\n", &d.meta).unwrap(), src);
    }

    #[test]
    fn unmappable_rejected() {
        let meta = TextMeta { encoding: "EUC-KR".into(), bom: false, eol: "LF".into(), guessed: false };
        assert!(encode("😀", &meta).is_err());
    }
}
