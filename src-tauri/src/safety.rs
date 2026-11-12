//! 文件导出安全边界。
//!
//! Tauri 的 fs scope 只约束 JS 侧 @tauri-apps/plugin-fs 的调用，
//! 对 Rust 侧直接调用的 std::fs 不生效。`save_bytes` 由前端 invoke 触发，
//! 路径来自保存对话框 / 前端拼接，必须在 Rust 侧独立校验，防止：
//!   - 路径穿越、写入系统目录或覆盖程序自身
//!   - 覆盖 .exe / .dll 等危险扩展名
//!   - 超大 base64 解码导致内存耗尽

use std::path::{Component, Path, PathBuf};

/// 单个导出文件（PNG / ZIP）允许的最大字节数：200 MB。
pub const MAX_EXPORT_BYTES: u64 = 200 * 1024 * 1024;
/// base64 文本最大长度（按 4/3 膨胀 + 余量），解码前拦截，避免 OOM。
pub const MAX_B64_LEN: usize = ((MAX_EXPORT_BYTES as usize) / 3 + 1) * 4;
/// 允许写出的扩展名白名单。
const ALLOWED_EXT: [&str; 2] = ["png", "zip"];
/// 禁止覆盖的危险扩展名。
const DANGEROUS_EXT: [&str; 12] = [
    "exe", "dll", "sys", "msi", "bat", "cmd", "ps1", "vbs", "js", "lnk", "reg", "scr",
];
/// Windows 保留设备名（大小写不敏感，去掉扩展名后匹配）。
const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SafetyError {
    EmptyPath,
    NotAbsolute(String),
    UnsafeName(String),
    DisallowedExtension(String),
    DangerousTarget(String),
    SystemDirectory(String),
    AppDirectory(String),
    TooLarge(u64),
    EncodingTooLarge(usize),
}

impl std::fmt::Display for SafetyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SafetyError::EmptyPath => write!(f, "保存路径为空"),
            SafetyError::NotAbsolute(p) => write!(f, "保存路径不是绝对路径：{p}"),
            SafetyError::UnsafeName(p) => write!(f, "文件名不合法：{p}"),
            SafetyError::DisallowedExtension(e) => {
                write!(f, "不支持的导出类型 .{e}，仅允许 PNG / ZIP")
            }
            SafetyError::DangerousTarget(p) => write!(f, "拒绝覆盖可执行文件：{p}"),
            SafetyError::SystemDirectory(p) => write!(f, "拒绝写入系统目录：{p}"),
            SafetyError::AppDirectory(p) => write!(f, "拒绝写入程序所在目录：{p}"),
            SafetyError::TooLarge(n) => {
                write!(f, "文件过大（{} MB），单次导出上限 200 MB", n / 1024 / 1024)
            }
            SafetyError::EncodingTooLarge(n) => {
                write!(f, "数据过大（{n} 字符），超出单次导出上限")
            }
        }
    }
}

/// 解码前检查 base64 文本长度。
pub fn check_encoding_len(b64: &str) -> Result<(), SafetyError> {
    if b64.len() > MAX_B64_LEN {
        return Err(SafetyError::EncodingTooLarge(b64.len()));
    }
    Ok(())
}

/// 解码后检查字节数。
pub fn check_payload_size(len: u64) -> Result<(), SafetyError> {
    if len > MAX_EXPORT_BYTES {
        return Err(SafetyError::TooLarge(len));
    }
    Ok(())
}

/// 规范化并校验导出目标路径，返回规范化后的绝对路径。
pub fn validate_export_path(path: &Path) -> Result<PathBuf, SafetyError> {
    if path.as_os_str().is_empty() {
        return Err(SafetyError::EmptyPath);
    }
    if !path.is_absolute() {
        return Err(SafetyError::NotAbsolute(path.display().to_string()));
    }

    // 禁止任何父目录跳转（保存对话框返回的通常是规范路径）
    for c in path.components() {
        if matches!(c, Component::ParentDir) {
            return Err(SafetyError::UnsafeName(path.display().to_string()));
        }
    }

    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| SafetyError::UnsafeName(path.display().to_string()))?;
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(SafetyError::UnsafeName(name.to_string()));
    }
    // 隐藏文件 / 点开头（防写到 .ssh、.env 等配置）
    if name.starts_with('.') {
        return Err(SafetyError::UnsafeName(name.to_string()));
    }
    // Windows 保留设备名
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    if RESERVED_NAMES.contains(&stem.to_ascii_lowercase().as_str()) {
        return Err(SafetyError::UnsafeName(name.to_string()));
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if DANGEROUS_EXT.contains(&ext.as_str()) {
        return Err(SafetyError::DangerousTarget(name.to_string()));
    }
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        let shown = if ext.is_empty() { "（无）" } else { &ext };
        return Err(SafetyError::DisallowedExtension(shown.to_string()));
    }

    let normalized = normalize(path);

    // 系统敏感目录黑名单
    for root in sensitive_roots() {
        if normalized.starts_with(&root) {
            return Err(SafetyError::SystemDirectory(normalized.display().to_string()));
        }
    }
    // 不允许写入程序自身所在目录，避免覆盖 exe / 依赖
    if let Ok(exe) = std::env::current_exe() {
        if let Some(app_dir) = exe.parent() {
            if normalized.starts_with(app_dir) {
                return Err(SafetyError::AppDirectory(normalized.display().to_string()));
            }
        }
    }

    Ok(normalized)
}

/// 词法规范化路径（解析 . 与 ..，不访问文件系统）。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

/// 系统敏感目录黑名单（仅列确实危险的）。
fn sensitive_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(win) = std::env::var("SystemRoot") {
        if !win.is_empty() {
            roots.push(PathBuf::from(win));
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        if !pf.is_empty() {
            roots.push(PathBuf::from(pf));
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
        if !pf.is_empty() {
            roots.push(PathBuf::from(pf));
        }
    }
    #[cfg(not(windows))]
    for d in ["/etc", "/usr", "/bin", "/sbin", "/System", "/Library"] {
        let p = PathBuf::from(d);
        if p.is_dir() {
            roots.push(p);
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("seal_test_{nanos}_{name}"))
    }

    #[test]
    fn accepts_png_and_zip_in_temp() {
        assert!(validate_export_path(&tmp_path("章.png")).is_ok());
        assert!(validate_export_path(&tmp_path("合同印章.zip")).is_ok());
    }

    #[test]
    fn rejects_relative_path() {
        assert!(matches!(
            validate_export_path(Path::new("a/b.png")),
            Err(SafetyError::NotAbsolute(_))
        ));
    }

    #[test]
    fn rejects_parent_traversal() {
        let p = std::env::temp_dir().join("a").join("..").join("b.png");
        assert!(matches!(
            validate_export_path(&p),
            Err(SafetyError::UnsafeName(_))
        ));
    }

    #[test]
    fn rejects_executable_and_unknown_ext() {
        assert!(matches!(
            validate_export_path(&tmp_path("x.exe")),
            Err(SafetyError::DangerousTarget(_))
        ));
        assert!(matches!(
            validate_export_path(&tmp_path("x.txt")),
            Err(SafetyError::DisallowedExtension(_))
        ));
    }

    #[test]
    fn rejects_hidden_and_reserved_names() {
        // 直接以点开头的文件名，而非拼在临时目录中间
        let tmp = std::env::temp_dir();
        assert!(matches!(
            validate_export_path(&tmp.join(".env")),
            Err(SafetyError::UnsafeName(_))
        ));
        assert!(matches!(
            validate_export_path(&tmp.join("CON.png")),
            Err(SafetyError::UnsafeName(_))
        ));
    }

    #[test]
    fn rejects_system_directory() {
        if let Ok(win) = std::env::var("SystemRoot") {
            if !win.is_empty() {
                let p = Path::new(&win).join("章.png");
                assert!(matches!(
                    validate_export_path(&p),
                    Err(SafetyError::SystemDirectory(_))
                ));
            }
        }
    }

    #[test]
    fn rejects_app_directory() {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let p = dir.join("章.png");
                assert!(matches!(
                    validate_export_path(&p),
                    Err(SafetyError::AppDirectory(_))
                ));
            }
        }
    }

    #[test]
    fn enforces_size_limits() {
        assert!(check_encoding_len(&"a".repeat(MAX_B64_LEN + 1)).is_err());
        assert!(check_encoding_len("aGVsbG8=").is_ok());
        assert!(check_payload_size(MAX_EXPORT_BYTES + 1).is_err());
        assert!(check_payload_size(1024).is_ok());
    }

    #[test]
    fn directory_path_has_no_filename() {
        // 用临时目录的根（Windows 为 C:\，Unix 为 /），跨平台且无盘符硬编码
        let root = std::env::temp_dir();
        let root = root.ancestors().last().unwrap();
        assert!(matches!(
            validate_export_path(root),
            Err(SafetyError::UnsafeName(_))
        ));
    }
}
