use base64::{engine::general_purpose::STANDARD, Engine as _};

mod safety;

/// 把前端生成的 PNG / ZIP 字节写到用户选定的路径。
/// 数据用 base64 传递，避免大数组走 JSON 序列化造成的体积膨胀。
/// 返回实际写入的字节数，前端会据此校验文件是否完整落盘。
///
/// 注意：Tauri 2 的命令参数默认按 camelCase 映射，
/// Rust 的 `data_b64` 在 JS 侧必须写成 `dataB64`，否则命令会因缺参直接失败。
///
/// 安全边界：路径来自前端，Tauri 的 fs scope 不约束 Rust 侧 std::fs，
/// 因此这里显式做路径白名单校验 + 体积上限，防止越权写入与 OOM。
#[tauri::command]
fn save_bytes(path: String, data_b64: String) -> Result<u64, String> {
    // 解码前先拦截超大输入，避免 base64 解码分配巨量内存
    safety::check_encoding_len(&data_b64).map_err(|e| e.to_string())?;

    // 校验目标路径：绝对、无穿越、扩展名白名单、非系统/程序目录
    let target = safety::validate_export_path(std::path::Path::new(&path))
        .map_err(|e| e.to_string())?;

    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("解码失败: {e}"))?;
    safety::check_payload_size(bytes.len() as u64).map_err(|e| e.to_string())?;

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建目录 {}: {e}", parent.display()))?;
        }
    }

    std::fs::write(&target, &bytes)
        .map_err(|e| format!("写入 {} 失败: {e}", target.display()))?;

    Ok(bytes.len() as u64)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_bytes])
        .run(tauri::generate_context!())
        .expect("启动印章提取工具失败");
}

#[cfg(test)]
mod command_tests {
    use super::*;

    #[test]
    fn encoding_guard_rejects_huge_payload() {
        let huge = "A".repeat(safety::MAX_B64_LEN + 1);
        let target = std::env::temp_dir().join("seal_huge.png").to_string_lossy().to_string();
        let err = save_bytes(target, huge).unwrap_err();
        assert!(err.contains("数据过大"), "实际: {err}");
    }

    #[test]
    fn save_rejects_executable_extension() {
        let tiny = STANDARD.encode([1u8, 2, 3]);
        let target = std::env::temp_dir().join("seal_reject.exe").to_string_lossy().to_string();
        let err = save_bytes(target, tiny).unwrap_err();
        assert!(err.contains("可执行文件"), "实际: {err}");
    }
}
