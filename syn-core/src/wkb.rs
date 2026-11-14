//! # WKB / EWKB → WKT
//!
//! Debezium 的 PostGIS 转换器给十六进制 WKB（部分版本带 SRID，走 EWKB），
//! 对 bytea 列则给 base64 —— 线上 `dtw_polygon` 就是后者，两种都要认。
//! 下游要 WKT 字符串，所以这里做一次转换。
//!
//! **为什么自己写而不用现成 crate**：
//! 1. 只需要 Point / LineString / Polygon 及其 Multi 版本，范围是封闭的；
//! 2. 数字格式直接影响「与 magic-api 逐字节比对」能不能过，必须自己控制；
//! 3. 遇到不认识的几何类型要**明确报错**，而不是尽力猜一个近似形状。
//!
//! 坐标用 `{}` 打印 f64，得到最短且可回读的表示（`116.391` 不会变成
//! `116.39100000000001`），这与 JTS/GEOS 的 WKT 输出习惯一致。

/// # WKB / EWKB → WKT
///
/// 两种编码都认：
/// - 十六进制（PostGIS 转换器、`ST_AsBinary` 直出的常见形态，可带 `\x` / `0x` 前缀）；
/// - base64（Debezium 对 bytea 列的默认编码，线上 `dtw_polygon` 实际给的就是这个）。
///
/// 十六进制优先：全长是合法 hex 且能解析成 WKB 才算命中，否则落到 base64 ——
/// 两边字符集有交集，不能只看字符形态猜。
pub fn to_wkt(raw: &str) -> Result<String, String> {
    let s = raw
        .strip_prefix("\\x")
        .or_else(|| raw.strip_prefix("0x"))
        .unwrap_or(raw)
        .trim();
    if s.is_empty() {
        return Err("WKB 为空".to_string());
    }
    if let Some(bytes) = decode_hex(s)
        && let Ok(wkt) = parse_wkb(&bytes)
    {
        return Ok(wkt);
    }
    if let Some(bytes) = decode_base64(s)
        && let Ok(wkt) = parse_wkb(&bytes)
    {
        return Ok(wkt);
    }
    Err("WKB 不是合法的十六进制或 base64".to_string())
}

/// 把已解码的字节流读成一个 WKT；读到半个几何或尾部有剩余都算失败
fn parse_wkb(bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("WKB 为空".to_string());
    }
    let mut reader = Reader {
        bytes,
        pos: 0,
    };
    let mut out = String::new();
    reader.geometry(&mut out, 0)?;
    if reader.pos != bytes.len() {
        // 多出来的字节说明读错了格式，宁可失败也不要发出半截几何
        return Err(format!("WKB 解析后剩余 {} 字节", bytes.len() - reader.pos));
    }
    Ok(out)
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, String> {
        let b = *self
            .bytes
            .get(self.pos)
            .ok_or_else(|| "WKB 提前结束".to_string())?;
        self.pos += 1;
        Ok(b)
    }

    fn u32(&mut self, le: bool) -> Result<u32, String> {
        let raw = self.take(4)?;
        let arr: [u8; 4] = raw.try_into().map_err(|_| "WKB 长度不足".to_string())?;
        Ok(if le {
            u32::from_le_bytes(arr)
        } else {
            u32::from_be_bytes(arr)
        })
    }

    fn f64(&mut self, le: bool) -> Result<f64, String> {
        let raw = self.take(8)?;
        let arr: [u8; 8] = raw.try_into().map_err(|_| "WKB 长度不足".to_string())?;
        Ok(if le {
            f64::from_le_bytes(arr)
        } else {
            f64::from_be_bytes(arr)
        })
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| "WKB 长度溢出".to_string())?;
        let slice = self
            .bytes
            .get(self.pos..end)
            .ok_or_else(|| "WKB 提前结束".to_string())?;
        self.pos = end;
        Ok(slice)
    }

    /// 读一个完整几何并写进 `out`
    fn geometry(&mut self, out: &mut String, depth: usize) -> Result<(), String> {
        if depth > 8 {
            return Err("WKB 几何嵌套过深".to_string());
        }
        let le = match self.u8()? {
            0 => false,
            1 => true,
            other => return Err(format!("WKB 字节序非法: {other}")),
        };

        let raw_type = self.u32(le)?;
        let has_z = raw_type & 0x8000_0000 != 0;
        let has_m = raw_type & 0x4000_0000 != 0;
        let has_srid = raw_type & 0x2000_0000 != 0;
        let ty = raw_type & 0x0FFF_FFFF;
        if has_srid {
            // SRID 读出来就丢：下游的 WKT 不带 SRID，带上去反而可能被拒
            let _ = self.u32(le)?;
        }
        let dims = 2 + usize::from(has_z) + usize::from(has_m);
        let suffix = if has_z {
            " Z"
        } else if has_m {
            " M"
        } else {
            ""
        };

        match ty {
            1 => {
                out.push_str("POINT");
                out.push_str(suffix);
                out.push(' ');
                out.push('(');
                self.coord(out, le, dims)?;
                out.push(')');
            }
            2 => {
                out.push_str("LINESTRING");
                out.push_str(suffix);
                out.push(' ');
                self.coord_seq(out, le, dims)?;
            }
            3 => {
                out.push_str("POLYGON");
                out.push_str(suffix);
                self.rings(out, le, dims)?;
            }
            4..=6 => {
                let name = match ty {
                    4 => "MULTIPOINT",
                    5 => "MULTILINESTRING",
                    _ => "MULTIPOLYGON",
                };
                out.push_str(name);
                out.push_str(suffix);
                out.push(' ');
                let n = self.u32(le)?;
                out.push('(');
                for i in 0..n {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    if ty == 4 {
                        // MULTIPOINT 里每个元素是完整 POINT，但 WKT 惯用不带 POINT 关键字的裸坐标
                        out.push('(');
                        self.coord(out, le, dims)?;
                        out.push(')');
                    } else {
                        self.geometry(out, depth + 1)?;
                    }
                }
                out.push(')');
            }
            7 => {
                out.push_str("GEOMETRYCOLLECTION");
                out.push_str(suffix);
                out.push(' ');
                let n = self.u32(le)?;
                out.push('(');
                for i in 0..n {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    self.geometry(out, depth + 1)?;
                }
                out.push(')');
            }
            other => return Err(format!("不支持的 WKB 几何类型 {other}")),
        }
        Ok(())
    }

    fn rings(&mut self, out: &mut String, le: bool, dims: usize) -> Result<(), String> {
        let n = self.u32(le)?;
        out.push_str(" (");
        for i in 0..n {
            if i > 0 {
                out.push_str(", ");
            }
            self.coord_seq(out, le, dims)?;
        }
        out.push(')');
        Ok(())
    }

    fn coord_seq(&mut self, out: &mut String, le: bool, dims: usize) -> Result<(), String> {
        let n = self.u32(le)?;
        out.push('(');
        for i in 0..n {
            if i > 0 {
                out.push_str(", ");
            }
            self.coord(out, le, dims)?;
        }
        out.push(')');
        Ok(())
    }

    fn coord(&mut self, out: &mut String, le: bool, dims: usize) -> Result<(), String> {
        for d in 0..dims {
            if d > 0 {
                out.push(' ');
            }
            let v = self.f64(le)?;
            if !v.is_finite() {
                return Err("WKB 坐标不是有限数".to_string());
            }
            out.push_str(&format!("{v}"));
        }
        Ok(())
    }
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in bytes.chunks(2) {
        out.push((hex_val(pair[0])? << 4) | hex_val(pair[1])?);
    }
    Some(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// 标准 / URL 安全字母表都认；`=` padding 有无皆可，过滤后按剩余长度收敛
fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let data: Vec<u8> = s
        .bytes()
        .filter(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'-' | b'_'))
        .collect();
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() / 4 * 3);
    for chunk in data.chunks(4) {
        let mut acc: u32 = 0;
        for &c in chunk {
            acc = (acc << 6) | b64_val(c)?;
        }
        // 尾块不足 4 字符时补零对齐到 24 位，再按整块取字节
        acc <<= 6 * (4 - chunk.len()) as u32;
        match chunk.len() {
            4 => {
                out.push((acc >> 16) as u8);
                out.push((acc >> 8) as u8);
                out.push(acc as u8);
            }
            3 => {
                out.push((acc >> 16) as u8);
                out.push((acc >> 8) as u8);
            }
            2 => {
                out.push((acc >> 16) as u8);
            }
            _ => return None,
        }
    }
    Some(out)
}

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02X}")).collect()
    }

    fn point(x: f64, y: f64) -> Vec<u8> {
        let mut v = vec![1u8];
        v.extend_from_slice(&1u32.to_le_bytes());
        v.extend_from_slice(&x.to_le_bytes());
        v.extend_from_slice(&y.to_le_bytes());
        v
    }

    #[test]
    fn point_round_trip() {
        let wkt = to_wkt(&hex(&point(116.391, 39.907))).unwrap();
        assert_eq!(wkt, "POINT (116.391 39.907)");
    }

    #[test]
    fn polygon_from_debezium() {
        // 北京某处，5 个点闭合
        let h = "010300000001000000050000001B2FDD2406195D406ABC749318F44340C520B07268195D406ABC749318F44340C520B07268195D40DBF97E6ABCF443401B2FDD2406195D40DBF97E6ABCF443401B2FDD2406195D406ABC749318F44340";
        let wkt = to_wkt(h).unwrap();
        assert!(wkt.starts_with("POLYGON (("), "{wkt}");
        assert!(wkt.contains("116.391 39.907"), "{wkt}");
        assert!(wkt.ends_with("))"));
    }

    #[test]
    fn ewkb_with_srid() {
        let mut v = vec![1u8];
        v.extend_from_slice(&(3u32 | 0x2000_0000).to_le_bytes());
        v.extend_from_slice(&4326i32.to_le_bytes());
        v.extend_from_slice(&1u32.to_le_bytes()); // 1 ring
        v.extend_from_slice(&5u32.to_le_bytes()); // 5 points
        for (x, y) in [
            (0.0f64, 0.0f64),
            (1.0, 0.0),
            (1.0, 1.0),
            (0.0, 1.0),
            (0.0, 0.0),
        ] {
            v.extend_from_slice(&x.to_le_bytes());
            v.extend_from_slice(&y.to_le_bytes());
        }
        let wkt = to_wkt(&hex(&v)).unwrap();
        assert_eq!(wkt, "POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
    }

    #[test]
    fn big_endian_point() {
        let mut v = vec![0u8];
        v.extend_from_slice(&1u32.to_be_bytes());
        v.extend_from_slice(&(-1.5f64).to_be_bytes());
        v.extend_from_slice(&2.25f64.to_be_bytes());
        assert_eq!(to_wkt(&hex(&v)).unwrap(), "POINT (-1.5 2.25)");
    }

    #[test]
    fn z_dimension() {
        let mut v = vec![1u8];
        v.extend_from_slice(&(1u32 | 0x8000_0000).to_le_bytes());
        for c in [1.0f64, 2.0, 3.0] {
            v.extend_from_slice(&c.to_le_bytes());
        }
        assert_eq!(to_wkt(&hex(&v)).unwrap(), "POINT Z (1 2 3)");
    }

    #[test]
    fn linestring() {
        let mut v = vec![1u8];
        v.extend_from_slice(&2u32.to_le_bytes());
        v.extend_from_slice(&3u32.to_le_bytes());
        for (x, y) in [(0.0f64, 0.0f64), (1.0, 1.0), (2.0, 0.0)] {
            v.extend_from_slice(&x.to_le_bytes());
            v.extend_from_slice(&y.to_le_bytes());
        }
        assert_eq!(to_wkt(&hex(&v)).unwrap(), "LINESTRING (0 0, 1 1, 2 0)");
    }

    #[test]
    fn rejects_broken_input() {
        assert!(to_wkt("").is_err());
        assert!(to_wkt("ZZ").is_err());
        assert!(to_wkt("0103").is_err());
        // 未知类型
        let mut v = vec![1u8];
        v.extend_from_slice(&99u32.to_le_bytes());
        assert!(to_wkt(&hex(&v)).is_err());
        // 尾部多余字节
        let mut p = point(1.0, 2.0);
        p.push(0);
        assert!(to_wkt(&hex(&p)).is_err());
    }

    #[test]
    fn accepts_hex_prefixes() {
        let h = hex(&point(1.0, 2.0));
        assert!(to_wkt(&format!("\\x{h}")).is_ok());
        assert!(to_wkt(&format!("0x{h}")).is_ok());
        assert!(to_wkt(&h.to_lowercase()).is_ok());
    }

    #[test]
    fn accepts_base64_from_debezium() {
        // 线上 dtw_polygon 死信里的真实记录：POLYGON Z，1 环 9 点闭合（Debezium base64 编码）
        let b64 = "AQMAAIABAAAACQAAAAAAAKCgMj5AAAAAwACXU8AAAAAAAAA0QAAAAKCgMj5AAAAAwACXU8AAAAAAAAA0QAAAAGBag1pAAAAAAA0NP8AAAAAAAAA0QAAAAGBag1pAAAAAAA0NP8AAAAAAAAA0QAAAAODGrV9AAAAAQCfOT8AAAAAAAAA0QAAAAODGrV9AAAAAQCfOT8AAAAAAAAA0QAAAAMBi5klAAAAAQIgZXMAAAAAAAAA0QAAAAMBi5klAAAAAQIgZXMAAAAAAAAA0QAAAAKCgMj5AAAAAwACXU8AAAAAAAAA0QA==";
        let wkt = to_wkt(b64).unwrap();
        assert!(wkt.starts_with("POLYGON Z (("), "{wkt}");
        assert!(wkt.ends_with("))"), "{wkt}");
        // 首尾点相同（闭合）
        let inner = &wkt[wkt.find('(').unwrap() + 2..wkt.rfind(')').unwrap() - 1];
        let first = inner.split(',').next().unwrap().trim();
        let last = inner.rsplit(',').next().unwrap().trim();
        assert_eq!(first, last, "{wkt}");
    }

    #[test]
    fn hex_wins_when_both_charset_fit() {
        // 纯 hex 字符串即使也是合法 base64，仍按 hex 解析（并解析成 WKB 才算命中）
        let h = hex(&point(1.0, 2.0));
        assert!(to_wkt(&h).is_ok());
    }

    #[test]
    fn base64_urlsafe_and_unpadded_accepted() {
        let mut v = vec![1u8];
        v.extend_from_slice(&1u32.to_le_bytes());
        v.extend_from_slice(&1.5f64.to_le_bytes());
        v.extend_from_slice(&2.25f64.to_be_bytes());
        let std = base64_encode_std(&v);
        let urlsafe = std.replace('+', "-").replace('/', "_");
        assert_eq!(to_wkt(&std).unwrap(), to_wkt(&urlsafe).unwrap());
        assert!(to_wkt(std.trim_end_matches('=')).is_ok());
    }

    /// 只为本测试用的最小编码器（不引入依赖）
    fn base64_encode_std(bytes: &[u8]) -> String {
        const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(TBL[(n >> 18) as usize & 63] as char);
            out.push(TBL[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 { TBL[(n >> 6) as usize & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { TBL[n as usize & 63] as char } else { '=' });
        }
        out
    }
}
