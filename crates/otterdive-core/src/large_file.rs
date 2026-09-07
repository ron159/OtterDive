//! Bounded read-only pages. Sparse offsets are built on demand, never a full text copy.
use crate::{
    EncodingKind, LineEnding,
    fs::{decode_bytes, decode_bytes_with_encoding},
};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};

const PAGE_LINES: usize = 2000;
const PAGE_BYTES: usize = 256 * 1024;
const LINE_BYTES: usize = 64 * 1024;
const INDEX_STRIDE: usize = 1024;

#[derive(Debug)]
pub struct LargePage {
    pub text: String,
    pub start_line: usize,
    pub next_line: usize,
    pub eof: bool,
    pub truncated: bool,
}

pub struct LargeFile {
    path: PathBuf,
    pub encoding: EncodingKind,
    pub size: u64,
    pub line_ending: LineEnding,
    modified: Option<SystemTime>,
    checkpoints: Vec<(usize, u64)>,
}

impl LargeFile {
    pub fn open(path: &Path, encoding: Option<EncodingKind>) -> io::Result<Self> {
        let metadata = fs::metadata(path)?;
        if !metadata.is_file() {
            return Err(io::Error::other("路径不是文件"));
        }
        let mut sample = Vec::new();
        File::open(path)?.take(64 * 1024).read_to_end(&mut sample)?;
        // A UTF-8 code point split at the probe boundary must not imply GBK.
        if let Err(error) = std::str::from_utf8(&sample) {
            if error.error_len().is_none() {
                sample.truncate(error.valid_up_to());
            }
        }
        let detected = decode_bytes(&sample).encoding;
        let encoding = encoding.unwrap_or(detected);
        let line_ending = LineEnding::detect(&decode_bytes_with_encoding(&sample, encoding).text);
        let bom = match encoding {
            EncodingKind::Utf8 | EncodingKind::Utf8Bom
                if sample.starts_with(&[0xef, 0xbb, 0xbf]) =>
            {
                3
            }
            EncodingKind::Utf16Le if sample.starts_with(&[0xff, 0xfe]) => 2,
            EncodingKind::Utf16Be if sample.starts_with(&[0xfe, 0xff]) => 2,
            _ => 0,
        };
        Ok(Self {
            path: path.to_path_buf(),
            encoding,
            line_ending,
            size: metadata.len(),
            modified: metadata.modified().ok(),
            checkpoints: vec![(1, bom)],
        })
    }

    pub fn read_page(&mut self, requested_line: usize) -> io::Result<LargePage> {
        let metadata = fs::metadata(&self.path)?;
        if metadata.len() != self.size || metadata.modified().ok() != self.modified {
            return Err(io::Error::other("文件已发生变化，请重新载入后继续浏览"));
        }
        let requested_line = requested_line.max(1);
        let &(mut line, offset) = self
            .checkpoints
            .iter()
            .rev()
            .find(|(line, _)| *line <= requested_line)
            .unwrap();
        let mut reader = BufReader::with_capacity(64 * 1024, File::open(&self.path)?);
        reader.seek(SeekFrom::Start(offset))?;
        let mut page = LargePage {
            text: String::new(),
            start_line: requested_line,
            next_line: requested_line,
            eof: false,
            truncated: false,
        };
        while let Some((bytes, newline, truncated)) = read_line(
            &mut reader,
            self.encoding,
            if line >= requested_line {
                LINE_BYTES
            } else {
                0
            },
        )? {
            if line >= requested_line {
                let text = decode_bytes_with_encoding(&bytes, self.encoding).text;
                page.text.push_str(&text);
                if truncated {
                    page.text.push_str(" … [本行预览已截断]");
                    page.truncated = true;
                }
                if newline {
                    page.text.push('\n');
                }
                page.next_line = line + 1;
            }
            line += 1;
            let offset = reader.stream_position()?;
            if (line - 1) % INDEX_STRIDE == 0 && line > self.checkpoints.last().unwrap().0 {
                self.checkpoints.push((line, offset));
            }
            if page.next_line - page.start_line >= PAGE_LINES || page.text.len() >= PAGE_BYTES {
                page.eof = reader.fill_buf()?.is_empty();
                return Ok(page);
            }
        }
        page.eof = true;
        if page.text.is_empty() && line < requested_line {
            page.start_line = line;
            page.next_line = line;
        }
        Ok(page)
    }
}

/// Consume a whole physical line while retaining only a bounded prefix.
fn read_line(
    reader: &mut BufReader<File>,
    encoding: EncodingKind,
    limit: usize,
) -> io::Result<Option<(Vec<u8>, bool, bool)>> {
    let width = if matches!(encoding, EncodingKind::Utf16Le | EncodingKind::Utf16Be) {
        2
    } else {
        1
    };
    let unit = |bytes: &[u8]| -> u16 {
        if width == 1 {
            bytes[0] as u16
        } else if encoding == EncodingKind::Utf16Le {
            u16::from_le_bytes([bytes[0], bytes[1]])
        } else {
            u16::from_be_bytes([bytes[0], bytes[1]])
        }
    };
    let mut out = Vec::new();
    let mut consumed = false;
    let mut truncated = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(consumed.then_some((out, false, truncated)));
        }
        consumed = true;
        let boundary = buffer
            .chunks_exact(width)
            .position(|bytes| matches!(unit(bytes), 10 | 13))
            .map(|i| i * width);
        let count = boundary.unwrap_or(buffer.len());
        let keep = count.min(limit.saturating_sub(out.len()));
        out.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
        let newline = boundary.map(|i| unit(&buffer[i..]));
        reader.consume(count + if newline.is_some() { width } else { 0 });
        if let Some(newline) = newline {
            if newline == 13 {
                let next = reader.fill_buf()?;
                if next.len() >= width && unit(next) == 10 {
                    reader.consume(width);
                }
            }
            // Avoid introducing a replacement character solely due to our preview bound.
            if matches!(encoding, EncodingKind::Utf8 | EncodingKind::Utf8Bom) && truncated {
                if let Err(error) = std::str::from_utf8(&out) {
                    if error.error_len().is_none() {
                        out.truncate(error.valid_up_to());
                    }
                }
            }
            return Ok(Some((out, true, truncated)));
        }
    }
}
