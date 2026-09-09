use otterdive_core::fs::{
    decode_bytes, decode_bytes_with_encoding, decode_owned_bytes, decode_owned_bytes_with_encoding,
    encode_text,
};
use otterdive_core::{EncodingKind, LoadedDocument};

#[test]
fn owned_decoding_matches_existing_encoding_and_invalid_byte_behavior() {
    let encodings = [
        EncodingKind::Utf8,
        EncodingKind::Utf8Bom,
        EncodingKind::Utf16Le,
        EncodingKind::Utf16Be,
        EncodingKind::Gbk,
    ];
    let mut samples: Vec<Vec<u8>> = encodings
        .iter()
        .map(|encoding| encode_text("中文 hello\r\n尾行", *encoding))
        .collect();
    samples.extend([
        vec![],
        vec![0xff, 0, 0x80],
        vec![0xef, 0xbb, 0xbf, 0xff],
        vec![0xff, 0xfe, 0x61],
    ]);
    for bytes in samples {
        let expected = decode_bytes(&bytes);
        let actual = decode_owned_bytes(bytes.clone());
        assert_eq!(actual.text, expected.text);
        assert_eq!(actual.encoding, expected.encoding);
        for encoding in encodings {
            let expected = decode_bytes_with_encoding(&bytes, encoding);
            let actual = decode_owned_bytes_with_encoding(bytes.clone(), encoding);
            assert_eq!(actual.text, expected.text);
            assert_eq!(actual.encoding, expected.encoding);
        }
    }
}

#[test]
fn utf8_decoding_reuses_the_input_allocation() {
    let bytes = "中文 hello\n".repeat(100_000).into_bytes();
    let pointer = bytes.as_ptr();
    let length = bytes.len();
    let decoded = decode_owned_bytes(bytes);
    assert_eq!(decoded.text.as_ptr(), pointer);
    assert_eq!(decoded.text.len(), length);
}

#[test]
fn large_document_preserves_long_lines_and_tail_without_final_newline() {
    let path = std::env::temp_dir().join(format!("otterdive-full-text-{}", std::process::id()));
    let text = format!(
        "{}{}尾部命中",
        "中文 data\r\n".repeat(2_000_000),
        "x".repeat(70_000)
    );
    std::fs::write(&path, &text).unwrap();
    let document = LoadedDocument::open(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(document.text, text);
    assert_eq!(document.meta.file_size, text.len());
    assert!(document.meta.read_only);
}
