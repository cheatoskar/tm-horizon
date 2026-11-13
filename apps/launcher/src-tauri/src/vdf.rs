//! Minimal Valve KeyValues parser, enough for libraryfolders.vdf and appmanifest_*.acf.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Obj(BTreeMap<String, Vdf>),
}

impl Vdf {
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Obj(m) => m.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn entries(&self) -> Vec<(&String, &Vdf)> {
        match self {
            Vdf::Obj(m) => m.iter().collect(),
            _ => vec![],
        }
    }
}

fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' | '}' => out.push(c.to_string()),
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => {
                            if let Some(n) = chars.next() {
                                s.push(match n {
                                    'n' => '\n',
                                    't' => '\t',
                                    other => other,
                                });
                            }
                        }
                        '"' => break,
                        other => s.push(other),
                    }
                }
                // Mark quoted strings so a quoted "{" is not a brace.
                out.push(format!("\u{0}{s}"));
            }
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

pub fn parse(text: &str) -> Vdf {
    let toks = tokens(text);
    let mut i = 0;
    fn obj(toks: &[String], i: &mut usize) -> Vdf {
        let mut m = BTreeMap::new();
        while *i < toks.len() {
            let k = &toks[*i];
            *i += 1;
            if k == "}" {
                break;
            }
            let key = k.trim_start_matches('\u{0}').to_string();
            if *i >= toks.len() {
                break;
            }
            let v = &toks[*i];
            *i += 1;
            let val = if v == "{" { obj(toks, i) } else { Vdf::Str(v.trim_start_matches('\u{0}').to_string()) };
            m.insert(key, val);
        }
        Vdf::Obj(m)
    }
    obj(&toks, &mut i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_folders() {
        let t = r#""libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps" { "228980" "1" }
	}
	"1"
	{
		"path"		"E:\\SteamLibrary"
	}
}"#;
        let v = parse(t);
        let lf = v.get("libraryfolders").unwrap();
        let paths: Vec<&str> = lf.entries().iter().filter_map(|(_, e)| e.get("path")?.str()).collect();
        assert_eq!(paths, vec![r"C:\Program Files (x86)\Steam", r"E:\SteamLibrary"]);
    }

    #[test]
    fn app_manifest() {
        let t = "\"AppState\"\n{\n\"appid\"\t\"11020\"\n\"name\"\t\"TrackMania Nations Forever\"\n\"installdir\"\t\"TrackMania Nations Forever\"\n}";
        let v = parse(t);
        let a = v.get("AppState").unwrap();
        assert_eq!(a.get("appid").unwrap().str(), Some("11020"));
        assert_eq!(a.get("installdir").unwrap().str(), Some("TrackMania Nations Forever"));
    }
}
