//! LZO1X decompressor (decompress only), for the TrackMania server query (serverquery.rs).
//!
//! Written from the format description in the community protocol notes (docs/design/server-query.md)
//! and cross-checked with the byte examples there; the algorithm follows the well-known structure
//! of LZO1X (literal runs, M1..M4 matches, end marker = M4 with distance 0). Every read and every
//! back-reference is bounds-checked, so a hostile server cannot crash or over-allocate.

/// Upper bound for the output, so a forged size field cannot allocate gigabytes.
pub const MAX_OUT: usize = 4 << 20;

fn bad(what: &str) -> String {
    format!("lzo: {what}")
}

/// Decompresses `src` into exactly `size` bytes.
pub fn decompress(src: &[u8], size: usize) -> Result<Vec<u8>, String> {
    if size > MAX_OUT {
        return Err(bad("size too large"));
    }
    let mut out: Vec<u8> = Vec::with_capacity(size);
    let mut ip = 0usize;
    let mut state = 0u8;

    macro_rules! byte {
        () => {{
            let b = *src.get(ip).ok_or_else(|| bad("input truncated"))?;
            ip += 1;
            b
        }};
    }
    // Extended length: every zero byte adds 255, the final byte adds itself.
    macro_rules! run {
        ($base:expr) => {{
            let mut n = 0usize;
            loop {
                let b = *src.get(ip).ok_or_else(|| bad("input truncated"))?;
                if b != 0 {
                    break;
                }
                n += 255;
                ip += 1;
                if n > MAX_OUT {
                    return Err(bad("run too long"));
                }
            }
            n + $base + byte!() as usize
        }};
    }
    macro_rules! literals {
        ($n:expr) => {{
            let n: usize = $n;
            let end = ip.checked_add(n).filter(|e| *e <= src.len()).ok_or_else(|| bad("literals truncated"))?;
            if out.len() + n > size {
                return Err(bad("output overrun"));
            }
            out.extend_from_slice(&src[ip..end]);
            ip = end;
        }};
    }
    macro_rules! copy_match {
        ($dist:expr, $len:expr) => {{
            let dist: usize = $dist;
            let len: usize = $len;
            if dist == 0 || dist > out.len() {
                return Err(bad("bad distance"));
            }
            if out.len() + len > size {
                return Err(bad("output overrun"));
            }
            let start = out.len() - dist;
            for i in 0..len {
                let b = out[start + i];
                out.push(b);
            }
        }};
    }

    if src.is_empty() {
        return Err(bad("empty input"));
    }
    if src[0] > 17 {
        let n = (src[0] - 17) as usize;
        ip = 1;
        literals!(n);
        state = if n < 4 { n as u8 } else { 4 };
    }
    loop {
        let t = byte!() as usize;
        if t < 16 {
            if state == 0 {
                let n = if t == 0 { run!(15) } else { t } + 3;
                literals!(n);
                state = 4;
                continue;
            }
            let d = (t >> 2) + ((byte!() as usize) << 2);
            if state == 4 {
                copy_match!(0x801 + d, 3);
            } else {
                copy_match!(1 + d, 2);
            }
        } else if t >= 64 {
            let d = ((t >> 2) & 7) + ((byte!() as usize) << 3);
            copy_match!(1 + d, (t >> 5) + 1);
        } else if t >= 32 {
            let n = if t & 31 != 0 { t & 31 } else { run!(31) } + 2;
            let lo = byte!() as usize;
            let hi = byte!() as usize;
            copy_match!(1 + ((lo | hi << 8) >> 2), n);
        } else {
            let n = if t & 7 != 0 { t & 7 } else { run!(7) } + 2;
            let lo = byte!() as usize;
            let hi = byte!() as usize;
            let d = ((t & 8) << 11) + ((lo | hi << 8) >> 2);
            if d == 0 {
                break;
            }
            copy_match!(d + 0x4000, n);
        }
        state = src[ip - 2] & 3;
        if state != 0 {
            literals!(state as usize);
        }
    }
    if out.len() != size {
        return Err(bad("size mismatch"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_literals_then_end() {
        // first byte 17+5 = 5 literals, then the end marker 0x11 0x00 0x00
        let src = [22, b'h', b'e', b'l', b'l', b'o', 0x11, 0, 0];
        assert_eq!(decompress(&src, 5).unwrap(), b"hello");
    }

    #[test]
    fn overlapping_match() {
        // 1 literal 'a', then M2 match length 5 distance 1 (t = (4<<5)|0 = 0x80? len=(t>>5)+1)
        // t = 0x80 -> len 5, d = ((t>>2)&7) + next<<3 = 0 -> dist 1. state byte: low 2 bits of the dist byte = 0.
        let src = [18, b'a', 0x80, 0x00, 0x11, 0, 0];
        assert_eq!(decompress(&src, 6).unwrap(), b"aaaaaa");
    }

    #[test]
    fn rejects_garbage() {
        assert!(decompress(&[], 1).is_err());
        assert!(decompress(&[22, b'h'], 5).is_err());
        assert!(decompress(&[0x80, 0, 0x11, 0, 0], 3).is_err()); // match before any output
        assert!(decompress(&[22, 1, 2, 3, 4, 5, 0x11, 0, 0], 9).is_err()); // size mismatch
        assert!(decompress(&[0, 0], MAX_OUT + 1).is_err());
    }
}
